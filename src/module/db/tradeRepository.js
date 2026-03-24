/**
 * tradeRepository.js
 *
 * Весь запис/читання в БД — в одному місці.
 * Решта системи імпортує тільки ці функції, не торкається моделей напряму.
 *
 * Принцип: функції тонкі, без бізнес-логіки.
 * Рахунки і агрегати → окремий аналітичний модуль.
 */

import { Op } from 'sequelize';
import { Signal, Trade, TradeEvent, SlHistory } from './database.js';
import { EVENT_TYPES } from './models/TradeEvent.js';
import { SL_MOVE_REASONS } from './models/SlHistory.js';
import { logger } from '../../shared/logger.js';

export { EVENT_TYPES, SL_MOVE_REASONS };

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNALS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Зберегти новий сигнал одразу після парсингу.
 *
 * @param {object} parsed  — результат signalParser.js
 * @param {number} [priceAtSignal]  — поточна mark price
 * @returns {Promise<Signal>}
 */
export async function saveSignal(parsed, priceAtSignal = null) {
  try {
    const signal = await Signal.create({
      signalId:      parsed.signalId   ?? null,
      symbol:        parsed.symbol,
      side:          parsed.side === 'BUY' ? 'LONG' : parsed.side === 'SELL' ? 'SHORT' : parsed.side,
      entryLow:      parsed.entryLow   ?? null,
      entryHigh:     parsed.entryHigh  ?? null,
      entryMid:      parsed.entryMid   ?? null,
      slPrice:       parsed.slPrice    ?? null,
      tpPrices:      parsed.tpPrices   ?? null,
      timeframe:     parsed.timeframe  ?? null,
      accuracy:      parsed.accuracy   ?? null,
      rawText:       parsed.rawText    ?? null,
      status:        'PENDING',
      priceAtSignal,
      receivedAt:    new Date(),
    });

    logger.debug('Signal saved', { id: signal.id, symbol: signal.symbol });
    return signal;

  } catch (err) {
    logger.error('saveSignal failed', { err: err.message, symbol: parsed.symbol });
    throw err;
  }
}

/**
 * Оновити статус сигналу після рішення confirmation.js
 *
 * @param {number} signalDbId  — signal.id з БД
 * @param {'TRADED'|'REJECTED'|'EXPIRED'|'CANCELLED'|'PAUSED'} status
 * @param {string} [rejectReason]
 */
