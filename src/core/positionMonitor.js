/**
 * positionMonitor.js
 *
 * Polling-монітор активних позицій.
 * Реалізує повну логіку управління позицією згідно плану:
 *
 *   Binance executes TP1/TP2/TP3/TP4 at 45%/35%/15%/5%.
 *   Monitor observes actual fills, moves SL, and activates trailing after TP2.
 *
 *   + Weak momentum  → extra partial close після TP1
 *   + Strong momentum → keep runner toward TP3/trailing
 *   + Fake breakout  → extra partial close
 *   + Timeout        → early exit
 *
 * DB інтеграція:
 *   - watchPosition() приймає tradeId в meta (заповнює confirmation.js)
 *   - всі події записуються в trade_events і sl_history
 *   - при перезапуску restoreWatchlistFromDB() відновлює watchlist
 */

import {
  getOpenPositions,
  getOpenOrders,
  getOrder,
  getMarkPrice,
  moveSLAfterTP,
  activateTrailingStop,
  partialClose,
  getMomentumAssessment,
  syncProtectiveOrders,
  cancelAllOrders,
} from '../exchanges/binance.js';
import {
  expectedRemainingAfterTp,
  isPositionTimedOut,
  normalizedTpShares,
  updateReversalState,
} from './exitStrategy.js';
import { logger } from '../shared/logger.js';
import {
  findOpenTrade,
  getOpenTrades,
  markTPHit,
  recordPartialClose,
  addSlMove,
  addEvent,
  closeTrade,
  updatePeakDrawdown,
  EVENT_TYPES,
  SL_MOVE_REASONS,
} from '../module/db/tradeRepository.js';

// ─── Watchlist ────────────────────────────────────────────────────────────────

/**
 * Структура запису у watchlist:
 * {
 *   side:           'LONG' | 'SHORT',
 *   entryPrice:     number,
 *   slPrice:        number,
 *   tpPrices:       number[],
 *   tpOrders:       object[],
 *   initialQuantity:number,
 *   tpTriggered:    boolean[],
 *   trailingActive: boolean,
 *   interval:       string,
 *   entryTime:      number,
 *   timeoutCandles: number,
 *   tp1Reached:     boolean,
 *   tradeId:        number | null,   ← ID запису в таблиці trades (для DB)
 * }
 */
const watchlist = new Map();

let notifyCallback = null;
let intervalHandle = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Зареєструвати позицію для відстеження.
 *
 * @param {string} symbol
 * @param {object} meta
 * @param {string}   meta.side
 * @param {number}   meta.entryPrice
 * @param {number}   meta.slPrice
 * @param {number[]} meta.tpPrices
 * @param {string}   [meta.interval]
 * @param {number}   [meta.timeoutCandles]
 * @param {number}   [meta.tradeId]        ID рядка в таблиці trades
 */
export function watchPosition(symbol, meta) {
  if (!meta.tpPrices?.length) throw new Error(`watchPosition: tpPrices required for ${symbol}`);

  watchlist.set(symbol, {
    side:           meta.side,
    entryPrice:     meta.entryPrice,
    slPrice:        meta.slPrice,
    tpPrices:       [...meta.tpPrices],
    tpOrders:       [...(meta.tpOrders ?? [])],
    initialQuantity: meta.initialQuantity,
    tpTriggered:    new Array(meta.tpPrices.length).fill(false),
    trailingActive: false,
    interval:       meta.interval       ?? '15m',
    entryTime:      Date.now(),
    timeoutCandles: meta.timeoutCandles ?? 0,
    tp1Reached:     false,
    lastTrendCandleTime: null,
    weakTrendCount: 0,
    tradeId:        meta.tradeId        ?? null,
  });

  logger.info('Watching position', {
    symbol,
    side:      meta.side,
    entry:     meta.entryPrice,
    sl:        meta.slPrice,
    tpLevels:  meta.tpPrices,
    interval:  meta.interval ?? '15m',
    timeout:   meta.timeoutCandles ?? 0,
    tradeId:   meta.tradeId ?? null,
  });
}

/** Зняти позицію з відстеження */
export function unwatchPosition(symbol) {
  watchlist.delete(symbol);
  logger.info('Stopped watching', { symbol });
}

/** Синхронізувати SL після ручного переносу */
export function updateWatchedSL(symbol, newSlPrice) {
  const entry = watchlist.get(symbol);
  if (entry) {
    entry.slPrice = newSlPrice;
    watchlist.set(symbol, entry);
  }
}

