import test from 'node:test';
import assert from 'node:assert/strict';
import { planEntry, RISK_CONFIG } from '../src/core/riskEngine.js';
import { normalizedTpShares } from '../src/core/exitStrategy.js';

// Реальний сигнал ENAUSDT: зона 0.09110–0.09656, SL 0.09001, TP1 0.09772.
const ENA = {
  side: 'BUY',
  tpPrices: [0.09772, 0.09888, 0.10004, 0.10351],
  providerSl: 0.09001,
};
const shares = normalizedTpShares(4);

test('own stop is far tighter than the provider stop on a late entry', () => {
  // Вхід біля верхнього краю зони — саме той випадок, де успадкований SL
  // означає ризикувати повною шириною зони заради кількох відсотків до TP1.
  const entry = 0.09656;
  const plan = planEntry({ ...ENA, entryPrice: entry, atr: 0.0005, tpShares: shares });

  assert.equal(plan.ok, true);
  assert.equal(plan.slSource, 'own');

  const providerDist = entry - ENA.providerSl;
  assert.ok(plan.slDistance < providerDist, 'own stop must be tighter');
  assert.ok(plan.slPrice > ENA.providerSl, 'own stop sits above the provider stop for a long');

  // targetRR = 1.0 означає, що TP1 має опинитись рівно на 1R.
  assert.ok(Math.abs(plan.rr[0] - RISK_CONFIG.targetRR) < 1e-9);
});

test('never widens beyond the provider stop', () => {
  // Вхід біля нижнього краю: до TP1 далеко, тож "потрібна" відстань більша за
  // ту, що дає провайдер. Ризикувати більше за сигнал підстав немає.
  const entry = 0.09110;
  const plan = planEntry({ ...ENA, entryPrice: entry, atr: 0.0002, tpShares: shares });

  assert.equal(plan.ok, true);
  assert.equal(plan.slSource, 'provider');
  assert.equal(plan.slPrice, ENA.providerSl);
});

test('skips the signal when the stop would sit inside the noise', () => {
  // ATR великий відносно відстані до TP1 — тісний стоп збиватиме шум,
  // а ширший не дає потрібного R:R. Такий сигнал треба пропускати, не торгувати.
  const plan = planEntry({ ...ENA, entryPrice: 0.09656, atr: 0.01, tpShares: shares });

  assert.equal(plan.ok, false);
  assert.match(plan.reason, /noise/);
});

test('rejects on weighted R:R, not on R:R to TP1', () => {
  // Ключова зміна політики: TP1 у цього провайдера завжди ≈1R, тому поріг
  // до TP1 відхиляв би все. Рішення приймає зважений R:R.
  const plan = planEntry({ ...ENA, entryPrice: 0.09656, atr: 0.0005, tpShares: shares });

  assert.equal(plan.ok, true);
  assert.ok(plan.rr[0] < 1.5, 'R:R to TP1 stays near 1 by construction');
  assert.ok(plan.weightedRR >= RISK_CONFIG.minWeightedRR);

  // А ось сигнал, у якого всі цілі тиснуться до TP1, зваженого порогу не бере.
  const flat = planEntry({
    side: 'BUY', entryPrice: 0.09656, providerSl: 0.09001,
    tpPrices: [0.09772, 0.09780, 0.09788, 0.09796],
    atr: 0.0005, tpShares: shares,
  });
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /Weighted R:R/);
});

test('mirrors correctly for shorts', () => {
  const plan = planEntry({
    side: 'SELL', entryPrice: 83.02, providerSl: 86.34,
    tpPrices: [82.44, 81.86, 81.28, 79.53],
    atr: 0.15, tpShares: shares,
  });

  assert.equal(plan.ok, true);
  assert.ok(plan.slPrice > 83.02, 'short stop sits above entry');
  assert.ok(plan.slPrice < 86.34, 'and below the provider stop');
});

test('refuses an entry already past TP1', () => {
  const plan = planEntry({ ...ENA, entryPrice: 0.09800, atr: 0.0005, tpShares: shares });

  assert.equal(plan.ok, false);
  assert.match(plan.reason, /behind entry/);
});

test('works without ATR, skipping only the noise floor', () => {
  const plan = planEntry({ ...ENA, entryPrice: 0.09656, atr: null, tpShares: shares });

  assert.equal(plan.ok, true);
  assert.ok(plan.slDistance > 0);
});

// ─── Розмір позиції ───────────────────────────────────────────────────────────

import { calculatePosition, VALIDATION } from '../src/core/riskEngine.js';

const INFO = { symbol: 'BNBUSDT', pricePrecision: 2, quantityPrecision: 2, tickSize: 0.01, stepSize: 0.01, minNotional: 5 };

test('leverage below 1x does not inflate the position to the full balance', async () => {
  // Регресія. Раніше гілка minLeverage підміняла positionUsdt на весь депозит,
  // тому реальний ризик злітав у рази вище цільового і risk engine відхиляв
  // будь-який сигнал з SL ширшим за ~1.1% — тобто практично всі.
  const balance = 193;
  const result = await calculatePosition({
    balance, entryPrice: 593.83, slPrice: 582.28, symbol: 'BNBUSDT', symbolInfo: INFO,
  });

  const targetRisk = balance * RISK_CONFIG.riskPct;

  assert.notEqual(result.status, VALIDATION.REJECT);
  assert.ok(result.positionUsdt < balance, 'position must stay smaller than the account');
  assert.equal(result.leverage, 1, 'sub-1x demand is satisfied by 1x leverage');
  assert.ok(
    Math.abs(result.realRiskUsdt - targetRisk) / targetRisk < 0.15,
    `real risk ${result.realRiskUsdt.toFixed(2)} should track target ${targetRisk.toFixed(2)}`,
  );
});

test('upper leverage cap still limits size when it can bind', async () => {
  // Плече не залежить від депозиту: leverage = riskPct / delta. За поточного
  // конфігу (riskPct 0.75%, minDeltaPct 0.2%) стеля — 3.75x, тож maxLeverage 10
  // недосяжний і межа лишається бездіяльною. Щоб перевірити саме обрізання,
  // піднімаємо ризик до рівня, на якому воно справді настає.
  const result = await calculatePosition({
    balance: 193, entryPrice: 593.83, slPrice: 592.0, symbol: 'BNBUSDT', symbolInfo: INFO,
    config: { riskPct: 0.05 },
  });

  assert.equal(result.leverage, RISK_CONFIG.maxLeverage);
  assert.equal(result.status, VALIDATION.CONFIRM);
  assert.match(result.reason, /Плече обрізано/);
});

test('leverage ceiling is a function of riskPct and minDeltaPct alone', async () => {
  // Документує наслідок формули: за однакового riskPct глибина SL повністю
  // визначає плече, а депозит на нього не впливає. Корисно памʼятати при
  // будь-якій зміні riskPct — стеля плеча зміниться разом із ним.
  const wide = await calculatePosition({
    balance: 5000, entryPrice: 593.83, slPrice: 582.28, symbol: 'BNBUSDT', symbolInfo: INFO,
  });
  const small = await calculatePosition({
    balance: 193, entryPrice: 593.83, slPrice: 582.28, symbol: 'BNBUSDT', symbolInfo: INFO,
  });

  assert.equal(wide.leverage, small.leverage);
});

test('rejects a stop-loss wider than the configured band', async () => {
  const result = await calculatePosition({
    balance: 193, entryPrice: 593.83, slPrice: 500, symbol: 'BNBUSDT', symbolInfo: INFO,
  });

  assert.equal(result.status, VALIDATION.REJECT);
});
