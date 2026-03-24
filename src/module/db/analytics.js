/**
 * analytics.js
 *
 * Готові аналітичні запити для відповіді на ключові питання:
 *  1. Оптимальний SL (яка ширина дає кращий R)
 *  2. Оптимальний TP (скільки угод доходять до TP2, TP3)
 *  3. Ефективність trailing і BE+
 *  4. Статистика по символу / таймфрейму
 *
 * Використання:
 *   import { slOptimizationReport, tpHitRate } from './db/analytics.js';
 */

import { db, Trade, Signal, SlHistory, TradeEvent } from './database.js';
import { QueryTypes } from 'sequelize';

// ─── SL аналіз ────────────────────────────────────────────────────────────────

/**
 * Розподіл delta (SL ширина) і середній R по кожному відрізку.
 * Допомагає знайти оптимальний діапазон SL.
 *
 * Повертає масив:
 *   [{ deltaBucket, tradeCount, avgProfitR, winRate, avgTimeInTradeH }]
 */
export async function slOptimizationReport() {
  return db.query(`
    SELECT
      ROUND(
        CAST(ABS(entry_price - sl_price_initial) / entry_price * 100 AS REAL) / 0.5
      ) * 0.5 AS delta_bucket_pct,

      COUNT(*)                                         AS trade_count,
      ROUND(AVG(profit_r), 3)                          AS avg_profit_r,
      ROUND(SUM(CASE WHEN profit_usdt > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS win_rate_pct,
      ROUND(AVG(time_in_trade_ms) / 3600000.0, 2)     AS avg_time_in_trade_h

    FROM trades
    WHERE status = 'CLOSED'
      AND profit_r IS NOT NULL
      AND sl_price_initial IS NOT NULL

    GROUP BY delta_bucket_pct
    ORDER BY delta_bucket_pct ASC
  `, { type: QueryTypes.SELECT });
}

/**
 * Яке максимальне несприятливе відхилення (MAE) буває до TP1.
 * Показує наскільки щільно можна виставити SL не втрачаючи угоди.
 *
 * Повертає: [{ symbol, side, maxDrawdownPct, tp1Hit, profitR }]
 */
export async function maeReport() {
  return Trade.findAll({
    where:      { status: 'CLOSED' },
    attributes: ['symbol', 'side', 'maxDrawdownPct', 'maxProfitPct', 'tp1Hit', 'profitR', 'closeReason'],
    order:      [['openedAt', 'DESC']],
    limit:      500,
    raw:        true,
  });
}

// ─── TP аналіз ────────────────────────────────────────────────────────────────

/**
 * Hit rate по кожному рівню TP і середній R.
 *
 * Повертає:
 *   { tp1HitRate, tp2HitRate, tp3HitRate, tp4HitRate, avgR }
 */
export async function tpHitRate() {
  const [row] = await db.query(`
    SELECT
      COUNT(*)                                                            AS total,
      ROUND(SUM(tp1_hit) * 100.0 / COUNT(*), 1)                          AS tp1_hit_rate,
      ROUND(SUM(tp2_hit) * 100.0 / COUNT(*), 1)                          AS tp2_hit_rate,
      ROUND(SUM(tp3_hit) * 100.0 / COUNT(*), 1)                          AS tp3_hit_rate,
      ROUND(SUM(tp4_hit) * 100.0 / COUNT(*), 1)                          AS tp4_hit_rate,
      ROUND(AVG(profit_r), 3)                                             AS avg_profit_r,
      ROUND(SUM(CASE WHEN profit_usdt > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS win_rate_pct
    FROM trades
    WHERE status = 'CLOSED'
  `, { type: QueryTypes.SELECT });

  return row;
}

/**
 * Розподіл за closeReason — що найчастіше закриває угоди.
 */
export async function closeReasonBreakdown() {
  return db.query(`
    SELECT
      close_reason,
      COUNT(*)                        AS trade_count,
      ROUND(AVG(profit_r), 3)         AS avg_profit_r,
      ROUND(AVG(profit_pct), 2)       AS avg_profit_pct,
      ROUND(AVG(time_in_trade_ms) / 3600000.0, 2) AS avg_hours
    FROM trades
    WHERE status = 'CLOSED'
    GROUP BY close_reason
    ORDER BY trade_count DESC
  `, { type: QueryTypes.SELECT });
}

