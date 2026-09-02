#!/usr/bin/env node
/**
 * replay.js — офлайн-перевірка політик виходу на зібраних сигналах.
 *
 * Читає сигнали з БД, підтягує свічки з Binance і рахує, чим би завершилась
 * кожна угода за різних правил. Ордери не виставляються і БД не змінюється.
 *
 * Ключова властивість: скрипт імпортує ту саму логіку, якою торгує бот
 * (planEntry, normalizedTpShares), а не її копію. Тому реплей перевіряє
 * реальний код, і будь-яка зміна параметрів у riskEngine одразу видно тут.
 *
 * Використання:
 *   node scripts/replay.js
 *   node scripts/replay.js --source channel --since 2026-06-01 --horizon 14
 *   node scripts/replay.js --detail
 *
 * Прапорці:
 *   --source   фільтр по джерелу сигналу
 *   --since    ISO-дата, від якої брати сигнали
 *   --horizon  скільки днів тримати позицію в симуляції (типово 14)
 *   --detail   вивести кожен сигнал окремим рядком
 */

import { db, Signal } from '../src/module/db/database.js';
import { planEntry, RISK_CONFIG } from '../src/core/riskEngine.js';
import { normalizedTpShares } from '../src/core/exitStrategy.js';

const BASE_URL = 'https://fapi.binance.com';
const TAKER_FEE = 0.00045;

// ─── Аргументи ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { horizon: 14, detail: false, source: null, since: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--detail')      args.detail  = true;
    else if (arg === '--source') args.source  = argv[++i];
    else if (arg === '--since')  args.since   = argv[++i];
    else if (arg === '--horizon') args.horizon = Number(argv[++i]);
  }

  if (!Number.isFinite(args.horizon) || args.horizon <= 0) {
    throw new Error('--horizon must be a positive number of days');
  }
  return args;
}

// ─── Ринкові дані ─────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, startTime, endTime) {
  const out = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const qs = new URLSearchParams({
      symbol, interval, startTime: String(cursor), endTime: String(endTime), limit: '1500',
    });
    const res = await fetch(`${BASE_URL}/fapi/v1/klines?${qs}`);
    if (!res.ok) throw new Error(`klines ${symbol}: HTTP ${res.status}`);

    const batch = await res.json();
    if (!batch.length) break;

    out.push(...batch.map(c => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] })));
    cursor = batch[batch.length - 1][0] + 1;
    if (batch.length < 1500) break;
  }
  return out;
}

async function fetchAtr(symbol, interval, endTime, period = 14) {
  const qs = new URLSearchParams({
    symbol, interval, endTime: String(endTime), limit: String(period + 2),
  });
  const res = await fetch(`${BASE_URL}/fapi/v1/klines?${qs}`);
  if (!res.ok) throw new Error(`atr ${symbol}: HTTP ${res.status}`);

  const k = (await res.json()).map(c => ({ h: +c[2], l: +c[3], c: +c[4] }));
  if (k.length < 2) return null;

  let sum = 0;
  for (let i = 1; i < k.length; i++) {
    sum += Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
  }
  return sum / (k.length - 1);
}

/**
 * Звести tpPrices до масиву чисел.
 *
 * З `raw: true` SQLite віддає JSON-колонку рядком, тож покладатися на
 * десеріалізацію Sequelize тут не можна.
 */
