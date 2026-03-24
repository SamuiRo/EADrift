/**
 * confirmation.js — підтвердження ордерів з підтримкою режимів торгівлі
 * і market-входу при пропущеній зоні.
 *
 * Логіка вирішення що робити з сигналом:
 *
 *   PAUSED       → ігнорувати
 *   FULL_AUTO    → виконати одразу (тільки REJECT блокує)
 *   SEMI_AUTO    → riskEngine OK  → виконати одразу
 *                  riskEngine CONFIRM → підтвердження (30 хв TTL)
 *                  riskEngine REJECT  → відхилити, повідомити адміна
 *   CONFIRM_ONLY → завжди підтвердження (30 хв TTL)
 *
 * Market-вхід:
 *   Якщо ціна вийшла з зони входу — validateMarketEntry() перевіряє
 *   чи угода ще має сенс. Якщо так — entryType примусово MARKET,
 *   картка показує попередження і оновлений R:R.
 */

import crypto from 'crypto';
import {
  getBot,
  sendMarkdown,
  editMessage,
  answerCallback,
  ADMIN_CHAT_ID,
} from './telegram.js';
import {
  openFullPosition,
  getMarkPrice,
  getAccountBalance,
} from '../exchanges/binance.js';
import { watchPosition } from '../core/positionMonitor.js';
import {
  calcFromBalance,
  applyLeverage,
  validateMarketEntry,
  VALIDATION,
} from '../core/riskEngine.js';
import {
  getMode, isPaused, isFullAuto, isSemiAuto,
  TRADING_MODES, MODE_LABELS,
} from '../core/tradingMode.js';
import { logger } from '../shared/logger.js';
import {
  saveSignal,
  updateSignalStatus,
  openTrade,
} from '../module/db/tradeRepository.js';

// ─── TTL ──────────────────────────────────────────────────────────────────────

const CONFIRM_TTL_MS     = 30 * 60 * 1000; // 30 хвилин
const REMINDER_BEFORE_MS =  5 * 60 * 1000; // нагадування за 5 хв

const TP_DISTRIBUTION = { 1: 40, 2: 30, 3: 20, 4: 10 };

// confirmId → { order, risk, marketEntry, messageId, expiresAt, resolved, reminderTimer, expireTimer }
const pending = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Головна точка входу для нового сигналу.
 *
 * @param {object} order
 * @param {string}   order.symbol
 * @param {string}   order.side           'BUY' | 'SELL'
 * @param {string}   order.entryType      'MARKET' | 'LIMIT'
 * @param {number}   [order.entryPrice]   середина зони (entryMid)
 * @param {number}   [order.entryLow]     нижня межа зони
 * @param {number}   [order.entryHigh]    верхня межа зони
 * @param {number}   order.slPrice
 * @param {number[]} order.tpPrices       [TP1, TP2, TP3, TP4]
 * @param {string}   [order.interval]     default '15m'
 * @param {number}   [order.timeoutCandles] default 12
 */