/** Встановити Telegram-нотифікатор */
export function setNotifier(fn) {
  notifyCallback = fn;
}

/** Запустити polling */
export function startMonitor(intervalMs = 5000) {
  if (intervalHandle) return;
  logger.info('Position monitor started', { intervalMs });
  intervalHandle = setInterval(
    () => tick().catch(err => logger.error('Monitor tick error', { err: err.message })),
    intervalMs,
  );
}

/** Зупинити polling */
export function stopMonitor() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Position monitor stopped');
  }
}

/** Поточний watchlist (для /watch команди) */
export function getWatchlist() {
  const result = {};
  for (const [symbol, meta] of watchlist) {
    result[symbol] = {
      side:           meta.side,
      entryPrice:     meta.entryPrice,
      slPrice:        meta.slPrice,
      tpPrices:       meta.tpPrices,
      tpOrders:       meta.tpOrders,
      initialQuantity: meta.initialQuantity,
      tpTriggered:    meta.tpTriggered,
      trailingActive: meta.trailingActive,
      interval:       meta.interval,
      timeoutCandles: meta.timeoutCandles,
      tradeId:        meta.tradeId,
    };
  }
  return result;
}

/**
 * Відновити watchlist з БД після перезапуску.
 *
 * Читає всі угоди зі статусом OPEN або PARTIALLY_CLOSED,
 * перевіряє що позиція ще існує на біржі і додає в watchlist.
 *
 * Викликати в index.js після initDatabase() і startMonitor(),
 * але до запуску channel listener.
 */
export async function restoreWatchlistFromDB() {
  let openTrades;
  try {
    openTrades = await getOpenTrades();
  } catch (err) {
    logger.error('restoreWatchlistFromDB: failed to load trades', { err: err.message });
    return;
  }

  if (!openTrades.length) {
    logger.info('restoreWatchlistFromDB: no open trades in DB');
    return;
  }

  // Отримуємо поточні позиції з біржі для звірки
  let livePositions = [];
  try {
    livePositions = await getOpenPositions();
  } catch (err) {
    logger.error('restoreWatchlistFromDB: aborted because live positions are unavailable', {
      err: err.message,
    });
    return;
  }

  const liveSymbols = new Set(livePositions.map(p => p.symbol));

  let restored = 0;
  let skipped  = 0;

  for (const trade of openTrades) {
    if (!liveSymbols.has(trade.symbol)) {
      // Позиція в БД є, але на біржі вже закрита —
      // позначаємо як закриту (SL hit або ручне закриття поки бот не працював)
      logger.warn('restoreWatchlistFromDB: position not on exchange, marking closed', {
        tradeId: trade.id, symbol: trade.symbol,
      });
      await closeTrade(trade.id, {
        exitPrice:    null,  // ціна невідома — закрили поки бот спав
        profitUsdt:   null,
        slPriceFinal: trade.slPriceFinal ?? trade.slPriceInitial,
        closeReason:  'manual',
        notes:        'Closed while bot was offline',
      }).catch(err => logger.error('Failed to close stale trade', { err: err.message }));

      skipped++;
      continue;
    }

    // Позиція жива — відновлюємо в watchlist
    // tpTriggered реконструюємо з tp1Hit..tp4Hit
    const tpCount     = trade.tpPrices?.length ?? 0;
    const tpTriggered = [trade.tp1Hit, trade.tp2Hit, trade.tp3Hit, trade.tp4Hit]
      .slice(0, tpCount);
    const trailingActive = Boolean(trade.tp2Hit);
    const openOrders = await getOpenOrders(trade.symbol).catch(() => []);
    const tpOrders = (trade.tpPrices ?? []).map((price, index) => {
      const order = openOrders.find(candidate =>
        candidate.type === 'TAKE_PROFIT_MARKET' &&
        Math.abs(parseFloat(candidate.stopPrice) - price) <= price * 0.000001
      );
      return order ? {
        level: index + 1,
        price,
        quantity: parseFloat(order.origQty),
        orderId: order.orderId?.toString(),
      } : null;
    }).filter(Boolean);
    const expectedOpenTpCount = tpTriggered.filter(triggered => !triggered).length;
    let restoredTpOrders = tpOrders;
    if (expectedOpenTpCount > 0 && tpOrders.length !== expectedOpenTpCount) {
      const rebuilt = await syncProtectiveOrders({
        symbol: trade.symbol,
        slPrice: trade.slPriceFinal ?? trade.slPriceInitial,
        tpPrices: trade.tpPrices ?? [],
        tpTriggered,
      }).catch(err => {
        logger.error('Could not rebuild missing protective orders', {
          symbol: trade.symbol,
          err: err.message,
        });
        return null;
      });
      restoredTpOrders = rebuilt?.tps ?? [];
    }

    watchlist.set(trade.symbol, {
      side:           trade.side,
      entryPrice:     trade.entryPrice,
      slPrice:        trade.slPriceFinal ?? trade.slPriceInitial,
      tpPrices:       trade.tpPrices ?? [],
      tpOrders: restoredTpOrders,
      initialQuantity: trade.quantity,
      tpTriggered,
      trailingActive,
      interval:       trade.interval ?? '15m',
      entryTime:      new Date(trade.openedAt).getTime(),
      timeoutCandles: 0,  // після перезапуску таймаут скидаємо — краще не виходити з позиції сліпо
      tp1Reached:     trade.tp1Hit ?? false,
      lastTrendCandleTime: null,
      weakTrendCount: 0,
      tradeId:        trade.id,
    });

    logger.info('restoreWatchlistFromDB: restored', {
      tradeId: trade.id, symbol: trade.symbol, side: trade.side,
      sl: trade.slPriceFinal ?? trade.slPriceInitial,
      tpTriggered,
      trailingActive,
    });

    restored++;
  }

  logger.info('restoreWatchlistFromDB: complete', { restored, skipped });

  if (restored > 0) {
    await notify(
      `🔄 *Відновлено після перезапуску*\n` +
      `Активних позицій: *${restored}*` +
      (skipped ? `\nЗакрито поки бот спав: *${skipped}*` : '')
    );
  }
}

