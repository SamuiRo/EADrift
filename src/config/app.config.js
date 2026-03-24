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
export const LOG_LEVEL                 = process.env.LOG_LEVEL || 'info';
export const APP_VERSION               = pkg.version;
export const PKG               = pkg;
export const DEFAULT_POSITION_SIZE_USDT = process.env.DEFAULT_POSITION_SIZE_USDT || "20";

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