export async function requestConfirmation(order) {

  // ── PAUSED ─────────────────────────────────────────────────────────────────
  if (isPaused()) {
    logger.info('Signal ignored — bot is paused', { symbol: order.symbol });

    // Зберігаємо в БД навіть проігноровані сигнали
    const signalRecord = await saveSignal(order, null).catch(() => null);
    await updateSignalStatus(signalRecord?.id, 'PAUSED');

    await sendMarkdown(
      `⏸ *Сигнал проігноровано* — бот на паузі\n` +
      `${order.symbol} ${order.side}\n\n` +
      `_/mode semi\\_auto або /mode confirm щоб увімкнути_`
    );
    return null;
  }

  // ── Отримуємо поточну ціну і баланс паралельно ────────────────────────────
  const [priceResult, balanceResult] = await Promise.allSettled([
    getMarkPrice(order.symbol),
    getUSDTBalance(),
  ]);

  const currentPrice = priceResult.status  === 'fulfilled' ? priceResult.value  : null;
  const balance      = balanceResult.status === 'fulfilled' ? balanceResult.value : null;

  // ── Зберігаємо сигнал в БД одразу після отримання ціни ───────────────────
  // Статус PENDING — оновимо після рішення
  const signalRecord = await saveSignal(order, currentPrice).catch(err => {
    logger.warn('Failed to save signal to DB', { err: err.message });
    return null;
  });

  // Прикріплюємо id до order для передачі в executeOrder і pending
  order = { ...order, _signalDbId: signalRecord?.id ?? null };

  // ── Визначаємо ефективну ціну входу ──────────────────────────────────────
  // Якщо є зона — перевіряємо чи ціна в ній, інакше — market за поточною
  let effectiveEntry  = order.entryPrice ?? currentPrice;
  let marketEntry     = null; // результат validateMarketEntry або null

  if (currentPrice && order.tpPrices?.length > 0) {
    const entryLow  = order.entryLow  ?? order.entryPrice ?? currentPrice;
    const entryHigh = order.entryHigh ?? order.entryPrice ?? currentPrice;

    marketEntry = validateMarketEntry({
      currentPrice,
      slPrice:    order.slPrice,
      tp1Price:   order.tpPrices[0],
      entryLow,
      entryHigh,
      side:       order.side,
    });

    if (!marketEntry.valid) {
      // Угода вже не валідна — відхиляємо без підтвердження
      logger.warn('Signal invalidated by market entry check', {
        symbol: order.symbol, reason: marketEntry.reason,
      });
      await updateSignalStatus(order._signalDbId, 'REJECTED', marketEntry.reason);
      await sendMarkdown(
        `🚫 *Сигнал відхилено* — ${order.symbol}\n\n` +
        `*Причина:* ${marketEntry.reason}\n\n` +
        `_Ордер не виставлено_`
      );
      return null;
    }

    // Якщо ціна вийшла з зони — входимо по ринку за поточною ціною
    if (!marketEntry.inZone) {
      effectiveEntry = currentPrice;
      order = { ...order, entryType: 'MARKET', entryPrice: currentPrice };
    }
  }

  // ── Розраховуємо ризик від ефективної ціни ────────────────────────────────
  // Передаємо вже отриманий баланс напряму — щоб не робити повторний запит
  const riskResult = await calcFromBalance({
    entryPrice: effectiveEntry,
    slPrice:    order.slPrice,
    symbol:     order.symbol,
    balance:    balance?.available ?? null,
  }).catch(err => {
    logger.warn('Risk calculation failed', { err: err.message });
    return null;
  });

  const enrichedOrder = {
    ...order,
    entryPrice: effectiveEntry,
    quantity:   riskResult?.quantity ?? order.quantity,
  };

  // ── REJECT від riskEngine ─────────────────────────────────────────────────
  if (riskResult?.status === VALIDATION.REJECT) {
    logger.warn('Signal REJECTED by risk engine', {
      symbol: order.symbol, reason: riskResult.reason,
    });
    await updateSignalStatus(order._signalDbId, 'REJECTED', riskResult.reason);
    await sendMarkdown(
      `🚫 *Сигнал відхилено* — ${order.symbol}\n\n` +
      `*Причина:* ${riskResult.reason}\n\n` +
      `_Ордер не виставлено_`
    );
    return null;
  }

  // ── FULL_AUTO ─────────────────────────────────────────────────────────────
  if (isFullAuto()) {
    logger.info('FULL_AUTO — executing immediately', { symbol: order.symbol });
    await executeAndNotify(enrichedOrder, riskResult, balance);
    return null;
  }

  // ── SEMI_AUTO ─────────────────────────────────────────────────────────────
  if (isSemiAuto()) {
    // Автоматично тільки якщо: riskEngine OK І ціна підтверджено в зоні входу
    const autoOk = riskResult?.status === VALIDATION.OK && marketEntry?.inZone === true;
    if (autoOk) {
      logger.info('SEMI_AUTO — conditions OK, executing immediately', { symbol: order.symbol });
      await executeAndNotify(enrichedOrder, riskResult, balance);
      return null;
    }
    logger.info('SEMI_AUTO — needs confirmation', {
      symbol: order.symbol,
      riskReason:   riskResult?.reason,
      marketReason: marketEntry?.slipped ? 'price slipped from zone' : null,
    });
  }

  // ── CONFIRM ───────────────────────────────────────────────────────────────
  return showConfirmCard(enrichedOrder, riskResult, marketEntry, currentPrice, balance);
}