function parseTpPrices(value) {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [];
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─── Симуляція ────────────────────────────────────────────────────────────────

/**
 * Пройти свічками вперед і порахувати результат у R.
 *
 * Консервативне припущення: якщо свічка торкнулась і TP, і стопа — рахуємо стоп.
 * Реальний порядок усередині свічки невідомий, тож припускаємо гірший.
 */
function simulate({ candles, side, entry, slPrice, tpPrices, shares, beAfterTp1 = true }) {
  const isLong = side === 'LONG';
  const risk   = Math.abs(entry - slPrice);
  if (risk <= 0) return null;

  const delta = risk / entry;
  const rr    = tpPrices.map(tp => Math.abs(tp - entry) / risk);

  let stop = slPrice, hit = 0, R = 0, remaining = 1, fills = 1;
  const path = [];

  for (const candle of candles) {
    const stopTouched = isLong ? candle.l <= stop : candle.h >= stop;
    if (stopTouched) {
      R += remaining * ((isLong ? stop - entry : entry - stop) / risk);
      path.push(hit === 0 ? 'SL' : hit === 1 ? 'BE' : `trail@TP${hit - 1}`);
      remaining = 0; fills++;
      break;
    }

    while (hit < shares.length && shares[hit] > 0 &&
           (isLong ? candle.h >= tpPrices[hit] : candle.l <= tpPrices[hit])) {
      R += shares[hit] * rr[hit];
      remaining -= shares[hit];
      hit++; fills++;
      path.push(`TP${hit}`);

      if (beAfterTp1 && hit === 1) stop = entry;
      else if (hit === 2) stop = tpPrices[0];
      else if (hit === 3) stop = tpPrices[1];
      if (remaining <= 1e-9) break;
    }
    if (remaining <= 1e-9) break;
  }

  if (remaining > 1e-9) {
    const last = candles.at(-1);
    R += remaining * ((isLong ? last.c - entry : entry - last.c) / risk);
    path.push('open');
    fills++;
  }

  const fees = TAKER_FEE * fills / delta;
  return { R: R - fees, grossR: R, fees, hit, path: path.join('→') };
}

// ─── Політики ─────────────────────────────────────────────────────────────────

const POLICIES = [
  { name: 'власний SL (поточна)', ownSl: true,  beAfterTp1: true  },
  { name: 'власний SL, без BE',   ownSl: true,  beAfterTp1: false },
  { name: 'SL провайдера',        ownSl: false, beAfterTp1: true  },
];

// ─── Головне ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const where = {};
  if (args.source) where.source = args.source;

  const signals = (await Signal.findAll({ where, order: [['receivedAt', 'ASC']], raw: true }))
    .map(s => ({ ...s, tpPrices: parseTpPrices(s.tpPrices) }))
    .filter(s => s.tpPrices.length && s.slPrice && s.entryLow && s.entryHigh)
    .filter(s => !args.since || new Date(s.receivedAt) >= new Date(args.since));

  if (!signals.length) {
    console.log('Немає сигналів, придатних для реплею.');
    console.log('Потрібні entryLow/entryHigh, slPrice, tpPrices і priceAtSignal.');
    console.log('Збирати їх можна в режимі /mode shadow.');
    return;
  }

  const results = new Map(POLICIES.map(p => [p.name, []]));
  const skipped = [];

  for (const signal of signals) {
    const startTime = new Date(signal.receivedAt).getTime();
    const endTime   = startTime + args.horizon * 86400000;
    const interval  = signal.timeframe ?? '1h';
    const shares    = normalizedTpShares(signal.tpPrices.length);

    let candles, atr;
    try {
      [candles, atr] = await Promise.all([
        fetchKlines(signal.symbol, '15m', startTime, endTime),
        fetchAtr(signal.symbol, interval, startTime),
      ]);
    } catch (err) {
      skipped.push({ signal, reason: err.message });
      continue;
    }

    if (!candles.length) {
      skipped.push({ signal, reason: 'no market data for this window' });
      continue;
    }

    // Ціна на момент сигналу: з запису, інакше — відкриття першої свічки.
    const entry = signal.priceAtSignal ?? candles[0].o;

    for (const policy of POLICIES) {
      let slPrice = signal.slPrice;

      if (policy.ownSl) {
        const plan = planEntry({
          entryPrice: entry,
          side:       signal.side,
          tpPrices:   signal.tpPrices,
          providerSl: signal.slPrice,
          atr,
          tpShares:   shares,
        });
        if (!plan.ok) {
          results.get(policy.name).push({ signal, skipped: true, reason: plan.reason });
          continue;
        }
        slPrice = plan.slPrice;
      }

      const outcome = simulate({
        candles, side: signal.side, entry, slPrice,
        tpPrices: signal.tpPrices, shares, beAfterTp1: policy.beAfterTp1,
      });
      results.get(policy.name).push({ signal, entry, slPrice, atr, ...outcome });
    }
  }

  report(results, skipped, args);
}

