/**
 * Signal.js
 *
 * Кожен сигнал з каналу — незалежно від того чи торгувався.
 * Зберігається одразу після парсингу, до будь-якої валідації.
 */

import { DataTypes } from 'sequelize';

export default (sequelize) => sequelize.define('Signal', {
  id: {
    type:          DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey:    true,
  },

  // Ідентифікатор з каналу (може бути null якщо канал не дає)
  signalId: {
    type:      DataTypes.STRING(64),
    allowNull: true,
    comment:   'ID сигналу з Telegram-каналу',
  },

  symbol: {
    type:      DataTypes.STRING(20),
    allowNull: false,
  },

  side: {
    type:      DataTypes.ENUM('LONG', 'SHORT'),
    allowNull: false,
  },

  // Зона входу з сигналу
  entryLow:  { type: DataTypes.DOUBLE, allowNull: true },
  entryHigh: { type: DataTypes.DOUBLE, allowNull: true },
  entryMid:  { type: DataTypes.DOUBLE, allowNull: true },

  slPrice: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Stop-loss з сигналу',
  },

  // TP рівні зберігаємо як JSON масив [tp1, tp2, tp3, tp4]
  tpPrices: {
    type:      DataTypes.JSON,
    allowNull: true,
    comment:   '[TP1, TP2, TP3, TP4]',
  },

  timeframe: {
    type:      DataTypes.STRING(10),
    allowNull: true,
    comment:   'Таймфрейм з сигналу (1h, 15m тощо)',
  },

  accuracy: {
    type:      DataTypes.FLOAT,
    allowNull: true,
    comment:   'Точність сигналу з каналу (%)',
  },

  rawText: {
    type:      DataTypes.TEXT,
    allowNull: true,
    comment:   'Оригінальний текст повідомлення',
  },

  // Результат обробки сигналу
  status: {
    type:         DataTypes.ENUM('PENDING', 'TRADED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'PAUSED'),
    allowNull:    false,
    defaultValue: 'PENDING',
    comment:      'TRADED=відкрита угода, REJECTED=не пройшов перевірку, EXPIRED=TTL вийшов',
  },

  rejectReason: {
    type:      DataTypes.STRING(512),
    allowNull: true,
    comment:   'Причина відхилення (від riskEngine або validateMarketEntry)',
  },

  // Ціна на момент надходження сигналу
  priceAtSignal: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Mark price на момент отримання сигналу',
  },

  receivedAt: {
    type:         DataTypes.DATE,
    allowNull:    false,
    defaultValue: DataTypes.NOW,
    comment:      'Час отримання сигналу',
  },
}, {
  tableName:  'signals',
  timestamps: true, // createdAt, updatedAt
  indexes: [
    { fields: ['symbol'] },
    { fields: ['status'] },
    { fields: ['receivedAt'] },
    { fields: ['signalId'] },
  ],
});