export function registerConfirmationHandler() {
  const bot = getBot();
  bot.on('callback_query', async (query) => {
    if (!query.data) return;
    const [action, confirmId] = query.data.split(':');
    if (!['confirm', 'cancel'].includes(action)) return;
    await answerCallback(query.id);
    await handleCallback(action, confirmId, query.message);
  });
  logger.info('Confirmation handler registered');
}

// ─── Confirmation card ────────────────────────────────────────────────────────

async function showConfirmCard(order, risk, marketEntry, currentPrice, balance) {
  const confirmId = crypto.randomUUID();
  const text      = buildConfirmCard(order, risk, marketEntry, currentPrice, balance);
  const keyboard  = buildKeyboard(confirmId);

  const sentMsg = await sendMarkdown(text, { reply_markup: keyboard });
  if (!sentMsg) return null;

  const expiresAt = Date.now() + CONFIRM_TTL_MS;

  const reminderTimer = setTimeout(() => sendReminder(confirmId), CONFIRM_TTL_MS - REMINDER_BEFORE_MS);
  const expireTimer   = setTimeout(() => expirePending(confirmId), CONFIRM_TTL_MS);

  // Зберігаємо balance щоб передати в executeOrder при підтвердженні
  pending.set(confirmId, {
    order, risk, marketEntry, balance,
    messageId: sentMsg.message_id,
    expiresAt, resolved: false, reminderTimer, expireTimer,
  });

  logger.info('Confirmation requested', {
    confirmId, symbol: order.symbol,
    ttlMin:     Math.round(CONFIRM_TTL_MS / 60000),
    mode:       getMode(),
    riskStatus: risk?.status ?? 'unknown',
    inZone:     marketEntry?.inZone ?? 'n/a',
  });

  return confirmId;
}

// ─── Card builder ─────────────────────────────────────────────────────────────

