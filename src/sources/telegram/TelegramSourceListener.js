import { NewMessage } from 'telegram/events/index.js';
import telegramClient from '../../module/telegram/TelegramClient.js';
import { parseSignal } from '../../parser/signalParser.js';
import { print } from '../../shared/utils.js';

/**
 * Слухає повідомлення з Telegram-каналу через MTProto (gramjs).
 *
 * Використання:
 *   const listener = new TelegramSourceListener(channelId, onSignal);
 *   await listener.connect();
 *   await listener.startListening();
 *   // ...
 *   await listener.stop();
 */
export class TelegramSourceListener {
  /**
   * @param {string|number} channelId      — ID каналу (число або рядок)
   * @param {Function}      onSignal       — async (signal) => void, викликається для кожного розпарсованого сигналу
   * @param {object}        [options]
   * @param {number}        [options.pingIntervalMs=240000]  — як часто робити fallback-пінг (мс)
   * @param {number}        [options.pingHistoryLimit=1]     — скільки останніх повідомлень тягнути при пінгу
   * @param {number}        [options.seenIdsMaxSize=1000]    — при якому розмірі чистити seenMessageIds
   * @param {number}        [options.seenIdsTrimTo=500]      — скільки залишати після чистки
   * @param {number}        [options.staleMessageMs=300000]  — повідомлення старіші за це ігноруються при пінгу
   */
  constructor(channelId, onSignal, options = {}) {
    if (!channelId) throw new Error('TelegramSourceListener: channelId is required');
    if (typeof onSignal !== 'function') throw new Error('TelegramSourceListener: onSignal callback is required');

    this.channelId = String(channelId);
    this.onSignal = onSignal;
    this.client = null;
    this.isListening = false;

    // Налаштування пінгу
    this.pingIntervalMs = options.pingIntervalMs ?? 4 * 60 * 1000;
    this.pingHistoryLimit = options.pingHistoryLimit ?? 1;
    this.seenIdsMaxSize = options.seenIdsMaxSize ?? 1000;
    this.seenIdsTrimTo = options.seenIdsTrimTo ?? 500;
    this.staleMessageMs = options.staleMessageMs ?? 5 * 60 * 1000;

    // Множина вже оброблених ID — захист від дублів між евентом і пінгом
    this._seenMessageIds = new Set();
    this._pingTimer = null;
  }

  // ─── Підключення ───────────────────────────────────────────────────────────

  async connect() {
    try {
      // TelegramClient — singleton, connect() безпечний для повторного виклику
      await telegramClient.connect();
      this.client = telegramClient.getClient();
      print('TelegramSourceListener: connected', 'success');
    } catch (error) {
      throw new Error(`TelegramSourceListener: failed to connect — ${error.message}`);
    }
  }

  // ─── Запуск слухача ────────────────────────────────────────────────────────

  async startListening() {
    if (this.isListening) {
      print('TelegramSourceListener: already listening', 'warning');
      return;
    }

    if (!this.client) {
      throw new Error('TelegramSourceListener: call connect() before startListening()');
    }

    try {
      // Резолвимо entity каналу один раз
      this._entity = await this.client.getEntity(this.channelId);

      // Підписуємося на нові повідомлення тільки з цього каналу
      this.client.addEventHandler(
        (event) => this._handleEvent(event),
        new NewMessage({ chats: [this._entity.id] }),
      );

      this.isListening = true;
      print(`TelegramSourceListener: listening to channel ${this.channelId}`, 'success');

      // Keepalive ping
      this._startPing();

    } catch (error) {
      throw new Error(`TelegramSourceListener: failed to start — ${error.message}`);
    }
  }

  // ─── Зупинка ───────────────────────────────────────────────────────────────

  async stop() {
    this._stopPing();

    if (this.client && this.isListening) {
      // gramjs не має removeEventHandler у всіх версіях,
      // тому просто відключаємо клієнт
      await telegramClient.disconnect();
      this.isListening = false;
      print('TelegramSourceListener: stopped', 'success');
    }
  }

  // ─── Внутрішня обробка події ───────────────────────────────────────────────

  async _handleEvent(event) {
    try {
      const message = event.message;

      // Ігноруємо не-текстові повідомлення (фото, гіфки, стікери тощо)
      if (!message?.message) return;

      // Евент і пінг можуть прийти майже одночасно — дедуплікуємо по ID
      if (this._seenMessageIds.has(message.id)) return;
      this._seenMessageIds.add(message.id);

      await this._tryParseAndHandle(message.message, message.id);

    } catch (error) {
      // Не кидаємо вище — одна погана подія не повинна зупинити слухача
      print(`TelegramSourceListener: error handling event — ${error.message}`, 'error');
      console.error(error);
    }
  }

  // ─── Спільна логіка парсингу ───────────────────────────────────────────────

  async _tryParseAndHandle(text, msgId) {
    const signal = parseSignal(text);
    if (!signal) return;

    print(`TelegramSourceListener: signal received [${signal.type}] ${signal.symbol} (msgId=${msgId})`, 'info');
    await this.onSignal(signal);
  }

  // ─── Ping + fallback polling ───────────────────────────────────────────────

  _startPing() {
    this._pingTimer = setInterval(async () => {
      try {
        if (this.client && this.isListening) {
          await this._pingChannel(this._entity);
        }
      } catch (error) {
        print(`TelegramSourceListener: ping failed — ${error.message}`, 'warning');
      }
    }, this.pingIntervalMs);
  }

  /**
   * Підтримує потік MTProto Updates для великого каналу.
   *
   * ЧОМУ це необхідно:
   *   Telegram-сервер оптимізує трафік для каналів із великою кількістю
   *   підписників. Якщо клієнт довго не проявляє активності щодо каналу,
   *   сервер припиняє надсилати для нього MTProto Updates — і NewMessage
   *   евенти просто перестають приходити. getMessages() сигналізує серверу
   *   що клієнт активно стежить за цим каналом, і сервер відновлює потік
   *   Updates. Це поведінка MTProto-протоколу, відтворюється в усіх
   *   бібліотеках (gramjs, Telethon, TDLib) — не баг gramjs.
   *
   * Бонус: також ловить повідомлення які евент міг пропустити під час
   *   короткого reconnect. Дублі виключаються через _seenMessageIds.
   */
  async _pingChannel(entity) {
    const messages = await this.client.getMessages(entity, { limit: this.pingHistoryLimit });
    print(`TelegramSourceListener: ping OK (fetched ${messages.length} msg)`, 'debug');

    for (const msg of messages) {
      if (!msg.message) continue;
      if (this._seenMessageIds.has(msg.id)) continue;
      this._seenMessageIds.add(msg.id);

      // При першому пінгу ігноруємо старі повідомлення (> staleMessageMs)
      const ageMs = Date.now() - msg.date * 1000;
      if (ageMs > this.staleMessageMs) continue;

      await this._tryParseAndHandle(msg.message, msg.id);
    }

    // Не даємо _seenMessageIds рости нескінченно
    if (this._seenMessageIds.size > this.seenIdsMaxSize) {
      const arr = [...this._seenMessageIds];
      arr.slice(0, this.seenIdsTrimTo).forEach(id => this._seenMessageIds.delete(id));
    }
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}