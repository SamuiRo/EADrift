#!/usr/bin/env node
/**
 * auth.js — створити рядок сесії Telegram (MTProto) для читання каналу.
 *
 * Запускається один раз, інтерактивно, у терміналі (на сервері — по SSH):
 *   npm run auth
 *
 * Потрібні лише TELEGRAM_API_ID і TELEGRAM_API_HASH у .env. Скрипт спитає
 * номер телефону, код і пароль 2FA, а потім надрукує TELEGRAM_SESSION_STRING.
 *
 * Рядок сесії — це повний доступ до акаунта Telegram. Не пересилайте його,
 * не комітьте і не вставляйте туди, де його можуть прочитати інші.
 */

import 'dotenv/config';
import input from 'input';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId   = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!process.stdin.isTTY) {
  console.error('Цей скрипт інтерактивний — запустіть його у терміналі, не під pm2/systemd.');
  process.exit(1);
}
if (!Number.isFinite(apiId) || !apiHash) {
  console.error('Заповніть TELEGRAM_API_ID і TELEGRAM_API_HASH у .env (https://my.telegram.org).');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.start({
    phoneNumber: () => input.text('Номер телефону (+380...): '),
    password:    () => input.text('Пароль 2FA (якщо увімкнено): '),
    phoneCode:   () => input.text('Код із Telegram: '),
    onError:     (err) => console.error('Помилка авторизації:', err.message),
  });

  console.log('\nГотово. Додайте в .env:\n');
  console.log(`TELEGRAM_SESSION_STRING=${client.session.save()}\n`);
} finally {
  await client.disconnect();
  process.exit(0);
}
