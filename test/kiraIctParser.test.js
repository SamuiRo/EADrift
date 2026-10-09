import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKiraSignal, parseLocaleNumber } from '../src/parser/kiraIctParser.js';
import { validateGeometry, verifyNumbersInSource } from '../src/core/signalGeometry.js';

// Структура постів каналу «Kíra | ICT». Числа модельні.

const LONG_WITH_THOUSANDS = [
  'Дам позицию утреннюю, рискнем 💊',
  '',
  'BTCUSDT ',
  'LONG ⬆️',
  'Плечо 100х ',
  '',
  'Вход: 81,500 – 82,300',
  'TP1: 83,000',
  'TP2: 84,200',
  'TP3: 85,500',
  'SL: 79,800',
].join('\n');

const LONG_DECIMALS = [
  'CTSIUSDT',
  'LONG ⬆️',
  'Рм - не больше 1%',
  '',
  'Вход 0.0325 - 0.0340',
  'TP1 0.0415',
  'TP2 0.0450',
  'Стоп 0.0300',
].join('\n');

test('parses a full signal with thousands separators', () => {
  const s = parseKiraSignal(LONG_WITH_THOUSANDS);

  assert.equal(s.symbol, 'BTCUSDT');
  assert.equal(s.side, 'LONG');
  assert.equal(s.entryLow, 81500);
  assert.equal(s.entryHigh, 82300);
  assert.deepEqual(s.tpPrices, [83000, 84200, 85500]);
  assert.equal(s.slPrice, 79800);
  assert.equal(s.timeframe, null);
  assert.equal(validateGeometry(s).valid, true);
  assert.equal(verifyNumbersInSource(s, s.rawText).valid, true);
});

test('parses a full signal with decimals and the Russian stop word', () => {
  const s = parseKiraSignal(LONG_DECIMALS);

  assert.equal(s.symbol, 'CTSIUSDT');
  assert.equal(s.entryLow, 0.0325);
  assert.equal(s.entryHigh, 0.034);
  assert.deepEqual(s.tpPrices, [0.0415, 0.045]);
  assert.equal(s.slPrice, 0.03);
  assert.equal(validateGeometry(s).valid, true);
});

test('recognises Cyrillic side words', () => {
  const s = parseKiraSignal(LONG_DECIMALS.replace('LONG ⬆️', 'ШОРТ ⬇️')
    .replace('Вход 0.0325 - 0.0340', 'Вход 0.0450 - 0.0460')
    .replace('TP1 0.0415', 'TP1 0.0420').replace('TP2 0.0450', 'TP2 0.0400')
    .replace('Стоп 0.0300', 'Стоп 0.0480'));

  assert.equal(s.side, 'SHORT');
  assert.equal(validateGeometry(s).valid, true);
});

test('ignores fragmented posts that lack a stop in the same message', () => {
  // Канал часто «відкриває» угоду кількома повідомленнями. Без стопа в тому ж
  // пості це не угода для автоматичного виконання.
  const fragments = [
    'Готова рискнуть на SUIUSDT ⬆️\n\nПо рынку открываю сейчас ЛОНГ⬆️',
    'Моя ТВХ: 1.1266\nПлечо у меня 75х',
    'Тейки : 1.17 - 1.22\nПока без стопа',
    'METUSDT - LONG ⬆️\n\nНабираем частями❗️',
    'Стоп в бу переводите, не будем рисковать ✅',
    'XAU - Закрытие выше 4220 может сигнализировать о пробое',
  ];
  for (const text of fragments) {
    assert.equal(parseKiraSignal(text), null, `should ignore: ${text.slice(0, 40)}`);
  }
});

test('locale numbers: comma as thousands vs decimal separator', () => {
  assert.equal(parseLocaleNumber('81,500'), 81500);
  assert.equal(parseLocaleNumber('1,234,567'), 1234567);
  assert.equal(parseLocaleNumber('4,430.44'), 4430.44);
  assert.equal(parseLocaleNumber('0,0325'), 0.0325);
  assert.equal(parseLocaleNumber('1,05'), 1.05);
  assert.equal(parseLocaleNumber('0.0300'), 0.03);
  assert.ok(Number.isNaN(parseLocaleNumber('abc')));
});
