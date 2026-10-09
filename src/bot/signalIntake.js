import { getBot, isAdmin, sendMarkdown } from './telegram.js';
import { requestConfirmation } from './confirmation.js';
import { PARSERS, resolveForwardSource } from '../sources/channelRegistry.js';
import { SIGNAL_CHANNELS } from '../config/app.config.js';
import { validateSignal } from '../core/signalGeometry.js';
import { logger } from '../shared/logger.js';
import { saveSignal, updateSignalStatus } from '../module/db/tradeRepository.js';

export function signalToOrder(signal, source = 'unknown') {
  return {
    source,
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

  // Геометрична перевірка до будь-якої торгової логіки. Ловить інвертовану зону,
  // переплутаний side, поміняні місцями SL і TP — незалежно від того, хто парсив.
  const check = validateSignal(signal, { verifySource: Boolean(signal.parsedBy) });
  if (!check.valid) {
    logger.warn('Signal failed geometry validation', {
      source,
      symbol: signal.symbol,
      side:   signal.side,
      errors: check.errors,
    });

    // Записуємо і такі сигнали: биті публікації — частина якості каналу.
    // Без запису канал, що шле неповні сигнали, виглядав би в статистиці
    // чистішим, ніж є. Поля можуть бути зіпсовані, тож помилку запису ковтаємо.
    const record = await saveSignal(signalToOrder(signal, source), null).catch(() => null);
    await updateSignalStatus(record?.id, 'REJECTED', `Geometry: ${check.reason}`.slice(0, 500));

    await sendMarkdown(
      `🚫 *Сигнал не пройшов перевірку структури* — ${signal.symbol}  \`[${source}]\`\n\n` +
      check.errors.map(e => `• ${e}`).join('\n') +
      `\n\n_Ордер не виставлено_`
    );
    return null;
  }

  logger.info('New signal received, requesting confirmation', {
    source,
    symbol: signal.symbol,
    side: signal.side,
  });

  return requestConfirmation(signalToOrder(signal, source));
}

/**
 * Розпарсити текст: спершу парсером відомого каналу, потім рештою.
 * Для повідомлень невідомого походження формат заздалегідь невідомий.
 */
export function parseWithFallback(text, preferred = null) {
  const order = [preferred, ...Object.keys(PARSERS).filter(name => name !== preferred)].filter(Boolean);
  for (const name of order) {
    const signal = PARSERS[name](text);
    if (signal) return { ...signal, parser: name };
  }
  return null;
}

export function registerAdminSignalIntake() {
  const bot = getBot();

  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;

    const text = msg.text ?? msg.caption;
    if (!text || text.trim().startsWith('/')) return;

    // Переслане з відомого каналу зараховується цьому каналу і парситься його
    // парсером — тоді ручне пересилання й автоматичний прийом дають одну
    // й ту саму статистику джерела.
    const { source, channel } = resolveForwardSource(msg, SIGNAL_CHANNELS);
    const signal = parseWithFallback(text, channel?.parser);

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
      await handleParsedSignal(signal, { source });
    } catch (err) {
      logger.error('Admin signal intake failed', { err: err.message });
      await sendMarkdown(`*Signal processing failed*\n\`${err.message}\``);
    }
  });

  logger.info('Admin signal intake registered');
}
