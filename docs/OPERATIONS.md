# Запуск Та Експлуатація

## Вимоги

- Node.js із підтримкою ESM та JSON import attributes;
- доступ до Binance USD-M Futures API;
- Telegram Bot token і admin chat ID;
- для читання каналу: Telegram API ID/hash, MTProto session string і channel ID.

## Встановлення та запуск

```bash
npm install
npm start
```

Режим розробки:

```bash
npm run dev
```

У `package.json` немає test, lint або migration scripts.

## Змінні середовища

### Обов'язкові

| Змінна | Призначення |
|---|---|
| `BINANCE_API_KEY` | API key для signed Futures-запитів |
| `BINANCE_SECRET_KEY` | HMAC secret |
| `TELEGRAM_BOT_TOKEN` | Bot API token |
| `TELEGRAM_ADMIN_CHAT_ID` | єдиний дозволений оператор |

### Рекомендовані для channel listener

| Змінна | Призначення |
|---|---|
| `TELEGRAM_API_ID` | MTProto application ID |
| `TELEGRAM_API_HASH` | MTProto application hash |
| `TELEGRAM_SESSION_STRING` | збережена gramjs session |
| `TELEGRAM_SIGNAL_CHANNEL_ID` | канал-джерело сигналів |

### Опціональні

| Змінна | Типове значення | Призначення |
|---|---:|---|
| `BINANCE_TESTNET` | `false` | `true` перемикає REST base URL на testnet |
| `MONITOR_INTERVAL_MS` | `5000` | інтервал position monitor |
| `CONFIRM_MAX_PRICE_MOVE_PCT` | `0.005` | максимальна зміна ціни між оцінкою та підтвердженням; `0.005` = 0.5% |
| `LOG_LEVEL` | `info` | рівень Winston; `debug` також вмикає SQL logs |
| `NODE_ENV` | немає | експортується, але логіку не змінює |
| `DEFAULT_POSITION_SIZE_USDT` | `"20"` | експортується, але зараз не використовується |

Поточний `.env.example` порожній, тому перелік вище є актуальним контрактом конфігурації.

## Telegram-команди

Усі команди доступні лише для `TELEGRAM_ADMIN_CHAT_ID`.

Крім команд, адміністратор може надіслати або переслати текст торгового сигналу
безпосередньо боту. Бот оцінить сигнал і покаже клавіатуру Confirm/Cancel.

| Команда | Дія |
|---|---|
| `/start` | довідка та поточний режим |
| `/status` | режим, USDT balance, кількість watched positions, risk config |
| `/mode full_auto` | усі валідні сигнали виконуються автоматично |
| `/mode semi_auto` | auto лише для risk OK і ціни в зоні |
| `/mode confirm` | завжди вимагати підтвердження |
| `/mode pause` | не торгувати нові сигнали |
| `/positions` | відкриті Binance positions |
| `/orders [SYMBOL]` | відкриті orders |
| `/balance` | ненульові Futures balances |
| `/watch` | in-memory watchlist |
| `/sl SYMBOL PRICE` | замінити поточний STOP_MARKET |
| `/be SYMBOL` | перенести SL у BE+ |
| `/close SYMBOL FRACTION` | reduce-only MARKET close, fraction `(0, 1]` |
| `/cancel SYMBOL ORDER_ID` | скасувати один order |
| `/cancelall SYMBOL` | скасувати всі orders символу |

## Логи

Winston пише:

- console;
- `logs/combined.log`;
- `logs/error.log`.

Binance adapter логуватиме path і params при помилці. Секретний ключ не входить у params, але API key передається в header і не повинен логуватися зовнішнім middleware.

## Testnet

Для безпечної перевірки:

```env
BINANCE_TESTNET=true
```

Перед MAINNET перевірити:

1. Bot стартує в `CONFIRM_ONLY`.
2. Binance account використовує one-way position mode.
3. API key має лише потрібні Futures permissions і не має withdrawal permission.
4. `MONITOR_INTERVAL_MS` відповідає бажаній частоті та API rate limits.
5. SL/TP quantities коректні для precision конкретного symbol.
6. Channel parser відповідає реальному формату повідомлень.

## Поведінка при помилках

- Fatal startup error завершує процес з кодом `1`.
- Помилка одного Telegram event не зупиняє listener.
- Помилка monitor tick логуються, наступні tick продовжуються.
- Якщо risk calculation не вдалася, сигнал відхиляється.
- Якщо Binance entry виконаний, але trade не записався в БД, позиція все одно додається до watchlist з `tradeId=null`; DB tracking для неї пропускається.

## Перевірка після змін

Мінімальна ручна перевірка:

1. Запустити на testnet.
2. Перевірити `/status`, `/positions`, `/orders`, `/watch`.
3. Надіслати валідний LONG і SHORT сигнал.
4. Перевірити in-zone LIMIT та slipped MARKET гілки.
5. Перевірити `REJECT`, `CONFIRM`, cancel і expiry.
6. Перезапустити бот із відкритою позицією та перевірити restore.
7. Перевірити записи `signals`, `trades`, `trade_events`, `sl_history`.
