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
  SIGNAL_CHANNELS,
} from './config/app.config.js';
import { PARSERS } from './sources/channelRegistry.js';
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

      // 4. Channel listeners → parser каналу → confirmation
      //    Кожен канал — окремий слухач зі своїм ім'ям джерела і парсером.
      //    Дедуплікація повідомлень теж окрема: ID повідомлень унікальні лише
      //    в межах каналу, і спільний набір ID змішав би різні канали.
      const listeners = [];
      const failedChannels = [];

      if (TELEGRAM_SESSION_STRING && SIGNAL_CHANNELS.length) {
        for (const channel of SIGNAL_CHANNELS) {
          const listener = new TelegramSourceListener(
            channel.id,
            async (signal) => {
              await handleParsedSignal(signal, { source: channel.name });
            },
            { name: channel.name, parse: PARSERS[channel.parser] },
          );

          // Один недоступний канал (не підписаний акаунт, помилка в ID) не має
          // зупиняти решту — збираємо, що вдалося, і повідомляємо адміна.
          try {
            await listener.connect();
            await listener.startListening();
            listeners.push(listener);
            logger.info('Channel listener started', { source: channel.name, channel: channel.id, parser: channel.parser });
          } catch (err) {
            failedChannels.push(`${channel.name} (${err.message})`);
            logger.error('Channel listener failed to start', { source: channel.name, channel: channel.id, err: err.message });
          }
        }
      } else {
        logger.warn('Channel listener skipped — set SIGNAL_CHANNELS and run `npm run auth` to create TELEGRAM_SESSION_STRING');
      }

      const shutdown = async () => {
        logger.info('Shutting down...');
        for (const listener of listeners) await listener.stop().catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT',  shutdown);
      process.on('SIGTERM', shutdown);

      // 5. Notify admin
      await sendMarkdown(
        `*Bot started* ✓  v${APP_VERSION}\n` +
        `Network: \`${BINANCE_TESTNET ? 'TESTNET' : 'MAINNET'}\`\n` +
        `Режим: *${MODE_LABELS[getMode()]}*\n` +
        `Капітал: \`до ${CAPITAL_CAP_USDT} USDT\`, позицій: \`до ${MAX_OPEN_POSITIONS}\`\n` +
        `Monitor: every \`${MONITOR_INTERVAL_MS / 1000}s\`\n` +
        `Канали: ${listeners.length ? listeners.map(l => `\`${l.name}\``).join(', ') : '`немає`'}\n` +
        (failedChannels.length ? `⚠️ Не підключено: \`${failedChannels.join('; ').replace(/`/g, "'")}\`\n` : '') +
        `\n` +
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
