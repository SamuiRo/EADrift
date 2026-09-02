/**
 * analytics.js
 *
 * Готові аналітичні запити для відповіді на ключові питання:
 *  1. Оптимальний SL (яка ширина дає кращий R)
 *  2. Оптимальний TP (скільки угод доходять до TP2, TP3)
 *  3. Ефективність trailing і BE+
 *  4. Статистика по символу, режиму й джерелу сигналів
 *  5. Де саме відсіюються сигнали
 *
 * Використання:
 *   import { slOptimizationReport, tpHitRate } from './db/analytics.js';
 *   npm run report
 *
 * Про назви колонок: Sequelize налаштований з `underscored: false`, тому в
 * SQLite колонки записані camelCase — "entryPrice", "profitR", "tradeId".
 * Ідентифікатори тут беруться в подвійні лапки, бо без них SQLite звів би
 * регістр до нечутливого пошуку лише випадково, а не за правилом.
 */

import { db, Trade } from './database.js';
import { QueryTypes } from 'sequelize';

const select = sql => db.query(sql, { type: QueryTypes.SELECT });

// ─── SL аналіз ────────────────────────────────────────────────────────────────

/**
 * Розподіл delta (ширина SL) і середній R по кожному відрізку 0.5%.
 * Допомагає побачити, на якій ширині стопа угоди справді окупаються.
 *
 * @returns {Promise<Array<{
 *   deltaBucketPct: number, tradeCount: number, avgProfitR: number,
 *   winRatePct: number, avgTimeInTradeH: number,
 * }>>}
 */
export async function slOptimizationReport() {
  return select(`
    SELECT
      ROUND(ABS("entryPrice" - "slPriceInitial") / "entryPrice" * 100 / 0.5) * 0.5
        AS "deltaBucketPct",

      COUNT(*)                                     AS "tradeCount",
      ROUND(AVG("profitR"), 3)                     AS "avgProfitR",
      ROUND(SUM(CASE WHEN "profitUsdt" > 0 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0), 1)              AS "winRatePct",
      ROUND(AVG("timeInTradeMs") / 3600000.0, 2)   AS "avgTimeInTradeH"

    FROM "trades"
    WHERE "status" = 'CLOSED'
      AND "profitR" IS NOT NULL
      AND "slPriceInitial" IS NOT NULL
      AND "entryPrice" > 0

    GROUP BY "deltaBucketPct"
    ORDER BY "deltaBucketPct" ASC
  `);
}

/**
 * Максимальне несприятливе відхилення (MAE) по закритих угодах.
 * Показує, наскільки щільно можна ставити SL, не втрачаючи угоду.
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
 * Hit rate по кожному рівню TP.
 *
 * Найважливіший звіт для калібрування сітки: частка позиції на рівні має
 * відповідати тому, як часто цей рівень реально спрацьовує.
 */
export async function tpHitRate() {
  const [row] = await select(`
    SELECT
      COUNT(*)                                                  AS "total",
      ROUND(SUM("tp1Hit") * 100.0 / NULLIF(COUNT(*), 0), 1)     AS "tp1HitRate",
      ROUND(SUM("tp2Hit") * 100.0 / NULLIF(COUNT(*), 0), 1)     AS "tp2HitRate",
      ROUND(SUM("tp3Hit") * 100.0 / NULLIF(COUNT(*), 0), 1)     AS "tp3HitRate",
      ROUND(SUM("tp4Hit") * 100.0 / NULLIF(COUNT(*), 0), 1)     AS "tp4HitRate",
      ROUND(AVG("profitR"), 3)                                  AS "avgProfitR",
      ROUND(SUM(CASE WHEN "profitUsdt" > 0 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0), 1)                           AS "winRatePct"
    FROM "trades"
    WHERE "status" = 'CLOSED'
  `);

  return row ?? null;
}

/**
 * Розподіл за closeReason — що саме закриває угоди і з яким результатом.
 */
