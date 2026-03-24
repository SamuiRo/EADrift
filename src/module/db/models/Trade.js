/**
 * Trade.js
 *
 * Одна позиція від відкриття до закриття.
 * Всі аналітичні поля — мінімальний набір + розширення для оптимізації SL/TP.
 */

import { DataTypes } from 'sequelize';

export default (sequelize) => sequelize.define('Trade', {
  id: {
    type:          DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey:    true,
  },

  // FK → signals
  signalId: {
    type:       DataTypes.INTEGER,
    allowNull:  true,
    references: { model: 'signals', key: 'id' },
    comment:    'NULL якщо угода відкрита вручну',
  },

  // ── Ідентифікація ────────────────────────────────────────────────────────────
  symbol:    { type: DataTypes.STRING(20), allowNull: false },
  side:      { type: DataTypes.ENUM('LONG', 'SHORT'), allowNull: false },

  // Binance order IDs
  entryOrderId: { type: DataTypes.STRING(32), allowNull: true },
  slOrderId:    { type: DataTypes.STRING(32), allowNull: true },

  // ── Параметри входу ──────────────────────────────────────────────────────────
  entryType: {
    type:      DataTypes.ENUM('LIMIT', 'MARKET'),
    allowNull: false,
  },

  entryPrice: {
    type:      DataTypes.DOUBLE,
    allowNull: false,
    comment:   'Реальна ціна виконання (avgPrice для MARKET)',
  },

  entryPricePlanned: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Планова ціна з сигналу (entryMid)',
  },

  // ── SL ───────────────────────────────────────────────────────────────────────
  slPriceInitial: {
    type:      DataTypes.DOUBLE,
    allowNull: false,
    comment:   'SL на момент відкриття',
  },

  slPriceFinal: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'SL на момент закриття (trailing/BE/TP-move)',
  },

  // ── TP ───────────────────────────────────────────────────────────────────────
  tpPrices: {
    type:      DataTypes.JSON,
    allowNull: true,
    comment:   '[TP1, TP2, TP3, TP4] — планові ціни',
  },

  tp1Hit: { type: DataTypes.BOOLEAN, defaultValue: false },
  tp2Hit: { type: DataTypes.BOOLEAN, defaultValue: false },
  tp3Hit: { type: DataTypes.BOOLEAN, defaultValue: false },
  tp4Hit: { type: DataTypes.BOOLEAN, defaultValue: false },

  // ── Розмір позиції ───────────────────────────────────────────────────────────
  quantity: {
    type:      DataTypes.DOUBLE,
    allowNull: false,
    comment:   'Розмір в базовій монеті',
  },

  positionUsdt: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Обсяг позиції в USDT (quantity × entryPrice)',
  },

  leverage: {
    type:      DataTypes.INTEGER,
    allowNull: false,
    comment:   'Плече (ISOLATED)',
  },

  // ── Ризик ────────────────────────────────────────────────────────────────────
  riskPerTradeUsdt: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Розрахунковий ризик (riskEngine.realRiskUsdt)',
  },

  riskPerTradePct: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Ризик як % від балансу на момент відкриття',
  },

  balanceAtEntry: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Баланс USDT (available) на момент відкриття',
  },

  // ── Результат ────────────────────────────────────────────────────────────────
  exitPrice: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Середньозважена ціна виходу (всі часткові закриття)',
  },

  profitUsdt: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'PnL в USDT (realised, з комісіями якщо відомо)',
  },

  profitR: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'PnL в R (profitUsdt / riskPerTradeUsdt)',
  },

  profitPct: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'PnL як % від positionUsdt',
  },

  // ── Drawdown / Peak ──────────────────────────────────────────────────────────
  maxDrawdownPct: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Максимальна просадка під час угоди (% від entry)',
  },

  maxProfitPct: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Максимальний профіт під час угоди (% від entry)',
  },

  // ── Час ─────────────────────────────────────────────────────────────────────
  openedAt: {
    type:      DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },

  closedAt: {
    type:      DataTypes.DATE,
    allowNull: true,
  },

  timeInTradeMs: {
    type:      DataTypes.BIGINT,
    allowNull: true,
    comment:   'Час у позиції в мілісекундах',
  },

  // ── Статус ───────────────────────────────────────────────────────────────────
  status: {
    type:         DataTypes.ENUM('OPEN', 'CLOSED', 'PARTIALLY_CLOSED'),
    allowNull:    false,
    defaultValue: 'OPEN',
  },

  closeReason: {
    type:      DataTypes.ENUM(
      'tp1', 'tp2', 'tp3', 'tp4',
      'sl_hit',
      'trailing_stop',
      'early_exit_timeout',
      'fake_breakout_protection',
      'weak_momentum',
      'manual',
      'liquidation',
    ),
    allowNull: true,
    comment:   'Причина закриття',
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────
  interval: {
    type:      DataTypes.STRING(10),
    allowNull: true,
    comment:   'Таймфрейм (для ATR/momentum)',
  },

  tradingMode: {
    type:      DataTypes.ENUM('FULL_AUTO', 'SEMI_AUTO', 'CONFIRM_ONLY'),
    allowNull: true,
    comment:   'Режим торгівлі на момент виконання',
  },

  notes: {
    type:      DataTypes.TEXT,
    allowNull: true,
    comment:   'Вільні нотатки (наприклад weak/strong momentum)',
  },
}, {
  tableName:  'trades',
  timestamps: true,
  indexes: [
    { fields: ['symbol'] },
    { fields: ['status'] },
    { fields: ['openedAt'] },
    { fields: ['signalId'] },
    { fields: ['closeReason'] },
  ],
});