// ─── Internal tick ────────────────────────────────────────────────────────────

async function tick() {
  if (watchlist.size === 0) return;

  let livePositions;
  try {
    livePositions = await getOpenPositions();
  } catch (err) {
    logger.warn('Could not fetch positions', { err: err.message });
    return;
  }

  const liveSymbols = new Set(livePositions.map(p => p.symbol));
  const liveBySymbol = new Map(livePositions.map(position => [position.symbol, position]));
  const toRemove = [];

  for (const [symbol, meta] of watchlist) {

    // Позиція закрита — збираємо для видалення після циклу
    if (!liveSymbols.has(symbol)) {
      toRemove.push(symbol);

      // Отримати останню mark price для запису в БД
      let lastMarkPrice = null;
      try {
        lastMarkPrice = await getMarkPrice(symbol);
      } catch (_) { /* ігноруємо */ }

      const finalTpLevel = await reconcileClosedPositionTpFills(symbol, meta, lastMarkPrice);
      await cancelAllOrders(symbol).catch(err => logger.warn('Could not cancel remaining orders', {
        symbol,
        err: err.message,
      }));

      if (meta.tradeId) {
        await addEvent({
          tradeId:   meta.tradeId,
          eventType: EVENT_TYPES.POSITION_DISAPPEARED,
          price:     lastMarkPrice,
          meta:      { slPrice: meta.slPrice },
        }).catch(err => logger.error('addEvent POSITION_DISAPPEARED failed', { err: err.message }));

        // Перевіряємо статус в БД перед закриттям (може вже закрита через closeTrade вище)
        const openRecord = await findOpenTrade(symbol).catch(() => null);
        if (openRecord) {
          await closeTrade(openRecord.id, {
            exitPrice:    lastMarkPrice,
            profitUsdt:   null,
            slPriceFinal: meta.slPrice,
            closeReason:  finalTpLevel ? `tp${finalTpLevel}` : 'manual',
            notes: finalTpLevel
              ? `Position closed by Binance TP${finalTpLevel}`
              : 'Position disappeared from exchange while monitoring',
          }).catch(err => logger.error('closeTrade on disappear failed', { err: err.message }));
        }
      }

      await notify(`✅ *${symbol}* — позицію закрито`);
      continue;
    }

    let markPrice;
    try {
      markPrice = await getMarkPrice(symbol);
    } catch (err) {
      logger.warn('Could not fetch mark price', { symbol, err: err.message });
      continue;
    }

    // Оновлюємо peak/drawdown кожен тік
    if (meta.tradeId) {
      await updatePeakDrawdown(meta.tradeId, markPrice, meta.side, meta.entryPrice)
        .catch(err => logger.warn('updatePeakDrawdown failed', { err: err.message }));
    }

    // Основна логіка — по порядку з плану
    await processPosition(symbol, meta, markPrice, liveBySymbol.get(symbol));
  }

  // Видаляємо закриті позиції після завершення ітерації по Map
  for (const symbol of toRemove) {
    logger.info('Position closed, removing from watchlist', { symbol });
    watchlist.delete(symbol);
  }
}

