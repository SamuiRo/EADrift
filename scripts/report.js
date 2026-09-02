#!/usr/bin/env node
/**
 * report.js — вивести аналітичні звіти з БД.
 *
 * Читає тільки; нічого не змінює і на біржу не ходить.
 *
 * Використання:
 *   npm run report
 *   npm run report -- --only tpHitRate,symbolStats
 *   npm run report -- --json
 *   EADRIFT_DB_PATH=./dump.db npm run report
 *
 * Прапорці:
 *   --only  список звітів через кому
 *   --json  сирий JSON замість таблиць (для передачі далі)
 *   --list  показати доступні звіти й вийти
 */

import { db } from '../src/module/db/database.js';
import * as analytics from '../src/module/db/analytics.js';

const REPORTS = [
  { fn: 'tpHitRate',            title: 'Досягнення TP',            note: 'частка позиції на рівні має відповідати частоті його спрацювання' },
  { fn: 'closeReasonBreakdown', title: 'Причини закриття' },
  { fn: 'symbolStats',          title: 'По символах' },
  { fn: 'sourceStats',          title: 'По джерелах',              note: 'калібрувати виходи треба окремо на кожне джерело' },
  { fn: 'modeStats',            title: 'По торгових режимах' },
  { fn: 'slOptimizationReport', title: 'Ширина SL проти результату' },
  { fn: 'beEffectiveness',      title: 'Ефективність BE+',         note: 'stoppedOutAtBe — скільки разів BE+ забрав угоду' },
  { fn: 'trailingEfficiency',   title: 'Trailing' },
  { fn: 'evaluationFunnel',     title: 'Воронка рішень' },
  { fn: 'rejectionReasons',     title: 'Причини відмов' },
  { fn: 'signalRejectionStats', title: 'Відмови за сигналами' },
];

function parseArgs(argv) {
  const args = { only: null, json: false, list: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json')      args.json = true;
    else if (argv[i] === '--list') args.list = true;
    else if (argv[i] === '--only') args.only = String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

/** Вирівняна таблиця з масиву однорідних об'єктів. */
function renderTable(rows) {
  if (!rows.length) return '  (порожньо)';

  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = value => value === null || value === undefined ? '—' : String(value);

  const widths = columns.map(col =>
    Math.max(col.length, ...rows.map(row => cell(row[col]).length)));

  const line = (values) => '  ' + values
    .map((value, i) => value.padStart(widths[i]))
    .join('  ');

  return [
    line(columns),
    '  ' + widths.map(w => '─'.repeat(w)).join('  '),
    ...rows.map(row => line(columns.map(col => cell(row[col])))),
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const r of REPORTS) console.log(`${r.fn.padEnd(24)} ${r.title}`);
    return;
  }

  const selected = args.only
    ? REPORTS.filter(r => args.only.includes(r.fn))
    : REPORTS;

  if (!selected.length) {
    console.error(`Невідомий звіт. Доступні: ${REPORTS.map(r => r.fn).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const output = {};

  for (const report of selected) {
    // Один зламаний звіт не має ховати решту — показуємо помилку і йдемо далі.
    try {
      output[report.fn] = await analytics[report.fn]();
    } catch (err) {
      output[report.fn] = { error: err.message };
    }
  }

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  for (const report of selected) {
    const data = output[report.fn];
    console.log(`\n── ${report.title} ${'─'.repeat(Math.max(0, 52 - report.title.length))}`);
    if (report.note) console.log(`  _${report.note}_`);

    if (data?.error) {
      console.log(`  помилка: ${data.error}`);
    } else if (Array.isArray(data)) {
      console.log(renderTable(data));
    } else if (data) {
      console.log(renderTable([data]));
    } else {
      console.log('  (немає даних)');
    }
  }

  console.log('');
}

main()
  .catch(err => { console.error('Report failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
