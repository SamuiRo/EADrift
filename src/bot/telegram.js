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
export function initBot() {
  if (bot) return bot;

  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('polling_error', (err) => {
    logger.error('Telegram polling error', { err: err.message });
  });

  bot.on('error', (err) => {
    logger.error('Telegram error', { err: err.message });
  });

  logger.info('Telegram bot initialized');
  return bot;
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