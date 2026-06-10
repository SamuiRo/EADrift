# Відомі Обмеження Та Технічний Борг

Цей список відокремлює фактичну поведінку від бажаної. Пріоритети є орієнтовними.

## Високий пріоритет

### 1. Невдалий Binance positions-запит під час restore може закрити всі DB-угоди

Якщо `getOpenPositions()` кидає помилку в `restoreWatchlistFromDB()`, код продовжує роботу з порожнім масивом positions. Після цього кожна відкрита угода в БД вважається відсутньою на біржі та закривається як `manual`.

Restore має перериватися без зміни БД, якщо біржовий стан не вдалося отримати.

### 2. Monitor може дублювати TP-закриття

`openFullPosition()` створює реальні TAKE_PROFIT_MARKET orders на Binance. Одночасно `positionMonitor` при досягненні того самого TP за mark price викликає додатковий `partialClose()`.

Наслідок: race condition між біржовим TP та monitor, потенційне подвійне скорочення позиції або reduce-only rejection. Потрібна одна модель виконання: або біржові TP є виконавцем, а monitor лише спостерігає fills, або monitor сам виконує exits без попередньо виставленої TP-сітки.

### 3. Кількості SL/TP не синхронізуються після partial close

Після `/close`, weak momentum, fake breakout або monitor partial close існуючі SL/TP orders можуть залишатися розрахованими на старий розмір.

Потрібен `syncProtectiveOrders(symbol)` після кожної зміни position size.

### 4. `timeoutCandles` насправді є polling-тіками

Лічильник збільшується кожні `MONITOR_INTERVAL_MS`, а не після закриття свічки обраного timeframe. Типові `12` при interval `5000` мс закривають позицію приблизно через одну хвилину.

Потрібно перейменувати на `timeoutTicks` або реалізувати candle-aware timeout.

## Середній пріоритет

### 5. LIMIT timeout залишає entry order на біржі

`waitForOrderFilled()` чекає 120 секунд і кидає помилку, але не скасовує LIMIT order. Після помилки він може виконатися пізніше без автоматично виставлених SL/TP і без trade/watchlist.

Потрібно скасовувати entry при timeout та перевіряти фінальний статус.

### 6. Ручні команди не повністю синхронізують БД і watchlist

- `/be` не оновлює `watchlist.slPrice` і не записує `sl_history`;
- `/close` не записує partial-close event;
- `/cancel` та `/cancelall` не узгоджують план позиції;
- ручні Binance-дії поза ботом виявляються лише як зникнення позиції.

### 7. Відновлення після рестарту неповне

Після restore:

- `trailingActive=false`, навіть якщо trailing уже був активований;
- timeout вимикається;
- актуальні open orders не звіряються з БД;
- position, що існує на Binance без trade у БД, не додається до watchlist;
- закритій offline-позиції ставиться `manual`, PnL та exit price лишаються `null`.

Потрібен reconciliation flow на основі positions, open orders та income/order history.

### 8. Analytics raw SQL, імовірно, використовує неправильні назви колонок

Sequelize налаштований з `underscored: false`, моделі мають camelCase поля, але raw SQL у `analytics.js` звертається до `entry_price`, `profit_r`, `trade_id` тощо.

Потрібно звірити фактичну SQLite schema та уніфікувати mapping. Аналітичні функції також не мають CLI/API/Telegram entry point.

### 9. Signal parser жорстко прив'язаний до формату каналу

- entry zone очікується як `HIGH - LOW`;
- маркери SIGNAL/REPORT та LONG/SHORT залежать від конкретних emoji;
- для `SIGNAL` parser зараз не повертає `rawText`, тому поле в БД буде `null`;
- немає schema validation результату parser-а;
- немає тестів на варіації форматування.

## Низький пріоритет / архітектурні межі

### 10. Одна позиція на symbol

Watchlist має тип `Map<symbol, meta>`. Це відповідає Binance one-way mode, але не підтримує hedge mode або кілька незалежних legs одного symbol.

### 11. In-memory state не персистентний

Після рестарту втрачаються:

- торговий режим, який повертається до `CONFIRM_ONLY`;
- pending confirmation cards;
- Telegram message deduplication set;
- trailing active state.

### 12. Немає автоматизованих тестів і CI-перевірок

У repository немає test suite, lint config, type checking або CI workflow. Зміни в risk/exchange/monitor flow потребують ручної перевірки на testnet.

### 13. Немає керованих міграцій БД

`db.sync({ alter: false })` не оновить існуючу schema після зміни моделі. Потрібні versioned migrations і backup policy.

### 14. `.env.example` порожній

Новий розробник не отримує готовий шаблон конфігурації. Також `DEFAULT_POSITION_SIZE_USDT` і `NODE_ENV` зараз не впливають на поведінку.

### 15. Частина залежностей і shared helpers не використовується основним flow

Наприклад, `@binance/connector`, `node-cron`, `zod`, image helpers і деякі exchange helper-функції не задіяні в основному runtime. Це збільшує поверхню підтримки.

### 16. README у корені частково застарілий

Він згадує відсутній `orderWizard.js`, стару структуру та приклад `watchPosition()` з `tpLevels`, тоді як реалізація очікує `tpPrices`. Актуальна технічна документація міститься в `docs/`.

## Рекомендований порядок покращень

1. Зупиняти restore без змін БД, якщо Binance state недоступний.
2. Визначити єдиного виконавця TP і прибрати race між exchange orders та monitor.
3. Додати reconciliation/sync protective orders після кожної зміни позиції.
4. Виправити LIMIT timeout із гарантованим cancel.
5. Переробити timeout на реальні свічки або чесно назвати ticks.
6. Додати parser, risk engine та monitor unit tests; Binance adapter покрити mocks.
7. Додати migrations, schema check та перевірити analytics SQL.
8. Персистити runtime mode/trailing state, якщо це потрібно операційно.
