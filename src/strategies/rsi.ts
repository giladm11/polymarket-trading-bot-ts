import cron from 'node-cron';
import { getMarketBySlug, placeLimitOrder, fetchOrderStatus } from '../polymarket.js';
import { loadConfig } from '../config.js';
import { sendTelegramMessage } from '../telegram.js';
import { logError, logInfo, logDebug, logWarn } from '../logger.js';
import { OrderSide } from '@polymarket/client';
import { toZonedTime, format } from 'date-fns-tz';

// --- Constants ---
const ORDER_POLL_INTERVAL_MS = 15_000;
const ORDER_FILL_TIMEOUT_MS = 30 * 60 * 1000;

const enteredCandles = new Set<string>();

// ────────────────────────────────────────────────────────────────────────────

export function startRsiStrategy() {
  cron.schedule('* * * * *', async () => {
    try {
      await checkAndTrade();
    } catch (e: unknown) {
      logError('RsiStrategy', e);
    }
  });

  const config = loadConfig();
  const rsi = config.rsi;
  sendTelegramMessage(
    `📊 <b>RSI Strategy started</b>\n` +
    `Interval: ${rsi.interval} | Period: ${rsi.period}\n` +
    `Overbought: ${rsi.overbought} | Oversold: ${rsi.oversold}\n` +
    `Buy prices: ${rsi.buyLevels.join(', ')}`
  );
}

// ────────────────────────────────────────────────────────────────────────────

