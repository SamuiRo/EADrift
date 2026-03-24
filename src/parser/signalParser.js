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

    const entryHigh = parseFloat(entryMatch[1]);
    const entryLow  = parseFloat(entryMatch[2]);

    return {
      type:      'SIGNAL',
      symbol:    symbolMatch[1].toUpperCase(),
      side:      sideMatch[1] ? 'LONG' : 'SHORT',
      timeframe: tfMatch ? tfMatch[1] : null,
      entryHigh,
      entryLow,
      entryMid:  midpoint(entryHigh, entryLow),
      tpPrices,
      slPrice:   parseFloat(slMatch[1]),
      trendLine: trendlineMatch ? parseFloat(trendlineMatch[1]) : null,
      accuracy:  accuracyMatch  ? parseFloat(accuracyMatch[1])  : null,
      signalId:  idMatch ? idMatch[1] : null,
    };
  }

  // ── 3. Решта повідомлень — не сигнал ─────────────────────────────────────
  return null;
}