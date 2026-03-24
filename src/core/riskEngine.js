/**
 * riskEngine.js
 *
 * Розрахунок розміру позиції та плеча від ризику і SL.
 * Логіка повністю з leverage.txt — плече є похідною від ризику, не окремим параметром.
 *
 * Також містить:
 *  - validateMarketEntry() — перевірка чи сигнал валідний для market-входу
 *  - calcFromBalance()     — зручна обгортка з автоотриманням балансу
 *  - applyLeverage()       — встановити плече на біржі
 */

import { getAccountBalance, getSymbolInfo, setLeverage, setMarginType } from '../exchanges/binance.js';
import { logger } from '../shared/logger.js';

// ─── Конфіг ───────────────────────────────────────────────────────────────────

export const RISK_CONFIG = {
  riskPct:          0.0075,  // 0.75% балансу на угоду
  maxLeverage:      10,      // hard cap плеча
  minLeverage:      1,       // мінімум (spot-like)
  maxRiskMultiple:  1.2,     // реальний ризик не може перевищувати target × 1.2
  skipRiskMultiple: 1.5,     // якщо перевищує × 1.5 → REJECT
  minDeltaPct:      0.002,   // 0.2% — мінімальна відстань до SL (нижче = шум)
//   maxDeltaPct:      0.04,    // 4.0% — максимальна відстань до SL (вище = занадто широкий)
  maxDeltaPct:      0.055,    // 4.0% — максимальна відстань до SL (вище = занадто широкий)
  marginType:       'ISOLATED',

  // Market-entry налаштування
  maxSlippagePct:   0.02,    // 2% — максимальний вихід ціни за зону входу
  minRR:            1.5,     // мінімальний R:R для market-входу (до TP1)
};

// ─── Статуси валідації ────────────────────────────────────────────────────────

export const VALIDATION = {
  OK:      'OK',       // все добре → можна виконувати автоматично
  CONFIRM: 'CONFIRM',  // щось поза нормою → потрібне підтвердження
  REJECT:  'REJECT',   // критичне → не торгувати
};

// ─── Core: розрахунок позиції ─────────────────────────────────────────────────

/**
 * Розрахувати розмір позиції і плече від ризику.
 *
 * @param {object} params
 * @param {number} params.balance      USDT баланс (total)
 * @param {number} params.entryPrice   ціна для розрахунку (поточна або зона)
 * @param {number} params.slPrice
 * @param {string} params.symbol
 * @param {object} [params.config]     override RISK_CONFIG
 *
 * @returns {Promise<RiskResult>}
 */
export async function calculatePosition({ balance, entryPrice, slPrice, symbol, config = {} }) {
  const cfg = { ...RISK_CONFIG, ...config };

  const info          = await getSymbolInfo(symbol);
  const delta         = Math.abs(entryPrice - slPrice) / entryPrice;
  const targetRiskUsd = balance * cfg.riskPct;

  // ── Фільтр по ширині SL ───────────────────────────────────────────────────
  if (delta < cfg.minDeltaPct) {
    return reject({ delta, targetRiskUsd, info },
      `SL занадто вузький: ${pct(delta)} < мін. ${pct(cfg.minDeltaPct)}`);
  }
  if (delta > cfg.maxDeltaPct) {
    return reject({ delta, targetRiskUsd, info },
      `SL занадто широкий: ${pct(delta)} > макс. ${pct(cfg.maxDeltaPct)}`);
  }

  // ── Розмір позиції (leverage.txt f3) ──────────────────────────────────────
  let positionUsdt = targetRiskUsd / delta;
  let leverage     = positionUsdt / balance;

  // ── Hard cap плеча (f6) ───────────────────────────────────────────────────
  let leverageCapped = false;
  if (leverage > cfg.maxLeverage) {
    leverage       = cfg.maxLeverage;
    positionUsdt   = balance * leverage;
    leverageCapped = true;
  }
  if (leverage < cfg.minLeverage) {
    leverage     = cfg.minLeverage;
    positionUsdt = balance * leverage;
  }

  leverage = Math.max(1, Math.ceil(leverage)); // Binance вимагає integer

  // ── Min order (f8) ────────────────────────────────────────────────────────
  let minOrderAdjusted = false;
  if (positionUsdt < info.minNotional) {
    positionUsdt      = info.minNotional;
    leverage          = Math.max(1, Math.ceil(positionUsdt / balance));
    minOrderAdjusted  = true;
  }

  // ── Кількість в базовій монеті ────────────────────────────────────────────
  const quantity     = parseFloat((positionUsdt / entryPrice).toFixed(info.quantityPrecision));
  const realRiskUsdt = quantity * entryPrice * delta;

  // ── Фінальна перевірка ризику (f9) ───────────────────────────────────────
  if (realRiskUsdt > targetRiskUsd * cfg.skipRiskMultiple) {
    return reject({ delta, targetRiskUsd, info },
      `Реальний ризик ${realRiskUsdt.toFixed(2)} USDT > ліміт ×${cfg.skipRiskMultiple}`);
  }

  // ── Статус ────────────────────────────────────────────────────────────────
  let status = VALIDATION.OK;
  let reason = null;

  if (leverageCapped) {
    status = VALIDATION.CONFIRM;
    reason = `Плече обрізано до ${leverage}x (розрахункове > ${cfg.maxLeverage}x)`;
  } else if (minOrderAdjusted) {
    status = VALIDATION.CONFIRM;
    reason = `Позиція збільшена до мін. ордера (${info.minNotional} USDT)`;
  } else if (realRiskUsdt > targetRiskUsd * cfg.maxRiskMultiple) {
    status = VALIDATION.CONFIRM;
    reason = `Реальний ризик ${realRiskUsdt.toFixed(2)} > target ×${cfg.maxRiskMultiple}`;
  }

  logger.info('Position calculated', {
    symbol, delta: pct(delta), positionUsdt: positionUsdt.toFixed(2),
    quantity, leverage, realRiskUsdt: realRiskUsdt.toFixed(2),
    targetRiskUsd: targetRiskUsd.toFixed(2), status,
  });

  return { quantity, positionUsdt, leverage, realRiskUsdt, targetRiskUsdt: targetRiskUsd, delta, status, reason };
}

