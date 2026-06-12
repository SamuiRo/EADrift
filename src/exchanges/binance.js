import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../shared/logger.js';
import {
  BINANCE_TESTNET,
  BINANCE_SECRET_KEY,
  BINANCE_API_KEY,
} from '../config/app.config.js';
import {
  calculateATR,
  calculateTrailingStop,
  classifyMomentum,
  allocateTpQuantities,
  roundTrailingStop,
  normalizedTpShares,
} from '../core/exitStrategy.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = BINANCE_TESTNET
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

/**
 * Після якого TP куди переносити SL (план, розділ 3).
 *   tp1 hit → BE+offset
 *   tp2 hit → TP1 price
 *   tp3 hit → TP2 price
 *   tp4 hit → trailing
 */
const BE_OFFSET_TICKS = 3; // відступ від entry для BE+

// ─── Request signing ──────────────────────────────────────────────────────────

function sign(queryString) {
  return crypto
    .createHmac('sha256', BINANCE_SECRET_KEY)
    .update(queryString)
    .digest('hex');
}

function buildSignedParams(params = {}) {
  const merged = { ...params, timestamp: Date.now() };
  const qs = new URLSearchParams(merged).toString();
  return `${qs}&signature=${sign(qs)}`;
}

const authHeaders = () => ({
  'X-MBX-APIKEY': BINANCE_API_KEY,
  'Content-Type': 'application/x-www-form-urlencoded',
});

// ─── HTTP helpers (всі з логуванням) ─────────────────────────────────────────

async function get(path, params = {}) {
  const qs = buildSignedParams(params);
  const url = `${BASE_URL}${path}?${qs}`;
  try {
    const { data } = await axios.get(url, { headers: authHeaders() });
    return data;
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`Binance GET ${path} failed`, { msg, params });
    throw new Error(`Binance error [GET ${path}]: ${msg}`);
  }
}

async function publicGet(path, params = {}) {
  const url = `${BASE_URL}${path}`;
  try {
    const { data } = await axios.get(url, { params });
    return data;
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`Binance PUBLIC GET ${path} failed`, { msg, params });
    throw new Error(`Binance error [GET ${path}]: ${msg}`);
  }
}

async function post(path, params = {}) {
  const body = buildSignedParams(params);
  try {
    const { data } = await axios.post(`${BASE_URL}${path}`, body, {
      headers: authHeaders(),
    });
    return data;
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`Binance POST ${path} failed`, { msg, params });
    throw new Error(`Binance error [POST ${path}]: ${msg}`);
  }
}

async function del(path, params = {}) {
  const qs = buildSignedParams(params);
  const url = `${BASE_URL}${path}?${qs}`;
  try {
    const { data } = await axios.delete(url, { headers: authHeaders() });
    return data;
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`Binance DELETE ${path} failed`, { msg, params });
    throw new Error(`Binance error [DELETE ${path}]: ${msg}`);
  }
}

// ─── Market data ──────────────────────────────────────────────────────────────

/**
 * Поточна mark price символу.
 */
export async function getMarkPrice(symbol) {
  const data = await publicGet('/fapi/v1/premiumIndex', { symbol });
  return parseFloat(data.markPrice);
}

/**
 * Exchange info — precision, tickSize, stepSize, minNotional.
 * Кешується в пам'яті на 5 хвилин щоб не тягнути весь exchangeInfo (~300 символів) кожен раз.
 */
const symbolInfoCache = new Map(); // symbol → { data, expiresAt }
const SYMBOL_INFO_TTL_MS = 5 * 60 * 1000; // 5 хвилин

export async function getSymbolInfo(symbol) {
  const cached = symbolInfoCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const data = await publicGet('/fapi/v1/exchangeInfo');
  const info = data.symbols.find(s => s.symbol === symbol);
  if (!info) throw new Error(`Symbol ${symbol} not found on exchange`);

  const priceFilter   = info.filters.find(f => f.filterType === 'PRICE_FILTER');
  const lotFilter     = info.filters.find(f => f.filterType === 'LOT_SIZE');
  const minNotional   = info.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  const result = {
    symbol,
    pricePrecision:    info.pricePrecision,
    quantityPrecision: info.quantityPrecision,
    tickSize:          parseFloat(priceFilter?.tickSize   || '0.01'),
    stepSize:          parseFloat(lotFilter?.stepSize     || '0.001'),
    minNotional:       parseFloat(minNotional?.notional   || '5'),
  };

  symbolInfoCache.set(symbol, { data: result, expiresAt: Date.now() + SYMBOL_INFO_TTL_MS });
  return result;
}

