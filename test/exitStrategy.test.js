import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateATR,
  calculateTrailingStop,
  classifyMomentum,
  allocateTpQuantities,
  expectedRemainingAfterTp,
  intervalToMs,
  isPositionTimedOut,
  normalizedTpShares,
  roundTrailingStop,
  updateReversalState,
} from '../src/core/exitStrategy.js';

test('TP distribution is 40/40/20 and normalizes incomplete signals', () => {
  // TP4 має нульову частку: на перевіреній вибірці він не спрацював жодного
  // разу, тоді як TP2 бере половину сигналів.
  assert.deepEqual(normalizedTpShares(4), [0.40, 0.40, 0.20, 0]);
  assert.ok(Math.abs(expectedRemainingAfterTp(2, 100) - 20) < 1e-12);

  // Сигнал із двома цілями: частки нормалізуються на наявні рівні.
  assert.ok(Math.abs(normalizedTpShares(2)[0] - 0.5) < 1e-12);

  assert.deepEqual(allocateTpQuantities(1, 3, 4), [0.40, 0.40, 0.20, 0]);
  assert.equal(allocateTpQuantities(0.007, 3, 4).reduce((sum, qty) => sum + qty, 0), 0.007);
  assert.deepEqual(
    allocateTpQuantities(0.55, 3, 3, [0.35, 0.15, 0.05]),
    [0.35, 0.15, 0.05],
  );
});

test('a zero-share level never receives the rounding remainder', () => {
  // Регресія: залишок від округлення діставався останньому елементу масиву.
  // З часткою 0 на TP4 це виставляло б на біржі зайвий мікроордер.
  const precision = 3;
  const step = 10 ** -precision;

  for (const qty of [0.007, 1, 0.33333, 12.5]) {
    const allocated = allocateTpQuantities(qty, precision, 4);
    assert.equal(allocated[3], 0, `TP4 must stay empty for quantity ${qty}`);

    // Сума збігається з кількістю в межах одного кроку точності — точніше
    // біржа все одно не приймає.
    const total = allocated.reduce((sum, q) => sum + q, 0);
    assert.ok(
      Math.abs(total - qty) < step,
      `funded levels must sum to ${qty} within one step, got ${total}`,
    );
  }
});

test('reversal exit requires two distinct weak closed candles', () => {
  const first = updateReversalState({
    assessment: { status: 'weak', candleTime: 1 },
  });
  assert.equal(first.shouldExit, false);

  const duplicate = updateReversalState({
    previousCandleTime: first.candleTime,
    weakCount: first.weakCount,
    assessment: { status: 'weak', candleTime: 1 },
  });
  assert.equal(duplicate.weakCount, 1);

  const second = updateReversalState({
    previousCandleTime: duplicate.candleTime,
    weakCount: duplicate.weakCount,
    assessment: { status: 'weak', candleTime: 2 },
  });
  assert.equal(second.shouldExit, true);
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