// ─── Market entry validation ──────────────────────────────────────────────────

/**
 * Перевірити чи сигнал ще валідний для market-входу.
 *
 * Умови валідності:
 *   1. SL ще не порушений
 *   2. TP1 ще не досягнуто (залишився потенціал)
 *   3. Ціна не пішла далі ніж maxSlippagePct від межі зони входу
 *   4. R:R від поточної ціни до TP1 >= minRR
 *
 * @param {object} params
 * @param {number}   params.currentPrice  поточна mark price
 * @param {number}   params.slPrice
 * @param {number}   params.tp1Price      перший TP (для R:R перевірки)
 * @param {number}   params.entryLow      нижня межа зони входу (з сигналу)
 * @param {number}   params.entryHigh     верхня межа зони входу (з сигналу)
 * @param {string}   params.side          'BUY' | 'SELL'
 * @param {object}   [params.config]      override RISK_CONFIG
 *
 * @returns {{
 *   valid:         boolean,
 *   inZone:        boolean,   ціна ще в зоні входу
 *   slipped:       boolean,   ціна вийшла з зони але ще в допуску
 *   slippagePct:   number,    % виходу за зону (0 якщо в зоні)
 *   rrFromCurrent: number,    R:R від поточної ціни до TP1
 *   reason?:       string,
 * }}
 */
export function validateMarketEntry({ currentPrice, slPrice, tp1Price, entryLow, entryHigh, side, config = {} }) {
  const cfg     = { ...RISK_CONFIG, ...config };
  const isLong  = side === 'BUY';

  // ── 1. SL не порушений ────────────────────────────────────────────────────
  const slHit = isLong ? currentPrice <= slPrice : currentPrice >= slPrice;
  if (slHit) {
    return { valid: false, inZone: false, slipped: false, slippagePct: 0, rrFromCurrent: 0,
      reason: `SL вже порушено (ціна ${currentPrice}, SL ${slPrice})` };
  }

  // ── 2. TP1 ще не досягнуто ────────────────────────────────────────────────
  const tp1Hit = isLong ? currentPrice >= tp1Price : currentPrice <= tp1Price;
  if (tp1Hit) {
    return { valid: false, inZone: false, slipped: false, slippagePct: 0, rrFromCurrent: 0,
      reason: `TP1 вже досягнуто (ціна ${currentPrice}, TP1 ${tp1Price})` };
  }

  // ── 3. Визначаємо чи в зоні і slippage ───────────────────────────────────
  const inZone = currentPrice >= entryLow && currentPrice <= entryHigh;

  let slippagePct = 0;
  if (!inZone) {
    // Для LONG: ціна вище зони (пішла вгору без нас)
    // Для SHORT: ціна нижче зони (пішла вниз без нас)
    const zoneEdge    = isLong ? entryHigh : entryLow;
    slippagePct       = Math.abs(currentPrice - zoneEdge) / zoneEdge;

    if (slippagePct > cfg.maxSlippagePct) {
      return { valid: false, inZone: false, slipped: true, slippagePct, rrFromCurrent: 0,
        reason: `Ціна пішла на ${pct(slippagePct)} від зони (макс. допуск: ${pct(cfg.maxSlippagePct)})` };
    }
  }

  // ── 4. R:R від поточної ціни ──────────────────────────────────────────────
  const distToSL  = Math.abs(currentPrice - slPrice);
  const distToTP1 = Math.abs(tp1Price - currentPrice);
  const rrFromCurrent = distToSL > 0 ? distToTP1 / distToSL : 0;

  if (rrFromCurrent < cfg.minRR) {
    return { valid: false, inZone, slipped: !inZone, slippagePct, rrFromCurrent,
      reason: `R:R від поточної ціни ${rrFromCurrent.toFixed(2)} < мін. ${cfg.minRR}` };
  }

  return { valid: true, inZone, slipped: !inZone, slippagePct, rrFromCurrent, reason: null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Зручна обгортка над calculatePosition.
 *
 * @param {number|null} [params.balance]  вже отриманий USDT-баланс (available).
 *   Якщо передано — запит до біржі не виконується.
 *   Якщо null/undefined — баланс запитується самостійно (зворотна сумісність).
 */
export async function calcFromBalance({ entryPrice, slPrice, symbol, balance = null, config = {} }) {
  let resolvedBalance = balance;

  if (resolvedBalance == null) {
    const balances = await getAccountBalance();
    const usdt     = balances.find(b => b.asset === 'USDT');
    if (!usdt) throw new Error('USDT balance not found');
    resolvedBalance = parseFloat(usdt.balance);
  }

  return calculatePosition({
    balance: resolvedBalance,
    entryPrice, slPrice, symbol, config,
  });
}

export async function applyLeverage(symbol, leverage) {
  await setMarginType(symbol, RISK_CONFIG.marginType);
  await setLeverage(symbol, leverage);
  logger.info('Leverage applied', { symbol, leverage, marginType: RISK_CONFIG.marginType });
}

function reject({ delta, targetRiskUsd }, reason) {
  return { quantity: 0, positionUsdt: 0, leverage: 1,
    realRiskUsdt: 0, targetRiskUsdt: targetRiskUsd, delta,
    status: VALIDATION.REJECT, reason };
}

function pct(n) { return (n * 100).toFixed(2) + '%'; }