/**
 * ATR (середній true range) за N свічок.
 * Використовується для трейлінгу та фільтру моментуму.
 *
 * @param {string} symbol
 * @param {string} interval   '1m' | '5m' | '15m' | '30m' | '1h' | ...
 * @param {number} [period=14]
 */
export async function getATR(symbol, interval, period = 14) {
  const data = await publicGet('/fapi/v1/klines', {
    symbol,
    interval,
    limit: period + 2,
  });

  // Binance returns the currently forming candle last; trailing uses closed candles only.
  return calculateATR(data.slice(0, -1).map(toCandle), period);
}

/**
 * Перевіряє чи є моментум сильним (план, розділ 5).
 * Повертає 'strong' | 'weak' | 'neutral'
 *
 * @param {string} symbol
 * @param {string} interval
 */
export async function getMomentum(symbol, interval = '15m', side = null) {
  return (await getMomentumAssessment(symbol, interval, side)).status;
}

export async function getMomentumAssessment(symbol, interval = '15m', side = null) {
  const data = await publicGet('/fapi/v1/klines', {
    symbol,
    interval,
    limit: 7,
  });

  const closed = data.slice(0, -1);
  return {
    status: classifyMomentum(closed.map(toCandle), side),
    candleTime: Number(closed.at(-1)?.[6] ?? closed.at(-1)?.[0]),
  };
}

function toCandle(candle) {
  return {
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
  };
}

// ─── Account ──────────────────────────────────────────────────────────────────

export async function getAccountBalance() {
  const data = await get('/fapi/v2/balance');
  return data.filter(b => parseFloat(b.balance) > 0);
}

// ─── Positions ────────────────────────────────────────────────────────────────

