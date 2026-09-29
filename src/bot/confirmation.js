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
  getATR,
} from '../exchanges/binance.js';
import { watchPosition, getWatchlist } from '../core/positionMonitor.js';
import {
  calcFromBalance,
  applyLeverage,
  validateMarketEntry,
  planEntry,
  VALIDATION,
  RISK_CONFIG,
} from '../core/riskEngine.js';
import { normalizedTpShares } from '../core/exitStrategy.js';
import {
  getMode, isPaused, isShadow, isFullAuto, isSemiAuto,
  TRADING_MODES, MODE_LABELS,
} from '../core/tradingMode.js';
import { logger } from '../shared/logger.js';
import { CONFIRM_MAX_PRICE_MOVE_PCT } from '../config/app.config.js';
import {
  saveSignal,
  updateSignalStatus,
  openTrade,
  recordEvaluation,
  DECISIONS,
} from '../module/db/tradeRepository.js';

// ─── TTL ──────────────────────────────────────────────────────────────────────

const CONFIRM_TTL_MS     = 30 * 60 * 1000; // 30 хвилин
const REMINDER_BEFORE_MS =  5 * 60 * 1000; // нагадування за 5 хв


class ConfirmationRejectedError extends Error {}

/**
 * Звести контекст рішення до рядка signal_evaluations.
 *
 * Пишеться для кожного термінального рішення, включно з відхиленнями:
 * саме відсіяні сигнали дають матеріал для питання "чи правильно пропустили".
 */
function evaluationRow(order, ctx, decision, reason = null) {
  const { marketEntry, plan, risk, markPrice, atr, balance } = ctx;

  return {
    signalId:    order._signalDbId ?? null,
    symbol:      order.symbol,
    side:        order.side === 'BUY' ? 'LONG' : 'SHORT',
    source:      order.source ?? 'unknown',
    decision,
    reason,
    tradingMode: getMode(),

    markPrice:   markPrice ?? null,
    atr:         atr ?? null,
    interval:    order.interval ?? null,

    entryType:   order.entryType ?? null,
    entryPrice:  order.entryPrice ?? null,
    inZone:      marketEntry?.inZone ?? null,
    slippagePct: marketEntry?.slippagePct ?? null,

    providerSlPrice: order.providerSlPrice ?? order.slPrice ?? null,
    plannedSlPrice:  plan?.slPrice ?? null,
    slSource:        plan?.slSource ?? null,
    slDistancePct:   plan?.slDistance && order.entryPrice
      ? plan.slDistance / order.entryPrice * 100
      : null,

    rrToTp1:    plan?.rr?.[0] ?? null,
    weightedRR: plan?.weightedRR ?? null,

    quantity:         risk?.quantity ?? null,
    leverage:         risk?.leverage ?? null,
    positionUsdt:     risk?.positionUsdt ?? null,
    riskUsdt:         risk?.realRiskUsdt ?? null,
    balanceAvailable: balance?.available ?? null,
  };
}

/** Відхилити сигнал: статус у БД, знімок рішення, повідомлення адміну. */
async function rejectSignal(order, ctx, reason) {
  logger.warn('Signal rejected', { symbol: order.symbol, reason });

  await updateSignalStatus(order._signalDbId, 'REJECTED', reason);
  await recordEvaluation(evaluationRow(order, ctx, DECISIONS.REJECTED, reason));
  await sendMarkdown(
    `🚫 *Сигнал відхилено* — ${order.symbol}\n\n` +
    `*Причина:* ${reason}\n\n` +
    `_Ордер не виставлено_`
  );
  return null;
}

/**
 * Чи дозволяє поточний портфель відкрити ще одну позицію.
 *
 * Повертає причину відмови або null. Watchlist — те, що бот відкрив і веде;
 * ручні позиції поза ботом сюди не потрапляють.
 */
function checkPortfolioLimits(symbol) {
  const watched = getWatchlist();

  // Binance у one-way режимі долив би новий ордер до наявної позиції, а
  // watchlist, де ключ — символ, мовчки перезатер би стару угоду.
  if (watched[symbol]) {
    return `Позиція по ${symbol} вже відкрита — повторний сигнал не торгуємо`;
  }

  const open = Object.keys(watched).length;
  if (open >= RISK_CONFIG.maxOpenPositions) {
    return `Досягнуто ліміт одночасних позицій: ${open}/${RISK_CONFIG.maxOpenPositions}`;
  }

  return null;
}

