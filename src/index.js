import { logger } from './shared/logger.js';
import { initBot, sendMarkdown, telegramNotify } from './bot/telegram.js';
import { registerCommands } from './bot/commands.js';
import { registerConfirmationHandler, requestConfirmation } from './bot/confirmation.js';
import { startMonitor, setNotifier, restoreWatchlistFromDB } from './core/positionMonitor.js';
import { TelegramSourceListener } from './sources/telegram/TelegramSourceListener.js';
import {
  BINANCE_TESTNET,
  MONITOR_INTERVAL_MS,
  TELEGRAM_SESSION_STRING,
  TELEGRAM_SIGNAL_CHANNEL_ID,
} from './config/app.config.js';
import { WELCOME_MESSAGE, SUB_TITLE } from './shared/message.js';
import { banner } from './shared/utils.js';
import { initDatabase } from './module/db/database.js';

class Drift {
  async main() {
    try {
      banner(WELCOME_MESSAGE, SUB_TITLE);

      logger.info('Trading bot starting...', { testnet: BINANCE_TESTNET });

      // 0. База даних — першим ділом, до будь-якої логіки
      await initDatabase();

      // 1. Telegram bot
      initBot();
      registerCommands();
      registerConfirmationHandler();

      // 2. Position monitor → Telegram notifier
      setNotifier(telegramNotify);
      startMonitor(MONITOR_INTERVAL_MS);

      // 3. Відновити відкриті позиції з БД після перезапуску
      //    (watchlist in-memory скинувся — читаємо з trades де status=OPEN)
      await restoreWatchlistFromDB();

      // 4. Channel listener → signal parser → confirmation
      //    Запускається тільки якщо є session string і channel id
      if (TELEGRAM_SESSION_STRING && TELEGRAM_SIGNAL_CHANNEL_ID) {

        const listener = new TelegramSourceListener(
          TELEGRAM_SIGNAL_CHANNEL_ID,
          async (signal) => {
            if (signal.type === 'REPORT') {
              logger.info('Signal report received', {
                symbol:   signal.symbol,
                signalId: signal.signalId,
              });
              return;
            }

            // signal.type === 'SIGNAL'
            logger.info('New signal received, requesting confirmation', {
              symbol: signal.symbol,
              side:   signal.side,
            });

            await requestConfirmation({
              symbol:     signal.symbol,
              side:       signal.side === 'LONG' ? 'BUY' : 'SELL',
              entryType:  'LIMIT',
              entryPrice: signal.entryMid,
              entryLow:   signal.entryLow,
              entryHigh:  signal.entryHigh,
              slPrice:    signal.slPrice,
              tpPrices:   signal.tpPrices,
              interval:   signal.timeframe ?? '1h',
              // Передаємо сирі дані для saveSignal
              signalId:   signal.signalId,
              accuracy:   signal.accuracy,
              rawText:    signal.rawText,
            });
          },
        );

        await listener.connect();
        await listener.startListening();

        logger.info('Channel listener started');

        const shutdown = async () => {
          logger.info('Shutting down...');
          await listener.stop();
          process.exit(0);
        };

        process.on('SIGINT',  shutdown);
        process.on('SIGTERM', shutdown);

      } else {
        logger.warn('Channel listener skipped — run: node scripts/auth.js');

        process.on('SIGINT',  () => { logger.info('Shutting down...'); process.exit(0); });
        process.on('SIGTERM', () => { logger.info('Shutting down...'); process.exit(0); });
      }

      // 5. Notify admin
      await sendMarkdown(
        `*Bot started* ✓\n` +
        `Mode: \`${BINANCE_TESTNET ? 'TESTNET' : 'MAINNET'}\`\n` +
        `Monitor: every \`${MONITOR_INTERVAL_MS / 1000}s\`\n` +
        `Channel: \`${TELEGRAM_SESSION_STRING ? 'active' : 'inactive'}\`\n\n` +
        `Введи /start для списку команд`
      );

      logger.info('Bot ready');

    } catch (error) {
      logger.error('Fatal startup error', { err: error.message });
      process.exit(1);
    }
  }
}

const drift = new Drift();
drift.main();