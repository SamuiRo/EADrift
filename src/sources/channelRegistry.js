/**
 * channelRegistry.js
 *
 * Перелік каналів-джерел сигналів і правила, за якими кожен сигнал отримує
 * ім'я свого джерела.
 *
 * Ім'я джерела — це те, що потрапляє в signals.source і signal_evaluations.source.
 * Уся статистика якості рахується в розрізі цього імені, тому воно має бути
 * стабільним: перейменування каналу в конфігу розірве історію на дві частини.
 *
 * Модуль чистий — без мережі й без читання env, щоб його можна було тестувати.
 */

import { parseSignal as parseGgshot } from '../parser/signalParser.js';

/**
 * Парсери за назвою. Канал у конфігу посилається на парсер за ключем.
 * Новий формат сигналів = новий запис тут.
 */
export const PARSERS = {
  ggshot: parseGgshot,
};

export const DEFAULT_PARSER = 'ggshot';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Звести ідентифікатор каналу до спільного вигляду.
 *
 * Bot API дає ID каналу як -1001234567890, MTProto — як 1234567890, у конфігу
 * людина може написати будь-який з них або @username. Для порівняння всі
 * числові форми зводяться до голого числа, username — до нижнього регістру.
 */
export function normalizeChannelKey(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!value) return null;

  if (value.startsWith('@')) return value.slice(1).toLowerCase();

  const digits = value.replace(/^-100/, '').replace(/^-/, '');
  return /^\d+$/.test(digits) ? digits : value.toLowerCase();
}

/**
 * Розібрати SIGNAL_CHANNELS.
 *
 * Формат: `ім'я:ідентифікатор[:парсер]` через кому.
 *   ggshot:-1001234567890
 *   ggshot:-1001234567890:ggshot,whales:@whales_signals:ggshot
 *
 * Якщо SIGNAL_CHANNELS порожній, але задано старий TELEGRAM_SIGNAL_CHANNEL_ID,
 * він стає одним каналом з ім'ям legacyName — так розгорнутий сервер
 * продовжує працювати без змін у .env.
 *
 * @returns {{ channels: Array<{name, id, key, parser}>, errors: string[] }}
 */
export function parseChannelConfig({ signalChannels, legacyChannelId, legacyName = 'ggshot' } = {}) {
  const channels = [];
  const errors   = [];
  const seenNames = new Set();
  const seenKeys  = new Set();

  const entries = String(signalChannels ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!entries.length && legacyChannelId) {
    entries.push(`${legacyName}:${legacyChannelId}`);
  }

  for (const entry of entries) {
    const [name, id, parser = DEFAULT_PARSER] = entry.split(':').map(s => s.trim());

    if (!name || !NAME_RE.test(name)) {
      errors.push(`"${entry}": ім'я має бути з малих латинських літер, цифр, _ або - (до 32 символів)`);
      continue;
    }
    if (!id) {
      errors.push(`"${entry}": не вказано ідентифікатор каналу`);
      continue;
    }
    if (!PARSERS[parser]) {
      errors.push(`"${entry}": невідомий парсер "${parser}". Доступні: ${Object.keys(PARSERS).join(', ')}`);
      continue;
    }

    const key = normalizeChannelKey(id);
    if (seenNames.has(name)) { errors.push(`"${entry}": ім'я "${name}" вже використано`); continue; }
    if (seenKeys.has(key))   { errors.push(`"${entry}": цей канал уже додано під іншим ім'ям`); continue; }

    seenNames.add(name);
    seenKeys.add(key);
    channels.push({ name, id, key, parser });
  }

  return { channels, errors };
}

/**
 * Визначити джерело повідомлення, яке адміністратор надіслав або переслав боту.
 *
 * Якщо сигнал переслано з каналу, що є в конфігу, — він отримує ім'я цього
 * каналу, і його статистика зараховується саме туди. Пересланий з невідомого
 * каналу підписується його назвою, щоб його можна було знайти й додати.
 *
 * @param {object} msg — повідомлення Bot API
 * @param {Array}  channels — результат parseChannelConfig().channels
 * @returns {{ source: string, channel: object|null }}
 */
export function resolveForwardSource(msg, channels = []) {
  const origin = msg?.forward_origin;
  const chat   = origin?.chat ?? msg?.forward_from_chat ?? null;

  if (chat) {
    const keys = [normalizeChannelKey(chat.id), normalizeChannelKey(chat.username ? `@${chat.username}` : null)]
      .filter(Boolean);
    const known = channels.find(c => keys.includes(c.key));
    if (known) return { source: known.name, channel: known };

    const label = slug(chat.username || chat.title || String(chat.id));
    return { source: `forward:${label}`, channel: null };
  }

  if (origin || msg?.forward_date) return { source: 'admin_forward', channel: null };
  return { source: 'admin_message', channel: null };
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'unknown';
}
