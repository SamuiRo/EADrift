# Розгортання на сервері

Мета першого розгортання — **збір даних**, а не торгівля. Бот слухає канал,
проганяє кожен сигнал через усі фільтри й записує рішення в
`signal_evaluations`, не виставляючи жодного ордера.

## 1. Сервер

- Linux, Node.js ≥ 20.10 (`node --version`).
- pm2: `npm install -g pm2`.
- Годинник синхронізований (`timedatectl` → `System clock synchronized: yes`).
  Підписані запити Binance відхиляються при розбіжності часу понад ~1 с.

## 2. Код і залежності

```bash
git clone <repo> eadrift && cd eadrift
git checkout <потрібна гілка або тег>
npm ci
npm test
```

## 3. Ключ Binance для SHADOW

Створіть **окремий** API-ключ саме для сервера:

- лише право **Enable Reading** — торгові права в SHADOW не потрібні;
- **Withdrawals вимкнено**;
- обмеження за IP сервера.

Навіть якщо ключ витече, з ним не можна ні торгувати, ні вивести кошти.
Торгові права вмикаються тільки при переході на live, окремим рішенням.

## 4. `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Для збору даних:

```env
STARTUP_TRADING_MODE=SHADOW
CAPITAL_CAP_USDT=1000
MAX_OPEN_POSITIONS=3
BINANCE_TESTNET=false
```

`STARTUP_TRADING_MODE` обов'язковий для сервера: без нього кожен рестарт
процесу повертав би бота в `CONFIRM_ONLY`, і збір даних тихо зупинявся б.

## 5. Сесія Telegram

Один раз, у терміналі по SSH (не під pm2):

```bash
npm run auth
```

Скрипт спитає номер, код і пароль 2FA та надрукує `TELEGRAM_SESSION_STRING`.
Вставте його в `.env`. Рядок сесії — це повний доступ до акаунта Telegram:
нікому не пересилайте і не зберігайте поза `.env`.

Якщо сесія колись протухне, бот під pm2 не зависне в очікуванні вводу, а впаде
з повідомленням `run npm run auth` — pm2 після кількох спроб зупиниться.

## 6. Запуск

```bash
pm2 start ecosystem.config.cjs
pm2 logs eadrift --lines 50
pm2 save
pm2 startup        # виконати команду, яку він надрукує
```

У Telegram має прийти `Bot started` з рядком `Режим: 👁 Shadow`. Далі `/status`
покаже ліміти капіталу, а кожен сигнал із каналу — повідомлення
`записано в shadow` або `Сигнал відхилено` з причиною.

## 7. Перевірка після запуску

- [ ] `Bot started` прийшов, режим — Shadow.
- [ ] `/status` показує `Капітал: до 1000 USDT`.
- [ ] `pm2 logs` містить `Channel listener started`.
- [ ] Перешліть боту будь-який старий сигнал — має прийти shadow-запис або відмова.
- [ ] `npm run report -- --only evaluationFunnel` показує цей запис.

## 8. Резервні копії

SQLite можна безпечно копіювати на ходу через його власний механізм:

```bash
sqlite3 src/data/trading.db ".backup backups/trading-$(date +%F).db"
```

Простий `cp` працюючої бази може дати пошкоджену копію. Раз на добу через cron
достатньо. Для аналізу локально скопіюйте файл і запустіть:

```bash
EADRIFT_DB_PATH=./trading-2026-10-15.db npm run replay -- --detail
```

## 9. Оновлення коду

```bash
git pull
npm ci
npm test
pm2 restart eadrift
```

Міграції колонок виконуються автоматично при старті.

## Перехід на live — не раніше

Критерії, коли має сенс вмикати торгівлю:

1. У `signal_evaluations` щонайменше 50 записів від одного джерела.
2. `npm run replay` показує стабільно додатний середній R на поточній політиці.
3. Окремий ключ із торговими правами, той самий IP-ліміт, без withdrawals.
4. Перший тиждень — `CONFIRM_ONLY`, а не `FULL_AUTO`.