async function checkAndTrade() {
  const config = loadConfig();
  const rsi = config.rsi;
  const intervalMinutes = parseInt(rsi.interval);

  const now = new Date();
  const minutes = now.getMinutes();

  // Log every tick so you can see the bot is alive
  logDebug('RSI', `Tick: ${now.toLocaleTimeString()} — min=${minutes} interval=${intervalMinutes}m`);

  if (minutes % intervalMinutes !== 0) {
    logDebug('RSI', `Skip: minute ${minutes} is not a ${intervalMinutes}-min boundary`);
    return;
  }

  const candleKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${Math.floor(minutes / intervalMinutes)}`;
  if (enteredCandles.has(candleKey)) {
    logDebug('RSI', `Skip: candle ${candleKey} already processed`);
    return;
  }

  logInfo('RSI', `✅ Candle boundary: ${candleKey}`);

  // Fetch period+3: need period+2 closed candles to compute RSI for two candles
  // (current closed + previous closed), plus 1 current (open) to exclude
  const allKlines = await fetchBinanceKlines(rsi.symbol, rsi.interval, rsi.period + 3);
  if (!allKlines || allKlines.length < rsi.period + 3) {
    logWarn('RSI', `Not enough kline data (got ${allKlines?.length ?? 0}, need ${rsi.period + 3})`);
    return;
  }

  // The last kline is the current (open) candle — exclude it
  const currentKline = allKlines[allKlines.length - 1];
  const closedKlines = allKlines.slice(0, -1);

  // Log candle timestamps for verification
  const tz = 'America/New_York';
  for (let i = 0; i < closedKlines.length; i++) {
    const k = closedKlines[i];
    const time = new Date(k.openTime).toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    logDebug('RSI', `  Closed candle ${i}: ${time} ET — close: ${k.close}`);
  }

  const currentTime = new Date(currentKline.openTime).toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  logDebug('RSI', `  Current (excluded): ${currentTime} ET — close: ${currentKline.close}`);

  if (closedKlines.length < rsi.period + 2) {
    logWarn('RSI', `Not enough closed candles (got ${closedKlines.length}, need ${rsi.period + 2})`);
    return;
  }

  // Compute RSI for the last two closed candles
  const closes = closedKlines.map(k => k.close);

  // Current signal: RSI of the most recent closed candle
  const currentRsi = calculateRsi(closes, rsi.period);
  // Previous signal: RSI of the candle before that (exclude last closed)
  const prevCloses = closes.slice(0, -1);
  const prevRsi = calculateRsi(prevCloses, rsi.period);

  logInfo('RSI', `Current RSI(${rsi.period}) = ${currentRsi.toFixed(2)} | Previous RSI = ${prevRsi.toFixed(2)}`);

  // Determine signals for both candles
  let currentSignal: 'overbought' | 'oversold' | null = null;
  let prevSignal: 'overbought' | 'oversold' | null = null;

  if (currentRsi > rsi.overbought) currentSignal = 'overbought';
  else if (currentRsi < rsi.oversold) currentSignal = 'oversold';

  if (prevRsi > rsi.overbought) prevSignal = 'overbought';
  else if (prevRsi < rsi.oversold) prevSignal = 'oversold';

  // Only trade on fresh signal: current candle in threshold, previous was NOT
  if (!currentSignal) {
    logInfo('RSI', `No signal on current candle.`);
    return;
  }

  if (currentSignal === prevSignal) {
    logInfo('RSI', `Signal "${currentSignal}" already active on previous candle, skipping.`);
    return;
  }

  enteredCandles.add(candleKey);

  const sideLabel = currentSignal === 'overbought' ? 'DOWN' : 'UP';
  logInfo('RSI', `Fresh signal: ${currentSignal} → buying ${sideLabel}`);

  // Find next candle
  const nextCandle = new Date(now);
  nextCandle.setMinutes(Math.ceil((now.getMinutes() + 1) / intervalMinutes) * intervalMinutes, 0, 0);
  if (nextCandle <= now) {
    nextCandle.setMinutes(nextCandle.getMinutes() + intervalMinutes);
  }

  const slug = buildMarketSlug(nextCandle, intervalMinutes);
  logInfo('RSI', `Looking for market: ${slug}`);

  const market = await getMarketBySlug(slug);
  if (!market) {
    logWarn('RSI', `Market not found: ${slug}`);
    return;
  }

  const acceptingOrders =
    market.acceptingOrders ??
    market.state?.acceptingOrders ??
    false;

  if (!acceptingOrders) {
    logWarn('RSI', `Market not accepting orders: ${slug}`);
    return;
  }

  const tokens = extractTokenIds(market);
  if (!tokens.up || !tokens.down) {
    logError('Rsi.tokenParse', `Failed to parse token IDs for: ${slug}`);
    return;
  }

  const targetTokenId = sideLabel === 'UP' ? tokens.up : tokens.down;

  const levelSummary = rsi.buyLevels.join(', ');

  sendTelegramMessage(
    `📊 <b>RSI Signal: ${currentSignal.toUpperCase()}</b>\n` +
    `RSI(${rsi.period}) = <b>${currentRsi.toFixed(2)}</b>\n` +
    `Market: ${slug}\n` +
    `Buying: <b>${sideLabel}</b> token\n` +
    `Order size: <b>$${config.orderSizeUsd}</b>\n` +
    `Buy prices: ${levelSummary}`
  );

  // Place buy orders for each level
  for (const buyPrice of rsi.buyLevels) {
    const size = parseFloat((config.orderSizeUsd / buyPrice).toFixed(2));
    await placeBuyOrder(targetTokenId, buyPrice, size, sideLabel);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function placeBuyOrder(
  tokenId: string,
  buyPrice: number,
  size: number,
  sideLabel: 'UP' | 'DOWN',
): Promise<void> {
  try {
    const orderId = await placeLimitOrder(tokenId, OrderSide.BUY, buyPrice, size);
    if (!orderId) {
      logWarn(`Rsi.${sideLabel}`, `Order placed but no orderId returned`);
      return;
    }

    logInfo(`Rsi.${sideLabel}`, `BUY order placed: ${orderId} @ ${buyPrice} (${size} shares)`);
    sendTelegramMessage(
      `🟢 <b>BUY ORDER PLACED (${sideLabel})</b>\n` +
      `Price: <b>${buyPrice}</b> | Size: <b>${size}</b> shares`
    );

    void monitorForFill(orderId, sideLabel, buyPrice);
  } catch (e: unknown) {
    logError(`Rsi.BuyOrder.${sideLabel}`, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorForFill(orderId: string, sideLabel: string, buyPrice: number): Promise<void> {
  logInfo(`Rsi.Monitor`, `Watching ${sideLabel} order ${orderId}...`);
  const startTime = Date.now();

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    if (Date.now() - startTime > ORDER_FILL_TIMEOUT_MS) {
      logWarn(`Rsi.Monitor`, `${sideLabel} order ${orderId} timed out.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        logInfo(`Rsi.Monitor`, `${sideLabel} order ${orderId} gone (cancelled).`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        logInfo(`Rsi.Monitor`, `${sideLabel} FILLED — ${sizeMatched} shares`);
        sendTelegramMessage(
          `🟡 <b>BUY FILLED (${sideLabel})</b>\n` +
          `Filled: <b>${sizeMatched}</b> shares @ ${buyPrice}`
        );
        break;
      }
    } catch (e: unknown) {
      logError(`Rsi.Monitor.${sideLabel}`, e);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Binance API
// ────────────────────────────────────────────────────────────────────────────

interface Kline {
  openTime: number;
  close: number;
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      logError('Rsi.Binance', `HTTP ${response.status}: ${response.statusText}`);
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any[];
    return data.map((k: any[]) => ({
      openTime: k[0] as number,
      close: parseFloat(k[4] as string),
    }));
  } catch (e: unknown) {
    logError('Rsi.Binance', e);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────

function calculateRsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;
  if (gains === 0) return 0;

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

// ────────────────────────────────────────────────────────────────────────────

function buildMarketSlug(openTime: Date, intervalMinutes: number): string {
  const timeZone = 'America/New_York';
  const zonedDate = toZonedTime(openTime, timeZone);

  const month = format(zonedDate, 'MMMM', { timeZone }).toLowerCase();
  const day = zonedDate.getDate();
  const year = zonedDate.getFullYear();
  const hourStr = format(zonedDate, 'h', { timeZone });
  const ampm = format(zonedDate, 'a', { timeZone }).toLowerCase();
  const minute = zonedDate.getMinutes();

  if (intervalMinutes === 15) {
    return `bitcoin-up-or-down-15-min-${month}-${day}-${year}-${hourStr}${minute.toString().padStart(2, '0')}${ampm}-et`;
  }

  return `bitcoin-up-or-down-${month}-${day}-${year}-${hourStr}${ampm}-et`;
}

// ────────────────────────────────────────────────────────────────────────────

function extractTokenIds(market: unknown): { up?: string; down?: string } {
  const result: { up?: string; down?: string } = {};
  const m = market as Record<string, unknown>;

  if (m.outcomes && typeof m.outcomes === 'object') {
    const outcomes = m.outcomes as Record<string, { tokenId?: string }>;
    if (outcomes.yes?.tokenId) result.up = outcomes.yes.tokenId;
    if (outcomes.no?.tokenId) result.down = outcomes.no.tokenId;
    if (result.up && result.down) return result;
    if (outcomes.up?.tokenId) result.up = outcomes.up.tokenId;
    if (outcomes.down?.tokenId) result.down = outcomes.down.tokenId;
    if (result.up && result.down) return result;
  }

  try {
    let tokenIds: string[] = [];
    if (typeof m.clobTokenIds === 'string') {
      tokenIds = JSON.parse(m.clobTokenIds) as string[];
    } else if (Array.isArray(m.clobTokenIds)) {
      tokenIds = m.clobTokenIds as string[];
    }

    let outcomeLabels: string[] = ['Up', 'Down'];
    if (typeof m.outcomes === 'string') {
      outcomeLabels = JSON.parse(m.outcomes) as string[];
    } else if (Array.isArray(m.outcomes)) {
      outcomeLabels = m.outcomes as string[];
    }

    outcomeLabels.forEach((label, idx) => {
      const l = String(label).toLowerCase();
      if ((l === 'up' || l === 'yes') && tokenIds[idx]) result.up = tokenIds[idx];
      if ((l === 'down' || l === 'no') && tokenIds[idx]) result.down = tokenIds[idx];
    });
    if (result.up && result.down) return result;
  } catch {}

  if (Array.isArray(m.tokens)) {
    for (const t of m.tokens as Array<Record<string, unknown>>) {
      const outcome = String(t.outcome ?? '').toLowerCase();
      const tid = t.token_id ?? t.tokenId;
      if ((outcome === 'up' || outcome === 'yes') && tid) result.up = String(tid);
      if ((outcome === 'down' || outcome === 'no') && tid) result.down = String(tid);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