export async function updateSignalStatus(signalDbId, status, rejectReason = null) {
  if (!signalDbId) return;
  try {
    await Signal.update(
      { status, rejectReason },
      { where: { id: signalDbId } }
    );
  } catch (err) {
    logger.error('updateSignalStatus failed', { err: err.message, signalDbId, status });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRADES — відкриття
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Зберегти нову угоду одразу після успішного openFullPosition().
 *
 * @param {object} p
 * @param {number}   [p.signalId]          signal.id (FK)
 * @param {string}   p.symbol
 * @param {string}   p.side                'LONG' | 'SHORT'
 * @param {string}   p.entryType           'LIMIT' | 'MARKET'
 * @param {number}   p.entryPrice          реальна ціна виконання
 * @param {number}   [p.entryPricePlanned] планова ціна з сигналу
 * @param {number}   p.slPrice
 * @param {number[]} p.tpPrices
 * @param {number}   p.quantity
 * @param {number}   p.leverage
 * @param {object}   [p.risk]              riskResult від calcFromBalance()
 * @param {number}   [p.balance]           баланс на момент входу
 * @param {string}   [p.interval]
 * @param {string}   [p.tradingMode]
 * @param {string}   [p.entryOrderId]
 * @param {string}   [p.slOrderId]
 * @returns {Promise<Trade>}
 */
export async function openTrade({
  signalId = null,
  symbol, side, entryType,
  entryPrice, entryPricePlanned = null,
  slPrice, tpPrices = [],
  quantity, leverage,
  risk = null,
  balance = null,
  interval = '15m',
  tradingMode = null,
  entryOrderId = null,
  slOrderId = null,
}) {
  try {
    const positionUsdt    = quantity * entryPrice;
    const riskPerTradeUsdt = risk?.realRiskUsdt ?? null;
    const riskPerTradePct  = (riskPerTradeUsdt && balance)
      ? (riskPerTradeUsdt / balance * 100)
      : null;

    const trade = await Trade.create({
      signalId,
      symbol,
      side,
      entryType,
      entryPrice,
      entryPricePlanned,
      slPriceInitial: slPrice,
      slPriceFinal:   null,
      tpPrices,
      tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false,
      quantity,
      positionUsdt,
      leverage,
      riskPerTradeUsdt,
      riskPerTradePct,
      balanceAtEntry: balance,
      exitPrice:      null,
      profitUsdt:     null,
      profitR:        null,
      profitPct:      null,
      maxDrawdownPct: null,
      maxProfitPct:   null,
      status:         'OPEN',
      closeReason:    null,
      openedAt:       new Date(),
      interval,
      tradingMode,
      entryOrderId,
      slOrderId,
    });

    logger.info('Trade opened in DB', { id: trade.id, symbol, side, entryPrice, leverage });

    // Записуємо початковий SL в sl_history
    await addSlMove({
      tradeId:      trade.id,
      reason:       SL_MOVE_REASONS.INITIAL,
      slPricePrev:  null,
      slPriceNew:   slPrice,
      markPrice:    entryPrice,
    });

    // Перша подія
    await addEvent({
      tradeId:   trade.id,
      eventType: EVENT_TYPES.TRADE_OPENED,
      price:     entryPrice,
      meta:      { entryType, leverage, quantity, tradingMode },
    });

    return trade;

  } catch (err) {
    logger.error('openTrade failed', { err: err.message, symbol });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRADES — оновлення під час угоди
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Відмітити досягнення TP рівня.
 *
 * @param {number} tradeId
 * @param {1|2|3|4} tpLevel
 * @param {number} markPrice
 */
export async function markTPHit(tradeId, tpLevel, markPrice) {
  const fieldMap = { 1: 'tp1Hit', 2: 'tp2Hit', 3: 'tp3Hit', 4: 'tp4Hit' };
  const eventMap = {
    1: EVENT_TYPES.TP1_HIT,
    2: EVENT_TYPES.TP2_HIT,
    3: EVENT_TYPES.TP3_HIT,
    4: EVENT_TYPES.TP4_HIT,
  };

  const field = fieldMap[tpLevel];
  if (!field) return;

  try {
    await Trade.update({ [field]: true }, { where: { id: tradeId } });
    await addEvent({ tradeId, eventType: eventMap[tpLevel], price: markPrice });
    logger.debug('TP hit marked', { tradeId, tpLevel, markPrice });
  } catch (err) {
    logger.error('markTPHit failed', { err: err.message, tradeId, tpLevel });
  }
}

/**
 * Записати часткове закриття.
 *
 * @param {number} tradeId
 * @param {number} fraction   0.0–1.0
 * @param {number} price      ціна закриття
 * @param {string} reason     наприклад 'tp1_hit', 'weak_momentum'
 * @param {number} [quantity] кількість в базовій монеті
 */
export async function recordPartialClose(tradeId, fraction, price, reason, quantity = null) {
  try {
    await Trade.update({ status: 'PARTIALLY_CLOSED' }, { where: { id: tradeId } });

    await addEvent({
      tradeId,
      eventType:      EVENT_TYPES.PARTIAL_CLOSE,
      price,
      closedFraction: fraction,
      closedQuantity: quantity,
      meta:           { reason },
    });
  } catch (err) {
    logger.error('recordPartialClose failed', { err: err.message, tradeId });
  }
}

/**
 * Оновити поточний peak/drawdown (викликати з positionMonitor кожен тік).
 *
 * @param {number} tradeId
 * @param {number} markPrice
 * @param {string} side       'LONG' | 'SHORT'
 * @param {number} entryPrice
 */
export async function updatePeakDrawdown(tradeId, markPrice, side, entryPrice) {
  try {
    const trade = await Trade.findByPk(tradeId, {
      attributes: ['maxDrawdownPct', 'maxProfitPct'],
    });
    if (!trade) return;

    const changePct = side === 'LONG'
      ? (markPrice - entryPrice) / entryPrice * 100
      : (entryPrice - markPrice) / entryPrice * 100;

    const updates = {};
    if (changePct < 0 && (trade.maxDrawdownPct === null || changePct < trade.maxDrawdownPct)) {
      updates.maxDrawdownPct = changePct;
    }
    if (changePct > 0 && (trade.maxProfitPct === null || changePct > trade.maxProfitPct)) {
      updates.maxProfitPct = changePct;
    }

    if (Object.keys(updates).length) {
      await Trade.update(updates, { where: { id: tradeId } });
    }
  } catch (err) {
    logger.error('updatePeakDrawdown failed', { err: err.message, tradeId });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRADES — закриття
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Закрити угоду і зафіксувати фінальний PnL.
 *
 * @param {number} tradeId
 * @param {object} p
 * @param {number}   p.exitPrice
 * @param {number}   p.profitUsdt
 * @param {number}   p.slPriceFinal
 * @param {string}   p.closeReason   — значення з ENUM моделі Trade
 * @param {string}   [p.notes]
 */
export async function closeTrade(tradeId, { exitPrice, profitUsdt, slPriceFinal, closeReason, notes = null }) {
  try {
    const trade = await Trade.findByPk(tradeId);
    if (!trade) {
      logger.warn('closeTrade: trade not found', { tradeId });
      return;
    }

    const now           = new Date();
    const timeInTradeMs = now - trade.openedAt;

    const profitR   = (profitUsdt != null && trade.riskPerTradeUsdt)
      ? profitUsdt / trade.riskPerTradeUsdt
      : null;

    const profitPct = (profitUsdt != null && trade.positionUsdt)
      ? profitUsdt / trade.positionUsdt * 100
      : null;

    await trade.update({
      status:         'CLOSED',
      closedAt:       now,
      timeInTradeMs,
      exitPrice,
      profitUsdt,
      profitR,
      profitPct,
      slPriceFinal,
      closeReason,
      notes,
    });

    await addEvent({
      tradeId,
      eventType: EVENT_TYPES.TRADE_CLOSED,
      price:     exitPrice,
      meta:      { closeReason, profitUsdt, profitR },
    });

    logger.info('Trade closed in DB', {
      tradeId, symbol: trade.symbol, profitUsdt, profitR: profitR?.toFixed(2), closeReason,
    });

  } catch (err) {
    logger.error('closeTrade failed', { err: err.message, tradeId });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRADE EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Додати довільну подію.
 *
 * @param {object} p
 * @param {number}   p.tradeId
 * @param {string}   p.eventType         EVENT_TYPES constant
 * @param {number}   [p.price]
 * @param {number}   [p.closedFraction]
 * @param {number}   [p.closedQuantity]
 * @param {number}   [p.slFrom]
 * @param {number}   [p.slTo]
 * @param {number}   [p.unrealisedPnlUsdt]
 * @param {object}   [p.meta]
 */
export async function addEvent({
  tradeId, eventType, price = null,
  closedFraction = null, closedQuantity = null,
  slFrom = null, slTo = null,
  unrealisedPnlUsdt = null, meta = null,
}) {
  try {
    await TradeEvent.create({
      tradeId, eventType, price,
      closedFraction, closedQuantity,
      slFrom, slTo,
      unrealisedPnlUsdt,
      meta,
      occurredAt: new Date(),
    });
  } catch (err) {
    logger.error('addEvent failed', { err: err.message, tradeId, eventType });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SL HISTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Записати переміщення SL.
 *
 * @param {object} p
 * @param {number}   p.tradeId
 * @param {string}   p.reason       SL_MOVE_REASONS constant
 * @param {number}   [p.slPricePrev]
 * @param {number}   p.slPriceNew
 * @param {number}   [p.markPrice]
 * @param {string}   [p.orderId]    новий Binance order ID
 */
export async function addSlMove({
  tradeId, reason, slPricePrev = null, slPriceNew, markPrice = null, orderId = null,
}) {
  try {
    const distanceFromPricePct = (markPrice && slPriceNew)
      ? Math.abs(markPrice - slPriceNew) / markPrice * 100
      : null;

    await SlHistory.create({
      tradeId, reason, slPricePrev, slPriceNew,
      markPrice, distanceFromPricePct, orderId,
      movedAt: new Date(),
    });

    // Також оновлюємо slPriceFinal в trade (rolling update)
    await Trade.update({ slPriceFinal: slPriceNew }, { where: { id: tradeId } });

    logger.debug('SL move recorded', { tradeId, reason, slPriceNew, markPrice });

  } catch (err) {
    logger.error('addSlMove failed', { err: err.message, tradeId, reason });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  READS — для команд бота і аналітики
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Знайти відкриту угоду по символу (для positionMonitor).
 */
export async function findOpenTrade(symbol) {
  return Trade.findOne({
    where:  { symbol, status: { [Op.in]: ['OPEN', 'PARTIALLY_CLOSED'] } },
    order:  [['openedAt', 'DESC']],
  });
}

/**
 * Всі відкриті угоди.
 */
export async function getOpenTrades() {
  return Trade.findAll({
    where: { status: { [Op.in]: ['OPEN', 'PARTIALLY_CLOSED'] } },
    order: [['openedAt', 'ASC']],
  });
}

/**
 * Угода з усіма подіями і SL-рухами (для детального аналізу).
 */
export async function getTradeWithHistory(tradeId) {
  return Trade.findByPk(tradeId, {
    include: [
      { model: TradeEvent, as: 'events',  order: [['occurredAt', 'ASC']] },
      { model: SlHistory,  as: 'slMoves', order: [['movedAt', 'ASC']] },
      { model: Signal,     as: 'signal' },
    ],
  });
}

/**
 * Прості агрегати для /status команди.
 *
 * @returns {{ totalTrades, wins, losses, avgProfitR, totalPnlUsdt }}
 */
export async function getTradeSummary() {
  const trades = await Trade.findAll({
    where:      { status: 'CLOSED', profitUsdt: { [Op.not]: null } },
    attributes: ['profitUsdt', 'profitR'],
  });

  const totalTrades  = trades.length;
  const wins         = trades.filter(t => t.profitUsdt > 0).length;
  const losses       = trades.filter(t => t.profitUsdt < 0).length;
  const totalPnlUsdt = trades.reduce((s, t) => s + (t.profitUsdt ?? 0), 0);
  const avgProfitR   = totalTrades
    ? trades.reduce((s, t) => s + (t.profitR ?? 0), 0) / totalTrades
    : 0;

  return { totalTrades, wins, losses, avgProfitR, totalPnlUsdt };
}