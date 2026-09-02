/**
 * Парсер торгових сигналів із повідомлень Telegram-каналу.
 *
 * Підтримувані типи:
 *  - SIGNAL  — нове відкриття позиції (📩)
 *  - REPORT  — звіт про виконання цілей (📬)
 *  - INFO    — неформатований текстовий анонс
 *
 * Повідомлення без жодного з цих маркерів повертають null.
 */

// ─── Регулярки ───────────────────────────────────────────────────────────────

const RE_SYMBOL   = /#([A-Z0-9]+USDT)/i;
const RE_SIDE     = /📈\s*(Long)|📉\s*(Short)/i;
const RE_ENTRY    = /Entry Zone:\s*([\d.]+)\s*[-–]\s*([\d.]+)/i;
const RE_TARGETS  = /Target\s+\d+:\s*([\d.]+)/gi;
const RE_SL       = /Stop-Loss:\s*([\d.]+)/i;
const RE_TRENDLINE= /Trend-Line:\s*([\d.]+)/i;
const RE_ACCURACY = /Strategy Accuracy:\s*([\d.]+)%/i;
const RE_SIGNAL_ID= /#ID(\d+)/;
const RE_REPORT   = /📬/;
const RE_NEW_SIG  = /📩/;
const RE_TIMEFRAME= /#\w+USDT\s+(\w+)/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Повертає середину між двома числами (entryMid для LIMIT-ордера).
 */
function midpoint(a, b) {
  return parseFloat(((a + b) / 2).toFixed(10));
}

const BINANCE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

/** Голе число хвилин → інтервал Binance. Канал пише і "30m", і просто "30". */
const BARE_MINUTES = {
  1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m',
  60: '1h', 120: '2h', 240: '4h', 360: '6h', 480: '8h', 720: '12h', 1440: '1d',
};

/**
 * Звести таймфрейм із тексту сигналу до валідного інтервалу Binance.
 * Невпізнане повертає null — далі спрацює дефолт викликача.
 */
function normalizeInterval(raw) {
  if (!raw) return null;

  const value = String(raw).trim();
  if (BINANCE_INTERVALS.has(value)) return value;

  const lower = value.toLowerCase();
  if (BINANCE_INTERVALS.has(lower)) return lower;

  if (/^\d+$/.test(lower)) return BARE_MINUTES[Number(lower)] ?? null;

  return null;
}

// ─── Основна функція ─────────────────────────────────────────────────────────

/**
 * Парсить текст одного повідомлення.
 *
 * @param {string} text  — текст повідомлення
 * @returns {Object|null} — розпарсований сигнал або null
 *
 * Структура поверненого об'єкта для SIGNAL:
 * {
 *   type:       'SIGNAL',
 *   symbol:     'PENDLEUSDT',
 *   side:       'LONG' | 'SHORT',
 *   timeframe:  '1h',
 *   entryLow:   1.1775,
 *   entryHigh:  1.2335,
 *   entryMid:   1.2055,
 *   tpPrices:   [1.268, 1.3025, 1.3371, 1.4406],
 *   slPrice:    1.1445,
 *   trendLine:  1.1775,
 *   accuracy:   88.94,
 *   signalId:   '20000036760',
 * }
 *
 * Структура для REPORT:
 * {
 *   type:      'REPORT',
 *   symbol:    'WOOUSDT',
 *   side:      'LONG' | 'SHORT',
 *   signalId:  '20000036895',
 *   rawText:   '...',
 * }
 */
export function parseSignal(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  // ── 1. Звіти (📬) ─────────────────────────────────────────────────────────
  if (RE_REPORT.test(trimmed)) {
    const symbolMatch = RE_SYMBOL.exec(trimmed);
    const sideMatch   = RE_SIDE.exec(trimmed);
    const idMatch     = RE_SIGNAL_ID.exec(trimmed);

    if (!symbolMatch) return null;

    return {
      type:     'REPORT',
      symbol:   symbolMatch[1].toUpperCase(),
      side:     sideMatch ? (sideMatch[1] ? 'LONG' : 'SHORT') : null,
      signalId: idMatch ? idMatch[1] : null,
      rawText:  trimmed,
    };
  }

  // ── 2. Нові сигнали (📩) ──────────────────────────────────────────────────
  if (RE_NEW_SIG.test(trimmed)) {
    const symbolMatch    = RE_SYMBOL.exec(trimmed);
    const sideMatch      = RE_SIDE.exec(trimmed);
    const entryMatch     = RE_ENTRY.exec(trimmed);
    const slMatch        = RE_SL.exec(trimmed);
    const trendlineMatch = RE_TRENDLINE.exec(trimmed);
    const accuracyMatch  = RE_ACCURACY.exec(trimmed);
    const idMatch        = RE_SIGNAL_ID.exec(trimmed);
    const tfMatch        = RE_TIMEFRAME.exec(trimmed);

    // Обов'язкові поля
    if (!symbolMatch || !sideMatch || !entryMatch || !slMatch) return null;

    // Всі таргети
    const tpPrices = [];
    let m;
    // Скидаємо lastIndex бо RE_TARGETS — глобальна
    RE_TARGETS.lastIndex = 0;
    while ((m = RE_TARGETS.exec(trimmed)) !== null) {
      tpPrices.push(parseFloat(m[1]));
    }

    // Джерела пишуть зону в обох порядках: GGShøt дає "LOW - HIGH",
    // старіший формат каналу давав "HIGH - LOW". Позиція в рядку нічого не
    // гарантує, тому межі визначаємо за значенням.
    const boundA    = parseFloat(entryMatch[1]);
    const boundB    = parseFloat(entryMatch[2]);
    const entryLow  = Math.min(boundA, boundB);
    const entryHigh = Math.max(boundA, boundB);

    return {
      type:      'SIGNAL',
      symbol:    symbolMatch[1].toUpperCase(),
      side:      sideMatch[1] ? 'LONG' : 'SHORT',
      timeframe: normalizeInterval(tfMatch?.[1]),
      entryHigh,
      entryLow,
      entryMid:  midpoint(entryHigh, entryLow),
      tpPrices,
      slPrice:   parseFloat(slMatch[1]),
      trendLine: trendlineMatch ? parseFloat(trendlineMatch[1]) : null,
      accuracy:  accuracyMatch  ? parseFloat(accuracyMatch[1])  : null,
      signalId:  idMatch ? idMatch[1] : null,
      rawText:   trimmed,
    };
  }

  // ── 3. Решта повідомлень — не сигнал ─────────────────────────────────────
  return null;
}
