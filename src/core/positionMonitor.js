/**
 * positionMonitor.js
 *
 * Polling-монітор активних позицій.
 * Реалізує повну логіку управління позицією згідно плану:
 *
 *   TP1 hit → close 40% → SL to BE+
 *   TP2 hit → close 30% → SL to TP1
 *   TP3 hit → close 20% → SL to TP2
 *   TP4 hit → close 10% OR activate trailing
 *
 *   + Weak momentum  → extra partial close після TP1
 *   + Strong momentum → reallocate TP2 → TP3
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
  handleWeakMomentum,
  handleStrongMomentum,
  handleFakeBreakout,
  getMomentum,
} from '../exchanges/binance.js';
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
 *   tickCount:      number,
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
    tickCount:      0,
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
      tickCount:      meta.tickCount,
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
    logger.warn('restoreWatchlistFromDB: could not fetch live positions', { err: err.message });
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
        closeReason:  'sl_hit',
        notes:        'Closed while bot was offline',
      }).catch(err => logger.error('Failed to close stale trade', { err: err.message }));

      await addEvent({
        tradeId:   trade.id,
        eventType: EVENT_TYPES.POSITION_DISAPPEARED,
        meta:      { reason: 'bot_restart_not_found' },
      }).catch(() => {});

      skipped++;
      continue;
    }

    // Позиція жива — відновлюємо в watchlist
    // tpTriggered реконструюємо з tp1Hit..tp4Hit
    const tpCount     = trade.tpPrices?.length ?? 0;
    const tpTriggered = [trade.tp1Hit, trade.tp2Hit, trade.tp3Hit, trade.tp4Hit]
      .slice(0, tpCount);

    watchlist.set(trade.symbol, {
      side:           trade.side,
      entryPrice:     trade.entryPrice,
      slPrice:        trade.slPriceFinal ?? trade.slPriceInitial,
      tpPrices:       trade.tpPrices ?? [],
      tpTriggered,
      trailingActive: false,
      interval:       trade.interval ?? '15m',
      entryTime:      new Date(trade.openedAt).getTime(),
      timeoutCandles: 0,  // після перезапуску таймаут скидаємо — краще не виходити з позиції сліпо
      tickCount:      0,
      tp1Reached:     trade.tp1Hit ?? false,
      tradeId:        trade.id,
    });

    await addEvent({
      tradeId:   trade.id,
      eventType: EVENT_TYPES.TRADE_OPENED,
      meta:      { reason: 'restored_after_restart' },
    }).catch(() => {});

    logger.info('restoreWatchlistFromDB: restored', {
      tradeId: trade.id, symbol: trade.symbol, side: trade.side,
      sl: trade.slPriceFinal ?? trade.slPriceInitial,
      tpTriggered,
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
            closeReason:  'sl_hit',
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
        await checkTimeout(symbol, meta, markPrice);
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
  const tpDistribution = { 1: 0.40, 2: 0.30, 3: 0.20, 4: 0.10 };
  const closeFraction  = tpDistribution[tpLevel] ?? 0.25;

  // ── Крок 1: Закрити частку ──────────────────────────────────────────────────
  await partialClose(symbol, closeFraction, `tp${tpLevel}_hit`);
  logger.info(`TP${tpLevel}: closed ${closeFraction * 100}%`, { symbol, tpPrice });

  // Записати в БД
  if (meta.tradeId) {
    await markTPHit(meta.tradeId, tpLevel, markPrice)
      .catch(err => logger.error('markTPHit DB failed', { err: err.message }));
    await recordPartialClose(meta.tradeId, closeFraction, markPrice, `tp${tpLevel}_hit`)
      .catch(err => logger.error('recordPartialClose DB failed', { err: err.message }));
  }

  // ── Крок 2: Перенести SL ────────────────────────────────────────────────────
  const slResult = await moveSLAfterTP(symbol, tpLevel, meta.tpPrices);

  // Рахуємо новий SL і зберігаємо в sl_history
  const slReasonMap = {
    1: SL_MOVE_REASONS.BE_PLUS,
    2: SL_MOVE_REASONS.TP1,
    3: SL_MOVE_REASONS.TP2,
  };

  let newSLDescription = '';
  let newSLPrice       = meta.slPrice; // fallback

  if (tpLevel === 1) {
    meta.slPrice    = meta.entryPrice; // приблизно BE+
    newSLPrice      = meta.entryPrice;
    meta.tp1Reached = true;
    meta.tickCount  = 0;
    newSLDescription = 'BE+';
  } else if (tpLevel === 2) {
    meta.slPrice     = meta.tpPrices[0];
    newSLPrice       = meta.tpPrices[0];
    newSLDescription = `TP1 (${meta.tpPrices[0]})`;
  } else if (tpLevel === 3) {
    meta.slPrice     = meta.tpPrices[1];
    newSLPrice       = meta.tpPrices[1];
    newSLDescription = `TP2 (${meta.tpPrices[1]})`;
  } else if (tpLevel === 4) {
    meta.trailingActive = true;
    newSLDescription    = 'trailing ON';
    if (meta.tradeId) {
      await addEvent({
        tradeId:   meta.tradeId,
        eventType: EVENT_TYPES.TRAILING_ACTIVATED,
        price:     markPrice,
      }).catch(() => {});
    }
  }

  // Записати SL move якщо є відповідний reason (TP4 → trailing, не SL move)
  if (meta.tradeId && slReasonMap[tpLevel]) {
    const prevSL = tpLevel === 1 ? meta.slPrice : // вже оновлено — передаємо старе значення нижче
      tpLevel === 2 ? meta.tpPrices[0] : meta.tpPrices[1];

    await addSlMove({
      tradeId:     meta.tradeId,
      reason:      slReasonMap[tpLevel],
      slPricePrev: tpLevel === 1
        ? meta.entryPrice  // до BE+ slPrice зберігався як initial
        : meta.tpPrices[tpLevel - 2], // SL до цього кроку = попередній TP
      slPriceNew:  newSLPrice,
      markPrice,
      orderId:     slResult?.orderId?.toString() ?? null,
    }).catch(err => logger.error('addSlMove DB failed', { err: err.message }));
  }

  // ── Крок 3: Перевірити моментум ─────────────────────────────────────────────
  let momentumNote = '';
  try {
    const momentum = await getMomentum(symbol, meta.interval);

    if (tpLevel === 1 && momentum === 'weak') {
      await partialClose(symbol, 0.25, 'weak_momentum_after_tp1');
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

    if (tpLevel === 2 && momentum === 'strong' && meta.tpPrices[2]) {
      const reallocated = await handleStrongMomentum(
        symbol,
        meta.tpPrices[1],
        meta.tpPrices[2],
        meta.interval,
      );
      if (reallocated) {
        momentumNote = '\n🚀 Сильний моментум — частина реалокована в TP3';
        if (meta.tradeId) {
          await addEvent({
            tradeId:   meta.tradeId,
            eventType: EVENT_TYPES.MOMENTUM_STRONG,
            price:     markPrice,
            meta:      { momentum, tp2Price: meta.tpPrices[1], tp3Price: meta.tpPrices[2] },
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.warn('Momentum check failed', { symbol, err: err.message });
  }

  // ── Сповіщення ───────────────────────────────────────────────────────────────
  await notify(
    `🎯 *${symbol}* — TP${tpLevel} досягнуто\n` +
    `Ціна: \`${markPrice}\` / TP: \`${tpPrice}\`\n` +
    `Закрито: ${closeFraction * 100}% позиції\n` +
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
  if (!meta.timeoutCandles) return;

  meta.tickCount = (meta.tickCount ?? 0) + 1;

  if (meta.tickCount < meta.timeoutCandles) return;

  logger.warn('Position timeout — early exit', {
    symbol,
    tickCount:      meta.tickCount,
    timeoutCandles: meta.timeoutCandles,
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
      `⏱ *${symbol}* — timeout (${meta.timeoutCandles} тіків без руху)\n` +
      `Позицію закрито автоматично`
    );
  } catch (err) {
    logger.error('Early exit failed', { symbol, err: err.message });
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