function buildConfirmCard(order, risk, marketEntry, currentPrice, balance) {
  const { symbol, side, entryType, entryPrice, slPrice, tpPrices = [] } = order;

  const isLong    = side === 'BUY';
  const sideLabel = isLong ? 'LONG  🟢' : 'SHORT  🔴';
  const refPrice  = entryPrice ?? currentPrice ?? 0;
  const mode      = getMode();

  const lines = [];

  // ── Заголовок ──────────────────────────────────────────────────────────────
  lines.push(`📋 *НОВИЙ ОРДЕР — ${symbol}*`);

  // Попередження про market вхід поза зоною
  if (marketEntry?.slipped) {
    lines.push(`⚠️ *Ціна поза зоною входу — вхід по MARKET*`);
    lines.push(`_Slippage: ${(marketEntry.slippagePct * 100).toFixed(2)}% від межі зони_`);
  }

  // Причина чому потрібне підтвердження в SEMI_AUTO
  if (isSemiAuto() && risk?.reason) {
    lines.push(`⚠️ _${risk.reason}_`);
  }

  lines.push(``);
  lines.push(`Режим     : \`${MODE_LABELS[mode]}\``);
  lines.push(`Напрямок  : *${sideLabel}*`);
  lines.push(`Тип входу : \`${entryType}\``);

  // ── Ціни ──────────────────────────────────────────────────────────────────
  lines.push(``, `💰 *Ціни*`);

  if (currentPrice) {
    lines.push(`Поточна ціна : \`${fmt(currentPrice)}\``);
  }

  // Оригінальна зона з сигналу (якщо є)
  if (order.entryLow && order.entryHigh && marketEntry?.slipped) {
    lines.push(`Зона входу   : \`${fmt(order.entryLow)}\` – \`${fmt(order.entryHigh)}\` _(пропущено)_`);
    lines.push(`Вхід MARKET  : \`${fmt(refPrice)}\``);
  } else if (entryPrice && currentPrice && Math.abs(entryPrice - currentPrice) > currentPrice * 0.0001) {
    const diff  = pctDiff(entryPrice, currentPrice);
    const arrow = diff >= 0 ? '▲' : '▼';
    lines.push(`Ціна входу   : \`${fmt(entryPrice)}\`  (${arrow} ${Math.abs(diff).toFixed(2)}% від ринку)`);
  } else if (entryPrice) {
    lines.push(`Ціна входу   : \`${fmt(entryPrice)}\``);
  } else {
    lines.push(`Ціна входу   : \`MARKET\``);
  }

  if (refPrice && slPrice) {
    const slPct   = Math.abs(pctDiff(slPrice, refPrice));
    const slPts   = Math.abs(refPrice - slPrice);
    const slArrow = isLong ? '▼' : '▲';
    lines.push(`Stop-Loss    : \`${fmt(slPrice)}\`  (${slArrow} ${slPct.toFixed(2)}% | ${fmt(slPts)} pts)`);
  }

  // ── Take-Profits ───────────────────────────────────────────────────────────
  const rPts = refPrice && slPrice ? Math.abs(refPrice - slPrice) : null;

  if (tpPrices.length > 0) {
    lines.push(``, `🎯 *Take-Profits*`);

    // R:R від поточної ціни (важливо при market-вході)
    const rrNote = marketEntry?.slipped
      ? `  _(R:R від поточної ціни)_`
      : '';

    tpPrices.forEach((tp, i) => {
      const level  = i + 1;
      const share  = TP_DISTRIBUTION[level] ?? Math.round(100 / tpPrices.length);
      const tpPct  = refPrice ? Math.abs(pctDiff(tp, refPrice)) : null;
      const sign   = isLong ? '+' : '-';
      const pctStr = tpPct !== null ? ` ${sign}${tpPct.toFixed(2)}%` : '';
      const rrStr  = rPts ? `  ${(Math.abs(tp - refPrice) / rPts).toFixed(1)}R` : '';
      lines.push(`TP${level} → \`${fmt(tp)}\` (${pctStr}${rrStr})  — *${share}% позиції*`);
    });

    // Для market-входу показуємо загальний R:R окремо
    if (marketEntry?.rrFromCurrent) {
      lines.push(`R:R до TP1 від входу : \`${marketEntry.rrFromCurrent.toFixed(2)}\`${rrNote}`);
    }
  }

  // ── Позиція + плече ───────────────────────────────────────────────────────
  lines.push(``, `📐 *Позиція*`);

  const base = symbol.replace(/USDT$|BUSD$|USD$/, '');

  if (risk) {
    lines.push(`Кількість    : \`${risk.quantity} ${base}\``);
    lines.push(`Плече        : \`${risk.leverage}x\``);
    lines.push(`Обсяг        : \`≈ ${fmt(risk.positionUsdt)} USDT\``);
    lines.push(`1R (ризик)   : \`${risk.realRiskUsdt.toFixed(2)} USDT\``);
    lines.push(`Target ризик : \`${risk.targetRiskUsdt.toFixed(2)} USDT\``);
    lines.push(`SL відстань  : \`${(risk.delta * 100).toFixed(2)}%\``);
  } else if (order.quantity) {
    lines.push(`Кількість    : \`${order.quantity} ${base}\``);
  }

  // ── Баланс ────────────────────────────────────────────────────────────────
  if (balance) {
    lines.push(``, `💳 *Баланс USDT*`);
    lines.push(`Доступно     : \`${fmt(balance.available)}\``);
    lines.push(`Всього       : \`${fmt(balance.total)}\``);

    if (risk?.realRiskUsdt && balance.total > 0) {
      const riskPct = (risk.realRiskUsdt / balance.total * 100).toFixed(2);
      const warn    = parseFloat(riskPct) > 1.5 ? '  ⚠️' : '';
      lines.push(`Ризик / депо : \`${riskPct}%\`${warn}`);
    }

    if (risk?.positionUsdt && balance.total > 0) {
      lines.push(`Використання : \`${(risk.positionUsdt / balance.total * 100).toFixed(1)}% депо\``);
    }
  }

  // ── Футер ─────────────────────────────────────────────────────────────────
  const ttlMin = Math.round(CONFIRM_TTL_MS / 60000);
  lines.push(``, `_⏳ Підтвердження діє ${ttlMin} хв_`);

  return lines.join('\n');
}

