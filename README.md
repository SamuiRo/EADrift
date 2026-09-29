# EADrift

EADrift — Node.js ESM бот для виконання Telegram-сигналів на Binance USD-M Futures.

Система читає сигнали через Telegram MTProto, перевіряє актуальність входу, розраховує позицію від заданого ризику, виконує угоду автоматично або після підтвердження та зберігає історію в SQLite.

> Проєкт виконує реальні торгові операції. Для розробки й перевірки використовуйте Binance Futures Testnet.

## Швидкий Старт

```bash
npm install
cp .env.example .env
# Заповніть .env власними ключами та Telegram-конфігурацією
npm start
```

Режим розробки:

```bash
npm run dev
```

Для Testnet:

```env
BINANCE_TESTNET=true
```

## Основний Flow

```text
Telegram channel
  -> signal parser
  -> geometry validation (схема, взаємне розташування SL / зони / TP)
  -> market validation + власний SL + зважений R:R
  -> auto execution або admin confirmation
  -> Binance entry + SL + TP
  -> position monitor
  -> SQLite history та Telegram notifications
```

Stop-loss розраховується самостійно від фактичної ціни входу, а не береться з
сигналу: SL провайдера відкалібровано під вхід по середині зони набору й при
пізнішому вході дає надто несиметричний ризик. Деталі — в
[торговій стратегії](./docs/TRADING_STRATEGY.md).

Після кожного запуску торговий режим за замовчуванням — `CONFIRM_ONLY`.

## Документація

- [Огляд документації](./docs/README.md)
- [Архітектура](./docs/ARCHITECTURE.md)
- [Поточні flow](./docs/FLOWS.md)
- [Торгова стратегія та формули](./docs/TRADING_STRATEGY.md)
- [Модель даних](./docs/DATA_MODEL.md)
- [Запуск та експлуатація](./docs/OPERATIONS.md)
- [Відомі обмеження](./docs/KNOWN_LIMITATIONS.md)
- [Розгортання на сервері](./docs/DEPLOYMENT.md)
- [Збір і аналіз даних](./docs/DATA_COLLECTION.md)
- [Історія покращень](./docs/HISTORY.md)
- [Changelog](./CHANGELOG.md)

## Технології

- Node.js ESM
- Binance USD-M Futures REST API
- Telegram Bot API та gramjs/MTProto
- SQLite + Sequelize
- Winston

## Команди

Основні Telegram-команди адміністратора:

```text
/status
/stats
/export
/mode shadow|full_auto|semi_auto|confirm|pause
/positions
/orders [SYMBOL]
/watch
/sl SYMBOL PRICE
/be SYMBOL
/close SYMBOL FRACTION
/cancel SYMBOL ORDER_ID
/cancelall SYMBOL
```

Повний опис конфігурації, алгоритмів і поточних ризиків міститься в [`docs/`](./docs/README.md).