function report(results, skipped, args) {
  console.log(`\nРеплей: горизонт ${args.horizon} дн, комісія ${(TAKER_FEE * 100).toFixed(3)}% на виконання`);
  console.log(`Конфіг: targetRR ${RISK_CONFIG.targetRR}, ATR-підлога ${RISK_CONFIG.atrStopMultiplier}×, `
            + `мін. зважений R:R ${RISK_CONFIG.minWeightedRR}, сітка ${normalizedTpShares(4).map(s => Math.round(s * 100) + '%').join('/')}`);

  for (const [name, rows] of results) {
    const taken = rows.filter(r => !r.skipped);
    const total = taken.reduce((sum, r) => sum + r.R, 0);
    const wins  = taken.filter(r => r.R > 0);
    const beyondDelta = taken.filter(r =>
      Math.abs(r.entry - r.slPrice) / r.entry > RISK_CONFIG.maxDeltaPct).length;

    console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 46 - name.length))}`);
    console.log(`взято ${taken.length} із ${rows.length}   `
              + `разом ${total.toFixed(2)}R   `
              + `сер. ${taken.length ? (total / taken.length).toFixed(3) : '—'}R   `
              + `частка плюсових ${taken.length ? (wins.length / taken.length * 100).toFixed(0) : '—'}%`);

    if (beyondDelta) {
      console.log(`  ⚠ ${beyondDelta} з них наживо не пройшли б фільтр ширини SL (maxDeltaPct `
                + `${(RISK_CONFIG.maxDeltaPct * 100).toFixed(1)}%) — це теоретична база, не досяжний результат`);
    }

    if (args.detail) {
      for (const row of rows) {
        const sym = row.signal.symbol.replace('USDT', '').padEnd(8);
        if (row.skipped) { console.log(`  ${sym} пропуск: ${row.reason}`); continue; }
        const slPct = Math.abs(row.entry - row.slPrice) / row.entry * 100;
        // Позначаємо рядки, які наживо не пройшли б фільтр ширини SL у risk engine:
        // порівнювати з ними інші політики можна лише як з теоретичною базою.
        const untradeable = slPct > RISK_CONFIG.maxDeltaPct * 100 ? '  ⚠ поза maxDeltaPct' : '';
        console.log(`  ${sym} ${row.signal.side.padEnd(5)} вхід ${String(row.entry).padEnd(11)}`
                  + ` SL ${slPct.toFixed(2).padStart(5)}%  ${row.R >= 0 ? '+' : ''}${row.R.toFixed(2)}R`
                  + `  (комісія ${row.fees.toFixed(3)}R)  ${row.path}${untradeable}`);
      }
    }
  }

  if (skipped.length) {
    console.log(`\nБез ринкових даних: ${skipped.length}`);
    for (const s of skipped) console.log(`  ${s.signal.symbol} — ${s.reason}`);
  }

  // Беремо найбільшу вибірку серед політик: у першої може бути 0 взятих,
  // і попередження тоді вводило б в оману.
  const n = Math.max(0, ...[...results.values()].map(rows => rows.filter(r => !r.skipped).length));
  if (n < 30) {
    console.log(`\n⚠️  n = ${n}. Це замало для висновку про перевагу: різниця між політиками`);
    console.log(`   на такій вибірці визначається кількома окремими угодами. Цифри показують`);
    console.log(`   напрямок, а не очікуваний результат.`);
  }
}

main()
  .catch(err => { console.error('Replay failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
