# Відомі Обмеження Та Технічний Борг

Цей список відокремлює фактичну поведінку від бажаної. Пріоритети є орієнтовними.

## Високий пріоритет

### 1. Додаткові виходи та пересування SL залежать від monitor

Binance самостійно виконує всі стандартні TP та SL навіть коли бот недоступний.
Але reversal exit, fake breakout, weak momentum, trailing updates і пересування SL
потребують активного monitor.

### 2. Ручні partial close не повністю синхронізують TP-сітку

Monitor синхронізує TP-сітку після своїх partial close, але `/close` та ручні дії поза
ботом можуть залишити TP-кількості розрахованими на старий розмір позиції.

SL із `closePosition=true` продовжує покривати весь актуальний залишок. Для ручних
partial close потрібен `syncProtectiveOrders(symbol)` для перебудови TP-сітки.

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

### 6. ~~Analytics raw SQL використовує неправильні назви колонок~~ — виправлено

Усі запити переведені на фактичні camelCase-колонки в подвійних лапках,
додані `sourceStats`, `evaluationFunnel` і `rejectionReasons`, з'явилися точки
входу — `npm run report` і Telegram-команда `/stats`.

`test/analytics.test.js` проганяє кожен звіт по реальній схемі на засіяних
даних, тому повторне розходження схеми й запиту впаде на тестах.

### 7. Signal parser жорстко прив'язаний до формату каналу

Виправлено частково:

- межі entry zone тепер визначаються за значенням, тому обидва порядки запису
  читаються коректно;
- таймфрейм нормалізується до валідного інтервалу Binance (`30` → `30m`);
- результат парсера проходить `validateGeometry()` зі схемою на `zod`;
- є тести на обидва формати зони та на нормалізацію таймфрейму.

Лишається:

- маркери SIGNAL/REPORT та LONG/SHORT залежать від конкретних emoji;
- джерела з принципово іншою розміткою потребують окремого парсера
  (планується LLM-нормалізатор із перевіркою чисел через `verifyNumbersInSource()`).

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

### 11. Міграції БД мінімальні

`runColumnMigrations()` додає відсутні колонки (`ALTER TABLE ... ADD COLUMN`)
ідемпотентно перед sync. Цього достатньо для додавання полів, але не для зміни
типів, перейменувань чи видалення. Versioned migrations і backup policy
досі потрібні.

### 12. `.env.example` містить placeholder credentials

Шаблон містить перелік змінних, але placeholder credentials легко сплутати з
реальними значеннями. `DEFAULT_POSITION_SIZE_USDT` і `NODE_ENV` зараз не впливають на поведінку.

### 13. `maxLeverage` наразі недосяжний

`leverage = riskPct / delta`, тобто депозит на плече не впливає. За поточних
`riskPct = 0.75%` і `minDeltaPct = 0.2%` стеля становить `3.75x`, тому
`maxLeverage = 10` не обмежує жодного сигналу. Це не помилка, але про це варто
памʼятати при зміні `riskPct`.

### 14. Калібрування виходу підігнане під одне джерело

`targetRR`, `atrStopMultiplier`, `minWeightedRR` і сітка TP підібрані на вибірці
з шести сигналів одного провайдера. Це напрямок, а не встановлені параметри.
Поле `signals.source` додане, щоб статистику можна було рахувати окремо по
кожному джерелу, але окремих конфігів на джерело ще немає.

### 15. Частина залежностей і shared helpers не використовується основним flow

Наприклад, `@binance/connector`, `node-cron`, `zod`, image helpers і деякі exchange helper-функції не задіяні в основному runtime. Це збільшує поверхню підтримки.

### 16. `zod` використовується лише частково

Пакет був у залежностях невикористаним; тепер на ньому побудована схема в
`signalGeometry.js`. Решта межі даних — конфіг, відповіді Binance, поля з БД —
досі не валідуються, хоча інструмент уже в проєкті.

## Рекомендований порядок покращень

1. Накопичити вибірку: `/mode shadow` на сервері, потім `npm run replay`.
2. Додати reconciliation/sync protective orders після ручних змін позиції.
3. Виправити LIMIT timeout із гарантованим cancel.
4. Додати integration-тести Binance adapter з mocks і testnet smoke-test.
5. Персистити runtime mode/trailing state, якщо це потрібно операційно.
