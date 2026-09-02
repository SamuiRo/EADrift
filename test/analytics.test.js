import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Окрема тимчасова БД — тести не мають торкатися робочої бази.
// Змінна має бути встановлена ДО імпорту database.js, тому імпорт динамічний.
const DB_FILE = path.join(os.tmpdir(), `eadrift-analytics-${process.pid}-${Date.now()}.db`);
process.env.EADRIFT_DB_PATH = DB_FILE;

const { db, Signal, Trade, SlHistory, SignalEvaluation } = await import('../src/module/db/database.js');
const { initDatabase } = await import('../src/module/db/database.js');
const analytics = await import('../src/module/db/analytics.js');

test.before(async () => {
  await initDatabase();
  await seed();
});

test.after(async () => {
  await db.close();
  fs.rmSync(DB_FILE, { force: true });
});

async function seed() {
  const signal = await Signal.create({
    signalId: 'S1', source: 'channel', symbol: 'ENAUSDT', side: 'LONG',
    entryLow: 0.0911, entryHigh: 0.09656, entryMid: 0.09383,
    slPrice: 0.09001, tpPrices: [0.09772, 0.09888, 0.10004, 0.10351],
    timeframe: '1h', status: 'TRADED', priceAtSignal: 0.09558, receivedAt: new Date(),
  });

  const rejected = await Signal.create({
    signalId: 'S2', source: 'channel', symbol: 'ARUSDT', side: 'LONG',
    entryLow: 1.882, entryHigh: 1.976, slPrice: 1.853, tpPrices: [2.006],
    status: 'REJECTED', rejectReason: 'SL would sit inside noise: 1.01% available',
    priceAtSignal: 1.986, receivedAt: new Date(),
  });

  const winner = await Trade.create({
    signalId: signal.id, symbol: 'ENAUSDT', side: 'LONG', entryType: 'MARKET',
    entryPrice: 0.09558, slPriceInitial: 0.09344, slPriceFinal: 0.09558,
    tpPrices: [0.09772, 0.09888, 0.10004, 0.10351],
    tp1Hit: true, tp2Hit: true, tp3Hit: false, tp4Hit: false,
    quantity: 677, positionUsdt: 64.7, leverage: 1,
    riskPerTradeUsdt: 1.45, balanceAtEntry: 193,
    exitPrice: 0.09888, profitUsdt: 2.1, profitR: 1.45, profitPct: 3.2,
    maxDrawdownPct: -0.4, maxProfitPct: 3.6,
    status: 'CLOSED', closeReason: 'tp2', openedAt: new Date(Date.now() - 7200000),
    closedAt: new Date(), timeInTradeMs: 7200000, interval: '1h', tradingMode: 'SHADOW',
  });

  await Trade.create({
    symbol: 'BNBUSDT', side: 'LONG', entryType: 'MARKET',
    entryPrice: 593.44, slPriceInitial: 582.66, slPriceFinal: 582.66,
    tpPrices: [604.22], tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false,
    quantity: 0.12, positionUsdt: 71, leverage: 1,
    riskPerTradeUsdt: 1.45, balanceAtEntry: 193,
    exitPrice: 582.66, profitUsdt: -1.45, profitR: -1, profitPct: -2.0,
    maxDrawdownPct: -2.0, maxProfitPct: 0.1,
    status: 'CLOSED', closeReason: 'sl_hit', openedAt: new Date(Date.now() - 3600000),
    closedAt: new Date(), timeInTradeMs: 3600000, interval: '30m', tradingMode: 'SHADOW',
  });

  await SlHistory.bulkCreate([
    { tradeId: winner.id, reason: 'INITIAL', slPriceNew: 0.09344, markPrice: 0.09558, movedAt: new Date() },
    { tradeId: winner.id, reason: 'BE_PLUS', slPricePrev: 0.09344, slPriceNew: 0.09558, markPrice: 0.09772, distanceFromPricePct: 2.19, movedAt: new Date() },
    { tradeId: winner.id, reason: 'TRAILING', slPricePrev: 0.09558, slPriceNew: 0.09700, markPrice: 0.09888, distanceFromPricePct: 1.90, movedAt: new Date() },
  ]);

  await SignalEvaluation.bulkCreate([
    { signalId: signal.id, symbol: 'ENAUSDT', side: 'LONG', source: 'channel',
      decision: 'SHADOW', markPrice: 0.09558, inZone: true, weightedRR: 1.43,
      slDistancePct: 2.24, evaluatedAt: new Date() },
    { signalId: rejected.id, symbol: 'ARUSDT', side: 'LONG', source: 'channel',
      decision: 'REJECTED', reason: 'SL would sit inside noise: 1.01% available',
      markPrice: 1.986, inZone: false, slDistancePct: 1.01, evaluatedAt: new Date() },
  ]);
}

