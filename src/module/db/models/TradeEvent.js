/**
 * TradeEvent.js
 *
 * Хронологія подій по конкретній позиції.
 * Кожна дія positionMonitor → окремий запис.
 *
 * Використовується для:
 *  - Replay угоди крок за кроком
 *  - Аналізу чому спрацював той чи інший захист
 *  - Графіку PnL по часу
 */

import { DataTypes } from 'sequelize';

// Всі можливі типи подій в системі
export const EVENT_TYPES = {
  // Відкриття / закриття
  TRADE_OPENED:              'TRADE_OPENED',
  TRADE_CLOSED:              'TRADE_CLOSED',
  PARTIAL_CLOSE:             'PARTIAL_CLOSE',

  // TP Events
  TP1_HIT:                   'TP1_HIT',
  TP2_HIT:                   'TP2_HIT',
  TP3_HIT:                   'TP3_HIT',
  TP4_HIT:                   'TP4_HIT',

  // SL Events
  SL_MOVED_BE:               'SL_MOVED_BE',        // SL → Break-Even+
  SL_MOVED_TP1:              'SL_MOVED_TP1',        // SL → TP1
  SL_MOVED_TP2:              'SL_MOVED_TP2',        // SL → TP2
  SL_MOVED_TRAILING:         'SL_MOVED_TRAILING',   // Trailing update
  SL_MOVED_MANUAL:           'SL_MOVED_MANUAL',     // Ручний /sl команда

  // Momentum
  MOMENTUM_WEAK:             'MOMENTUM_WEAK',       // extra close 25%
  MOMENTUM_STRONG:           'MOMENTUM_STRONG',     // realloc TP2→TP3

  // Захисти
  FAKE_BREAKOUT_DETECTED:    'FAKE_BREAKOUT_DETECTED',
  EARLY_EXIT_TIMEOUT:        'EARLY_EXIT_TIMEOUT',
  TRAILING_ACTIVATED:        'TRAILING_ACTIVATED',

  // Монітор
  POSITION_DISAPPEARED:      'POSITION_DISAPPEARED', // зникла з біржі (SL hit / liq)
};

export default (sequelize) => sequelize.define('TradeEvent', {
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

  eventType: {
    type:      DataTypes.STRING(64),
    allowNull: false,
    comment:   'EVENT_TYPES constant',
  },

  // Ціна в момент події
  price: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Mark price в момент події',
  },

  // Для PARTIAL_CLOSE — скільки закрили
  closedFraction: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   '0.0–1.0 частка що закрили',
  },

  closedQuantity: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
    comment:   'Кількість в базовій монеті',
  },

  // Для SL moves — ціна до і після
  slFrom: { type: DataTypes.DOUBLE, allowNull: true },
  slTo:   { type: DataTypes.DOUBLE, allowNull: true },

  // Поточний PnL в момент події (unrealised)
  unrealisedPnlUsdt: {
    type:      DataTypes.DOUBLE,
    allowNull: true,
  },

  // Вільне поле для контексту
  meta: {
    type:      DataTypes.JSON,
    allowNull: true,
    comment:   'Довільний JSON — momentum value, tickCount тощо',
  },

  occurredAt: {
    type:         DataTypes.DATE,
    allowNull:    false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:  'trade_events',
  timestamps: false, // occurredAt достатньо
  indexes: [
    { fields: ['tradeId'] },
    { fields: ['eventType'] },
    { fields: ['occurredAt'] },
    { fields: ['tradeId', 'eventType'] },
  ],
});