/**
 * positionMonitor.js
 *
 * Polling-монітор активних позицій.
 * Реалізує повну логіку управління позицією згідно плану:
 *
 *   TP1 hit → close 40% → SL to BE+
 *   TP2 hit → close 30% of initial position → SL to TP1
 *   TP3 hit → close 20% of initial position → SL to TP2
 *   TP4 hit → keep the final runner and activate trailing
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
  getMarkPrice,
  moveSLAfterTP,
  activateTrailingStop,
  partialClose,
  getMomentum,
  updateStopLoss,
  cancelLegacyTakeProfitOrders,
} from '../exchanges/binance.js';
import {
  getTpCloseFraction,
  isPositionTimedOut,
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
    tpTriggered:    new Array(meta.tpPrices.length).fill(false),
    trailingActive: false,
    interval:       meta.interval       ?? '15m',
    entryTime:      Date.now(),
    timeoutCandles: meta.timeoutCandles ?? 0,
    tp1Reached:     false,
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

    // Remove TP orders created by older versions; monitor is now the only TP executor.
    await cancelLegacyTakeProfitOrders(trade.symbol)
      .catch(err => logger.warn('Could not cancel legacy TP orders', {
        symbol: trade.symbol,
        err: err.message,
      }));

    // Позиція жива — відновлюємо в watchlist
    // tpTriggered реконструюємо з tp1Hit..tp4Hit
    const tpCount     = trade.tpPrices?.length ?? 0;
    const tpTriggered = [trade.tp1Hit, trade.tp2Hit, trade.tp3Hit, trade.tp4Hit]
      .slice(0, tpCount);
    const trailingActive = tpCount > 0 && Boolean(tpTriggered[tpCount - 1]);

    watchlist.set(trade.symbol, {
      side:           trade.side,
      entryPrice:     trade.entryPrice,
      slPrice:        trade.slPriceFinal ?? trade.slPriceInitial,
      tpPrices:       trade.tpPrices ?? [],
      tpTriggered,
      trailingActive,
      interval:       trade.interval ?? '15m',
      entryTime:      new Date(trade.openedAt).getTime(),
      timeoutCandles: 0,  // після перезапуску таймаут скидаємо — краще не виходити з позиції сліпо
      tp1Reached:     trade.tp1Hit ?? false,
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
            closeReason:  'manual',
            notes:        'Position disappeared from exchange while monitoring',
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
    await processPosition(symbol, meta, markPrice);
  }

  // Видаляємо закриті позиції після завершення ітерації по Map
  for (const symbol of toRemove) {
    logger.info('Position closed, removing from watchlist', { symbol });
    watchlist.delete(symbol);
  }
}

// ─── Core position logic ──────────────────────────────────────────────────────

async function processPosition(symbol, meta, markPrice) {

  // 1. Trailing stop (активний після TP4)
  if (meta.trailingActive) {
    await runTrailing(symbol, meta, markPrice);
    return;
  }

  // 2. Перевірити TP-рівні в порядку від меншого до більшого
  for (let i = 0; i < meta.tpPrices.length; i++) {
    if (meta.tpTriggered[i]) continue;

    const tpPrice = meta.tpPrices[i];
    const tpLevel = i + 1; // 1-based

    const reached = meta.side === 'LONG'
      ? markPrice >= tpPrice
      : markPrice <= tpPrice;

    if (!reached) {
      // Якщо TP1 ще не досягнуто — перевіряємо timeout
      if (tpLevel === 1) {
        const timedOut = await checkTimeout(symbol, meta, markPrice);
        if (timedOut) return;
      }
      break; // вищі TP точно ще не досягнуто
    }

    // TP досягнуто
    meta.tpTriggered[i] = true;
    logger.info('TP level reached', { symbol, tpLevel, tpPrice, markPrice });

    try {
      await handleTPHit(symbol, meta, tpLevel, tpPrice, markPrice);
    } catch (err) {
      logger.error('Failed to handle TP hit', { symbol, tpLevel, err: err.message });
      meta.tpTriggered[i] = false; // retry next tick
      break;
    }
  }

  // 3. Fake breakout захист — тільки після TP1
  if (meta.tp1Reached) {
    await checkFakeBreakout(symbol, meta, markPrice);
  }

  watchlist.set(symbol, meta);
}

// ─── TP hit handler ───────────────────────────────────────────────────────────

async function handleTPHit(symbol, meta, tpLevel, tpPrice, markPrice) {
  const isFinalTp = tpLevel === meta.tpPrices.length;
  const closeFraction = getTpCloseFraction(tpLevel, meta.tpPrices.length);
  const prevSLBeforeMove = meta.slPrice;

  // TP4 hands the remaining runner to trailing instead of closing it.
  if (closeFraction > 0) {
    await partialClose(symbol, closeFraction, `tp${tpLevel}_hit`);
    logger.info(`TP${tpLevel}: closed ${(closeFraction * 100).toFixed(2)}% of remaining position`, {
      symbol,
      tpPrice,
    });
  }

  // Записати в БД
  if (meta.tradeId) {
    await markTPHit(meta.tradeId, tpLevel, markPrice)
      .catch(err => logger.error('markTPHit DB failed', { err: err.message }));
    if (closeFraction > 0) {
      await recordPartialClose(meta.tradeId, closeFraction, markPrice, `tp${tpLevel}_hit`)
        .catch(err => logger.error('recordPartialClose DB failed', { err: err.message }));
    }
  }

  // ── Крок 2: Перенести SL ────────────────────────────────────────────────────
  const slResult = isFinalTp ? null : await moveSLAfterTP(symbol, tpLevel, meta.tpPrices);

  // Рахуємо новий SL і зберігаємо в sl_history
  const slReasonMap = {
    1: SL_MOVE_REASONS.BE_PLUS,
    2: SL_MOVE_REASONS.TP1,
    3: SL_MOVE_REASONS.TP2,
  };

  let newSLDescription = '';
  let newSLPrice       = meta.slPrice; // fallback

  if (isFinalTp) {
    meta.trailingActive = true;
    newSLDescription = 'trailing ON';
    const trailingResult = await activateTrailingStop(symbol, meta.interval);
    if (trailingResult?.stopPrice != null) {
      meta.slPrice = parseFloat(trailingResult.stopPrice);
      newSLPrice = meta.slPrice;
      newSLDescription = `trailing (${meta.slPrice})`;
      if (meta.tradeId) {
        await addSlMove({
          tradeId: meta.tradeId,
          reason: SL_MOVE_REASONS.TRAILING,
          slPricePrev: prevSLBeforeMove,
          slPriceNew: meta.slPrice,
          markPrice,
          orderId: trailingResult.orderId?.toString() ?? null,
        }).catch(err => logger.error('addSlMove initial TRAILING failed', { err: err.message }));
      }
    }
    if (meta.tradeId) {
      await addEvent({
        tradeId:   meta.tradeId,
        eventType: EVENT_TYPES.TRAILING_ACTIVATED,
        price:     markPrice,
      }).catch(() => {});
    }
  } else if (tpLevel === 1) {
    const slFromExchange = slResult?.stopPrice != null ? parseFloat(slResult.stopPrice) : null;
    meta.slPrice    = slFromExchange ?? meta.entryPrice; // fallback якщо біржа не повернула stopPrice
    newSLPrice      = meta.slPrice;
    meta.tp1Reached = true;
    newSLDescription = 'BE+';
  } else if (tpLevel === 2) {
    meta.slPrice     = meta.tpPrices[0];
    newSLPrice       = meta.tpPrices[0];
    newSLDescription = `TP1 (${meta.tpPrices[0]})`;
  } else if (tpLevel === 3) {
    meta.slPrice     = meta.tpPrices[1];
    newSLPrice       = meta.tpPrices[1];
    newSLDescription = `TP2 (${meta.tpPrices[1]})`;
  }

  // Записати SL move для TP1-TP3; первинний trailing move записаний у TP4 branch.
  if (!isFinalTp && meta.tradeId && slReasonMap[tpLevel]) {
    await addSlMove({
      tradeId:     meta.tradeId,
      reason:      slReasonMap[tpLevel],
      slPricePrev: prevSLBeforeMove,
      slPriceNew:  newSLPrice,
      markPrice,
      orderId:     slResult?.orderId?.toString() ?? null,
    }).catch(err => logger.error('addSlMove DB failed', { err: err.message }));
  }

  // ── Крок 3: Перевірити моментум ─────────────────────────────────────────────
  let momentumNote = '';
  try {
    const momentum = await getMomentum(symbol, meta.interval, meta.side);

    if (tpLevel === 1 && momentum === 'weak') {
      await partialClose(symbol, 0.25, 'weak_momentum_after_tp1');
      await syncWatchedStopLoss(symbol, meta);
      momentumNote = '\n⚠️ Слабкий моментум — закрито ще 25%';
      logger.info('Weak momentum after TP1 — extra partial close', { symbol });

      if (meta.tradeId) {
        await recordPartialClose(meta.tradeId, 0.25, markPrice, 'weak_momentum_after_tp1')
          .catch(() => {});
        await addEvent({
          tradeId:   meta.tradeId,
          eventType: EVENT_TYPES.MOMENTUM_WEAK,
          price:     markPrice,
          meta:      { closedFraction: 0.25, momentum },
        }).catch(() => {});
      }
    }

    if (tpLevel === 2 && momentum === 'strong') {
      momentumNote = '\n🚀 Сильний моментум — runner залишається до TP3/trailing';
      if (meta.tradeId) {
        await addEvent({
          tradeId:   meta.tradeId,
          eventType: EVENT_TYPES.MOMENTUM_STRONG,
          price:     markPrice,
          meta:      { momentum, action: 'keep_runner' },
        }).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn('Momentum check failed', { symbol, err: err.message });
  }

  // ── Сповіщення ───────────────────────────────────────────────────────────────
  await notify(
    `🎯 *${symbol}* — TP${tpLevel} досягнуто\n` +
    `Ціна: \`${markPrice}\` / TP: \`${tpPrice}\`\n` +
    (closeFraction > 0
      ? `Закрито: ${(closeFraction * 100).toFixed(2)}% залишку позиції\n`
      : `Runner залишено відкритим\n`) +
    `SL → ${newSLDescription}` +
    momentumNote
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
  const result = await updateStopLoss(symbol, meta.slPrice, 'sync_after_partial_close');
  if (result?.stopPrice != null) {
    meta.slPrice = parseFloat(result.stopPrice);
  }
}
