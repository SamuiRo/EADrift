/**
 * database.js
 *
 * Ініціалізація Sequelize + SQLite, реєстрація всіх моделей і асоціацій.
 * Єдина точка входу для роботи з БД.
 *
 * Використання:
 *   import { db, Signal, Trade, TradeEvent, SlHistory } from './db/database.js';
 *   await db.authenticate(); // перевірити з'єднання
 */

import { Sequelize } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../shared/logger.js';

import defineSignal     from './models/Signal.js';
import defineTrade      from './models/Trade.js';
import defineTradeEvent from './models/TradeEvent.js';
import defineSlHistory  from './models/SlHistory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.resolve(__dirname, '../../data/trading.db');

// ─── Sequelize instance ───────────────────────────────────────────────────────

export const db = new Sequelize({
  dialect: 'sqlite',
  storage: DB_PATH,

  logging: (sql, timing) => {
    // Логуємо тільки повільні запити або якщо LOG_LEVEL=debug
    if (process.env.LOG_LEVEL === 'debug') {
      logger.debug('SQL', { sql, timing });
    }
  },

  define: {
    underscored:    false, // camelCase у JS, camelCase у SQLite
    freezeTableName: true, // tableName береться точно з моделі
  },
});

// ─── Моделі ───────────────────────────────────────────────────────────────────

export const Signal     = defineSignal(db);
export const Trade      = defineTrade(db);
export const TradeEvent = defineTradeEvent(db);
export const SlHistory  = defineSlHistory(db);

// ─── Асоціації ────────────────────────────────────────────────────────────────

// Signal → Trade (один сигнал може не торгуватись або торгуватись один раз)
Signal.hasOne(Trade,  { foreignKey: 'signalId', as: 'trade' });
Trade.belongsTo(Signal, { foreignKey: 'signalId', as: 'signal' });

// Trade → TradeEvent (хронологія)
Trade.hasMany(TradeEvent, { foreignKey: 'tradeId', as: 'events' });
TradeEvent.belongsTo(Trade, { foreignKey: 'tradeId', as: 'trade' });

// Trade → SlHistory
Trade.hasMany(SlHistory, { foreignKey: 'tradeId', as: 'slMoves' });
SlHistory.belongsTo(Trade, { foreignKey: 'tradeId', as: 'trade' });

// ─── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Ініціалізувати БД:
 *  - Перевірити з'єднання
 *  - Створити таблиці якщо не існують (alter:false — не ламати prod дані)
 *
 * Викликати один раз при старті бота.
 */
export async function initDatabase({ alter = false } = {}) {
  try {
    await db.authenticate();
    logger.info('Database connection established', { path: DB_PATH });

    await db.sync({ alter });
    logger.info('Database synced', { alter });

  } catch (err) {
    logger.error('Database initialization failed', { err: err.message });
    throw err;
  }
}