import 'dotenv/config';
import { logger } from '../shared/logger.js';

import pkg from '../../package.json' with { type: 'json' };

export const NODE_ENV                  = process.env.NODE_ENV;
export const BINANCE_API_KEY           = process.env.BINANCE_API_KEY;
export const BINANCE_SECRET_KEY        = process.env.BINANCE_SECRET_KEY;
export const BINANCE_TESTNET           = process.env.BINANCE_TESTNET === 'true';
export const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_ADMIN_CHAT_ID    = process.env.TELEGRAM_ADMIN_CHAT_ID;
export const TELEGRAM_SIGNAL_CHANNEL_ID = process.env.TELEGRAM_SIGNAL_CHANNEL_ID;
export const TELEGRAM_API_ID           = +process.env.TELEGRAM_API_ID;
export const TELEGRAM_API_HASH         = process.env.TELEGRAM_API_HASH;
export const TELEGRAM_SESSION_STRING   = process.env.TELEGRAM_SESSION_STRING || '';
export const MONITOR_INTERVAL_MS       = parseInt(process.env.MONITOR_INTERVAL_MS || '5000');
const confirmMaxPriceMovePct           = parseFloat(process.env.CONFIRM_MAX_PRICE_MOVE_PCT || '0.005');
export const CONFIRM_MAX_PRICE_MOVE_PCT = Number.isFinite(confirmMaxPriceMovePct) && confirmMaxPriceMovePct >= 0
  ? confirmMaxPriceMovePct
  : 0.005;
export const LOG_LEVEL                 = process.env.LOG_LEVEL || 'info';
export const APP_VERSION               = pkg.version;
export const PKG               = pkg;
export const DEFAULT_POSITION_SIZE_USDT = process.env.DEFAULT_POSITION_SIZE_USDT || "20";

// ─── Капітал і портфельні ліміти ──────────────────────────────────────────────

/** Число з env з перевіркою; некоректне значення не зупиняє бот, а дає дефолт. */
function envNumber(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    logger.warn(`Invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * Скільки USDT бот вважає своїм капіталом, навіть якщо на рахунку більше.
 * Ризик, розмір позиції й маржа рахуються від min(баланс, ця межа).
 */
export const CAPITAL_CAP_USDT = envNumber('CAPITAL_CAP_USDT', 1000, { min: 1 });

/**
 * Скільки позицій може бути відкрито одночасно. Капітал ділиться на стільки
 * маржинальних слотів, тому це ж значення визначає плече.
 */
export const MAX_OPEN_POSITIONS = Math.floor(envNumber('MAX_OPEN_POSITIONS', 3, { min: 1 }));

// ─── Стартовий режим ──────────────────────────────────────────────────────────

const STARTUP_MODES = ['SHADOW', 'CONFIRM_ONLY', 'SEMI_AUTO', 'FULL_AUTO', 'PAUSED'];

/**
 * Режим, у якому бот стартує. Без цього будь-який рестарт процесу повертав
 * бота в CONFIRM_ONLY — на сервері це тихо зупиняло б збір даних у SHADOW.
 */
export const STARTUP_TRADING_MODE = (() => {
  const raw = (process.env.STARTUP_TRADING_MODE || 'CONFIRM_ONLY').trim().toUpperCase();
  if (STARTUP_MODES.includes(raw)) return raw;
  logger.warn(`Invalid STARTUP_TRADING_MODE="${raw}", falling back to CONFIRM_ONLY`);
  return 'CONFIRM_ONLY';
})();

// ─── Env check ────────────────────────────────────────────────────────────────

const required = [
  'BINANCE_API_KEY',
  'BINANCE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ADMIN_CHAT_ID',
];

// gramjs змінні — попереджаємо але не зупиняємо (канал опціональний на старті)
const recommendedForChannel = [
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION_STRING',
  'TELEGRAM_SIGNAL_CHANNEL_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    logger.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

for (const key of recommendedForChannel) {
  if (!process.env[key]) {
    logger.warn(`Channel listener disabled: missing ${key}`);
  }
}
