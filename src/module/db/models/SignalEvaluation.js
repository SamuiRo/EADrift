/**
 * SignalEvaluation.js
 *
 * Знімок рішення системи по сигналу — включно з тими, що були відхилені.
 *
 * Навіщо окрема таблиця, а не поля в `signals`: `signals` описує те, що
 * прийшло з джерела, і має лишатися незмінним. Тут — те, що система на ці
 * дані відповіла, разом із ринковим контекстом на момент рішення.
 *
 * Записується в усіх режимах, включно з SHADOW. Саме відхилені сигнали дають
 * найцінніший матеріал: питання "чи правильно ми пропустили" без цих рядків
 * узагалі не можна поставити.
 *
 * Похідні величини (R, результат) тут навмисно відсутні — вони рахуються
 * офлайн зі свічок. Так політику виходу можна перевіряти заднім числом,
 * зокрема ту, якої на момент запису ще не існувало.
 */

import { DataTypes } from 'sequelize';

export const DECISIONS = {
  EXECUTED:          'EXECUTED',           // ордер виставлено
  CONFIRM_REQUESTED: 'CONFIRM_REQUESTED',  // показано картку підтвердження
  REJECTED:          'REJECTED',           // відсіяно фільтром
  SHADOW:            'SHADOW',             // пройшов би, але режим спостереження
};

export default (sequelize) => sequelize.define('SignalEvaluation', {
  id: {
    type:          DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey:    true,
  },

  signalId: {
    type:      DataTypes.INTEGER,
    allowNull: true,
    comment:   'FK на signals.id',
  },

  symbol: { type: DataTypes.STRING(20), allowNull: false },
  side:   { type: DataTypes.ENUM('LONG', 'SHORT'), allowNull: false },
  source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'unknown' },

  decision: {
    type:      DataTypes.ENUM(...Object.values(DECISIONS)),
    allowNull: false,
  },

  reason: {
    type:      DataTypes.STRING(512),
    allowNull: true,
    comment:   'Причина відхилення або примітка до рішення',
  },

  tradingMode: { type: DataTypes.STRING(16), allowNull: true },

  // ── Ринковий контекст на момент рішення ─────────────────────────────────
  markPrice: { type: DataTypes.DOUBLE, allowNull: true },
  atr:       { type: DataTypes.DOUBLE, allowNull: true, comment: 'ATR таймфрейму сигналу, в ціні' },
  interval:  { type: DataTypes.STRING(10), allowNull: true },

  // ── Що система планувала зробити ────────────────────────────────────────
  entryType:   { type: DataTypes.STRING(10), allowNull: true },
  entryPrice:  { type: DataTypes.DOUBLE, allowNull: true },
  inZone:      { type: DataTypes.BOOLEAN, allowNull: true },
  slippagePct: { type: DataTypes.DOUBLE, allowNull: true },

  providerSlPrice: { type: DataTypes.DOUBLE, allowNull: true, comment: 'SL як опубліковано джерелом' },
  plannedSlPrice:  { type: DataTypes.DOUBLE, allowNull: true, comment: 'SL, порахований planEntry()' },
  slSource:        { type: DataTypes.STRING(10), allowNull: true, comment: 'own | provider' },
  slDistancePct:   { type: DataTypes.DOUBLE, allowNull: true },

  rrToTp1:    { type: DataTypes.DOUBLE, allowNull: true },
  weightedRR: { type: DataTypes.DOUBLE, allowNull: true },

  // ── Розмір ──────────────────────────────────────────────────────────────
  quantity:         { type: DataTypes.DOUBLE, allowNull: true },
  leverage:         { type: DataTypes.INTEGER, allowNull: true },
  positionUsdt:     { type: DataTypes.DOUBLE, allowNull: true },
  riskUsdt:         { type: DataTypes.DOUBLE, allowNull: true },
  balanceAvailable: { type: DataTypes.DOUBLE, allowNull: true },

  evaluatedAt: {
    type:         DataTypes.DATE,
    allowNull:    false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:  'signal_evaluations',
  timestamps: false,
  indexes: [
    { fields: ['signalId'] },
    { fields: ['symbol'] },
    { fields: ['decision'] },
    { fields: ['source'] },
    { fields: ['evaluatedAt'] },
  ],
});
