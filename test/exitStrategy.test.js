import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateATR,
  calculateTrailingStop,
  classifyMomentum,
  getTpCloseFraction,
  intervalToMs,
  isPositionTimedOut,
  roundTrailingStop,
} from '../src/core/exitStrategy.js';

test('TP fractions leave a 10% runner for trailing', () => {
  let remaining = 1;
  for (const level of [1, 2, 3, 4]) {
    remaining *= 1 - getTpCloseFraction(level, 4);
  }
  assert.ok(Math.abs(remaining - 0.1) < 1e-12);
  assert.equal(getTpCloseFraction(3, 3), 0);
});

test('momentum compares the latest closed candle with prior baseline and direction', () => {
  const baseline = Array.from({ length: 5 }, () => ({
    open: 100, high: 102, low: 99, close: 101, volume: 100,
  }));
  const bullishImpulse = { open: 100, high: 108, low: 99, close: 107, volume: 180 };

  assert.equal(classifyMomentum([...baseline, bullishImpulse], 'LONG'), 'strong');
  assert.equal(classifyMomentum([...baseline, bullishImpulse], 'SHORT'), 'weak');
});

test('ATR and trailing stop use deterministic closed-candle math', () => {
  const candles = [
    { high: 10, low: 8, close: 9 },
    { high: 12, low: 9, close: 11 },
    { high: 13, low: 10, close: 12 },
  ];
  assert.equal(calculateATR(candles, 2), 3);
  assert.equal(calculateTrailingStop({ side: 'LONG', markPrice: 20, atr: 2 }), 17);
  assert.equal(calculateTrailingStop({ side: 'SHORT', markPrice: 20, atr: 2 }), 23);
  assert.ok(Math.abs(roundTrailingStop({ side: 'LONG', price: 17.09, tickSize: 0.1 }) - 17) < 1e-12);
  assert.ok(Math.abs(roundTrailingStop({ side: 'SHORT', price: 22.01, tickSize: 0.1 }) - 22.1) < 1e-12);
});

test('timeout follows signal timeframe instead of polling ticks', () => {
  assert.equal(intervalToMs('1h'), 3_600_000);
  assert.equal(isPositionTimedOut({
    entryTime: 0,
    timeoutCandles: 12,
    interval: '1h',
    now: 11 * 3_600_000,
  }), false);
  assert.equal(isPositionTimedOut({
    entryTime: 0,
    timeoutCandles: 12,
    interval: '1h',
    now: 12 * 3_600_000,
  }), true);
});