// ─── Core position logic ──────────────────────────────────────────────────────

async function processPosition(symbol, meta, markPrice, livePosition) {
  await observeTpFills(symbol, meta, markPrice, livePosition);

  if (!meta.tpTriggered[0]) {
    const exited = await checkPreTpReversal(symbol, meta, markPrice);
    if (exited) return;
    const timedOut = await checkTimeout(symbol, meta, markPrice);
    if (timedOut) return;
  }

  if (meta.tp1Reached) {
    await checkFakeBreakout(symbol, meta, markPrice);
  }

  if (meta.trailingActive) {
    await runTrailing(symbol, meta, markPrice);
  }

  watchlist.set(symbol, meta);
}

// ─── TP hit handler ───────────────────────────────────────────────────────────

async function observeTpFills(symbol, meta, markPrice, livePosition) {
  for (let i = 0; i < meta.tpPrices.length; i++) {
    if (meta.tpTriggered[i]) continue;

    const tpLevel = i + 1;
    const trackedOrder = meta.tpOrders.find(order => order.level === tpLevel);
    let filledOrder = null;

    if (trackedOrder?.orderId) {
      const order = await getOrder(symbol, trackedOrder.orderId).catch(() => null);
      if (order?.status !== 'FILLED') break;
      filledOrder = order;
    } else {
      const shares = normalizedTpShares(meta.tpPrices.length);
      const expectedRemaining = expectedRemainingAfterTp(tpLevel, meta.initialQuantity, shares);
      const tolerance = Math.max(meta.initialQuantity * 0.002, 1e-12);
      if (!livePosition || livePosition.size > expectedRemaining + tolerance) break;
    }

    meta.tpTriggered[i] = true;
    await handleObservedTPHit(symbol, meta, tpLevel, meta.tpPrices[i], markPrice, filledOrder);
  }
}

async function reconcileClosedPositionTpFills(symbol, meta, markPrice) {
  let finalTpLevel = null;

  for (let i = 0; i < meta.tpPrices.length; i++) {
    if (meta.tpTriggered[i]) {
      finalTpLevel = i + 1;
      continue;
    }

    const tpLevel = i + 1;
    const trackedOrder = meta.tpOrders.find(order => order.level === tpLevel);
    if (!trackedOrder?.orderId) break;

    const order = await getOrder(symbol, trackedOrder.orderId).catch(() => null);
    if (order?.status !== 'FILLED') break;

    meta.tpTriggered[i] = true;
    finalTpLevel = tpLevel;
    const filledQuantity = parseFloat(order.executedQty || order.origQty || 0) || null;
    const shares = normalizedTpShares(meta.tpPrices.length);

    if (meta.tradeId) {
      await markTPHit(meta.tradeId, tpLevel, markPrice)
        .catch(err => logger.error('markTPHit reconciliation failed', { err: err.message }));
      await recordPartialClose(
        meta.tradeId,
        shares[i],
        markPrice,
        `tp${tpLevel}_filled_on_binance`,
        filledQuantity,
      ).catch(err => logger.error('recordPartialClose reconciliation failed', { err: err.message }));
    }
  }

  return finalTpLevel === meta.tpPrices.length ? finalTpLevel : null;
}