export async function closeReasonBreakdown() {
  return select(`
    SELECT
      "closeReason",
      COUNT(*)                                    AS "tradeCount",
      ROUND(AVG("profitR"), 3)                    AS "avgProfitR",
      ROUND(AVG("profitPct"), 2)                  AS "avgProfitPct",
      ROUND(AVG("timeInTradeMs") / 3600000.0, 2)  AS "avgHours"
    FROM "trades"
    WHERE "status" = 'CLOSED'
    GROUP BY "closeReason"
    ORDER BY "tradeCount" DESC
  `);
}

// ─── Trailing і BE+ ───────────────────────────────────────────────────────────

/**
 * Наскільки тісно trailing тримає ціну.
 */
export async function trailingEfficiency() {
  return select(`
    SELECT
      t."symbol",
      COUNT(sl."id")                              AS "trailingUpdates",
      ROUND(AVG(sl."distanceFromPricePct"), 3)    AS "avgDistancePct",
      ROUND(MIN(sl."distanceFromPricePct"), 3)    AS "minDistancePct",
      ROUND(MAX(sl."distanceFromPricePct"), 3)    AS "maxDistancePct"
    FROM "sl_history" sl
    JOIN "trades" t ON t."id" = sl."tradeId"
    WHERE sl."reason" = 'TRAILING'
    GROUP BY t."symbol"
    ORDER BY "trailingUpdates" DESC
  `);
}

/**
 * Чи допомагає перенос у BE+.
 *
 * Показує, скільки угод після переносу все одно закрилися по стопу — тобто
 * скільки разів BE+ забрав угоду, яка могла б доїхати далі.
 */
export async function beEffectiveness() {
  return select(`
    SELECT
      t."symbol",
      COUNT(DISTINCT t."id")                                          AS "tradesWithBe",
      SUM(CASE WHEN t."profitUsdt" >= 0 THEN 1 ELSE 0 END)            AS "profitableAfterBe",
      ROUND(AVG(t."profitR"), 3)                                      AS "avgProfitRAfterBe",
      SUM(CASE WHEN t."closeReason" = 'sl_hit' THEN 1 ELSE 0 END)     AS "stoppedOutAtBe"
    FROM "trades" t
    INNER JOIN "sl_history" sl ON sl."tradeId" = t."id" AND sl."reason" = 'BE_PLUS'
    WHERE t."status" = 'CLOSED'
    GROUP BY t."symbol"
  `);
}

// ─── Зрізи ────────────────────────────────────────────────────────────────────

/**
 * Статистика по кожному символу й напрямку.
 */
export async function symbolStats() {
  return select(`
    SELECT
      "symbol",
      "side",
      COUNT(*)                                                        AS "trades",
      ROUND(SUM(CASE WHEN "profitUsdt" > 0 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0), 1)                                 AS "winRate",
      ROUND(AVG("profitR"), 3)                                        AS "avgR",
      ROUND(SUM("profitUsdt"), 2)                                     AS "totalPnlUsdt",
      ROUND(AVG("leverage"), 1)                                       AS "avgLeverage",
      ROUND(AVG("timeInTradeMs") / 3600000.0, 2)                      AS "avgHours"
    FROM "trades"
    WHERE "status" = 'CLOSED'
    GROUP BY "symbol", "side"
    ORDER BY "totalPnlUsdt" DESC
  `);
}

/**
 * Статистика по торговому режиму — FULL_AUTO vs SEMI_AUTO vs CONFIRM_ONLY.
 */
export async function modeStats() {
  return select(`
    SELECT
      "tradingMode",
      COUNT(*)                                                        AS "trades",
      ROUND(AVG("profitR"), 3)                                        AS "avgR",
      ROUND(SUM("profitUsdt"), 2)                                     AS "totalPnl",
      ROUND(SUM(CASE WHEN "profitUsdt" > 0 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0), 1)                                 AS "winRate"
    FROM "trades"
    WHERE "status" = 'CLOSED'
    GROUP BY "tradingMode"
  `);
}

