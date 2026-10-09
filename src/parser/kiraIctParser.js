/**
 * Парсер сигналів каналу «Kíra | ICT».
 *
 * Канал публікує два типи постів, і розпізнається лише перший:
 *
 *   1. Повний сигнал одним повідомленням:
 *        BTCUSDT
 *        LONG ⬆️
 *        Вход: 81,500 – 82,300
 *        TP1: 83,000
 *        TP2: 84,200
 *        SL: 79,800
 *
 *   2. Сигнал, розірваний на кілька повідомлень: «открываю ЛОНГ» → окремо
 *      точка входу → окремо тейки → «пока без стопа». Такі пости навмисно
 *      повертають null: без стопа в тому самому повідомленні це не угода для
 *      автоматичного виконання, хоч би як її розпізнати.
 *
 * Повертає об'єкт у тому ж форматі, що й signalParser.js, або null.
 */

const RE_SYMBOL = /\b([A-Z0-9]{2,20}USDT)\b/;
const RE_SIDE   = /\b(LONG|SHORT)\b|(ЛОНГ|ШОРТ)/i;

// Число: цифри з можливими розділювачами "," "." і пробілами всередині.
const NUM = '(\\d[\\d.,]*)';
const DASH = '\\s*[-–—]\\s*';

const RE_ENTRY_RANGE  = new RegExp(`(?:Вход|Вхід|Entry)\\s*:?\\s*${NUM}${DASH}${NUM}`, 'i');
const RE_ENTRY_SINGLE = new RegExp(`(?:Вход|Вхід|Entry)\\s*:?\\s*${NUM}`, 'i');
const RE_TP_NUMBERED  = new RegExp(`\\bTP\\s*(\\d)\\s*:?\\s*${NUM}`, 'gi');
const RE_SL           = new RegExp(`(?:\\bSL\\b|Стоп|Stop)\\s*:?\\s*${NUM}`, 'i');

/**
 * Перетворити запис числа на число.
 *
 * Кома неоднозначна: у "81,500" це розділювач тисяч, у "1,012" може бути
 * десятковий знак. Правило: якщо є і кома, і крапка — кома розділяє тисячі;
 * якщо лише кома й після неї рівно три цифри групами — тисячі; інакше кома
 * десяткова. Помилку масштабу (×1000) додатково ловить звірка з ринковою
 * ціною перед будь-яким рішенням.
 */
export function parseLocaleNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim().replace(/[.,]+$/, '');

  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

export function parseKiraSignal(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  const symbolMatch = RE_SYMBOL.exec(trimmed);
  const sideMatch   = RE_SIDE.exec(trimmed);
  const slMatch     = RE_SL.exec(trimmed);
  if (!symbolMatch || !sideMatch || !slMatch) return null;

  const rangeMatch  = RE_ENTRY_RANGE.exec(trimmed);
  const singleMatch = rangeMatch ? null : RE_ENTRY_SINGLE.exec(trimmed);
  if (!rangeMatch && !singleMatch) return null;

  const a = parseLocaleNumber(rangeMatch ? rangeMatch[1] : singleMatch[1]);
  const b = rangeMatch ? parseLocaleNumber(rangeMatch[2]) : a;

  const tpByLevel = new Map();
  RE_TP_NUMBERED.lastIndex = 0;
  let m;
  while ((m = RE_TP_NUMBERED.exec(trimmed)) !== null) {
    const level = Number(m[1]);
    if (!tpByLevel.has(level)) tpByLevel.set(level, parseLocaleNumber(m[2]));
  }
  const tpPrices = [...tpByLevel.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);

  const slPrice = parseLocaleNumber(slMatch[1]);
  const numbers = [a, b, slPrice, ...tpPrices];
  if (!tpPrices.length || numbers.some(n => !Number.isFinite(n) || n <= 0)) return null;

  const word = (sideMatch[1] || sideMatch[2]).toUpperCase();
  const side = word === 'LONG' || word === 'ЛОНГ' ? 'LONG' : 'SHORT';

  const entryLow  = Math.min(a, b);
  const entryHigh = Math.max(a, b);

  return {
    type:      'SIGNAL',
    symbol:    symbolMatch[1].toUpperCase(),
    side,
    timeframe: null,   // канал таймфрейм не вказує; викликач підставить дефолт
    entryLow,
    entryHigh,
    entryMid:  parseFloat(((entryLow + entryHigh) / 2).toFixed(10)),
    tpPrices,
    slPrice,
    trendLine: null,
    accuracy:  null,
    signalId:  null,
    rawText:   trimmed,
  };
}
