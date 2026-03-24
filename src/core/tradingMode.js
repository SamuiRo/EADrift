/**
 * tradingMode.js
 *
 * Управління режимами торгівлі.
 *
 * FULL_AUTO    — виконувати всі сигнали автоматично (тільки REJECT блокує)
 * SEMI_AUTO    — автоматично якщо riskEngine повертає OK,
 *                інакше кидати на підтвердження з подовженим TTL
 * CONFIRM_ONLY — завжди чекати підтвердження адміна
 * PAUSED       — ігнорувати всі нові сигнали
 *
 * Режим зберігається в пам'яті (reset при перезапуску).
 * Зміна через Telegram-команди: /mode full_auto | semi_auto | confirm | pause
 */

export const TRADING_MODES = {
    FULL_AUTO:    'FULL_AUTO',
    SEMI_AUTO:    'SEMI_AUTO',
    CONFIRM_ONLY: 'CONFIRM_ONLY',
    PAUSED:       'PAUSED',
  };
  
  // Default — безпечний режим при старті
  let currentMode = TRADING_MODES.CONFIRM_ONLY;
  
  export function getMode()         { return currentMode; }
  export function setMode(mode)     {
    if (!Object.values(TRADING_MODES).includes(mode)) {
      throw new Error(`Unknown trading mode: ${mode}`);
    }
    currentMode = mode;
  }
  
  export function isPaused()        { return currentMode === TRADING_MODES.PAUSED; }
  export function isFullAuto()      { return currentMode === TRADING_MODES.FULL_AUTO; }
  export function isSemiAuto()      { return currentMode === TRADING_MODES.SEMI_AUTO; }
  export function isConfirmOnly()   { return currentMode === TRADING_MODES.CONFIRM_ONLY; }
  
  export const MODE_LABELS = {
    [TRADING_MODES.FULL_AUTO]:    '🤖 Full Auto',
    [TRADING_MODES.SEMI_AUTO]:    '⚡ Semi Auto',
    [TRADING_MODES.CONFIRM_ONLY]: '✋ Confirm Only',
    [TRADING_MODES.PAUSED]:       '⏸ Paused',
  };