// ─── Головне: SQL мусить сходитися з фактичною схемою ────────────────────────

const REPORTS = [
  'slOptimizationReport', 'maeReport', 'tpHitRate', 'closeReasonBreakdown',
  'trailingEfficiency', 'beEffectiveness', 'symbolStats', 'modeStats',
  'sourceStats', 'signalRejectionStats', 'evaluationFunnel', 'rejectionReasons',
  'equityCurve',
];

test('every report runs against the real schema', async () => {
  // Регресія на цілий клас багів: raw SQL звертався до snake_case колонок
  // (entry_price, profit_r, trade_id), яких у схемі немає, тож кожен звіт
  // падав при першому ж виклику. Тест ловить будь-яке нове розходження.
  for (const name of REPORTS) {
    const result = await analytics[name]();
    assert.ok(result !== undefined, `${name} returned undefined`);
  }
});

test('tpHitRate reflects the seeded trades', async () => {
  const row = await analytics.tpHitRate();

  assert.equal(row.total, 2);
  assert.equal(row.tp1HitRate, 50);   // одна з двох дійшла до TP1
  assert.equal(row.tp2HitRate, 50);
  assert.equal(row.tp3HitRate, 0);
  assert.equal(row.winRatePct, 50);
  assert.ok(Math.abs(row.avgProfitR - 0.225) < 1e-9);
});

test('closeReasonBreakdown groups by the reason enum', async () => {
  const rows = await analytics.closeReasonBreakdown();
  const reasons = Object.fromEntries(rows.map(r => [r.closeReason, r.tradeCount]));

  assert.equal(reasons.tp2, 1);
  assert.equal(reasons.sl_hit, 1);
});

test('symbolStats separates winners from losers', async () => {
  const rows = await analytics.symbolStats();
  const ena = rows.find(r => r.symbol === 'ENAUSDT');
  const bnb = rows.find(r => r.symbol === 'BNBUSDT');

  assert.equal(ena.winRate, 100);
  assert.equal(bnb.winRate, 0);
  assert.equal(ena.totalPnlUsdt, 2.1);
  assert.equal(bnb.totalPnlUsdt, -1.45);
});

test('slOptimizationReport buckets by stop width', async () => {
  const rows = await analytics.slOptimizationReport();

  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(Number.isFinite(row.deltaBucketPct), 'bucket must be numeric');
    assert.ok(row.tradeCount >= 1);
  }
});

test('trailing and BE reports join sl_history correctly', async () => {
  const trailing = await analytics.trailingEfficiency();
  assert.equal(trailing.length, 1);
  assert.equal(trailing[0].symbol, 'ENAUSDT');
  assert.equal(trailing[0].trailingUpdates, 1);

  const be = await analytics.beEffectiveness();
  assert.equal(be.length, 1);
  assert.equal(be[0].tradesWithBe, 1);
  assert.equal(be[0].stoppedOutAtBe, 0);
});

test('sourceStats attributes trades back to their signal source', async () => {
  const rows = await analytics.sourceStats();
  const channel = rows.find(r => r.source === 'channel');

  assert.equal(channel.signals, 2);
  assert.equal(channel.trades, 1);   // друга угода не має signalId
  assert.equal(channel.winRate, 100);
});

test('evaluationFunnel shows where signals die', async () => {
  const rows = await analytics.evaluationFunnel();
  const byDecision = Object.fromEntries(rows.map(r => [r.decision, r]));

  assert.equal(byDecision.SHADOW.count, 1);
  assert.equal(byDecision.SHADOW.inZoneCount, 1);
  assert.equal(byDecision.REJECTED.count, 1);
  assert.equal(byDecision.REJECTED.inZoneCount, 0);
});

test('rejection reasons collapse the numbers inside the text', async () => {
  // Тексти відмов містять конкретні числа, тож без нормалізації кожен рядок
  // був би унікальним і згрупувати їх не вийшло б.
  const rows = await analytics.rejectionReasons();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 1);
  assert.ok(rows[0].reasonPrefix.startsWith('SL would sit inside noise'));
});

test('equityCurve accumulates PnL in chronological order', async () => {
  const rows = await analytics.equityCurve();

  assert.equal(rows.length, 2);
  const last = rows.at(-1);
  assert.ok(Math.abs(last.cumulativePnl - 0.65) < 1e-9, `got ${last.cumulativePnl}`);
});
