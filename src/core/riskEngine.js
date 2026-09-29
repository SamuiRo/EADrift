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
import { CAPITAL_CAP_USDT, MAX_OPEN_POSITIONS } from '../config/app.config.js';

// ─── Конфіг ───────────────────────────────────────────────────────────────────

export const RISK_CONFIG = {
  // ── Капітал ───────────────────────────────────────────────────────────────
  // Усі розрахунки йдуть від min(баланс, capitalCapUsdt): зайві кошти на
  // рахунку не збільшують ні ризик, ні розмір позиції.
  capitalCapUsdt:   CAPITAL_CAP_USDT,
  // Капітал ділиться на стільки маржинальних слотів. Плече підбирається так,
  // щоб маржа однієї позиції вкладалася в свій слот — інакше дві-три угоди з
  // тісним стопом при плечі 1x з'їли б увесь рахунок.
  maxOpenPositions: MAX_OPEN_POSITIONS,
  // Ліквідація має бути далеко за стопом: відстань до неї ≥ SL × цей множник.
  liqBufferMultiple:     2,
  maintenanceMarginPct:  0.005, // консервативна оцінка для USD-M, 0.5%

  riskPct:          0.0075,  // 0.75% капіталу на угоду
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

  // ── Власний SL ────────────────────────────────────────────────────────────
  // SL провайдера відкалібровано під вхід по середині зони набору. При вході
  // біля верхнього краю успадкування цього SL означає ризикувати 1R заради
  // ~0.2R. Тому стоп рахуємо самі: відштовхуємось від відстані до TP1, але
  // ніколи не тісніше за ATR-підлогу, інакше стоп збиває звичайний шум.
  targetRR:          1.0,    // цільовий R:R до TP1 від фактичного входу
  atrStopMultiplier: 0.75,   // мінімальна відстань SL у ATR таймфрейму сигналу

  // ── Поріг якості угоди ────────────────────────────────────────────────────
  // Міряти R:R до TP1 не має сенсу: провайдери ставлять TP1 приблизно на 1R.
  // Оцінюємо зважений R:R по фактичному розподілу часток між TP-рівнями.
  minWeightedRR:     1.2,
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
export async function calculatePosition({ balance, entryPrice, slPrice, symbol, config = {}, symbolInfo = null }) {
  const cfg = { ...RISK_CONFIG, ...config };

  // symbolInfo можна підставити ззовні — це робить розрахунок тестованим
  // без мережі й дозволяє перевикористати вже отримані дані символу.
  const info          = symbolInfo ?? await getSymbolInfo(symbol);
  const delta         = Math.abs(entryPrice - slPrice) / entryPrice;

  // Капітал — менше з двох: фактичний баланс або встановлена межа.
  const capital       = Math.min(balance, cfg.capitalCapUsdt ?? Infinity);
  const marginBudget  = capital / Math.max(1, cfg.maxOpenPositions ?? 1);
  const targetRiskUsd = capital * cfg.riskPct;

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
  // Розмір визначає ризик і тільки ризик. Плече на нього не впливає — воно
  // лише вирішує, скільки маржі позиція заблокує.
  let positionUsdt  = targetRiskUsd / delta;

  // ── Плече від маржинального слота ─────────────────────────────────────────
  // Плече підбираємо так, щоб маржа позиції вклалась у свою частку капіталу.
  // Раніше воно рахувалось від усього балансу, і при тісному стопі одна угода
  // з плечем 1x могла заблокувати половину рахунку.
  let rawLeverage   = positionUsdt / marginBudget;

  // ── Hard cap плеча (f6) ───────────────────────────────────────────────────
  // Тут межа справді обмежує розмір: більшу позицію слот не потягне.
  let leverageCapped = false;
  if (rawLeverage > cfg.maxLeverage) {
    rawLeverage    = cfg.maxLeverage;
    positionUsdt   = marginBudget * cfg.maxLeverage;
    leverageCapped = true;
  }

  // Нижня межа розміру НЕ обмежує. Розрахункове плече менше 1x означає лише,
  // що маржинальне плече не потрібне. Підтягувати позицію до слота не можна:
  // це підмінило б розмір, порахований від ризику.
  let leverage = Math.max(cfg.minLeverage, Math.ceil(rawLeverage)); // Binance вимагає integer

  // ── Min order (f8) ────────────────────────────────────────────────────────
  let minOrderAdjusted = false;
  if (positionUsdt < info.minNotional) {
    positionUsdt      = info.minNotional;
    leverage          = Math.max(cfg.minLeverage, Math.ceil(positionUsdt / marginBudget));
    minOrderAdjusted  = true;
  }

  // ── Запас до ліквідації ───────────────────────────────────────────────────
  // В ISOLATED ліквідація настає приблизно на 1/плече мінус підтримувальна
  // маржа. Стоп мусить спрацювати задовго до неї, інакше прослизання або
  // гепа вистачить, щоб позицію ліквідували повз SL.
  const liqDistance = 1 / leverage - cfg.maintenanceMarginPct;
  if (liqDistance < delta * cfg.liqBufferMultiple) {
    return reject({ delta, targetRiskUsd, info },
      `Ліквідація надто близько до SL: ${pct(liqDistance)} при плечі ${leverage}x, ` +
      `потрібно ≥ ${pct(delta * cfg.liqBufferMultiple)}`);
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

  const marginUsdt = positionUsdt / leverage;

  logger.info('Position calculated', {
    symbol, delta: pct(delta), positionUsdt: positionUsdt.toFixed(2),
    quantity, leverage, marginUsdt: marginUsdt.toFixed(2),
    realRiskUsdt: realRiskUsdt.toFixed(2),
    targetRiskUsd: targetRiskUsd.toFixed(2), capital: capital.toFixed(2), status,
  });

  return {
    quantity, positionUsdt, leverage, marginUsdt, capital,
    realRiskUsdt, targetRiskUsdt: targetRiskUsd, delta, status, reason,
  };
}

// ─── Market entry validation ──────────────────────────────────────────────────

/**
 * Перевірити чи сигнал ще валідний для market-входу.
 *
 * Умови валідності:
 *   1. SL ще не порушений
 *   2. TP1 ще не досягнуто (залишився потенціал)
 *   3. Ціна не пішла далі ніж maxSlippagePct від межі зони входу
 *
 * Поріг R:R тут навмисно відсутній: рішення про якість угоди приймає
 * planEntry() за зваженим R:R, порахованим від власного стопа.
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

  // ── 4. R:R від поточної ціни (довідково) ──────────────────────────────────
  // Порогом більше не є: провайдери ставлять TP1 приблизно на 1R від середини
  // зони, тому фільтр по цій величині відхиляв би геть усе. Рішення про якість
  // угоди приймає planEntry() за зваженим R:R і власним SL.
  const distToSL  = Math.abs(currentPrice - slPrice);
  const distToTP1 = Math.abs(tp1Price - currentPrice);
  const rrFromCurrent = distToSL > 0 ? distToTP1 / distToSL : 0;

  return { valid: true, inZone, slipped: !inZone, slippagePct, rrFromCurrent, reason: null };
}

// ─── План входу: власний SL і зважений R:R ────────────────────────────────────

/**
 * Порахувати власний stop-loss і оцінити якість угоди від фактичної ціни входу.
 *
 * SL провайдера відкалібровано під вхід по середині зони набору. Якщо ціна вже
 * пішла і ми входимо біля краю зони, успадкований SL дає катастрофічну асиметрію:
 * ризик 1R заради 0.2R. Тому відстань стопа рахуємо так:
 *
 *   needed   = |TP1 − entry| / targetRR      скільки дозволено ризикувати
 *   distance = min(needed, відстань провайдера)   ширше за провайдера не йдемо
 *   floor    = atrStopMultiplier × ATR       нижче — стоп збиває шум
 *
 * Якщо distance < floor, угода неможлива в межах цих обмежень — пропускаємо.
 *
 * @param {object} params
 * @param {number}   params.entryPrice   фактична ціна входу
 * @param {string}   params.side         'BUY' | 'SELL' | 'LONG' | 'SHORT'
 * @param {number[]} params.tpPrices     рівні take-profit
 * @param {number}   params.providerSl   SL із сигналу
 * @param {number}   params.atr          ATR таймфрейму сигналу, в ціні
 * @param {number[]} params.tpShares     частки позиції по рівнях (сума 1)
 * @param {object}   [params.config]     override RISK_CONFIG
 *
 * @returns {{
 *   ok: boolean, slPrice?: number, slDistance?: number, slSource?: string,
 *   rr?: number[], weightedRR?: number, reason?: string,
 * }}
 */
export function planEntry({ entryPrice, side, tpPrices, providerSl, atr, tpShares, config = {} }) {
  const cfg    = { ...RISK_CONFIG, ...config };
  const isLong = side === 'BUY' || side === 'LONG';

  if (!tpPrices?.length)              return fail('No take-profit levels');
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return fail('Invalid entry price');

  const tp1 = tpPrices[0];
  const rewardToTp1 = isLong ? tp1 - entryPrice : entryPrice - tp1;
  if (rewardToTp1 <= 0) return fail(`TP1 ${tp1} is already behind entry ${entryPrice}`);

  const providerDistance = Math.abs(entryPrice - providerSl);
  const needed  = rewardToTp1 / cfg.targetRR;
  const distance = Math.min(needed, providerDistance);

  if (Number.isFinite(atr) && atr > 0) {
    const floor = cfg.atrStopMultiplier * atr;
    if (distance < floor) {
      return fail(
        `SL would sit inside noise: ${pct(distance / entryPrice)} available, ` +
        `${pct(floor / entryPrice)} needed for ${cfg.atrStopMultiplier}×ATR`
      );
    }
  }

  const slPrice = isLong ? entryPrice - distance : entryPrice + distance;
  if (slPrice <= 0) return fail('Computed SL is not a positive price');

  const rr = tpPrices.map(tp => Math.abs(tp - entryPrice) / distance);

  // Зважений R:R по фактичному розподілу часток. Частки коротші за масив TP
  // (або навпаки) нормалізуємо на перетині — оцінюємо тільки те, що реально виконуватиметься.
  const shares = tpShares?.length ? tpShares : rr.map(() => 1 / rr.length);
  const usable = Math.min(shares.length, rr.length);
  const shareSum = shares.slice(0, usable).reduce((sum, s) => sum + s, 0);
  const weightedRR = shareSum > 0
    ? shares.slice(0, usable).reduce((sum, s, i) => sum + s * rr[i], 0) / shareSum
    : 0;

  if (weightedRR < cfg.minWeightedRR) {
    return fail(
      `Weighted R:R ${weightedRR.toFixed(2)} < min ${cfg.minWeightedRR} ` +
      `(TP1 ${rr[0].toFixed(2)}R)`
    );
  }

  return {
    ok:         true,
    slPrice,
    slDistance: distance,
    slSource:   distance < providerDistance ? 'own' : 'provider',
    rr,
    weightedRR,
  };

  function fail(reason) { return { ok: false, reason }; }
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