import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignal } from '../src/parser/signalParser.js';

const signalText = [
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

test('parses a sent or forwarded signal and preserves raw text', () => {
  const signal = parseSignal(signalText);

  assert.equal(signal.type, 'SIGNAL');
  assert.equal(signal.symbol, 'BTCUSDT');
  assert.equal(signal.side, 'LONG');
  assert.equal(signal.entryMid, 67500);
  assert.deepEqual(signal.tpPrices, [70000, 72000]);
  assert.equal(signal.rawText, signalText);
});

test('rejects signal-like text with missing required fields', () => {
  assert.equal(parseSignal('#BTCUSDT\nEntry Zone: 68000 - 67000'), null);
});
