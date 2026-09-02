/**
 * signalGeometry.js
 *
 * Валідація структури сигналу, незалежна від того, хто його розпарсив —
 * regex, LLM чи ручне пересилання адміном.
 *
 * Два шари:
 *
 *   1. validateGeometry()  — взаємне розташування SL / зони / TP.
 *      Ловить інвертовану зону, переплутаний side, поміняні місцями SL і TP,
 *      немонотонні або відсутні цілі.
 *
 *   2. verifyNumbersInSource() — кожне число з розпарсеного об'єкта мусить
 *      дослівно зустрічатися в оригінальному тексті. Це детермінований захист
 *      від галюцинованих цін, коли парсинг робить мовна модель.
 *
 * Обидва шари навмисно не знають нічого про біржу і не роблять мережевих
 * запитів — їх можна викликати до будь-якої торгової логіки.
 */

import { z } from 'zod';

// ─── Межі здорового глузду ────────────────────────────────────────────────────

export const GEOMETRY_LIMITS = {
  maxZoneWidthPct: 0.20,  // зона входу ширша за 20% — майже напевно помилка парсингу
  minSlDistPct:    0.001, // 0.1% — ближче до входу SL не буває осмисленим
  maxSlDistPct:    0.25,  // 25% — далі це вже не стоп
  maxTpDistPct:    2.00,  // TP далі ніж +200% від входу — підозріло
  maxTpLevels:     8,
};

// ─── Схема ────────────────────────────────────────────────────────────────────

const price = z.number().finite().positive();

export const ParsedSignalSchema = z.object({
  symbol:    z.string().regex(/^[A-Z0-9]{2,20}$/, 'symbol must be uppercase alphanumeric'),
  side:      z.enum(['LONG', 'SHORT']),
  entryLow:  price,
  entryHigh: price,
  slPrice:   price,
  tpPrices:  z.array(price).min(1).max(GEOMETRY_LIMITS.maxTpLevels),
  timeframe: z.string().max(10).nullable().optional(),
  signalId:  z.string().max(64).nullable().optional(),
  accuracy:  z.number().finite().nullable().optional(),
  rawText:   z.string().nullable().optional(),
}).passthrough();

// ─── Шар 1: геометрія ─────────────────────────────────────────────────────────

/**
 * Перевірити, що числа сигналу складаються в осмислену угоду.
 *
 * Для LONG:  SL < entryLow <= entryHigh < TP1 < TP2 < ...
 * Для SHORT: SL > entryHigh >= entryLow > TP1 > TP2 > ...
 *
 * @param {object} signal — розпарсений сигнал
 * @returns {{ valid: boolean, errors: string[], signal?: object }}
 */
export function validateGeometry(signal) {
  const parsed = ParsedSignalSchema.safeParse(signal);
  if (!parsed.success) {
    return {
      valid:  false,
      errors: parsed.error.issues.map(i => `${i.path.join('.') || 'signal'}: ${i.message}`),
    };
  }

  const s      = parsed.data;
  const errors = [];
  const isLong = s.side === 'LONG';

  // ── Зона ──────────────────────────────────────────────────────────────────
  if (s.entryLow > s.entryHigh) {
    errors.push(`entry zone inverted: low ${s.entryLow} > high ${s.entryHigh}`);
  }

  const zoneMid = (s.entryLow + s.entryHigh) / 2;
  const zoneWidthPct = Math.abs(s.entryHigh - s.entryLow) / zoneMid;
  if (zoneWidthPct > GEOMETRY_LIMITS.maxZoneWidthPct) {
    errors.push(
      `entry zone too wide: ${pct(zoneWidthPct)} (max ${pct(GEOMETRY_LIMITS.maxZoneWidthPct)})`
    );
  }

  // ── SL відносно зони ──────────────────────────────────────────────────────
  const slOnCorrectSide = isLong ? s.slPrice < s.entryLow : s.slPrice > s.entryHigh;
  if (!slOnCorrectSide) {
    errors.push(
      isLong
        ? `LONG requires SL below entry zone: SL ${s.slPrice}, zone low ${s.entryLow}`
        : `SHORT requires SL above entry zone: SL ${s.slPrice}, zone high ${s.entryHigh}`
    );
  }

  const slDistPct = Math.abs(zoneMid - s.slPrice) / zoneMid;
  if (slDistPct < GEOMETRY_LIMITS.minSlDistPct) {
    errors.push(`SL too close to entry: ${pct(slDistPct)} (min ${pct(GEOMETRY_LIMITS.minSlDistPct)})`);
  }
  if (slDistPct > GEOMETRY_LIMITS.maxSlDistPct) {
    errors.push(`SL too far from entry: ${pct(slDistPct)} (max ${pct(GEOMETRY_LIMITS.maxSlDistPct)})`);
  }

  // ── TP відносно зони ──────────────────────────────────────────────────────
  const firstTp = s.tpPrices[0];
  const tpOnCorrectSide = isLong ? firstTp > s.entryHigh : firstTp < s.entryLow;
  if (!tpOnCorrectSide) {
    errors.push(
      isLong
        ? `LONG requires TP1 above entry zone: TP1 ${firstTp}, zone high ${s.entryHigh}`
        : `SHORT requires TP1 below entry zone: TP1 ${firstTp}, zone low ${s.entryLow}`
    );
  }

  // ── TP монотонні ──────────────────────────────────────────────────────────
  for (let i = 1; i < s.tpPrices.length; i++) {
    const prev = s.tpPrices[i - 1];
    const cur  = s.tpPrices[i];
    const ordered = isLong ? cur > prev : cur < prev;
    if (!ordered) {
      errors.push(
        `TP levels not monotonic for ${s.side}: TP${i} ${prev} -> TP${i + 1} ${cur}`
      );
      break;
    }
  }

  const lastTpDistPct = Math.abs(s.tpPrices.at(-1) - zoneMid) / zoneMid;
  if (lastTpDistPct > GEOMETRY_LIMITS.maxTpDistPct) {
    errors.push(
      `final TP unrealistically far: ${pct(lastTpDistPct)} (max ${pct(GEOMETRY_LIMITS.maxTpDistPct)})`
    );
  }

  return errors.length
    ? { valid: false, errors }
    : { valid: true, errors: [], signal: s };
}