async function handleObservedTPHit(symbol, meta, tpLevel, tpPrice, markPrice, filledOrder) {
  const prevSLBeforeMove = meta.slPrice;
  const filledQuantity = parseFloat(filledOrder?.executedQty || filledOrder?.origQty || 0) || null;
  const shares = normalizedTpShares(meta.tpPrices.length);

  if (meta.tradeId) {
    await markTPHit(meta.tradeId, tpLevel, markPrice)
      .catch(err => logger.error('markTPHit DB failed', { err: err.message }));
    await recordPartialClose(
      meta.tradeId,
      shares[tpLevel - 1],
      markPrice,
      `tp${tpLevel}_filled_on_binance`,
      filledQuantity,
    ).catch(err => logger.error('recordPartialClose DB failed', { err: err.message }));
  }

  let slResult = null;
  let newSLDescription = 'unchanged';
  if (tpLevel === 1) {
    slResult = await moveSLAfterTP(symbol, 1, meta.tpPrices);
    const slFromExchange = slResult?.stopPrice != null ? parseFloat(slResult.stopPrice) : null;
    meta.slPrice = slFromExchange ?? meta.entryPrice;
    meta.tp1Reached = true;
    newSLDescription = 'BE+';
    await recordSlMove(meta, prevSLBeforeMove, markPrice, slResult, SL_MOVE_REASONS.BE_PLUS);

    const assessment = await getMomentumAssessment(symbol, meta.interval, meta.side).catch(() => null);
    if (assessment?.status === 'weak') {
      await partialClose(symbol, 0.25, 'weak_momentum_after_tp1');
      await syncWatchedStopLoss(symbol, meta);
      if (meta.tradeId) {
        await recordPartialClose(meta.tradeId, 0.25, markPrice, 'weak_momentum_after_tp1')
          .catch(() => {});
        await addEvent({
          tradeId: meta.tradeId,
          eventType: EVENT_TYPES.MOMENTUM_WEAK,
          price: markPrice,
          meta: { action: 'extra_close_after_tp1', closedFraction: 0.25 },
        }).catch(() => {});
      }
      newSLDescription += ' + weak momentum extra close 25%';
    }
  } else if (tpLevel === 2 && !meta.trailingActive) {
    slResult = await moveSLAfterTP(symbol, 2, meta.tpPrices);
    meta.slPrice = parseFloat(slResult?.stopPrice ?? meta.tpPrices[0]);
    newSLDescription = `TP1 (${meta.slPrice}) + trailing`;
    await recordSlMove(meta, prevSLBeforeMove, markPrice, slResult, SL_MOVE_REASONS.TP1);
    meta.trailingActive = true;
    if (meta.tradeId) {
      await addEvent({
        tradeId: meta.tradeId,
        eventType: EVENT_TYPES.TRAILING_ACTIVATED,
        price: markPrice,
        meta: { afterTp: 2 },
      }).catch(() => {});
    }
  }

  await notify(
    `🎯 *${symbol}* — TP${tpLevel} виконано на Binance\n` +
    `TP: \`${tpPrice}\`${filledQuantity ? ` | Qty: \`${filledQuantity}\`` : ''}\n` +
    `SL → ${newSLDescription}` +
    (tpLevel === 2 ? '\n🔄 ATR trailing активовано' : '')
  );
}

// ─── Trailing ─────────────────────────────────────────────────────────────────

async function runTrailing(symbol, meta, markPrice) {
  try {
    const result = await activateTrailingStop(symbol, meta.interval);
    if (result) {
      logger.info('Trailing SL updated', { symbol });
      if (result.stopPrice) {
        const prevSL   = meta.slPrice;
        const newSL    = parseFloat(result.stopPrice);
        meta.slPrice   = newSL;
        watchlist.set(symbol, meta);

        if (meta.tradeId) {
          await addSlMove({
            tradeId:     meta.tradeId,
            reason:      SL_MOVE_REASONS.TRAILING,
            slPricePrev: prevSL,
            slPriceNew:  newSL,
            markPrice,
            orderId:     result.orderId?.toString() ?? null,
          }).catch(err => logger.error('addSlMove TRAILING failed', { err: err.message }));
        }

        await notify(`🔄 *${symbol}* — trailing SL → \`${result.stopPrice}\``);
      }
    }
  } catch (err) {
    logger.error('Trailing stop failed', { symbol, err: err.message });
  }
}

// ─── Timeout / early exit ─────────────────────────────────────────────────────

async function checkTimeout(symbol, meta, markPrice) {
  if (!isPositionTimedOut({
    entryTime: meta.entryTime,
    timeoutCandles: meta.timeoutCandles,
    interval: meta.interval,
  })) return false;

  logger.warn('Position timeout — early exit', {
    symbol,
    timeoutCandles: meta.timeoutCandles,
    interval:       meta.interval,
  });

  try {
    await partialClose(symbol, 1, 'early_exit_timeout');
    await cancelAllOrders(symbol).catch(() => {});
    watchlist.delete(symbol);

    if (meta.tradeId) {
      await recordPartialClose(meta.tradeId, 1.0, markPrice, 'early_exit_timeout')
        .catch(() => {});
      await closeTrade(meta.tradeId, {
        exitPrice:    markPrice,
        profitUsdt:   null,
        slPriceFinal: meta.slPrice,
        closeReason:  'early_exit_timeout',
      }).catch(err => logger.error('closeTrade timeout failed', { err: err.message }));
    }

    await notify(
      `⏱ *${symbol}* — timeout (${meta.timeoutCandles} × ${meta.interval} без TP1)\n` +
      `Позицію закрито автоматично`
    );
    return true;
  } catch (err) {
    logger.error('Early exit failed', { symbol, err: err.message });
    return false;
  }
}

