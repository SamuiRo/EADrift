import { getBot, isAdmin, sendMarkdown } from './telegram.js';
import { requestConfirmation } from './confirmation.js';
import { parseSignal } from '../parser/signalParser.js';
import { logger } from '../shared/logger.js';

export function signalToOrder(signal) {
  return {
    symbol:     signal.symbol,
    side:       signal.side === 'LONG' ? 'BUY' : 'SELL',
    entryType:  'LIMIT',
    entryPrice: signal.entryMid,
    entryLow:   signal.entryLow,
    entryHigh:  signal.entryHigh,
    slPrice:    signal.slPrice,
    tpPrices:   signal.tpPrices,
    interval:   signal.timeframe ?? '1h',
    signalId:   signal.signalId,
    accuracy:   signal.accuracy,
    rawText:    signal.rawText,
  };
}

export async function handleParsedSignal(signal, { source = 'unknown' } = {}) {
  if (signal.type === 'REPORT') {
    logger.info('Signal report received', {
      source,
      symbol: signal.symbol,
      signalId: signal.signalId,
    });
    return null;
  }

  logger.info('New signal received, requesting confirmation', {
    source,
    symbol: signal.symbol,
    side: signal.side,
  });

  return requestConfirmation(signalToOrder(signal));
}

export function registerAdminSignalIntake() {
  const bot = getBot();

  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;

    const text = msg.text ?? msg.caption;
    if (!text || text.trim().startsWith('/')) return;

    const signal = parseSignal(text);
    if (!signal) {
      if (/#\w+USDT|Entry Zone:|Stop-Loss:/i.test(text)) {
        await sendMarkdown(
          '*Signal was not recognized*\n\n' +
          'Check that symbol, LONG/SHORT, entry zone, and stop-loss are present.'
        );
      }
      return;
    }

    try {
      await handleParsedSignal(signal, {
        source: msg.forward_origin || msg.forward_date ? 'admin_forward' : 'admin_message',
      });
    } catch (err) {
      logger.error('Admin signal intake failed', { err: err.message });
      await sendMarkdown(`*Signal processing failed*\n\`${err.message}\``);
    }
  });

  logger.info('Admin signal intake registered');
}
