/**
 * Конфіг pm2 для сервера.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     # автозапуск після ребуту
 *
 * Режим і ліміти беруться з .env (STARTUP_TRADING_MODE, CAPITAL_CAP_USDT),
 * тому рестарт процесу не змінює поведінку бота.
 */
module.exports = {
  apps: [{
    name:   'eadrift',
    script: 'src/index.js',
    cwd:    __dirname,

    // Один процес: watchlist і pending-підтвердження живуть у пам'яті,
    // кілька копій почали б дублювати угоди.
    instances: 1,
    exec_mode: 'fork',

    autorestart:   true,
    // Якщо процес падає одразу після старту (напр. протухла сесія Telegram),
    // не крутимо його в нескінченному циклі — зупиняємось і чекаємо людину.
    min_uptime:    '30s',
    max_restarts:  10,
    restart_delay: 5000,

    max_memory_restart: '400M',
    time: true,
  }],
};