// ─── Trailing і BE+ ───────────────────────────────────────────────────────────

/**
 * Аналіз trailing: середня відстань від ціни до trailing SL.
 * Показує наскільки trailing "тісний" або "слабкий".
 */
export async function trailingEfficiency() {
  return db.query(`
    SELECT
      t.symbol,
      COUNT(sl.id)                                 AS trailing_updates,
      ROUND(AVG(sl.distance_from_price_pct), 3)    AS avg_distance_pct,
      ROUND(MIN(sl.distance_from_price_pct), 3)    AS min_distance_pct,
      ROUND(MAX(sl.distance_from_price_pct), 3)    AS max_distance_pct
    FROM sl_history sl
    JOIN trades t ON t.id = sl.trade_id
    WHERE sl.reason = 'TRAILING'
    GROUP BY t.symbol
    ORDER BY trailing_updates DESC
  `, { type: QueryTypes.SELECT });
}

/**
 * BE+ ефективність: скільки разів після BE+ ціна поверталась і вибивала по SL.
 * Порівнює угоди де SL досяг BE+ з подальшим результатом.
 */
export async function beEffectiveness() {
  return db.query(`
    SELECT
      t.symbol,
      COUNT(DISTINCT t.id)                    AS trades_with_be,
      SUM(CASE WHEN t.profit_usdt >= 0 THEN 1 ELSE 0 END) AS profitable_after_be,
      ROUND(AVG(t.profit_r), 3)               AS avg_profit_r_after_be,
      SUM(CASE WHEN t.close_reason = 'sl_hit' THEN 1 ELSE 0 END) AS stopped_out_at_be
    FROM trades t
    INNER JOIN sl_history sl ON sl.trade_id = t.id AND sl.reason = 'BE_PLUS'
    WHERE t.status = 'CLOSED'
    GROUP BY t.symbol
  `, { type: QueryTypes.SELECT });
}

// ─── Статистика по символу ────────────────────────────────────────────────────

/**
 * Повна статистика по кожному символу.
 */
export async function symbolStats() {
  return db.query(`
    SELECT
      symbol,
      side,
      COUNT(*)                                                             AS trades,
      ROUND(SUM(CASE WHEN profit_usdt > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS win_rate,
      ROUND(AVG(profit_r), 3)                                              AS avg_r,
      ROUND(SUM(profit_usdt), 2)                                           AS total_pnl_usdt,
      ROUND(AVG(leverage), 1)                                              AS avg_leverage,
      ROUND(AVG(time_in_trade_ms) / 3600000.0, 2)                         AS avg_hours
    FROM trades
    WHERE status = 'CLOSED'
    GROUP BY symbol, side
    ORDER BY total_pnl_usdt DESC
  `, { type: QueryTypes.SELECT });
}

/**
 * Статистика по торговому режиму — FULL_AUTO vs SEMI_AUTO vs CONFIRM_ONLY.
 */
export async function modeStats() {
  return db.query(`
    SELECT
      trading_mode,
      COUNT(*)                                  AS trades,
      ROUND(AVG(profit_r), 3)                   AS avg_r,
      ROUND(SUM(profit_usdt), 2)                AS total_pnl,
      ROUND(SUM(CASE WHEN profit_usdt > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS win_rate
    FROM trades
    WHERE status = 'CLOSED'
    GROUP BY trading_mode
  `, { type: QueryTypes.SELECT });
}

/**
 * Скільки сигналів відхилено і чому — дає розуміння фільтрів.
 */
export async function signalRejectionStats() {
  return db.query(`
    SELECT
      reject_reason,
      COUNT(*) AS count,
      symbol
    FROM signals
    WHERE status = 'REJECTED'
    GROUP BY reject_reason, symbol
    ORDER BY count DESC
    LIMIT 50
  `, { type: QueryTypes.SELECT });
}

/**
 * Загальне equity curve (кумулятивний PnL по часу).
 * Готово для побудови графіку.
 */
export async function equityCurve() {
  return db.query(`
    SELECT
      closed_at                                          AS ts,
      profit_usdt,
      SUM(profit_usdt) OVER (ORDER BY closed_at)        AS cumulative_pnl,
      symbol,
      close_reason
    FROM trades
    WHERE status = 'CLOSED'
      AND profit_usdt IS NOT NULL
    ORDER BY closed_at ASC
  `, { type: QueryTypes.SELECT });
}