// ─── Callbacks ────────────────────────────────────────────────────────────────

async function handleCallback(action, confirmId, callbackMsg) {
  const entry = pending.get(confirmId);

  if (!entry) {
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      '_Ордер вже оброблено або протухнув._', { parse_mode: 'Markdown' });
    return;
  }

  if (entry.resolved) {
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      '_Ордер вже оброблено._', { parse_mode: 'Markdown' });
    return;
  }

  entry.resolved = true;
  clearTimeout(entry.reminderTimer);
  clearTimeout(entry.expireTimer);
  pending.set(confirmId, entry);

  if (action === 'cancel') {
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      `_✗ Ордер ${entry.order.symbol} скасовано_`, { parse_mode: 'Markdown' });
    await updateSignalStatus(entry.order._signalDbId, 'CANCELLED');
    pending.delete(confirmId);
    logger.info('Order cancelled by user', { confirmId });
    return;
  }

  await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
    `_⏳ ${entry.order.symbol} — виконується..._`, { parse_mode: 'Markdown' });

  try {
    const result = await executeOrder(entry.order, entry.risk, entry.balance);
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      `_✅ ${entry.order.symbol} — виконано_\norderId: \`${result.entry.orderId}\``,
      { parse_mode: 'Markdown' });
    logger.info('Order executed', { confirmId, orderId: result.entry.orderId });
  } catch (err) {
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      `_❌ ${entry.order.symbol} — помилка: ${err.message}_`, { parse_mode: 'Markdown' });
    logger.error('Order execution failed', { confirmId, err: err.message });
  }

  pending.delete(confirmId);
}

// ─── Execute ──────────────────────────────────────────────────────────────────

/**
 * Виконати ордер і зареєструвати в БД і watchlist.
 *
 * @param {object} order
 * @param {object} risk         riskResult від calcFromBalance()
 * @param {object|null} balance { available, total } або null
 */
async function executeOrder(order, risk, balance = null) {
  const {
    symbol, side, quantity, entryType, entryPrice,
    slPrice, tpPrices = [], interval = '15m', timeoutCandles = 12,
  } = order;

  if (risk?.leverage) {
    await applyLeverage(symbol, risk.leverage);
  }

  const result = await openFullPosition({
    symbol, side,
    quantity:   risk?.quantity ?? quantity,
    entryType,
    entryPrice: entryType === 'MARKET' ? undefined : entryPrice,
    slPrice, tpPrices,
  });

  // Для MARKET-ордерів завжди беремо реальну ціну виконання (avgPrice),
  // а не entryPrice з моменту рішення — вона може відрізнятись через slippage.
  const actualEntryPrice = entryType === 'MARKET'
    ? (parseFloat(result.entry.avgPrice) || parseFloat(result.entry.price) || entryPrice)
    : entryPrice;

  // ── Зберегти угоду в БД ──────────────────────────────────────────────────
  let tradeRecord = null;
  if (tpPrices.length > 0) {
    tradeRecord = await openTrade({
      signalId:          order._signalDbId ?? null,
      symbol,
      side:              side === 'BUY' ? 'LONG' : 'SHORT',
      entryType,
      entryPrice:        actualEntryPrice,
      entryPricePlanned: order.entryLow
        ? (order.entryLow + order.entryHigh) / 2
        : entryPrice,
      slPrice,
      tpPrices,
      quantity:          risk?.quantity ?? quantity,
      leverage:          risk?.leverage ?? 1,
      risk,
      balance:           balance?.available ?? null,
      interval,
      tradingMode:       getMode(),
      entryOrderId:      result.entry.orderId?.toString() ?? null,
      slOrderId:         result.sl?.orderId?.toString()   ?? null,
    }).catch(err => {
      logger.error('Failed to save trade to DB', { err: err.message, symbol });
      return null;
    });

    // Оновити сигнал як TRADED
    await updateSignalStatus(order._signalDbId, 'TRADED');

    // Реєструємо в watchlist — передаємо tradeId для positionMonitor
    watchPosition(symbol, {
      side:       side === 'BUY' ? 'LONG' : 'SHORT',
      entryPrice: actualEntryPrice,
      slPrice, tpPrices, interval, timeoutCandles,
      tradeId:    tradeRecord?.id ?? null,
    });
  }

  return result;
}

