import cron from 'node-cron';
import { getMarketBySlug, placeLimitOrder, fetchOrderStatus, buildMarketSlug } from '../polymarket.js';
import { loadConfig } from '../config.js';
import { sendTelegramMessage } from '../telegram.js';
import { logError, logInfo, logDebug, logWarn } from '../logger.js';
import { OrderSide } from '@polymarket/client';

// --- Constants ---
const ORDER_POLL_INTERVAL_MS = 15_000;
const ORDER_FILL_TIMEOUT_MS = 30 * 60 * 1000;
let blockTrading = false;

// ────────────────────────────────────────────────────────────────────────────

export function startRsiStrategy() {
  cron.schedule('* * * * *', async () => {
    checkAndTrade().catch(e => logError('RsiStrategy', e));
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

  if (minutes % intervalMinutes !== 0) {
    return;
  }

  const candleKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${Math.floor(minutes / intervalMinutes)}`;

  logInfo('RSI', `✅ Candle boundary: ${candleKey}`);

  // Fetch 200 candles so Wilder's smoothing converges (same as Binance default)
  const allKlines = await fetchBinanceKlines(rsi.symbol, rsi.interval, 200);
  if (!allKlines || allKlines.length < rsi.period + 3) {
    logWarn('RSI', `Not enough kline data (got ${allKlines?.length ?? 0}, need ${rsi.period + 3})`);
    return;
  }

  // Check if the last kline is a new (open) candle or still the previous closed one
  const lastKline = allKlines[allKlines.length - 1];
  const lastKlineTime = lastKline.openTime;

  // Expected open time of the current candle (no setMinutes — avoids hour-boundary issues)
  const intervalMs = intervalMinutes * 60 * 1000;
  const expectedCurrentOpen = new Date(now.getTime() - (now.getTime() % intervalMs));

  const isNewCandle = lastKlineTime >= expectedCurrentOpen.getTime();

  const tz = 'America/New_York';
  const lastTime = new Date(lastKlineTime).toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

  let closes: number[];
  if (isNewCandle) {
    // Last kline is current open candle — exclude it
    closes = allKlines.slice(0, -1).map(k => k.close);
    logDebug('RSI', `  Current (excluded): ${lastTime} ET — close: ${lastKline.close}`);
  } else {
    // New candle not created yet — all klines are closed
    closes = allKlines.map(k => k.close);
    logDebug('RSI', `  No new candle yet — using all ${closes.length} closed candles (last: ${lastTime} ET)`);
  }

  if (closes.length < rsi.period + 2) {
    logWarn('RSI', `Not enough closed candles (got ${closes.length}, need ${rsi.period + 2})`);
    return;
  }

  // Current RSI: all available closes (matches Binance chart)
  const currentRsi = calculateRsi(closes, rsi.period);

  // Previous RSI: exclude last closed candle (what was available one candle ago)
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

  if (!currentSignal) {
    blockTrading = false;
    logInfo('RSI', `No signal on current candle.`);
    return;
  }

  if (currentSignal != prevSignal) {
    logInfo('RSI', `No signal on previous candle.`);
    return;
  }

  if (blockTrading) {
    logInfo('RSI', `Trading is blocked, enetered position already.`);
    return;
  }

  blockTrading = true;

  const sideLabel = currentSignal === 'overbought' ? 'DOWN' : 'UP';
  logInfo('RSI', `Signal: ${currentSignal} → buying ${sideLabel}}`);

  // Use the current candle's open time (the one that triggered the signal)
  const slug = buildMarketSlug(expectedCurrentOpen, intervalMinutes);
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


  if (config.orderSizeUsd && config.orderSizeUsd > 0) {
    // Place buy orders for each level
    for (const buyPrice of rsi.buyLevels) {
      const size = parseFloat(((config.orderSizeUsd) / buyPrice).toFixed(2));
      placeBuyOrder(targetTokenId, buyPrice, size, sideLabel).catch(err1 => logError(`Rsi.BuyOrder.${sideLabel}`, err1));
    }
  }


  sendTelegramMessage(
    `📊 <b>RSI Signal: ${currentSignal.toUpperCase()}</b>\n` +
    `RSI(${rsi.period}) = <b>${currentRsi.toFixed(2)}</b>\n` +
    `Market: ${slug}\n` +
    `Buying: <b>${sideLabel}</b> token\n` +
    `Order size: <b>$${config.orderSizeUsd}</b>\n` +
    `Buy prices: ${levelSummary}`
  );
}

// ────────────────────────────────────────────────────────────────────────────

async function placeBuyOrder(
  tokenId: string,
  buyPrice: number,
  size: number,
  sideLabel: 'UP' | 'DOWN',
): Promise<void> {
  try {
    // Order is valid for 5 minutes only (good-for-5m), then expires.
    const expiration = Math.floor(Date.now() / 1000) + (5 * 60);
    const orderId = await placeLimitOrder(tokenId, OrderSide.BUY, buyPrice, size, expiration);
    if (!orderId) {
      logWarn(`Rsi.${sideLabel}`, `Order placed but no orderId returned`);
      return;
    }

    logInfo(`Rsi.${sideLabel}`, `BUY order placed: ${orderId} @ ${buyPrice} (${size} shares)`);
    sendTelegramMessage(
      `🟢 <b>BUY ORDER PLACED (${sideLabel})</b>\n` +
      `Price: <b>${buyPrice}</b> | Size: <b>${size}</b> shares\n` +
      `Expires in: <b>5 min</b>`
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

  // Wilder's smoothing (same as Binance)
  // Seed with simple average of first `period` changes
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }

  avgGain /= period;
  avgLoss /= period;

  // Exponential smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
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
  } catch { }

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
