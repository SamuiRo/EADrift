/**
 * SlHistory.js
 *
 * Всі переміщення Stop-Loss по конкретній позиції.
 *
 * Окрема таблиця (не просто подія в trade_events) — бо дає можливість:
 *  - Аналізувати ефективність BE+ (скільки разів SL спрацював до TP2)
 *  - Оцінювати trailing — як далеко trailing відставав від ціни
 *  - Порівнювати initial SL vs final SL
 *  - Рахувати "вартість SL move" — скільки прибутку залишили на столі
 */

import { DataTypes } from 'sequelize';

export const SL_MOVE_REASONS = {
  INITIAL:          'INITIAL',         // Виставлення при відкритті
  BE_PLUS:          'BE_PLUS',         // TP1 hit → SL до BE+
  TP1:              'TP1',             // TP2 hit → SL до TP1
  TP2:              'TP2',             // TP3 hit → SL до TP2
  TRAILING:         'TRAILING',        // Trailing stop update
  MANUAL:           'MANUAL',          // Ручний /sl команда
};

export default (sequelize) => sequelize.define('SlHistory', {
  id: {
    type:          DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey:    true,
  },

  tradeId: {
    type:       DataTypes.INTEGER,
    allowNull:  false,
    references: { model: 'trades', key: 'id' },
  },

  reason: {
    type:      DataTypes.STRING(32),
    allowNull: false,
    comment:   'SL_MOVE_REASONS constant',
  },

  slPricePrev: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'SL до переміщення (null для INITIAL)',
  },

  slPriceNew: {
    type:      DataTypes.DOUBLE,
    allowNull: false,
    comment:   'Новий SL',
  },

  // Ринкова ціна в момент переміщення
  markPrice: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Mark price в момент SL move — для аналізу trailing lag',
  },

  // Відстань SL від ціни (для аналізу ширини захисту)
  distanceFromPricePct: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   '|markPrice - slPriceNew| / markPrice × 100',
  },

  // Binance order ID нового SL ордера
  orderId: {
    type:      DataTypes.STRING(32),
    allowNull: true,
  },

  movedAt: {
    type:         DataTypes.DATE,
    allowNull:    false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:  'sl_history',
  timestamps: false,
  indexes: [
    { fields: ['tradeId'] },
    { fields: ['reason'] },
    { fields: ['movedAt'] },
  ],
});