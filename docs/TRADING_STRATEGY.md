# Торгова Стратегія Та Формули

Цей документ описує реалізовану поведінку, а не торгову рекомендацію. Значення нижче взяті з поточного коду.

## 1. Вхідні дані сигналу

Торгова гілка очікує:

```text
symbol, side, entryLow, entryHigh, entryMid,
tpPrices[], slPrice, timeframe, signalId, accuracy
```

`LONG` перетворюється на Binance side `BUY`, `SHORT` — на `SELL`.

Плановий LIMIT entry:

```text
entryMid = (entryHigh + entryLow) / 2
```

Якщо поточна ціна поза entry zone, але сигнал проходить market validation, entry змінюється на MARKET.

## 2. Перевірка market entry

Для LONG:

```text
SL порушений, якщо currentPrice <= slPrice
TP1 досягнутий, якщо currentPrice >= tp1Price
```

Для SHORT:

```text
SL порушений, якщо currentPrice >= slPrice
TP1 досягнутий, якщо currentPrice <= tp1Price
```

Вихід ціни за зону:

```text
zoneEdge = entryHigh для LONG
zoneEdge = entryLow  для SHORT

slippagePct = |currentPrice - zoneEdge| / zoneEdge
```

Допустимий slippage: не більше `2%`.

Risk-to-reward від поточної ціни:

```text
distanceToSL  = |currentPrice - slPrice|
distanceToTP1 = |tp1Price - currentPrice|
RR = distanceToTP1 / distanceToSL
```

Мінімальний допустимий `RR = 1.5`.

## 3. Risk engine

Поточна конфігурація:

| Параметр | Значення | Значення для рішення |
|---|---:|---|
| `riskPct` | 0.75% балансу | цільовий ризик угоди |
| `minDeltaPct` | 0.2% | нижче — `REJECT` |
| `maxDeltaPct` | 5.5% | вище — `REJECT` |
| `maxLeverage` | 10x | leverage обрізається, результат `CONFIRM` |
| `minLeverage` | 1x | мінімальне leverage |
| `maxRiskMultiple` | 1.2 | реальний ризик вище target × 1.2 дає `CONFIRM` |
| `skipRiskMultiple` | 1.5 | реальний ризик вище target × 1.5 дає `REJECT` |
| `marginType` | `ISOLATED` | застосовується перед entry |

Основні формули:

```text
delta = |entryPrice - slPrice| / entryPrice

targetRiskUsdt = balance × riskPct

positionUsdt = targetRiskUsdt / delta

rawLeverage = positionUsdt / balance
leverage = ceil(rawLeverage), у межах 1..10

quantity = positionUsdt / entryPrice
quantity = round(quantity, symbol.quantityPrecision)

realRiskUsdt = quantity × entryPrice × delta
```

Після обмеження leverage або підняття позиції до Binance `minNotional` реальний ризик перераховується.

### Статуси risk engine

- `OK`: сигнал може виконуватися автоматично.
- `CONFIRM`: ризик допустимий, але є відхилення, яке має побачити оператор.
- `REJECT`: торгівля заборонена.

`FULL_AUTO` виконує і `OK`, і `CONFIRM`, але ніколи не виконує `REJECT`.

## 4. Режими торгівлі

| Режим | Поведінка |
|---|---|
| `CONFIRM_ONLY` | кожен валідний сигнал потребує підтвердження |
| `SEMI_AUTO` | auto лише коли risk=`OK` і mark price усередині entry zone |
| `FULL_AUTO` | кожен валідний не-`REJECT` сигнал виконується одразу |
| `PAUSED` | сигнал зберігається зі статусом `PAUSED`, ордер не створюється |

Типовий режим після запуску: `CONFIRM_ONLY`.

## 5. Entry, SL та TP

Перед entry система встановлює `ISOLATED` margin і ціле leverage.

Типовий TP-розподіл:

| Рівень | Частка початкової позиції | Дія після досягнення |
|---|---:|---|
| TP1 | 40% | SL → BE+, перевірка слабкого momentum |
| TP2 | 30% | SL → TP1, перевірка сильного momentum |
| TP3 | 20% | SL → TP2 |
| Останній доступний TP | 0% | залишити runner та увімкнути ATR trailing |

BE+:

```text
buffer = 3 × tickSize

LONG:  BE+ = entryPrice + buffer
SHORT: BE+ = entryPrice - buffer
```

Усі SL/TP-ордери використовують:

```text
reduceOnly = true
workingType = MARK_PRICE
priceProtect = TRUE
```

## 6. Momentum

Система використовує останню закриту свічку та порівнює її з попередніми п'ятьма
закритими свічками. Поточна незакрита свічка не входить у розрахунок.

```text
avgVolume = average(previous closed volume[5])
avgRange  = average(previous closed high - low[5])

volumeStrong = lastVolume > avgVolume × 1.3
rangeStrong  = lastRange  > avgRange  × 1.2
```

Результат:

- `strong`, якщо одночасно сильні volume/range і напрям свічки збігається з позицією;
- `weak`, якщо напрям свічки протилежний позиції або обсяг нижче `avgVolume × 0.7`;
- інакше `neutral`.

Після TP1 слабкий momentum закриває додатково 25% від поточної позиції.

Після TP2 сильний momentum підтверджує утримання runner до TP3/trailing.

## 7. Fake breakout

Після TP1, якщо ціна повернулася до entry:

```text
LONG:  markPrice <= entryPrice
SHORT: markPrice >= entryPrice
```

система один раз закриває додаткові 25% від поточної позиції та скидає прапорець `tp1Reached`.

## 8. ATR trailing

ATR рахується за 14 періодами з 15 закритих свічок. Поточна незакрита свічка
не використовується:

```text
TR = max(
  high - low,
  |high - previousClose|,
  |low - previousClose|
)

ATR = average(TR)
```

Після останнього доступного TP:

```text
LONG:  trailPrice = markPrice - ATR × 1.5
SHORT: trailPrice = markPrice + ATR × 1.5
```

SL рухається лише в бік прибутку та округлюється до `tickSize`.

## 9. Timeout / early exit

За замовчуванням `executeOrder()` передає `timeoutCandles = 12`. Timeout рахується
за тривалістю timeframe сигналу, доки TP1 не досягнутий.

```text
timeoutAt = entryTime + timeoutCandles × intervalDuration
```

Наприклад, `12 × 1h` означає timeout приблизно через 12 годин. Після досягнення
ліміту позиція закривається повністю з причиною `early_exit_timeout`.

## 10. Аналітичні метрики

Для кожної trade monitor оновлює:

```text
LONG changePct  = (markPrice - entryPrice) / entryPrice × 100
SHORT changePct = (entryPrice - markPrice) / entryPrice × 100
```

Найменше від'ємне значення зберігається як `maxDrawdownPct`, найбільше додатне — як `maxProfitPct`.

При закритті trade repository розраховує:

```text
profitR   = profitUsdt / riskPerTradeUsdt
profitPct = profitUsdt / positionUsdt × 100
timeInTradeMs = closedAt - openedAt
```
