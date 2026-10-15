import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../shared/logger.js';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_SIGNAL_CHANNEL_ID } from "../config/app.config.js"

// ─── Singleton ────────────────────────────────────────────────────────────────

let bot = null;

export function getBot() {
  if (!bot) throw new Error('Bot not initialized. Call initBot() first.');
  return bot;
}

/**
 * Ініціалізувати бота. Викликати один раз при старті.
 * @returns {TelegramBot}
 */
// Long polling: Telegram тримає запит відкритим до LONG_POLL_SECONDS, тож
// таймаут HTTP-запиту мусить бути помітно більшим.
const LONG_POLL_SECONDS  = 10;
const REQUEST_TIMEOUT_MS = 30_000;

// Скільки тиші від Telegram вважати зависанням, і як часто перевіряти.
export const POLLING_STALL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS     = 60_000;

let watchdogHandle = null;
let lastPollingError = null;

export function initBot() {
  if (bot) return bot;

  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: { autoStart: true, interval: 300, params: { timeout: LONG_POLL_SECONDS } },
    // Без таймауту запит getUpdates на "завислому" TCP-з'єднанні не завершується
    // ніколи. Бібліотека планує наступне опитування лише після завершення
    // попереднього, тому прийом команд тихо зупинявся назавжди, а isPolling()
    // і далі повертав true. Таймаут перетворює зависання на звичайну помилку,
    // після якої цикл опитування продовжується сам.
    request: { timeout: REQUEST_TIMEOUT_MS },
  });

  bot.on('polling_error', (err) => {
    lastPollingError = { at: Date.now(), message: err.message, code: err.code };
    logger.error('Telegram polling error', { err: err.message, code: err.code });
  });

  bot.on('error', (err) => {
    logger.error('Telegram error', { err: err.message });
  });

  startPollingWatchdog();

  logger.info('Telegram bot initialized');
  return bot;
}

/**
 * Стан прийому команд: коли востаннє Telegram відповів на опитування.
 * Бібліотека оновлює _lastUpdate після кожного успішного getUpdates,
 * навіть порожнього, тож це надійний сигнал "цикл живий".
 */
export function getPollingHealth(now = Date.now()) {
  const last = bot?._polling?._lastUpdate || 0;
  return {
    lastResponseAt: last || null,
    silentMs:       last ? now - last : null,
    lastError:      lastPollingError,
    stalled:        Boolean(last) && now - last > POLLING_STALL_MS,
  };
}

/**
 * Страховка поверх таймауту: якщо Telegram мовчить довше за POLLING_STALL_MS,
 * процес завершується з кодом 1, і pm2 піднімає його заново.
 *
 * Перезапуск процесу, а не лише опитування, — свідомо: скасування завислого
 * запиту в цій бібліотеці може запустити два цикли опитування одночасно, а
 * Telegram на паралельні getUpdates відповідає 409 і ламає прийом ще гірше.
 * Стан відновлюється при старті: watchlist — з БД, режим — з env.
 */
function startPollingWatchdog() {
  if (watchdogHandle) return;

  watchdogHandle = setInterval(() => {
    const health = getPollingHealth();
    if (!health.stalled) return;

    logger.error('Telegram polling stalled — restarting process', {
      silentSec: Math.round(health.silentMs / 1000),
      lastError: health.lastError?.message ?? null,
    });

    // Спроба попередити адміна. sendMessage — окремий запит, він може пройти
    // навіть коли завис саме getUpdates. Чекаємо недовго і виходимо в будь-якому разі.
    const notice = bot.sendMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `⚠️ Прийом команд завис (${Math.round(health.silentMs / 60000)} хв без відповіді від Telegram). Перезапускаю бота.`,
    ).catch(() => {});
    const deadline = new Promise(resolve => setTimeout(resolve, 5000));
    Promise.race([notice, deadline]).finally(() => process.exit(1));
  }, WATCHDOG_INTERVAL_MS);

  watchdogHandle.unref?.();
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const ADMIN_CHAT_ID = TELEGRAM_ADMIN_CHAT_ID;
export const SIGNAL_CHANNEL = TELEGRAM_SIGNAL_CHANNEL_ID;