async function checkPreTpReversal(symbol, meta, markPrice) {
  try {
    const assessment = await getMomentumAssessment(symbol, meta.interval, meta.side);
    const reversal = updateReversalState({
      previousCandleTime: meta.lastTrendCandleTime,
      weakCount: meta.weakTrendCount,
      assessment,
    });
    meta.lastTrendCandleTime = reversal.candleTime;
    meta.weakTrendCount = reversal.weakCount;

    if (!reversal.shouldExit) return false;

    logger.warn('Pre-TP reversal confirmed', { symbol, assessment, weakCount: reversal.weakCount });
    await partialClose(symbol, 1, 'pre_tp_reversal');
    await cancelAllOrders(symbol).catch(() => {});
    watchlist.delete(symbol);

    if (meta.tradeId) {
      await addEvent({
        tradeId: meta.tradeId,
        eventType: EVENT_TYPES.MOMENTUM_WEAK,
        price: markPrice,
        meta: { action: 'pre_tp_reversal_exit', weakCount: reversal.weakCount },
      }).catch(() => {});
      await closeTrade(meta.tradeId, {
        exitPrice: markPrice,
        profitUsdt: null,
        slPriceFinal: meta.slPrice,
        closeReason: 'weak_momentum',
        notes: 'Closed before TP1 after two consecutive adverse closed candles',
      }).catch(() => {});
    }

    await notify(`⚠️ *${symbol}* — підтверджено розворот до TP1\nПозицію закрито`);
    return true;
  } catch (err) {
    logger.warn('Pre-TP reversal check failed', { symbol, err: err.message });
    return false;
  }
}

// ─── Fake breakout ────────────────────────────────────────────────────────────

async function checkFakeBreakout(symbol, meta, markPrice) {
  const returnedToEntry = meta.side === 'LONG'
    ? markPrice <= meta.entryPrice
    : markPrice >= meta.entryPrice;

  if (!returnedToEntry) return;

  logger.warn('Fake breakout detected', { symbol, markPrice, entryPrice: meta.entryPrice });

  // Вимикаємо прапор ДО виклику — щоб не спрацьовувало щотіку
  meta.tp1Reached = false;

  try {
    await partialClose(symbol, 0.25, 'fake_breakout_protection');
    await syncWatchedStopLoss(symbol, meta);

    if (meta.tradeId) {
      await recordPartialClose(meta.tradeId, 0.25, markPrice, 'fake_breakout_protection')
        .catch(() => {});
      await addEvent({
        tradeId:   meta.tradeId,
        eventType: EVENT_TYPES.FAKE_BREAKOUT_DETECTED,
        price:     markPrice,
        meta:      { entryPrice: meta.entryPrice },
      }).catch(() => {});
    }

    await notify(
      `⚡ *${symbol}* — фейковий пробій\n` +
      `Ціна повернулась до entry \`${meta.entryPrice}\`\n` +
      `Закрито додаткові 25%`
    );
  } catch (err) {
    logger.error('Fake breakout handler failed', { symbol, err: err.message });
  }
}

// ─── Notify helper ────────────────────────────────────────────────────────────

async function notify(message) {
  if (!notifyCallback) return;
  try {
    await notifyCallback(message);
  } catch (err) {
    logger.error('Notify failed', { err: err.message });
  }
}

async function syncWatchedStopLoss(symbol, meta) {
  const result = await syncProtectiveOrders({
    symbol,
    slPrice: meta.slPrice,
    tpPrices: meta.tpPrices,
    tpTriggered: meta.tpTriggered,
  });
  meta.tpOrders = result.tps;
  if (result.sl?.stopPrice != null) meta.slPrice = parseFloat(result.sl.stopPrice);
}

async function recordSlMove(meta, previousSl, markPrice, result, reason) {
  if (!meta.tradeId) return;
  await addSlMove({
    tradeId: meta.tradeId,
    reason,
    slPricePrev: previousSl,
    slPriceNew: meta.slPrice,
    markPrice,
    orderId: result?.orderId?.toString() ?? null,
  }).catch(err => logger.error('addSlMove failed', { err: err.message }));
}