/**
 * Статистика по джерелу сигналів.
 *
 * Геометрія в різних провайдерів різна, тому змішана вибірка дає середні,
 * які не описують жодне з джерел. Калібрувати виходи треба окремо на кожне.
 */
export async function sourceStats() {
  return select(`
    SELECT
      s."source",
      COUNT(DISTINCT s."id")                                          AS "signals",
      COUNT(t."id")                                                   AS "trades",
      ROUND(AVG(t."profitR"), 3)                                      AS "avgR",
      ROUND(SUM(t."profitUsdt"), 2)                                   AS "totalPnlUsdt",
      ROUND(SUM(CASE WHEN t."profitUsdt" > 0 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(t."id"), 0), 1)                            AS "winRate"
    FROM "signals" s
    LEFT JOIN "trades" t ON t."signalId" = s."id" AND t."status" = 'CLOSED'
    GROUP BY s."source"
    ORDER BY "signals" DESC
  `);
}

// ─── Воронка сигналів ─────────────────────────────────────────────────────────

/**
 * Скільки сигналів відхилено і чому.
 *
 * Причини нормалізуються до префікса: тексти містять конкретні числа
 * ("Ціна пішла на 6.07% від зони"), тому без цього кожен рядок був би
 * унікальним і згрупувати їх не вийшло б.
 */
export async function signalRejectionStats() {
  return select(`
    SELECT
      SUBSTR("rejectReason", 1, 40) AS "reasonPrefix",
      COUNT(*)                      AS "count"
    FROM "signals"
    WHERE "status" = 'REJECTED'
      AND "rejectReason" IS NOT NULL
    GROUP BY "reasonPrefix"
    ORDER BY "count" DESC
    LIMIT 50
  `);
}

/**
 * Воронка рішень із signal_evaluations — де саме гинуть сигнали.
 *
 * На відміну від signalRejectionStats дає ще й ринковий контекст відмови:
 * який був R:R, чи була ціна в зоні, який стоп планувався.
 */
export async function evaluationFunnel() {
  return select(`
    SELECT
      "source",
      "decision",
      COUNT(*)                          AS "count",
      ROUND(AVG("weightedRR"), 2)       AS "avgWeightedRR",
      ROUND(AVG("slDistancePct"), 2)    AS "avgSlDistancePct",
      SUM(CASE WHEN "inZone" = 1 THEN 1 ELSE 0 END) AS "inZoneCount"
    FROM "signal_evaluations"
    GROUP BY "source", "decision"
    ORDER BY "source" ASC, "count" DESC
  `);
}

/**
 * Найчастіші причини відмови з контекстом — що саме відсіює фільтри.
 */
export async function rejectionReasons() {
  return select(`
    SELECT
      SUBSTR("reason", 1, 40)        AS "reasonPrefix",
      COUNT(*)                       AS "count",
      ROUND(AVG("weightedRR"), 2)    AS "avgWeightedRR",
      ROUND(AVG("slDistancePct"), 2) AS "avgSlDistancePct"
    FROM "signal_evaluations"
    WHERE "decision" = 'REJECTED' AND "reason" IS NOT NULL
    GROUP BY "reasonPrefix"
    ORDER BY "count" DESC
    LIMIT 50
  `);
}

// ─── Equity ───────────────────────────────────────────────────────────────────

/**
 * Кумулятивний PnL по часу — готове до побудови графіка.
 */
export async function equityCurve() {
  return select(`
    SELECT
      "closedAt"                                        AS "ts",
      "profitUsdt",
      SUM("profitUsdt") OVER (ORDER BY "closedAt")      AS "cumulativePnl",
      "symbol",
      "closeReason"
    FROM "trades"
    WHERE "status" = 'CLOSED'
      AND "profitUsdt" IS NOT NULL
    ORDER BY "closedAt" ASC
  `);
}
