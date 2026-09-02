import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGeometry,
  verifyNumbersInSource,
  validateSignal,
} from '../src/core/signalGeometry.js';

const LONG = {
  symbol: 'ENAUSDT',
  side: 'LONG',
  entryLow: 0.09110,
  entryHigh: 0.09656,
  slPrice: 0.09001,
  tpPrices: [0.09772, 0.09888, 0.10004, 0.10351],
};

const SHORT = {
  symbol: 'CLUSDT',
  side: 'SHORT',
  entryLow: 83.02,
  entryHigh: 85.74,
  slPrice: 86.34,
  tpPrices: [82.44, 81.86, 81.28, 79.53],
};

test('accepts well-formed LONG and SHORT signals', () => {
  assert.equal(validateGeometry(LONG).valid, true);
  assert.equal(validateGeometry(SHORT).valid, true);
});

test('rejects the inverted entry zone that the old parser produced', () => {
  // Парсер призначав перше число як entryHigh, тож для "0.09110-0.09656"
  // виходило entryLow > entryHigh. Саме цей стан робив inZone недосяжним.
  const result = validateGeometry({ ...LONG, entryLow: 0.09656, entryHigh: 0.09110 });

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(e => e.includes('entry zone inverted')),
    `expected inversion error, got: ${result.errors.join(' | ')}`,
  );
});

test('rejects a side that contradicts the numbers', () => {
  // Ті самі рівні, але оголошені як SHORT: SL нижче зони, TP іще нижче.
  const result = validateGeometry({ ...LONG, side: 'SHORT' });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('SHORT requires SL above entry zone')));
});

test('rejects swapped SL and TP', () => {
  const result = validateGeometry({
    ...LONG,
    slPrice: 0.09772,
    tpPrices: [0.09001, 0.09888, 0.10004, 0.10351],
  });

  assert.equal(result.valid, false);
});

test('rejects non-monotonic take-profit levels', () => {
  const result = validateGeometry({ ...LONG, tpPrices: [0.09772, 0.09700, 0.10004] });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('not monotonic')));
});

test('rejects an entry zone far too wide to be real', () => {
  const result = validateGeometry({ ...LONG, entryLow: 0.05, entryHigh: 0.15 });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('entry zone too wide')));
});

test('rejects missing and malformed fields', () => {
  assert.equal(validateGeometry({ ...LONG, tpPrices: [] }).valid, false);
  assert.equal(validateGeometry({ ...LONG, slPrice: 0 }).valid, false);
  assert.equal(validateGeometry({ ...LONG, slPrice: NaN }).valid, false);
  assert.equal(validateGeometry({ ...LONG, side: 'BUY' }).valid, false);
  assert.equal(validateGeometry(null).valid, false);
});

// ─── Шар 2: числа мусять походити з тексту ───────────────────────────────────

const RAW = [
  '📩 #ENAUSDT 1h | Mid-Term',
  '📈 Long Entry Zone: 0.09110-0.09656',
  'Target 1: 0.09772',
  'Target 2: 0.09888',
  'Target 3: 0.10004',
  'Target 4: 0.10351',
  '🔺 Stop-Loss: 0.09001',
].join('\n');

test('accepts numbers that appear verbatim in the source message', () => {
  assert.equal(verifyNumbersInSource(LONG, RAW).valid, true);
});

test('catches a fabricated price that is not in the source', () => {
  // Правдоподібне, монотонне, геометрично бездоганне — але вигадане.
  const tampered = { ...LONG, tpPrices: [0.09772, 0.09888, 0.10004, 0.10999] };
  const result = verifyNumbersInSource(tampered, RAW);

  assert.equal(result.valid, false);
  assert.ok(result.errors[0].includes('0.10999'));
});

test('geometry still catches a decimal shift, via the distance bound', () => {
  // 0.10351 -> 1.0351 лишає рівні монотонними, але виносить останній TP
  // на +1000% від зони — це ловить уже перший шар.
  const shifted = { ...LONG, tpPrices: [0.09772, 0.09888, 0.10004, 1.0351] };

  const result = validateGeometry(shifted);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('unrealistically far')));
});

test('catches a transposition that geometry cannot see', () => {
  // 0.10351 -> 0.10531: монотонно, правильний бік, правдоподібна відстань.
  // Перший шар не має підстав заперечити — ловить лише звірка з джерелом.
  const transposed = { ...LONG, tpPrices: [0.09772, 0.09888, 0.10004, 0.10531] };

  assert.equal(validateGeometry(transposed).valid, true);
  assert.equal(verifyNumbersInSource(transposed, RAW).valid, false);
});

test('tolerates trailing-zero and thousands-separator formatting', () => {
  const raw = 'Entry Zone: 4,220.80-4,362.39\nTarget 1: 4,430.44\nStop-Loss: 4,168.12';
  const signal = {
    symbol: 'XAUUSDT', side: 'LONG',
    entryLow: 4220.8, entryHigh: 4362.39,
    slPrice: 4168.12, tpPrices: [4430.44],
  };

  assert.equal(verifyNumbersInSource(signal, raw).valid, true);
});

test('validateSignal runs source verification only when asked', () => {
  const tampered = { ...LONG, tpPrices: [0.09772, 0.09888, 0.10004, 0.10999], rawText: RAW };

  assert.equal(validateSignal(tampered).valid, true);
  assert.equal(validateSignal(tampered, { verifySource: true }).valid, false);
});