// confirmId → { order, risk, marketEntry, evaluationPrice, messageId, expiresAt, resolved, timers }
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

  // ── Ринковий контекст ─────────────────────────────────────────────────────
  // Отримуємо до розгалуження по режимах: mark price на момент сигналу — те
  // єдине поле, без якого пізніший офлайн-реплей неможливий, тому воно має
  // зберігатися навіть коли бот на паузі й нічого не торгує.
  const [priceResult, balanceResult, atrResult] = await Promise.allSettled([
    getMarkPrice(order.symbol),
    getUSDTBalance(),
    getATR(order.symbol, order.interval ?? '1h'),
  ]);

  const currentPrice = priceResult.status   === 'fulfilled' ? priceResult.value   : null;
  const balance      = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
  const atr          = atrResult.status     === 'fulfilled' ? atrResult.value     : null;

  if (atrResult.status === 'rejected') {
    logger.warn('ATR unavailable — stop-loss floor will be skipped', {
      symbol: order.symbol, err: atrResult.reason?.message,
    });
  }

  // Накопичувач контексту рішення — доповнюється в міру обчислень і
  // записується в signal_evaluations на кожному термінальному виході.
  const ctx = { markPrice: currentPrice, atr, balance, marketEntry: null, plan: null, risk: null };

  // ── PAUSED ─────────────────────────────────────────────────────────────────
  if (isPaused()) {
    logger.info('Signal ignored — bot is paused', { symbol: order.symbol, currentPrice });

    // Зберігаємо в БД навіть проігноровані сигнали — разом із ціною на момент
    // отримання, інакше запис не придатний для подальшого аналізу.
    const signalRecord = await saveSignal(order, currentPrice).catch(() => null);
    await updateSignalStatus(signalRecord?.id, 'PAUSED');

    await sendMarkdown(
      `⏸ *Сигнал проігноровано* — бот на паузі\n` +
      `${order.symbol} ${order.side}\n\n` +
      `_/mode semi\\_auto або /mode confirm щоб увімкнути_`
    );
    return null;
  }

  // ── Зберігаємо сигнал в БД одразу після отримання ціни ───────────────────
  // Статус PENDING — оновимо після рішення
  const signalRecord = await saveSignal(order, currentPrice).catch(err => {
    logger.warn('Failed to save signal to DB', { err: err.message });
    return null;
  });

  // Прикріплюємо id до order для передачі в executeOrder і pending
  order = { ...order, _signalDbId: signalRecord?.id ?? null };

  if (!order.tpPrices?.length) {
    return rejectSignal(order, ctx, 'Signal has no take-profit levels');
  }

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

    ctx.marketEntry = marketEntry;

    if (!marketEntry.valid) {
      // Угода вже не валідна — відхиляємо без підтвердження
      return rejectSignal(order, ctx, marketEntry.reason);
    }

    // Входимо по ринку і в зоні, і при виході з неї.
    //
    // Раніше при ціні в зоні виставлявся LIMIT по її середині. На реплеї
    // реальних сигналів це найгірша з перевірених політик: лімітка, що чекає
    // відкату вглиб зони, виконується переважно тоді, коли сетап уже
    // розвалюється — SL провайдера стоїть одразу за дальнім краєм. Вхід по
    // доступній зараз ціні дав помітно кращий результат.
    effectiveEntry = currentPrice;
    order = { ...order, entryType: 'MARKET', entryPrice: currentPrice };
  }

  // ── Власний SL і оцінка якості угоди ──────────────────────────────────────
  const plan = planEntry({
    entryPrice: effectiveEntry,
    side:       order.side,
    tpPrices:   order.tpPrices,
    providerSl: order.slPrice,
    atr,
    tpShares:   normalizedTpShares(order.tpPrices.length),
  });

  if (!plan.ok) {
    return rejectSignal(order, ctx, plan.reason);
  }

  ctx.plan = plan;

  // SL провайдера лишається в записі сигналу; торгуємо власним.
  order = { ...order, providerSlPrice: order.slPrice, slPrice: plan.slPrice };

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

  // Без валідного riskResult забороняємо виконання в будь-якому режимі.
  if (!riskResult) {
    return rejectSignal(order, ctx, 'Risk calculation failed');
  }

  ctx.risk = riskResult;

  const enrichedOrder = {
    ...order,
    entryPrice: effectiveEntry,
    quantity:   riskResult?.quantity ?? order.quantity,
  };

  // ── REJECT від riskEngine ─────────────────────────────────────────────────
  if (riskResult?.status === VALIDATION.REJECT) {
    return rejectSignal(order, ctx, riskResult.reason);
  }

  // ── Портфельні межі ───────────────────────────────────────────────────────
  // У SHADOW позицій не відкривається, тож ці межі там не спрацьовують —
  // і правильно: інакше вибірка залежала б від уявних позицій.
  const portfolioBlock = checkPortfolioLimits(order.symbol);
  if (portfolioBlock) {
    return rejectSignal(order, ctx, portfolioBlock);
  }

  // ── SHADOW ────────────────────────────────────────────────────────────────
  // Сигнал пройшов усі фільтри й був би виконаний. Ордер не виставляємо —
  // записуємо повний знімок рішення, щоб офлайн порівняти з тим, що зробив ринок.
  if (isShadow()) {
    await updateSignalStatus(order._signalDbId, 'PAUSED', 'Shadow mode: recorded, not traded');
    await recordEvaluation(evaluationRow(enrichedOrder, ctx, DECISIONS.SHADOW));

    logger.info('SHADOW — recorded without trading', {
      symbol:     order.symbol,
      entryPrice: enrichedOrder.entryPrice,
      slPrice:    plan.slPrice,
      slSource:   plan.slSource,
      weightedRR: Number(plan.weightedRR.toFixed(2)),
      riskStatus: riskResult.status,
    });

    await sendMarkdown(
      `👁 *${order.symbol}* — записано в shadow\n` +
      `Вхід: \`${fmt(enrichedOrder.entryPrice)}\`  SL: \`${fmt(plan.slPrice)}\` _(${plan.slSource})_\n` +
      `Зважений R:R: \`${plan.weightedRR.toFixed(2)}\`  Плече: \`${riskResult.leverage}x\`\n` +
      `_Ордер не виставлено_`
    );
    return null;
  }

  // ── FULL_AUTO ─────────────────────────────────────────────────────────────
  if (isFullAuto()) {
    logger.info('FULL_AUTO — executing immediately', { symbol: order.symbol });
    await recordEvaluation(evaluationRow(enrichedOrder, ctx, DECISIONS.EXECUTED));
    await executeAndNotify(enrichedOrder, riskResult, balance);
    return null;
  }

  // ── SEMI_AUTO ─────────────────────────────────────────────────────────────
  if (isSemiAuto()) {
    // Автоматично тільки якщо: riskEngine OK І ціна підтверджено в зоні входу
    const autoOk = riskResult?.status === VALIDATION.OK && marketEntry?.inZone === true;
    if (autoOk) {
      logger.info('SEMI_AUTO — conditions OK, executing immediately', { symbol: order.symbol });
      await recordEvaluation(evaluationRow(enrichedOrder, ctx, DECISIONS.EXECUTED));
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
  await recordEvaluation(evaluationRow(enrichedOrder, ctx, DECISIONS.CONFIRM_REQUESTED));
  return showConfirmCard(enrichedOrder, riskResult, marketEntry, currentPrice, balance, plan);
}

export function registerConfirmationHandler() {
  const bot = getBot();
  bot.on('callback_query', async (query) => {
    if (!query.data) return;
    if (String(query.message?.chat?.id) !== String(ADMIN_CHAT_ID)) return;
    const [action, confirmId] = query.data.split(':');
    if (!['confirm', 'cancel'].includes(action)) return;
    await answerCallback(query.id);
    await handleCallback(action, confirmId, query.message);
  });
  logger.info('Confirmation handler registered');
}

// ─── Confirmation card ────────────────────────────────────────────────────────

async function showConfirmCard(order, risk, marketEntry, currentPrice, balance, plan) {
  const confirmId = crypto.randomUUID();
  const text      = buildConfirmCard(order, risk, marketEntry, currentPrice, balance, plan);
  const keyboard  = buildKeyboard(confirmId);

  const sentMsg = await sendMarkdown(text, { reply_markup: keyboard });
  if (!sentMsg) return null;

  const expiresAt = Date.now() + CONFIRM_TTL_MS;

  const reminderTimer = setTimeout(() => sendReminder(confirmId), CONFIRM_TTL_MS - REMINDER_BEFORE_MS);
  const expireTimer   = setTimeout(() => expirePending(confirmId), CONFIRM_TTL_MS);

  // Зберігаємо balance щоб передати в executeOrder при підтвердженні
  pending.set(confirmId, {
    order, risk, marketEntry, balance, plan,
    evaluationPrice: currentPrice,
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

function buildConfirmCard(order, risk, marketEntry, currentPrice, balance, plan) {
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

    // Коли стоп власний, показуємо наскільки він вужчий за SL провайдера —
    // це основне джерело різниці в R між цією угодою і сигналом як опубліковано.
    if (order.providerSlPrice && plan?.slSource === 'own') {
      const provPct = Math.abs(pctDiff(order.providerSlPrice, refPrice));
      const tighter = provPct / (slPct || 1);
      lines.push(`SL сигналу   : \`${fmt(order.providerSlPrice)}\`  (${provPct.toFixed(2)}%) — власний вужчий у ${tighter.toFixed(1)}×`);
    }
  }

  // ── Take-Profits ───────────────────────────────────────────────────────────
  const rPts = refPrice && slPrice ? Math.abs(refPrice - slPrice) : null;

  if (tpPrices.length > 0) {
    lines.push(``, `🎯 *Take-Profits*`);

    // R:R від поточної ціни (важливо при market-вході)
    const rrNote = marketEntry?.slipped
      ? `  _(R:R від поточної ціни)_`
      : '';

    const shares = normalizedTpShares(tpPrices.length);

    tpPrices.forEach((tp, i) => {
      const level  = i + 1;
      const share  = Math.round((shares[i] ?? 0) * 100);
      const tpPct  = refPrice ? Math.abs(pctDiff(tp, refPrice)) : null;
      const sign   = isLong ? '+' : '-';
      const pctStr = tpPct !== null ? ` ${sign}${tpPct.toFixed(2)}%` : '';
      const rrStr  = rPts ? `  ${(Math.abs(tp - refPrice) / rPts).toFixed(1)}R` : '';
      const shareLabel = share > 0 ? `*${share}% позиції*` : '_не виставляється_';
      lines.push(`TP${level} → \`${fmt(tp)}\` (${pctStr}${rrStr})  — ${shareLabel}`);
    });

    // Зважений R:R — те, за чим приймається рішення. R:R до TP1 показуємо
    // довідково: провайдери ставлять TP1 приблизно на 1R, тому сам по собі
    // він майже нічого не говорить про якість угоди.
    if (plan?.weightedRR) {
      lines.push(`R:R зважений : \`${plan.weightedRR.toFixed(2)}\`  (до TP1: \`${plan.rr[0].toFixed(2)}\`)${rrNote}`);
    } else if (marketEntry?.rrFromCurrent) {
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
    await updateSignalStatus(entry.order._signalDbId, 'CANCELLED', 'Cancelled by user');
    pending.delete(confirmId);
    logger.info('Order cancelled by user', { confirmId });
    return;
  }

  await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
    `_⏳ ${entry.order.symbol} — повторна перевірка..._`, { parse_mode: 'Markdown' });

  try {
    const checked = await recheckBeforeExecution(entry);
    const result = await executeOrder(checked.order, checked.risk, checked.balance);
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      `_✅ ${entry.order.symbol} — виконано_\norderId: \`${result.entry.orderId}\``,
      { parse_mode: 'Markdown' });
    logger.info('Order executed', { confirmId, orderId: result.entry.orderId });
  } catch (err) {
    const status = err instanceof ConfirmationRejectedError ? 'REJECTED' : 'FAILED';
    await updateSignalStatus(
      entry.order._signalDbId,
      status,
      `${status === 'REJECTED' ? 'Confirmation recheck rejected' : 'Confirmed order failed'}: ${err.message}`
    );
    await editMessage(callbackMsg.chat.id, callbackMsg.message_id,
      `_❌ ${entry.order.symbol} — відхилено після перевірки: ${err.message}_`,
      { parse_mode: 'Markdown' });
    logger.error('Order execution failed', { confirmId, err: err.message });
  }

  pending.delete(confirmId);
}

async function recheckBeforeExecution(entry) {
  const [priceResult, balanceResult] = await Promise.allSettled([
    getMarkPrice(entry.order.symbol),
    getUSDTBalance(),
  ]);

  if (priceResult.status !== 'fulfilled' || !Number.isFinite(priceResult.value)) {
    throw new ConfirmationRejectedError('Could not fetch current mark price');
  }

  const currentPrice = priceResult.value;
  const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
  const evaluationPrice = entry.evaluationPrice;

  if (evaluationPrice) {
    const movePct = Math.abs(currentPrice - evaluationPrice) / evaluationPrice;
    if (movePct > CONFIRM_MAX_PRICE_MOVE_PCT) {
      throw new ConfirmationRejectedError(
        `Price moved ${(movePct * 100).toFixed(2)}% since evaluation ` +
        `(max ${(CONFIRM_MAX_PRICE_MOVE_PCT * 100).toFixed(2)}%)`
      );
    }
  }

  let order = { ...entry.order };

  if (order.tpPrices?.length > 0) {
    const marketEntry = validateMarketEntry({
      currentPrice,
      slPrice: order.slPrice,
      tp1Price: order.tpPrices[0],
      entryLow: order.entryLow ?? order.entryPrice ?? currentPrice,
      entryHigh: order.entryHigh ?? order.entryPrice ?? currentPrice,
      side: order.side,
    });

    if (!marketEntry.valid) {
      throw new ConfirmationRejectedError(marketEntry.reason);
    }

    if (!marketEntry.inZone || order.entryType === 'MARKET') {
      order = { ...order, entryType: 'MARKET', entryPrice: currentPrice };
    }
  }

  const effectiveEntry = order.entryType === 'MARKET' ? currentPrice : order.entryPrice;

  // Стоп перераховуємо від фактичної ціни підтвердження, а не переносимо той,
  // що був порахований 30 хвилин тому: ціна змістилась — змістився і план.
  const atr = await getATR(order.symbol, order.interval ?? '1h').catch(() => null);
  const plan = planEntry({
    entryPrice: effectiveEntry,
    side:       order.side,
    tpPrices:   order.tpPrices,
    providerSl: order.providerSlPrice ?? order.slPrice,
    atr,
    tpShares:   normalizedTpShares(order.tpPrices.length),
  });

  if (!plan.ok) throw new ConfirmationRejectedError(plan.reason);

  // За час життя картки могла відкритися інша позиція — перевіряємо знову.
  const portfolioBlock = checkPortfolioLimits(order.symbol);
  if (portfolioBlock) throw new ConfirmationRejectedError(portfolioBlock);

  order = { ...order, providerSlPrice: order.providerSlPrice ?? order.slPrice, slPrice: plan.slPrice };

  const risk = await calcFromBalance({
    entryPrice: effectiveEntry,
    slPrice: order.slPrice,
    symbol: order.symbol,
    balance: balance?.available ?? null,
  });

  if (!risk || risk.status === VALIDATION.REJECT) {
    throw new ConfirmationRejectedError(
      risk?.reason ?? 'Risk calculation failed during confirmation recheck'
    );
  }

  logger.info('Confirmation recheck passed', {
    symbol: order.symbol,
    evaluationPrice,
    currentPrice,
    entryType:  order.entryType,
    riskStatus: risk.status,
    slPrice:    plan.slPrice,
    slSource:   plan.slSource,
    weightedRR: Number(plan.weightedRR.toFixed(2)),
  });

  return {
    order: { ...order, quantity: risk.quantity },
    risk,
    balance,
  };
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

    // Позначаємо TRADED тільки якщо запис угоди реально створився в БД.
    if (tradeRecord?.id) {
      await updateSignalStatus(order._signalDbId, 'TRADED');
    } else {
      logger.error('Trade was executed but DB record was not created; signal status not set to TRADED', {
        symbol,
        signalDbId: order._signalDbId ?? null,
      });
    }

    // Реєструємо в watchlist — передаємо tradeId для positionMonitor
    watchPosition(symbol, {
      side:       side === 'BUY' ? 'LONG' : 'SHORT',
      entryPrice: actualEntryPrice,
      slPrice, tpPrices, interval, timeoutCandles,
      initialQuantity: risk?.quantity ?? quantity,
      tpOrders: result.tps ?? [],
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
    await updateSignalStatus(
      order._signalDbId,
      'FAILED',
      `Automatic execution failed: ${err.message}`
    );
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

  await updateSignalStatus(entry.order._signalDbId, 'EXPIRED', 'Confirmation expired');

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
