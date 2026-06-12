const INTERVAL_UNITS_MS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function intervalToMs(interval) {
  const match = /^(\d+)([mhdw])$/.exec(interval ?? '');
  if (!match) return null;
  return Number(match[1]) * INTERVAL_UNITS_MS[match[2]];
}

export function isPositionTimedOut({ entryTime, timeoutCandles, interval, now = Date.now() }) {
  const intervalMs = intervalToMs(interval);
  if (!intervalMs || !timeoutCandles || timeoutCandles <= 0) return false;
  return now >= entryTime + timeoutCandles * intervalMs;
}

export function getTpCloseFraction(tpLevel, totalLevels = 4) {
  if (tpLevel >= totalLevels) return 0;

  const initialShares = [0.40, 0.30, 0.20];
  const desiredInitialShare = initialShares[tpLevel - 1] ?? 0;
  const alreadyClosed = initialShares
    .slice(0, tpLevel - 1)
    .reduce((sum, share) => sum + share, 0);

  return desiredInitialShare / (1 - alreadyClosed);
}

export function classifyMomentum(candles, side = null) {
  if (!Array.isArray(candles) || candles.length < 2) return 'neutral';

  const last = candles.at(-1);
  const baseline = candles.slice(0, -1);
  const avgVolume = average(baseline.map(c => c.volume));
  const avgRange = average(baseline.map(c => c.high - c.low));
  const lastRange = last.high - last.low;
  const direction = last.close > last.open ? 'LONG' : last.close < last.open ? 'SHORT' : null;
  const favorableDirection = !side || direction === side;

  const volumeStrong = last.volume > avgVolume * 1.3;
  const rangeStrong = lastRange > avgRange * 1.2;

  if (favorableDirection && volumeStrong && rangeStrong) return 'strong';
  if (!favorableDirection || last.volume < avgVolume * 0.7) return 'weak';
  return 'neutral';
}

export function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    throw new Error(`ATR requires at least ${period + 1} closed candles`);
  }

  const sample = candles.slice(-(period + 1));
  const trueRanges = [];

  for (let i = 1; i < sample.length; i++) {
    const current = sample[i];
    const previous = sample[i - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }

  return average(trueRanges);
}

export function calculateTrailingStop({ side, markPrice, atr, multiplier = 1.5 }) {
  return side === 'LONG'
    ? markPrice - atr * multiplier
    : markPrice + atr * multiplier;
}

export function roundTrailingStop({ side, price, tickSize }) {
  const ticks = price / tickSize;
  return (side === 'LONG' ? Math.floor(ticks) : Math.ceil(ticks)) * tickSize;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