export async function getOpenPositions() {
  const data = await get('/fapi/v2/positionRisk');
  return data
    .filter(p => parseFloat(p.positionAmt) !== 0)
    .map(p => ({
      symbol:        p.symbol,
      side:          parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
      size:          Math.abs(parseFloat(p.positionAmt)),
      entryPrice:    parseFloat(p.entryPrice),
      markPrice:     parseFloat(p.markPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
      leverage:      parseInt(p.leverage),
      liquidPrice:   parseFloat(p.liquidationPrice),
      marginType:    p.marginType,
    }));
}

export async function getPosition(symbol) {
  const positions = await getOpenPositions();
  return positions.find(p => p.symbol === symbol) || null;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function getOpenOrders(symbol = null) {
  return get('/fapi/v1/openOrders', symbol ? { symbol } : {});
}

export async function getOrder(symbol, orderId) {
  return get('/fapi/v1/order', { symbol, orderId });
}

/**
 * Розмістити ринковий або лімітний ордер.
 */
export async function placeOrder({
  symbol,
  side,
  type,
  quantity,
  price,
  reduceOnly = false,
}) {
  const info = await getSymbolInfo(symbol);
  const qty  = quantity.toFixed(info.quantityPrecision);

  const params = {
    symbol,
    side,
    type,
    quantity: qty,
    reduceOnly: reduceOnly ? 'true' : 'false',
  };

  if (type === 'LIMIT') {
    if (!price) throw new Error('LIMIT order requires price');
    params.price       = price.toFixed(info.pricePrecision);
    params.timeInForce = 'GTC';
  }

  logger.info('Placing order', params);
  const result = await post('/fapi/v1/order', params);
  logger.info('Order placed', { orderId: result.orderId, symbol, side, type });
  return result;
}

/** Stop-Loss ордер (STOP_MARKET), який завжди закриває актуальний залишок позиції. */
export async function placeStopLoss({ symbol, side, stopPrice }) {
  const info = await getSymbolInfo(symbol);

  const params = {
    symbol,
    side,
    type:        'STOP_MARKET',
    stopPrice:   stopPrice.toFixed(info.pricePrecision),
    closePosition: 'true',
    workingType: 'MARK_PRICE',
    priceProtect: 'TRUE',
  };

  logger.info('Placing SL', { symbol, side, stopPrice, closePosition: true });
  const result = await post('/fapi/v1/order', params);
  logger.info('SL placed', { orderId: result.orderId, symbol, stopPrice });
  return result;
}

export async function placeTakeProfit({ symbol, side, stopPrice, quantity }) {
  const info = await getSymbolInfo(symbol);
  if (!quantity) throw new Error('placeTakeProfit: quantity is required');

  return post('/fapi/v1/order', {
    symbol,
    side,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: stopPrice.toFixed(info.pricePrecision),
    quantity: quantity.toFixed(info.quantityPrecision),
    reduceOnly: 'true',
    workingType: 'MARK_PRICE',
    priceProtect: 'TRUE',
  });
}

export async function cancelOrder(symbol, orderId) {
  logger.info('Cancelling order', { symbol, orderId });
  return del('/fapi/v1/order', { symbol, orderId });
}

export async function cancelAllOrders(symbol) {
  logger.info('Cancelling all orders', { symbol });
  return del('/fapi/v1/allOpenOrders', { symbol });
}

// ─── SL management ────────────────────────────────────────────────────────────

/**
 * Оновити SL: скасувати старий, виставити новий.
 *
 * @param {string} symbol
 * @param {number} newStopPrice
 * @param {string} [reason]
 */
export async function updateStopLoss(symbol, newStopPrice, reason = 'manual') {
  const position = await getPosition(symbol);
  if (!position) throw new Error(`No open position for ${symbol}`);

  const openOrders = await getOpenOrders(symbol);
  const existingStopOrders = openOrders.filter(o => o.type === 'STOP_MARKET');
  const existingSL = existingStopOrders[0];

  for (const stopOrder of existingStopOrders) {
    await cancelOrder(symbol, stopOrder.orderId);
  }
  if (existingStopOrders.length > 0) {
    logger.info('Old SL orders cancelled', {
      symbol,
      count: existingStopOrders.length,
      oldSL: existingSL.stopPrice,
      reason,
    });
  }

  const slSide = position.side === 'LONG' ? 'SELL' : 'BUY';

  let result;
  try {
    result = await placeStopLoss({
      symbol,
      side:      slSide,
      stopPrice: newStopPrice,
    });
  } catch (err) {
    if (existingSL?.stopPrice) {
      await placeStopLoss({
        symbol,
        side: slSide,
        stopPrice: parseFloat(existingSL.stopPrice),
      }).catch(restoreErr => logger.error('Failed to restore previous SL', {
        symbol,
        err: restoreErr.message,
      }));
    }
    throw err;
  }

  logger.info('SL updated', { symbol, newSL: newStopPrice, reason, orderId: result.orderId });
  return result;
}

/**
 * Перенести SL в Break-Even+ (план, розділ 3 — TP1 hit).
 * BE+ = entry + BE_OFFSET_TICKS * tickSize для LONG,
 *        entry - BE_OFFSET_TICKS * tickSize для SHORT.
 */
export async function moveSLtoBreakEven(symbol) {
  const position = await getPosition(symbol);
  if (!position) throw new Error(`No open position for ${symbol}`);

  const info   = await getSymbolInfo(symbol);
  const buffer = BE_OFFSET_TICKS * info.tickSize;

  const bePrice = position.side === 'LONG'
    ? position.entryPrice + buffer
    : position.entryPrice - buffer;

  return updateStopLoss(symbol, bePrice, 'move_to_BE+');
}

/**
 * Автоматичний перенос SL після досягнення TP-рівня (план, розділ 3).
 *
 *   TP1 hit → SL = entry + BE_offset
 *   TP2 hit → SL = TP1 price
 *   TP3 hit → SL = TP2 price
 *
 * @param {string}   symbol
 * @param {number}   tpLevel      1 | 2 | 3
 * @param {number[]} tpPrices     масив [TP1, TP2, TP3, TP4] (0-based index → TP tpPrices[0]=TP1)
 */
export async function moveSLAfterTP(symbol, tpLevel, tpPrices) {
  if (!tpPrices || tpPrices.length < tpLevel) {
    throw new Error(`moveSLAfterTP: tpPrices must have at least ${tpLevel} elements`);
  }

  logger.info('Moving SL after TP hit', { symbol, tpLevel });

  switch (tpLevel) {
    case 1:
      // SL → BE+
      return moveSLtoBreakEven(symbol);

    case 2:
      // SL → TP1 price
      return updateStopLoss(symbol, tpPrices[0], 'trail_TP2→TP1');

    case 3:
      // SL → TP2 price
      return updateStopLoss(symbol, tpPrices[1], 'trail_TP3→TP2');

    default:
      throw new Error(`Unknown tpLevel: ${tpLevel}`);
  }
}

/**
 * Trailing stop через ATR (план, розділ 4).
 * Активується після TP2.
 *
 * Логіка: SL = max(currentSL, markPrice - ATR * multiplier)
 * Викликати по кожному тіку/моніторингу поки позиція відкрита.
 *
 * @param {string} symbol
 * @param {string} interval       таймфрейм для ATR ('15m', '1h', ...)
 * @param {number} [multiplier=1.5]
 */
export async function activateTrailingStop(symbol, interval = '15m', multiplier = 1.5) {
  const position = await getPosition(symbol);
  if (!position) {
    logger.warn('activateTrailingStop: no open position', { symbol });
    return null;
  }

  const [markPrice, atr] = await Promise.all([
    getMarkPrice(symbol),
    getATR(symbol, interval),
  ]);

  const info = await getSymbolInfo(symbol);

  // Новий trailing SL
  const trailPrice = calculateTrailingStop({
    side: position.side,
    markPrice,
    atr,
    multiplier,
  });

  // Беремо поточний SL щоб не зрушити його назад
  const openOrders  = await getOpenOrders(symbol);
  const existingSL  = openOrders.find(o => o.type === 'STOP_MARKET' && o.reduceOnly);
  const currentSLPrice = existingSL ? parseFloat(existingSL.stopPrice) : null;

  const rounded = roundTrailingStop({
    side: position.side,
    price: trailPrice,
    tickSize: info.tickSize,
  });

  const shouldUpdate = currentSLPrice === null ||
    (position.side === 'LONG' ? rounded > currentSLPrice : rounded < currentSLPrice);
  if (!shouldUpdate) {
    logger.debug('Trailing SL: no update needed', { symbol, trailPrice, rounded, currentSLPrice });
    return null;
  }

  return updateStopLoss(symbol, rounded, `trailing_atr_x${multiplier}`);
}

// ─── Partial close ────────────────────────────────────────────────────────────

/**
 * Закрити частину позиції по ринку (план — early exit, слабкий моментум).
 *
 * @param {string} symbol
 * @param {number} fraction      частка від поточної позиції (0..1), напр. 0.5
 * @param {string} [reason]
 */
export async function partialClose(symbol, fraction, reason = 'partial_close') {
  if (fraction <= 0 || fraction > 1) throw new Error('fraction must be in (0, 1]');

  const position = await getPosition(symbol);
  if (!position) throw new Error(`No open position for ${symbol}`);

  const info     = await getSymbolInfo(symbol);
  const closeQty = parseFloat((position.size * fraction).toFixed(info.quantityPrecision));

  if (closeQty <= 0) throw new Error(`partialClose: computed qty is 0 for fraction=${fraction}`);

  const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

  logger.info('Partial close', { symbol, fraction, closeQty, reason });

  return placeOrder({
    symbol,
    side:       closeSide,
    type:       'MARKET',
    quantity:   closeQty,
    reduceOnly: true,
  });
}

export async function syncProtectiveOrders({ symbol, slPrice, tpPrices, tpTriggered = [] }) {
  const position = await getPosition(symbol);
  if (!position) return { sl: null, tps: [] };

  const openOrders = await getOpenOrders(symbol);
  const protective = openOrders.filter(order =>
    order.type === 'STOP_MARKET' || order.type === 'TAKE_PROFIT_MARKET'
  );
  for (const order of protective) {
    await cancelOrder(symbol, order.orderId);
  }

  const oppositeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
  const sl = await placeStopLoss({
    symbol,
    side: oppositeSide,
    stopPrice: slPrice,
  });

  const remainingLevels = tpPrices
    .map((price, index) => ({ price, index }))
    .filter(({ index }) => !tpTriggered[index]);
  const originalShares = normalizedTpShares(tpPrices.length);
  const remainingShares = remainingLevels.map(({ index }) => originalShares[index]);
  const info = await getSymbolInfo(symbol);
  const quantities = allocateTpQuantities(
    position.size,
    info.quantityPrecision,
    remainingLevels.length,
    remainingShares,
  );
  const tps = [];

  for (let i = 0; i < remainingLevels.length; i++) {
    const quantity = quantities[i];
    if (quantity <= 0) continue;
    const result = await placeTakeProfit({
      symbol,
      side: oppositeSide,
      stopPrice: remainingLevels[i].price,
      quantity,
    });
    tps.push({
      level: remainingLevels[i].index + 1,
      price: remainingLevels[i].price,
      quantity,
      orderId: result.orderId?.toString(),
    });
  }

  return { sl, tps };
}

/**
 * Early exit: закрити частину або всю позицію якщо немає руху (план, розділ 6).
 *
 * @param {string} symbol
 * @param {number} [fraction=1]  1 = закрити повністю
 */
export async function earlyExit(symbol, fraction = 1) {
  logger.warn('Early exit triggered', { symbol, fraction });
  return partialClose(symbol, fraction, 'early_exit_timeout');
}

// ─── Full position setup ──────────────────────────────────────────────────────

/**
 * Відкрити позицію із захисними SL та TP-ордерами на Binance.
 *
 * SL виставляється на повний розмір позиції.
 * @param {object} opts
 * @param {string}   opts.symbol
 * @param {string}   opts.side         'BUY' | 'SELL'
 * @param {number}   opts.quantity     повний розмір (в базовій монеті)
 * @param {string}   opts.entryType    'MARKET' | 'LIMIT'
 * @param {number}   [opts.entryPrice] тільки для LIMIT
 * @param {number}   opts.slPrice
 * @param {number[]} opts.tpPrices     [TP1, TP2, TP3, TP4] — від 1 до 4 рівнів
 */
export async function openFullPosition({
  symbol,
  side,
  quantity,
  entryType,
  entryPrice,
  slPrice,
  tpPrices = [],
}) {
  const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
  const results      = {};

  // 1. Entry order
  results.entry = await placeOrder({
    symbol,
    side,
    type:     entryType,
    quantity,
    price:    entryPrice,
  });
  logger.info('Entry placed', { symbol, side, entryType, entryPrice, quantity });

  // Для LIMIT вхід може ще не бути виконаним; захисні reduceOnly ордери
  // ставимо тільки після fill, щоб уникнути невалідного стану.
  let filledQuantity = quantity;
  if (entryType === 'LIMIT') {
    const filledOrder = await waitForOrderFilled(symbol, results.entry.orderId);
    filledQuantity = parseFloat(filledOrder.executedQty || quantity);

    if (!Number.isFinite(filledQuantity) || filledQuantity <= 0) {
      throw new Error(`LIMIT order filledQty is invalid for ${symbol}`);
    }
  }

  // 2. Stop-Loss із closePosition=true завжди покриває актуальний залишок.
  results.sl = await placeStopLoss({
    symbol,
    side:      oppositeSide,
    stopPrice: slPrice,
  });

  results.tps = [];
  const info = await getSymbolInfo(symbol);
  const quantities = allocateTpQuantities(filledQuantity, info.quantityPrecision, tpPrices.length);
  for (let i = 0; i < tpPrices.length; i++) {
    const tpQuantity = quantities[i];
    if (tpQuantity <= 0) continue;
    const tp = await placeTakeProfit({
      symbol,
      side: oppositeSide,
      stopPrice: tpPrices[i],
      quantity: tpQuantity,
    });
    results.tps.push({
      level: i + 1,
      price: tpPrices[i],
      quantity: tpQuantity,
      orderId: tp.orderId?.toString(),
    });
  }

  logger.info('Full position opened', {
    symbol,
    side,
    entry:  entryPrice || 'MARKET',
    sl:     slPrice,
    tps:    tpPrices,
    tpExecutor: 'binance',
  });

  return results;
}

async function waitForOrderFilled(symbol, orderId, timeoutMs = 120000, pollIntervalMs = 1500) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const order = await getOrder(symbol, orderId);
    const status = order?.status;

    if (status === 'FILLED') return order;

    if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') {
      throw new Error(`Entry order ${orderId} ${status}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Entry order ${orderId} was not filled within ${Math.round(timeoutMs / 1000)}s`);
}

// ─── Leverage & margin ────────────────────────────────────────────────────────

export async function setLeverage(symbol, leverage) {
  return post('/fapi/v1/leverage', { symbol, leverage });
}

export async function setMarginType(symbol, marginType) {
  try {
    return await post('/fapi/v1/marginType', { symbol, marginType });
  } catch (err) {
    if (err.message.includes('No need to change')) return null;
    throw err;
  }
}
