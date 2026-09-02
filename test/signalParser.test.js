import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignal } from '../src/parser/signalParser.js';

/** Реальний формат каналу GGShøt: зона записана як LOW - HIGH. */
const ggshot = [
  '\u{1F4E9}',
  '#CLUSDT 30m | Mid-Term',
  '\u{1F4C9} Short Entry Zone: 83.02-85.74',
  '\u{1F3AF} Strategy Accuracy: 94%',
  'Target 1: 82.44',
  'Target 2: 81.86',
  'Target 3: 81.28',
  'Target 4: 79.53',
  '\u{1F53A} Stop-Loss: 86.34',
  '\u{1F50E} Signal ID: #ID6466009960',
].join('\n');

/** Старіший формат того ж каналу: зона записана як HIGH - LOW. */
const legacy = [
  '\u{1F4E9}',
  '#BTCUSDT 1h',
  '\u{1F4C8} Long',
  'Entry Zone: 68000 - 67000',
  'Target 1: 70000',
  'Target 2: 72000',
  'Stop-Loss: 65000',
  'Strategy Accuracy: 88.5%',
  '#ID12345',
].join('\n');

test('reads the entry zone by value, not by position in the line', () => {
  // Це головна регресія: раніше перше число завжди ставало entryHigh, тому
  // для формату LOW-HIGH виходило entryLow > entryHigh і сигнал ніколи не
  // міг вважатися "в зоні".
  const low  = parseSignal(ggshot);
  const high = parseSignal(legacy);

  assert.equal(low.entryLow, 83.02);
  assert.equal(low.entryHigh, 85.74);
  assert.ok(low.entryLow < low.entryHigh);

  assert.equal(high.entryLow, 67000);
  assert.equal(high.entryHigh, 68000);
  assert.ok(high.entryLow < high.entryHigh);
});

test('parses the full GGShot short signal', () => {
  const s = parseSignal(ggshot);

  assert.equal(s.type, 'SIGNAL');
  assert.equal(s.symbol, 'CLUSDT');
  assert.equal(s.side, 'SHORT');
  assert.equal(s.timeframe, '30m');
  assert.equal(s.entryMid, 84.38);
  assert.deepEqual(s.tpPrices, [82.44, 81.86, 81.28, 79.53]);
  assert.equal(s.slPrice, 86.34);
  assert.equal(s.accuracy, 94);
  assert.equal(s.signalId, '6466009960');
  assert.equal(s.rawText, ggshot);
});

test('parses a sent or forwarded legacy signal and preserves raw text', () => {
  const s = parseSignal(legacy);

  assert.equal(s.type, 'SIGNAL');
  assert.equal(s.symbol, 'BTCUSDT');
  assert.equal(s.side, 'LONG');
  assert.equal(s.entryMid, 67500);
  assert.deepEqual(s.tpPrices, [70000, 72000]);
  assert.equal(s.rawText, legacy);
});

test('normalizes bare-number timeframes to Binance intervals', () => {
  // Канал пише і "30m", і просто "30". Друге не є валідним інтервалом Binance
  // і зламало б запит свічок для ATR.
  const bare = parseSignal(ggshot.replace('#CLUSDT 30m', '#CLUSDT 30'));
  assert.equal(bare.timeframe, '30m');

  const hourly = parseSignal(ggshot.replace('#CLUSDT 30m', '#CLUSDT 1h'));
  assert.equal(hourly.timeframe, '1h');

  // Невпізнане краще віддати як null — викликач підставить безпечний дефолт,
  // ніж передати на біржу сміття.
  const junk = parseSignal(ggshot.replace('#CLUSDT 30m', '#CLUSDT Mid'));
  assert.equal(junk.timeframe, null);
});

test('rejects signal-like text with missing required fields', () => {
  assert.equal(parseSignal('#BTCUSDT\nEntry Zone: 68000 - 67000'), null);
});
