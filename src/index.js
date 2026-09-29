import { logger } from './shared/logger.js';
import { initBot, sendMarkdown, telegramNotify } from './bot/telegram.js';
import { registerCommands } from './bot/commands.js';
import { registerConfirmationHandler } from './bot/confirmation.js';
import { handleParsedSignal, registerAdminSignalIntake } from './bot/signalIntake.js';
import { startMonitor, setNotifier, restoreWatchlistFromDB } from './core/positionMonitor.js';
import { TelegramSourceListener } from './sources/telegram/TelegramSourceListener.js';
import {
  APP_VERSION,
  BINANCE_TESTNET,
  CAPITAL_CAP_USDT,
  MAX_OPEN_POSITIONS,
  MONITOR_INTERVAL_MS,
  STARTUP_TRADING_MODE,
  TELEGRAM_SESSION_STRING,
  TELEGRAM_SIGNAL_CHANNEL_ID,
} from './config/app.config.js';
import { setMode, getMode, MODE_LABELS } from './core/tradingMode.js';
import { WELCOME_MESSAGE, SUB_TITLE } from './shared/message.js';
import { banner } from './shared/utils.js';
import { initDatabase } from './module/db/database.js';

// Одна неперехоплена відмова (мережа, Telegram, Binance) не повинна вбивати
// процес, що місяцями збирає дані на сервері. Логуємо й живемо далі.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { err: reason?.message ?? String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err: err.message, stack: err.stack });
});

class Drift {
  async main() {
    try {
      banner(WELCOME_MESSAGE, SUB_TITLE);

      logger.info('Trading bot starting...', { version: APP_VERSION, testnet: BINANCE_TESTNET });

      // Режим задається з env: інакше кожен рестарт процесу повертав бота в
      // CONFIRM_ONLY і тихо зупиняв збір даних у SHADOW.
      setMode(STARTUP_TRADING_MODE);
      logger.info('Trading mode set from config', { mode: getMode() });

      // 0. База даних — першим ділом, до будь-якої логіки
      await initDatabase();

      // 1. Telegram bot
      initBot();
      registerCommands();
      registerConfirmationHandler();
      registerAdminSignalIntake();

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
            await handleParsedSignal(signal, { source: 'channel' });
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
        logger.warn('Channel listener skipped — run `npm run auth` to create TELEGRAM_SESSION_STRING');

        process.on('SIGINT',  () => { logger.info('Shutting down...'); process.exit(0); });
        process.on('SIGTERM', () => { logger.info('Shutting down...'); process.exit(0); });
      }

      // 5. Notify admin
      await sendMarkdown(
        `*Bot started* ✓  v${APP_VERSION}\n` +
        `Network: \`${BINANCE_TESTNET ? 'TESTNET' : 'MAINNET'}\`\n` +
        `Режим: *${MODE_LABELS[getMode()]}*\n` +
        `Капітал: \`до ${CAPITAL_CAP_USDT} USDT\`, позицій: \`до ${MAX_OPEN_POSITIONS}\`\n` +
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
