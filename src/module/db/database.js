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

import { Sequelize, QueryTypes } from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../shared/logger.js';

import defineSignal     from './models/Signal.js';
import defineTrade      from './models/Trade.js';
import defineTradeEvent from './models/TradeEvent.js';
import defineSlHistory  from './models/SlHistory.js';
import defineSignalEvaluation from './models/SignalEvaluation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Шлях можна перевизначити через EADRIFT_DB_PATH — це потрібно тестам, щоб не
// писати в робочу базу, і зручно для роботи з копією даних із сервера.
const DB_PATH = process.env.EADRIFT_DB_PATH
  ? path.resolve(process.env.EADRIFT_DB_PATH)
  : path.resolve(__dirname, '../../data/trading.db');

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
export const SignalEvaluation = defineSignalEvaluation(db);

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

// Signal → SignalEvaluation (сигнал може оцінюватись повторно — напр. при підтвердженні)
Signal.hasMany(SignalEvaluation, { foreignKey: 'signalId', as: 'evaluations' });
SignalEvaluation.belongsTo(Signal, { foreignKey: 'signalId', as: 'signal' });

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

    // Міграції — до sync(). Інакше sync спробує створити індекс на колонці,
    // якої в наявній таблиці ще немає, і впаде. На порожній БД міграції просто
    // не знаходять таблиць і пропускаються, а sync створює все зі схеми.
    await runColumnMigrations();

    await db.sync({ alter });
    logger.info('Database synced', { alter });

    await runDataRepairs();

  } catch (err) {
    logger.error('Database initialization failed', { err: err.message });
    throw err;
  }
}

/**
 * Виправлення даних, записаних старими версіями коду.
 *
 * Кожен крок ідемпотентний: умова WHERE вибирає лише ще не виправлені рядки,
 * тож повторний запуск нічого не змінює. Виконується після sync, коли всі
 * таблиці й колонки гарантовано існують.
 */
const DATA_REPAIRS = [
  {
    // Парсер до v1.2.0 записував першу межу зони як entryHigh, а канал пише
    // "LOW - HIGH". Межі в таких рядках переставлені місцями.
    name: 'swap inverted entry zones',
    sql:  `UPDATE "signals"
           SET "entryLow" = "entryHigh", "entryHigh" = "entryLow"
           WHERE "entryLow" IS NOT NULL AND "entryHigh" IS NOT NULL
             AND "entryLow" > "entryHigh"`,
  },
  {
    // До v1.6.1 таймфрейм у signals не зберігався; у знімку рішення він є.
    name: 'backfill signal timeframe from evaluations',
    sql:  `UPDATE "signals"
           SET "timeframe" = (
             SELECT e."interval" FROM "signal_evaluations" e
             WHERE e."signalId" = "signals"."id" AND e."interval" IS NOT NULL
             ORDER BY e."id" LIMIT 1)
           WHERE "timeframe" IS NULL
             AND EXISTS (SELECT 1 FROM "signal_evaluations" e
                         WHERE e."signalId" = "signals"."id" AND e."interval" IS NOT NULL)`,
  },
  {
    name: 'backfill signal entryMid',
    sql:  `UPDATE "signals"
           SET "entryMid" = ("entryLow" + "entryHigh") / 2.0
           WHERE "entryMid" IS NULL AND "entryLow" IS NOT NULL AND "entryHigh" IS NOT NULL`,
  },
];

async function runDataRepairs() {
  for (const { name, sql } of DATA_REPAIRS) {
    // З type UPDATE драйвер SQLite повертає [null, кількість змінених рядків].
    const [, changed] = await db.query(sql, { type: QueryTypes.UPDATE });
    if (changed > 0) logger.info('Data repair applied', { name, rows: changed });
  }
}

/**
 * Зняти консистентну копію бази, не зупиняючи бот.
 *
 * VACUUM INTO пише знімок у транзакції, тому копія цілісна навіть якщо саме
 * зараз записується новий сигнал. Простий `cp` працюючого файлу такої
 * гарантії не дає.
 *
 * @param {string} targetPath куди записати копію (файл не повинен існувати)
 * @returns {Promise<string>} абсолютний шлях до копії
 */
export async function exportDatabase(targetPath) {
  const absolute = path.resolve(targetPath);
  // SQLite приймає шлях як рядковий літерал: прямі слеші й екранування лапок.
  const literal = absolute.split(path.sep).join('/').replace(/'/g, "''");
  await db.query(`VACUUM INTO '${literal}'`);
  return absolute;
}

/**
 * Додати колонки, яких бракує в уже існуючій БД.
 *
 * `db.sync({ alter: false })` створює відсутні таблиці, але не змінює наявні,
 * тому робоча база на сервері не отримала б нових полів. Кожен крок
 * ідемпотентний: колонка додається лише якщо її ще немає.
 *
 * Свідомо обмежено ADD COLUMN — цього достатньо для додавання полів і воно
 * не переписує таблицю, тобто не ризикує наявними даними.
 */
const COLUMN_MIGRATIONS = [
  {
    table:  'signals',
    column: 'source',
    ddl:    `ALTER TABLE \`signals\` ADD COLUMN \`source\` VARCHAR(64) NOT NULL DEFAULT 'unknown'`,
  },
];

async function runColumnMigrations() {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    try {
      const columns = await db.getQueryInterface().describeTable(table);
      if (columns[column]) continue;

      await db.query(ddl);
      logger.info('Database migration applied', { table, column });

    } catch (err) {
      // Відсутня таблиця на порожній БД — не помилка: sync створить її зі схеми.
      // Sequelize формулює це по-різному залежно від діалекту, тож перевіряємо
      // обидва варіанти: SQLite віддає "No description found for ... table".
      if (/no such table|no description found/i.test(err.message)) continue;
      logger.error('Database migration failed', { table, column, err: err.message });
      throw err;
    }
  }
}