// ─── Guards ───────────────────────────────────────────────────────────────────

/**
 * Чи є повідомлення від адміна?
 */
export function isAdmin(msg) {
  return String(msg.chat.id) === String(TELEGRAM_ADMIN_CHAT_ID);
}

/**
 * Middleware-обгортка: виконати handler тільки якщо повідомлення від адміна.
 * Інакше — тихо ігнорує (або надсилає попередження).
 */
export function adminOnly(handler) {
  return async (msg, match) => {
    if (!isAdmin(msg)) {
      logger.warn('Unauthorized access attempt', { chatId: msg.chat.id });
      return;
    }
    try {
      await handler(msg, match);
    } catch (err) {
      logger.error('Handler error', { err: err.message });
      await sendAdmin(`Помилка: ${err.message}`);
    }
  };
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

/**
 * Відправити текст адміну.
 */
export async function sendAdmin(text, extra = {}) {
  const b = getBot();
  try {
    return await b.sendMessage(TELEGRAM_ADMIN_CHAT_ID, text, extra);
  } catch (err) {
    logger.error('sendAdmin failed', { err: err.message });
  }
}

/**
 * Відправити файл адміну. Лише в адмін-чат — інших адресатів тут немає.
 */
export async function sendAdminDocument(filePath, caption = '', fileName = undefined) {
  const b = getBot();
  try {
    return await b.sendDocument(
      TELEGRAM_ADMIN_CHAT_ID,
      filePath,
      { caption },
      { filename: fileName, contentType: 'application/octet-stream' },
    );
  } catch (err) {
    logger.error('sendAdminDocument failed', { err: err.message });
    throw err;
  }
}

/**
 * Відправити Markdown-повідомлення адміну.
 */
export async function sendMarkdown(text, extra = {}) {
  return sendAdmin(text, { parse_mode: 'Markdown', ...extra });
}

/**
 * Відредагувати існуюче повідомлення (для оновлення статусу).
 */
export async function editMessage(chatId, messageId, text, extra = {}) {
  const b = getBot();
  try {
    return await b.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...extra,
    });
  } catch (err) {
    // Повідомлення вже видалено або не змінилось — ігноруємо
    if (!err.message.includes('not modified')) {
      logger.error('editMessage failed', { err: err.message });
    }
  }
}

/**
 * Відповісти на callback_query (прибрати loading spinner на кнопці).
 */
export async function answerCallback(callbackQueryId, text = '') {
  const b = getBot();
  try {
    await b.answerCallbackQuery(callbackQueryId, { text });
  } catch (err) {
    logger.error('answerCallback failed', { err: err.message });
  }
}

// ─── Notify function for positionMonitor ─────────────────────────────────────

/**
 * Готова функція для передачі в positionMonitor.setNotifier().
 * Відправляє текстові алерти адміну.
 */
export async function telegramNotify(message) {
  await sendMarkdown(`*Монітор позицій*\n\n${message}`);
}

// ─── Format helpers ───────────────────────────────────────────────────────────

/**
 * Форматувати позицію для відображення в Telegram.
 */
export function formatPosition(pos) {
  const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
  const side = pos.side === 'LONG' ? 'LONG ▲' : 'SHORT ▼';

  return [
    `*${pos.symbol}* — ${side}`,
    `Entry: \`${pos.entryPrice}\``,
    `Mark:  \`${pos.markPrice}\``,
    `Size:  \`${pos.size}\` (x${pos.leverage})`,
    `PnL:   \`${pnlSign}${pos.unrealizedPnl.toFixed(2)} USDT\``,
    `Liq:   \`${pos.liquidPrice}\``,
  ].join('\n');
}

// formatOrderSummary видалено — логіка картки підтвердження перенесена в confirmation.js