// ─── Шар 2: числа мусять бути в оригіналі ─────────────────────────────────────

const NUMERIC_FIELDS = ['entryLow', 'entryHigh', 'slPrice'];

/**
 * Перевірити, що кожне цінове число з сигналу дослівно присутнє в тексті-джерелі.
 *
 * Призначено насамперед для парсингу мовною моделлю: модель може повернути
 * структурно бездоганний, але вигаданий рівень. Похідні поля (entryMid)
 * навмисно не перевіряються — вони обчислені, а не прочитані.
 *
 * @param {object} signal
 * @param {string} rawText — оригінальний текст повідомлення
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function verifyNumbersInSource(signal, rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { valid: false, errors: ['rawText is required for source verification'] };
  }

  // Прибираємо розділювачі тисяч, щоб "4,430.44" знайшлося як 4430.44
  const haystack = rawText.replace(/(?<=\d)[,   ](?=\d{3}\b)/g, '');
  const errors   = [];

  const check = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (!containsNumber(haystack, value)) {
      errors.push(`${label} ${value} does not appear in the source message`);
    }
  };

  for (const field of NUMERIC_FIELDS) check(signal[field], field);
  (signal.tpPrices ?? []).forEach((tp, i) => check(tp, `tpPrices[${i}]`));

  return { valid: errors.length === 0, errors };
}

/**
 * Чи зустрічається число в тексті в будь-якому розумному записі.
 * "0.0911" знаходиться в "0.09110", "1.2" — в "1.20".
 */
function containsNumber(haystack, value) {
  const canonical = String(value);
  if (haystack.includes(canonical)) return true;

  // Джерело могло записати число з іншою кількістю знаків після коми.
  for (const digits of [2, 3, 4, 5, 6, 8]) {
    if (haystack.includes(value.toFixed(digits))) return true;
  }

  // Або навпаки — коротше, ніж канонічний запис (0.09110 -> 0.0911).
  const trimmed = canonical.includes('.') ? canonical.replace(/0+$/, '').replace(/\.$/, '') : canonical;
  return haystack.includes(trimmed);
}

// ─── Комбінований вхід ────────────────────────────────────────────────────────

/**
 * Повна перевірка сигналу перед торговою логікою.
 *
 * @param {object} signal
 * @param {object} [opts]
 * @param {boolean} [opts.verifySource=false] — вмикати для сигналів від LLM
 * @returns {{ valid: boolean, errors: string[], reason: string|null, signal?: object }}
 */
export function validateSignal(signal, { verifySource = false } = {}) {
  const geometry = validateGeometry(signal);
  const errors   = [...geometry.errors];

  if (verifySource) {
    errors.push(...verifyNumbersInSource(signal, signal?.rawText).errors);
  }

  return {
    valid:  errors.length === 0,
    errors,
    reason: errors.length ? errors[0] : null,
    signal: errors.length ? undefined : (geometry.signal ?? signal),
  };
}

function pct(n) { return `${(n * 100).toFixed(2)}%`; }
