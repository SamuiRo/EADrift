# Відомі Обмеження Та Технічний Борг

Цей список відокремлює фактичну поведінку від бажаної. Пріоритети є орієнтовними.

## Високий пріоритет

### 1. Адаптивні TP залежать від доступності monitor

Position monitor є єдиним виконавцем TP, momentum, fake breakout і trailing-рішень.
Це прибирає подвійні закриття, але під час зупинки процесу TP не виконаються.
На Binance залишається захисний STOP_MARKET.

### 2. Ручні partial close не повністю синхронізують захисний SL

Monitor синхронізує SL після своїх partial close, але `/close` та ручні дії поза
ботом можуть залишити SL розрахованим на старий розмір позиції.

Потрібен `syncProtectiveOrders(symbol)` після кожної зміни position size.

## Середній пріоритет

### 3. LIMIT timeout залишає entry order на біржі

`waitForOrderFilled()` чекає 120 секунд і кидає помилку, але не скасовує LIMIT order. Після помилки він може виконатися пізніше без автоматично виставлених SL/TP і без trade/watchlist.

Потрібно скасовувати entry при timeout та перевіряти фінальний статус.

### 4. Ручні команди не повністю синхронізують БД і watchlist

- `/be` не оновлює `watchlist.slPrice` і не записує `sl_history`;
- `/close` не записує partial-close event;
- `/cancel` та `/cancelall` не узгоджують план позиції;
- ручні Binance-дії поза ботом виявляються лише як зникнення позиції.

### 5. Відновлення після рестарту неповне

Після restore:

- timeout вимикається;
- актуальні open orders не звіряються з БД;
- position, що існує на Binance без trade у БД, не додається до watchlist;
- закритій offline-позиції ставиться `manual`, PnL та exit price лишаються `null`.

Потрібен reconciliation flow на основі positions, open orders та income/order history.

### 6. Analytics raw SQL, імовірно, використовує неправильні назви колонок

Sequelize налаштований з `underscored: false`, моделі мають camelCase поля, але raw SQL у `analytics.js` звертається до `entry_price`, `profit_r`, `trade_id` тощо.

Потрібно звірити фактичну SQLite schema та уніфікувати mapping. Аналітичні функції також не мають CLI/API/Telegram entry point.

### 7. Signal parser жорстко прив'язаний до формату каналу

- entry zone очікується як `HIGH - LOW`;
- маркери SIGNAL/REPORT та LONG/SHORT залежать від конкретних emoji;
- немає schema validation результату parser-а;
- немає тестів на варіації форматування.

## Низький пріоритет / архітектурні межі

### 8. Одна позиція на symbol

Watchlist має тип `Map<symbol, meta>`. Це відповідає Binance one-way mode, але не підтримує hedge mode або кілька незалежних legs одного symbol.

### 9. In-memory state не персистентний

Після рестарту втрачаються:

- торговий режим, який повертається до `CONFIRM_ONLY`;
- pending confirmation cards;
- Telegram message deduplication set;
- trailing active state.

### 10. Немає CI та повних integration-тестів

У repository є базові unit-тести parser та exit strategy, але немає lint config,
type checking, CI workflow або Binance integration-тестів. Біржові зміни потребують
ручної перевірки на testnet.

### 11. Немає керованих міграцій БД

`db.sync({ alter: false })` не оновить існуючу schema після зміни моделі. Потрібні versioned migrations і backup policy.

### 12. `.env.example` містить placeholder credentials

Шаблон містить перелік змінних, але placeholder credentials легко сплутати з
реальними значеннями. `DEFAULT_POSITION_SIZE_USDT` і `NODE_ENV` зараз не впливають на поведінку.

### 13. Частина залежностей і shared helpers не використовується основним flow

Наприклад, `@binance/connector`, `node-cron`, `zod`, image helpers і деякі exchange helper-функції не задіяні в основному runtime. Це збільшує поверхню підтримки.

### 14. README у корені частково застарілий

Він згадує відсутній `orderWizard.js`, стару структуру та приклад `watchPosition()` з `tpLevels`, тоді як реалізація очікує `tpPrices`. Актуальна технічна документація міститься в `docs/`.

## Рекомендований порядок покращень

1. Додати reconciliation/sync protective orders після ручних змін позиції.
2. Виправити LIMIT timeout із гарантованим cancel.
3. Додати integration-тести Binance adapter з mocks і testnet smoke-test.
4. Додати migrations, schema check та перевірити analytics SQL.
5. Персистити runtime mode/trailing state, якщо це потрібно операційно.