async function executeAndNotify(order, risk, balance = null) {
  const mode = getMode();
  try {
    const result = await executeOrder(order, risk, balance);
    const isMarket = order.entryType === 'MARKET';
    await sendMarkdown(
      `✅ *${order.symbol}* — виконано автоматично\n` +
      `Режим: \`${MODE_LABELS[mode]}\`\n` +
      `Вхід: \`${isMarket ? 'MARKET' : order.entryPrice}\`\n` +
      `orderId: \`${result.entry.orderId}\`\n` +
      (risk ? `Плече: \`${risk.leverage}x\`  Ризик: \`${risk.realRiskUsdt.toFixed(2)} USDT\`` : '')
    );
    logger.info('Auto-executed', { symbol: order.symbol, mode, orderId: result.entry.orderId });
  } catch (err) {
    await sendMarkdown(`❌ *${order.symbol}* — помилка автовиконання\n\`${err.message}\``);
    logger.error('Auto-execute failed', { symbol: order.symbol, err: err.message });
  }
}

// ─── Reminder & expiry ────────────────────────────────────────────────────────

async function sendReminder(confirmId) {
  const entry = pending.get(confirmId);
  if (!entry || entry.resolved) return;

  const minsLeft = Math.round((entry.expiresAt - Date.now()) / 60000);
  const slipped  = entry.marketEntry?.slipped ? ' _(ціна поза зоною)_' : '';

  await sendMarkdown(
    `⏰ *Нагадування* — ${entry.order.symbol}${slipped}\n` +
    `До закінчення підтвердження: *${minsLeft} хв*\n\n` +
    `_Ордер буде скасовано автоматично якщо не підтвердиш_`
  );
}

async function expirePending(confirmId) {
  const entry = pending.get(confirmId);
  if (!entry || entry.resolved) return;

  logger.info('Confirmation expired', { confirmId });

  const bot = getBot();
  bot.editMessageText('_⌛ Час підтвердження вийшов_', {
    chat_id:    ADMIN_CHAT_ID,
    message_id: entry.messageId,
    parse_mode: 'Markdown',
  }).catch(() => {});

  await updateSignalStatus(entry.order._signalDbId, 'EXPIRED');

  await sendMarkdown(
    `⌛ *${entry.order.symbol}* — підтвердження протухло\n` +
    `_Ордер не виставлено_`
  );

  pending.delete(confirmId);
}

// ─── Utils ────────────────────────────────────────────────────────────────────

async function getUSDTBalance() {
  const balances = await getAccountBalance();
  const usdt     = balances.find(b => b.asset === 'USDT');
  if (!usdt) return null;
  return {
    available: parseFloat(usdt.availableBalance),
    total:     parseFloat(usdt.balance),
  };
}

function pctDiff(a, b) { return !b ? 0 : (a - b) / b * 100; }

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildKeyboard(confirmId) {
  return {
    inline_keyboard: [[
      { text: '✅ Підтвердити', callback_data: `confirm:${confirmId}` },
      { text: '❌ Скасувати',  callback_data: `cancel:${confirmId}`  },
    ]],
  };
}