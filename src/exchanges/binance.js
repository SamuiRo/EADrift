import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../shared/logger.js';
import {
  BINANCE_TESTNET,
  BINANCE_SECRET_KEY,
  BINANCE_API_KEY,
} from '../config/app.config.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = BINANCE_TESTNET
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

/**
 * Розподіл позиції по TP-рівнях (план, розділ 1).
 * Ключ = індекс TP (1-based), значення = частка від загального розміру.
 */
export const TP_DISTRIBUTION = {
  1: 0.40,
  2: 0.30,
  3: 0.20,
  4: 0.10,
};

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
    limit: period + 1,
  });

  // data: [[openTime, open, high, low, close, volume, ...], ...]
  const trValues = [];
  for (let i = 1; i < data.length; i++) {
    const high  = parseFloat(data[i][2]);
    const low   = parseFloat(data[i][3]);
    const prevClose = parseFloat(data[i - 1][4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }

  const atr = trValues.reduce((s, v) => s + v, 0) / trValues.length;
  return atr;
}

/**
 * Перевіряє чи є моментум сильним (план, розділ 5).
 * Повертає 'strong' | 'weak' | 'neutral'
 *
 * @param {string} symbol
 * @param {string} interval
 */
export async function getMomentum(symbol, interval = '15m') {
  const data = await publicGet('/fapi/v1/klines', {
    symbol,
    interval,
    limit: 5,
  });

  const candles = data.map(c => ({
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));

  // Середній об'єм
  const avgVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const lastVolume = candles[candles.length - 1].volume;

  // Середній розмір свічки
  const avgRange = candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;
  const lastRange = candles[candles.length - 1].high - candles[candles.length - 1].low;

  const volumeStrong = lastVolume > avgVolume * 1.3;
  const rangeStrong  = lastRange  > avgRange  * 1.2;

  if (volumeStrong && rangeStrong) return 'strong';
  if (!volumeStrong && lastVolume < avgVolume * 0.7) return 'weak';
  return 'neutral';
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

/**
 * Stop-Loss ордер (STOP_MARKET).
 * ВАЖЛИВО: завжди передаємо quantity + reduceOnly, НЕ closePosition.
 * closePosition:true несумісний з частковими TP-ордерами на тому ж символі.
 */
export async function placeStopLoss({ symbol, side, stopPrice, quantity }) {
  const info = await getSymbolInfo(symbol);

  if (!quantity) throw new Error('placeStopLoss: quantity is required (closePosition is not supported)');

  const params = {
    symbol,
    side,
    type:        'STOP_MARKET',
    stopPrice:   stopPrice.toFixed(info.pricePrecision),
    quantity:    quantity.toFixed(info.quantityPrecision),
    reduceOnly:  'true',
    workingType: 'MARK_PRICE',
    priceProtect: 'TRUE',
  };

  logger.info('Placing SL', { symbol, side, stopPrice, quantity });
  const result = await post('/fapi/v1/order', params);
  logger.info('SL placed', { orderId: result.orderId, symbol, stopPrice });
  return result;
}

/**
 * Take-Profit ордер (TAKE_PROFIT_MARKET).
 * Завжди з явним quantity — не closePosition.
 */
export async function placeTakeProfit({ symbol, side, stopPrice, quantity }) {
  const info = await getSymbolInfo(symbol);

  if (!quantity) throw new Error('placeTakeProfit: quantity is required');

  const params = {
    symbol,
    side,
    type:        'TAKE_PROFIT_MARKET',
    stopPrice:   stopPrice.toFixed(info.pricePrecision),
    quantity:    quantity.toFixed(info.quantityPrecision),
    reduceOnly:  'true',
    workingType: 'MARK_PRICE',
    priceProtect: 'TRUE',
  };

  logger.info('Placing TP', { symbol, side, stopPrice, quantity });
  const result = await post('/fapi/v1/order', params);
  logger.info('TP placed', { orderId: result.orderId, symbol, stopPrice });
  return result;
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
  const existingSL = openOrders.find(o => o.type === 'STOP_MARKET' && o.reduceOnly);

  if (existingSL) {
    await cancelOrder(symbol, existingSL.orderId);
    logger.info('Old SL cancelled', { symbol, oldSL: existingSL.stopPrice, reason });
  }

  const slSide = position.side === 'LONG' ? 'SELL' : 'BUY';

  const result = await placeStopLoss({
    symbol,
    side:      slSide,
    stopPrice: newStopPrice,
    quantity:  position.size,
  });

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
 *   TP4 hit → вмикаємо trailing (виклич activateTrailingStop окремо)
 *
 * @param {string}   symbol
 * @param {number}   tpLevel      1 | 2 | 3 | 4
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

    case 4:
      // Trailing — окремий виклик
      logger.info('TP4 hit — activate trailing stop manually via activateTrailingStop()', { symbol });
      return null;

    default:
      throw new Error(`Unknown tpLevel: ${tpLevel}`);
  }
}

/**
 * Trailing stop через ATR (план, розділ 4).
 * Активується після TP4.
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
  const trailPrice = position.side === 'LONG'
    ? markPrice - atr * multiplier
    : markPrice + atr * multiplier;

  // Беремо поточний SL щоб не зрушити його назад
  const openOrders  = await getOpenOrders(symbol);
  const existingSL  = openOrders.find(o => o.type === 'STOP_MARKET' && o.reduceOnly);
  const currentSLPrice = existingSL ? parseFloat(existingSL.stopPrice) : null;

  let shouldUpdate;
  if (currentSLPrice === null) {
    shouldUpdate = true;
  } else if (position.side === 'LONG') {
    shouldUpdate = trailPrice > currentSLPrice;
  } else {
    shouldUpdate = trailPrice < currentSLPrice;
  }

  if (!shouldUpdate) {
    logger.debug('Trailing SL: no update needed', { symbol, trailPrice, currentSLPrice });
    return null;
  }

  // Округлюємо до tickSize
  const rounded = Math.round(trailPrice / info.tickSize) * info.tickSize;

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
 * Відкрити повну позицію з TP-сіткою згідно плану:
 *   TP1 → 40% | TP2 → 30% | TP3 → 20% | TP4 → 10%
 *
 * SL виставляється на повний розмір позиції.
 * TP ордери — кожен на свою частку, з явним quantity (не closePosition).
 *
 * @param {object} opts
 * @param {string}   opts.symbol
 * @param {string}   opts.side         'BUY' | 'SELL'
 * @param {number}   opts.quantity     повний розмір (в базовій монеті)
 * @param {string}   opts.entryType    'MARKET' | 'LIMIT'
 * @param {number}   [opts.entryPrice] тільки для LIMIT
 * @param {number}   opts.slPrice
 * @param {number[]} opts.tpPrices     [TP1, TP2, TP3, TP4] — від 1 до 4 рівнів
 * @param {object}   [opts.distribution]  override розподілу, default = TP_DISTRIBUTION
 */
export async function openFullPosition({
  symbol,
  side,
  quantity,
  entryType,
  entryPrice,
  slPrice,
  tpPrices = [],
  distribution = TP_DISTRIBUTION,
}) {
  const info         = await getSymbolInfo(symbol);
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

  // 2. Stop-Loss на повний розмір позиції (quantity + reduceOnly, без closePosition)
  results.sl = await placeStopLoss({
    symbol,
    side:      oppositeSide,
    stopPrice: slPrice,
    quantity,
  });

  // 3. Take-Profits з розподілом за планом
  if (tpPrices.length > 0) {
    results.tps = [];

    const distKeys = Object.keys(distribution)
      .map(Number)
      .sort((a, b) => a - b)
      .slice(0, tpPrices.length);

    // Перевіряємо що сума часток = 1 (або близько того)
    const totalShare = distKeys.reduce((s, k) => s + distribution[k], 0);

    for (let i = 0; i < tpPrices.length; i++) {
      const tpIndex = distKeys[i];
      const share   = distribution[tpIndex] / totalShare; // нормалізуємо на випадок неповного набору TP
      const tpQty   = parseFloat((quantity * share).toFixed(info.quantityPrecision));

      if (tpQty <= 0) {
        logger.warn('TP qty is 0, skipping', { symbol, tpIndex, share });
        continue;
      }

      const tp = await placeTakeProfit({
        symbol,
        side:      oppositeSide,
        stopPrice: tpPrices[i],
        quantity:  tpQty,
      });
      results.tps.push({ level: tpIndex, price: tpPrices[i], qty: tpQty, orderId: tp.orderId });
    }
  }

  logger.info('Full position opened', {
    symbol,
    side,
    entry:  entryPrice || 'MARKET',
    sl:     slPrice,
    tps:    results.tps?.map(t => `TP${t.level}@${t.price}(${t.qty})`),
  });

  return results;
}

// ─── Momentum-based management ────────────────────────────────────────────────

/**
 * Додаткове закриття при слабкому моментумі після TP1 (план, розділ 5).
 * Закриває +20-30% позиції замість очікування TP2.
 *
 * @param {string} symbol
 * @param {string} interval
 */
export async function handleWeakMomentum(symbol, interval = '15m') {
  const momentum = await getMomentum(symbol, interval);

  if (momentum === 'weak') {
    logger.info('Weak momentum detected — partial close 25%', { symbol });
    await partialClose(symbol, 0.25, 'weak_momentum_close');
    return true;
  }

  return false;
}

/**
 * При сильному моментумі після TP1→TP2 — перенести частину (10-15%) з TP2 в TP3/TP4.
 * Це означає скасувати TP2-ордер і виставити менший.
 * (план, розділ 5 — логіка сильного імпульсу)
 *
 * @param {string}   symbol
 * @param {number}   tp2Price
 * @param {number}   tp3Price
 * @param {string}   interval
 */
export async function handleStrongMomentum(symbol, tp2Price, tp3Price, interval = '15m') {
  const momentum = await getMomentum(symbol, interval);
  if (momentum !== 'strong') return false;

  const openOrders = await getOpenOrders(symbol);
  const tp2Order   = openOrders.find(
    o => o.type === 'TAKE_PROFIT_MARKET' &&
         Math.abs(parseFloat(o.stopPrice) - tp2Price) < tp2Price * 0.001
  );

  if (!tp2Order) return false;

  const info          = await getSymbolInfo(symbol);
  const originalQty   = parseFloat(tp2Order.origQty);
  const transferShare = 0.15; // 15% переносимо вище
  const transferQty   = parseFloat((originalQty * transferShare).toFixed(info.quantityPrecision));
  const reducedQty    = parseFloat((originalQty - transferQty).toFixed(info.quantityPrecision));

  if (transferQty <= 0 || reducedQty <= 0) return false;

  logger.info('Strong momentum — reallocating TP2 → TP3', {
    symbol, originalQty, reducedQty, transferQty,
  });

  // Скасовуємо старий TP2
  await cancelOrder(symbol, tp2Order.orderId);

  const position     = await getPosition(symbol);
  const oppositeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

  // Виставляємо новий TP2 з меншим розміром
  await placeTakeProfit({ symbol, side: oppositeSide, stopPrice: tp2Price, quantity: reducedQty });

  // Додаємо до TP3
  await placeTakeProfit({ symbol, side: oppositeSide, stopPrice: tp3Price, quantity: transferQty });

  return true;
}

// ─── Fake breakout protection ─────────────────────────────────────────────────

/**
 * Захист від фейкового пробою (план, розділ 7).
 * Якщо ціна повернулась до entry після TP1 — закрити ще 20-30%.
 *
 * @param {string} symbol
 */
export async function handleFakeBreakout(symbol) {
  const position = await getPosition(symbol);
  if (!position) return false;

  const markPrice = await getMarkPrice(symbol);

  const returnedToEntry = position.side === 'LONG'
    ? markPrice <= position.entryPrice
    : markPrice >= position.entryPrice;

  if (returnedToEntry) {
    logger.warn('Fake breakout detected — closing 25%', { symbol, markPrice, entryPrice: position.entryPrice });
    await partialClose(symbol, 0.25, 'fake_breakout_protection');
    return true;
  }

  return false;
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