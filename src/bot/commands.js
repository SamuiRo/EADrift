/**
 * commands.js — slash-команди для адміна
 *
 * /start                        — привітання + список команд
 * /positions                    — активні позиції з PnL
 * /orders [symbol]              — відкриті ордери
 * /balance                      — баланс акаунту
 * /cancel <symbol> <orderId>    — скасувати ордер
 * /cancelall <symbol>           — скасувати всі ордери по символу
 * /sl <symbol> <price>          — вручну перенести SL
 * /be <symbol>                  — перенести SL в BE+
 * /watch                        — що зараз відстежує монітор
 * /close <symbol> <fraction>    — частково закрити позицію (напр. 0.5 = 50%)
 * /mode <mode>                  — full_auto | semi_auto | confirm | pause
 * /status                       — поточний режим + баланс
 */

import { getBot, adminOnly, sendMarkdown, formatPosition } from './telegram.js';
import {
  getOpenPositions,
  getOpenOrders,
  getAccountBalance,
  cancelOrder,
  cancelAllOrders,
  updateStopLoss,
  moveSLtoBreakEven,
  partialClose,
} from '../exchanges/binance.js';
import { getWatchlist, updateWatchedSL } from '../core/positionMonitor.js';
import { getMode, setMode, TRADING_MODES, MODE_LABELS } from '../core/tradingMode.js';
import { RISK_CONFIG } from '../core/riskEngine.js';
import { logger } from '../shared/logger.js';

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerCommands() {
  const bot = getBot();

  bot.onText(/\/start/,                adminOnly(handleStart));
  bot.onText(/\/status/,               adminOnly(handleStatus));
  bot.onText(/\/mode (.+)/,            adminOnly(handleMode));
  bot.onText(/\/positions?/,           adminOnly(handlePositions));
  bot.onText(/\/orders?(.*)$/,         adminOnly(handleOrders));
  bot.onText(/\/balance/,              adminOnly(handleBalance));
  bot.onText(/\/cancel (.+)/,          adminOnly(handleCancel));
  bot.onText(/\/cancelall (.+)/,       adminOnly(handleCancelAll));
  bot.onText(/\/sl (.+)/,              adminOnly(handleSL));
  bot.onText(/\/be (.+)/,              adminOnly(handleBE));
  bot.onText(/\/watch/,                adminOnly(handleWatch));
  bot.onText(/\/close (.+)/,           adminOnly(handleClose));

  logger.info('Commands registered');
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStart(msg) {
  const mode = getMode();
  const text = [
    `*Trading Bot* 🤖   |   ${MODE_LABELS[mode]}`,
    ``,
    `*Режим торгівлі:*`,
    `\`/mode full_auto\`  — автоматично всі сигнали`,
    `\`/mode semi_auto\`  — автоматично якщо ризик ОК, інакше confirm`,
    `\`/mode confirm\`    — завжди чекати підтвердження`,
    `\`/mode pause\`      — ігнорувати всі сигнали`,
    ``,
    `*Перегляд:*`,
    `\`/status\`          — режим + баланс`,
    `\`/positions\`       — активні позиції з PnL`,
    `\`/orders [SYMBOL]\` — відкриті ордери`,
    `\`/balance\`         — баланс акаунту`,
    `\`/watch\`           — що відстежує монітор`,
    ``,
    `*Управління SL:*`,
    `\`/sl BTCUSDT 67000\` — перенести SL`,
    `\`/be BTCUSDT\`       — SL в Break-Even+`,
    ``,
    `*Закриття:*`,
    `\`/close BTCUSDT 0.5\` — закрити 50% позиції`,
    `\`/close BTCUSDT 1\`   — закрити всю позицію`,
    ``,
    `*Скасування ордерів:*`,
    `\`/cancel BTCUSDT 123456789\``,
    `\`/cancelall BTCUSDT\``,
  ].join('\n');

  await sendMarkdown(text);
}

async function handleStatus(msg) {
  const mode = getMode();

  let balanceLine = '_не вдалось отримати_';
  try {
    const balances = await getAccountBalance();
    const usdt     = balances.find(b => b.asset === 'USDT');
    if (usdt) {
      const avail = parseFloat(usdt.availableBalance).toFixed(2);
      const total = parseFloat(usdt.balance).toFixed(2);
      balanceLine = `\`${avail}\` доступно / \`${total}\` всього`;
    }
  } catch {}

  const watchlist = getWatchlist();
  const watching  = Object.keys(watchlist).length;

  const text = [
    `*Статус бота*`,
    ``,
    `Режим       : *${MODE_LABELS[mode]}*`,
    `Баланс USDT : ${balanceLine}`,
    `Позицій     : \`${watching}\` в моніторі`,
    ``,
    `*Параметри ризику:*`,
    `Ризик/угода : \`${(RISK_CONFIG.riskPct * 100).toFixed(2)}%\``,
    `Макс плече  : \`${RISK_CONFIG.maxLeverage}x\``,
    `SL діапазон : \`${(RISK_CONFIG.minDeltaPct * 100).toFixed(1)}% – ${(RISK_CONFIG.maxDeltaPct * 100).toFixed(1)}%\``,
  ].join('\n');

  await sendMarkdown(text);
}

async function handleMode(msg, match) {
  const input = match[1].trim().toLowerCase().replace(/[_\-]/g, '_');

  const map = {
    'full_auto':    TRADING_MODES.FULL_AUTO,
    'fullauto':     TRADING_MODES.FULL_AUTO,
    'semi_auto':    TRADING_MODES.SEMI_AUTO,
    'semiauto':     TRADING_MODES.SEMI_AUTO,
    'semi':         TRADING_MODES.SEMI_AUTO,
    'confirm':      TRADING_MODES.CONFIRM_ONLY,
    'confirm_only': TRADING_MODES.CONFIRM_ONLY,
    'pause':        TRADING_MODES.PAUSED,
    'paused':       TRADING_MODES.PAUSED,
  };

  const newMode = map[input];

  if (!newMode) {
    await sendMarkdown(
      `_Невідомий режим: \`${input}\`_\n\n` +
      `Доступні: \`full_auto\` | \`semi_auto\` | \`confirm\` | \`pause\``
    );
    return;
  }

  const oldMode = getMode();
  setMode(newMode);

  logger.info('Trading mode changed', { from: oldMode, to: newMode });

  // Додаткове попередження для небезпечних переходів
  let warning = '';
  if (newMode === TRADING_MODES.FULL_AUTO) {
    warning = `\n\n⚠️ _Full Auto активний — всі валідні сигнали виконуються без підтвердження_`;
  }

  await sendMarkdown(
    `*Режим змінено*\n` +
    `${MODE_LABELS[oldMode]} → *${MODE_LABELS[newMode]}*` +
    warning
  );
}

async function handlePositions(msg) {
  let positions;
  try {
    positions = await getOpenPositions();
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
    return;
  }

  if (positions.length === 0) {
    await sendMarkdown('_Немає відкритих позицій_');
    return;
  }

  const lines = positions.map(formatPosition).join('\n\n─────────────\n\n');
  await sendMarkdown(lines);
}

async function handleOrders(msg, match) {
  const symbol = match[1]?.trim().toUpperCase() || null;

  let orders;
  try {
    orders = await getOpenOrders(symbol);
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
    return;
  }

  if (orders.length === 0) {
    await sendMarkdown(`_Немає відкритих ордерів${symbol ? ` по ${symbol}` : ''}_`);
    return;
  }

  const lines = orders.map(o => {
    const price = o.price !== '0' ? o.price : (o.stopPrice || '—');
    return (
      `*${o.symbol}* ${o.side} \`${o.type}\`\n` +
      `Qty: \`${o.origQty}\`  Price: \`${price}\`\n` +
      `ID: \`${o.orderId}\``
    );
  }).join('\n\n');

  await sendMarkdown(lines);
}

async function handleBalance(msg) {
  let balances;
  try {
    balances = await getAccountBalance();
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
    return;
  }

  if (balances.length === 0) {
    await sendMarkdown('_Баланс порожній_');
    return;
  }

  const lines = balances.map(b => {
    const avail = parseFloat(b.availableBalance).toFixed(2);
    const total = parseFloat(b.balance).toFixed(2);
    return `*${b.asset}*: \`${avail}\` доступно / \`${total}\` всього`;
  }).join('\n');

  await sendMarkdown(`*Баланс:*\n\n${lines}`);
}

async function handleCancel(msg, match) {
  const parts   = match[1].trim().split(/\s+/);
  const symbol  = parts[0]?.toUpperCase();
  const orderId = parts[1];

  if (!symbol || !orderId) {
    await sendMarkdown('Використання: `/cancel BTCUSDT 123456789`');
    return;
  }

  try {
    await cancelOrder(symbol, orderId);
    await sendMarkdown(`_Ордер \`${orderId}\` по ${symbol} скасовано ✓_`);
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
  }
}

async function handleCancelAll(msg, match) {
  const symbol = match[1].trim().toUpperCase();
  if (!symbol) {
    await sendMarkdown('Використання: `/cancelall BTCUSDT`');
    return;
  }

  try {
    await cancelAllOrders(symbol);
    await sendMarkdown(`_Всі ордери по ${symbol} скасовано ✓_`);
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
  }
}

async function handleSL(msg, match) {
  const parts    = match[1].trim().split(/\s+/);
  const symbol   = parts[0]?.toUpperCase();
  const newPrice = parseFloat(parts[1]);

  if (!symbol || isNaN(newPrice)) {
    await sendMarkdown('Використання: `/sl BTCUSDT 67000`');
    return;
  }

  try {
    await updateStopLoss(symbol, newPrice, 'manual_command');
    updateWatchedSL(symbol, newPrice);
    await sendMarkdown(`_SL по ${symbol} → \`${newPrice}\` ✓_`);
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
  }
}

async function handleBE(msg, match) {
  const symbol = match[1].trim().toUpperCase();
  if (!symbol) {
    await sendMarkdown('Використання: `/be BTCUSDT`');
    return;
  }

  try {
    const result = await moveSLtoBreakEven(symbol);
    await sendMarkdown(
      `_SL по ${symbol} перенесено в BE+ ✓_\n` +
      `orderId: \`${result?.orderId ?? '—'}\``
    );
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
  }
}

async function handleClose(msg, match) {
  const parts    = match[1].trim().split(/\s+/);
  const symbol   = parts[0]?.toUpperCase();
  const fraction = parseFloat(parts[1]);

  if (!symbol || isNaN(fraction) || fraction <= 0 || fraction > 1) {
    await sendMarkdown('Використання: `/close BTCUSDT 0.5` (частка від 0.01 до 1)');
    return;
  }

  try {
    await partialClose(symbol, fraction, 'manual_command');
    await sendMarkdown(`_${symbol}: закрито ${fraction * 100}% позиції ✓_`);
  } catch (err) {
    await sendMarkdown(`_Помилка: ${err.message}_`);
  }
}

async function handleWatch(msg) {
  const watchlist = getWatchlist();
  const symbols   = Object.keys(watchlist);

  if (symbols.length === 0) {
    await sendMarkdown('_Монітор нічого не відстежує_');
    return;
  }

  const lines = symbols.map(sym => {
    const m = watchlist[sym];

    const tpLines = m.tpPrices.map((price, i) => {
      const done  = m.tpTriggered[i] ? ' ✅' : '';
      const dist  = ['40%', '30%', '20%', '10%'][i] ?? '?';
      return `  TP${i + 1}: \`${price}\` (${dist})${done}`;
    }).join('\n');

    const trailing = m.trailingActive ? '\n  🔄 Trailing активний' : '';
    const timeout  = m.tickCount > 0
      ? `\n  ⏱ Тіків без руху: ${m.tickCount}`
      : '';

    return (
      `*${sym}* ${m.side} | TF: ${m.interval}\n` +
      `SL: \`${m.slPrice}\` | Entry: \`${m.entryPrice}\`\n` +
      `${tpLines}${trailing}${timeout}`
    );
  }).join('\n\n─────────────\n\n');

  await sendMarkdown(`*Монітор відстежує (${symbols.length}):*\n\n${lines}`);
}