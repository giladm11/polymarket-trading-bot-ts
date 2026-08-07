import cron from 'node-cron';
import { getMarketBySlug, placeLimitOrder, fetchOrderStatus, getBalance } from './polymarket.js';
import { loadConfig } from './config.js';
import { sendTelegramMessage } from './telegram.js';
import { logError, logInfo, logWarn } from './logger.js';
import { OrderSide } from '@polymarket/client';
import { toZonedTime, format } from 'date-fns-tz';

// --- Constants (easy to change) ---
const PRE_MARKET_MINUTES = 5;       // How many minutes before the hour to place orders
const ORDER_POLL_INTERVAL_MS = 15_000; // How often to check if a buy order was filled (15s)
const ORDER_FILL_TIMEOUT_MS = (PRE_MARKET_MINUTES + 30) * 60 * 1000; // Stop monitoring after 20 minutes (GTD equivalent)
const SELL_DELAY_MS = 3_000;        // Brief delay before placing sell order after fill

const enteredCycles = new Set<number>();
let isEntering = false;

interface TrackedOrder {
  orderId: string;
  tokenId: string;
  buyPrice: number;
  placedAt: number; // timestamp ms
  sideLabel: string;
  expiration?: number; // Unix timestamp in seconds — GTD expiry
}

const trackedOrders: TrackedOrder[] = [];

// ────────────────────────────────────────────────────────────────────────────

export function startScanner() {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      await tryEnterNextMarket();
    } catch (e: unknown) {
      logError('Scanner', e);
    }
  });

  sendTelegramMessage(`⏱️ Scanner started — placing orders ${PRE_MARKET_MINUTES} min before each hour.`);
}

// ────────────────────────────────────────────────────────────────────────────

async function tryEnterNextMarket() {
  if (isEntering) return;

  const now = new Date();
  const minutes = now.getMinutes();

  // Only run in the window: [60 - PRE_MARKET_MINUTES, 59]
  // e.g. PRE_MARKET_MINUTES=2 → only at minute 58 or 59
  if (minutes < 60 - PRE_MARKET_MINUTES) {
    return;
  }

  // The market we're targeting opens at the NEXT full hour.
  // Slug format uses the hour AFTER that (what the market resolves to),
  // e.g. at 10:58 we target the 11:00-12:00 candle → slug uses "12pm" (noon ET).
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1); // market opens at nextHour

  const targetTs = Math.floor(nextHour.getTime() / 1000);

  if (enteredCycles.has(targetTs)) return;

  const slug = buildMarketSlug(nextHour);
  console.log(`[Scanner] Looking for market slug: ${slug}`);

  isEntering = true;
  try {
    const market = await getMarketBySlug(slug);
    if (!market) {
      console.log(`[Scanner] Market not found: ${slug}`);
      return; // retry next minute
    }

    // Check if the market is accepting orders
    const acceptingOrders =
      market.acceptingOrders ??
      market.state?.acceptingOrders ??
      false;

    if (!acceptingOrders) {
      console.log(`[Scanner] Market found but not accepting orders yet: ${slug}`);
      return; // retry next minute
    }

    enteredCycles.add(targetTs);

    const tokens = extractTokenIds(market);
    if (!tokens.up || !tokens.down) {
      logError('Scanner.tokenParse', `Failed to parse UP/DOWN token IDs for market: ${slug}`);
      return;
    }

    const config = loadConfig();
    const { buyPrice, orderSizeUsd } = config;
    const size = parseFloat((orderSizeUsd / buyPrice).toFixed(2));

    // Order expires 20 minutes after market open (GTD)
    const ORDER_EXPIRY_SECONDS = 20 * 60;
    const expiration = Math.floor(nextHour.getTime() / 1000) + ORDER_EXPIRY_SECONDS;

    sendTelegramMessage(
      `🚀 <b>Entering market:</b> ${slug}\n` +
      `Buy Price: <b>${buyPrice}</b> | Size: <b>${size}</b> shares\n` +
      `Expires: ${ORDER_EXPIRY_SECONDS / 60} min after open (GTD)\n` +
      `(UP token: ${tokens.up.slice(0, 10)}... DOWN token: ${tokens.down.slice(0, 10)}...)`
    );

    await Promise.all([
      doBuyOrder(tokens.up, buyPrice, size, 'UP', expiration),
      doBuyOrder(tokens.down, buyPrice, size, 'DOWN', expiration),
    ]);

  } finally {
    isEntering = false;
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function doBuyOrder(tokenId: string, buyPrice: number, size: number, sideLabel: string, expiration?: number) {
  try {
    const orderId = await placeLimitOrder(tokenId, OrderSide.BUY, buyPrice, size, expiration);
    if (!orderId) {
      console.warn(`[${sideLabel}] Order placed but no orderId returned`);
      return;
    }

    console.log(`[${sideLabel}] BUY order placed: ${orderId}`);

    // Start polling for fill in the background
    trackedOrders.push({ orderId, tokenId, buyPrice, placedAt: Date.now(), sideLabel, expiration });
    void monitorForFill({ orderId, tokenId, buyPrice, placedAt: Date.now(), sideLabel, expiration });

  } catch (e: unknown) {
    logError(`BuyOrder.${sideLabel}`, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorForFill(tracked: TrackedOrder): Promise<void> {
  const { orderId, tokenId, buyPrice, sideLabel, expiration } = tracked;

  console.log(`[Monitor] Watching order ${orderId} (${sideLabel}) for fill...`);

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    // Timeout — stop monitoring
    if (Date.now() - tracked.placedAt > ORDER_FILL_TIMEOUT_MS) {
      console.log(`[Monitor] Order ${orderId} (${sideLabel}) timed out — no fill detected.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        console.log(`[Monitor] Order ${orderId} (${sideLabel}) is gone — likely cancelled.`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        console.log(`[Monitor] Order ${orderId} (${sideLabel}) FILLED — ${sizeMatched} shares`);
        sendTelegramMessage(
          `🟡 <b>BUY FILLED (${sideLabel})</b>\n` +
          `Order: ${orderId}\nFilled: <b>${sizeMatched}</b> shares @ ${buyPrice}`
        );

        await sleep(SELL_DELAY_MS);
        await doSellOrder(tokenId, sizeMatched, sideLabel);
        break;
      }
    } catch (e: unknown) {
      logError(`Monitor.${sideLabel}`, e);
      // Keep retrying unless timeout
    }
  }

  // Clean up tracked order
  const idx = trackedOrders.findIndex(o => o.orderId === orderId);
  if (idx !== -1) trackedOrders.splice(idx, 1);
}

// ────────────────────────────────────────────────────────────────────────────

async function doSellOrder(tokenId: string, sizeMatched: number, sideLabel: string) {
  const config = loadConfig();
  const sellPrice = config.sellPrice;
  // Floor to 2 decimals to avoid overselling due to floating point
  const size = Math.floor(sizeMatched * 100) / 100;

  if (size < 0.01) {
    console.warn(`[Sell] Size too small (${size}), skipping sell.`);
    return;
  }

  try {
    const orderId = await placeLimitOrder(tokenId, OrderSide.SELL, sellPrice, size);
    console.log(`[Sell] SELL order placed for ${sideLabel}: ${orderId} @ ${sellPrice}`);
    sendTelegramMessage(
      `📤 <b>SELL ORDER PLACED (${sideLabel})</b>\n` +
      `Size: <b>${size}</b> shares @ <b>${sellPrice}</b>`
    );

    // Monitor for sell fill
    void monitorForSellFill(orderId, sideLabel, size, sellPrice);
  } catch (e: unknown) {
    logError(`SellOrder.${sideLabel}`, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorForSellFill(orderId: string, sideLabel: string, size: number, sellPrice: number): Promise<void> {
  console.log(`[Monitor] Watching sell order ${orderId} (${sideLabel}) for fill...`);
  const startTime = Date.now();
  const MAX_SELL_WAIT_MS = 60 * 60 * 1000; // 60 minutes max for sell

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    if (Date.now() - startTime > MAX_SELL_WAIT_MS) {
      console.log(`[Monitor] Sell order ${orderId} (${sideLabel}) timed out — not filled.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        console.log(`[Monitor] Sell order ${orderId} (${sideLabel}) is gone — likely cancelled.`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        console.log(`[Monitor] Sell order ${orderId} (${sideLabel}) FILLED — ${sizeMatched} shares`);
        const balance = await getBalance();
        const balanceStr = balance !== null ? `$${balance.toFixed(2)}` : 'unknown';
        sendTelegramMessage(
          `🟢 <b>SELL FILLED (${sideLabel})</b>\n` +
          `Order: ${orderId}\nFilled: <b>${sizeMatched}</b> shares @ ${sellPrice}\n` +
          `Revenue: <b>$${(sizeMatched * sellPrice).toFixed(2)}</b>\n` +
          `💰 Balance: <b>${balanceStr}</b>`
        );
        break;
      }
    } catch (e: unknown) {
      logError(`Monitor.Sell.${sideLabel}`, e);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the Gamma-style market slug for the BTC hourly market
 * that opens at `openTime` (UTC).
 *
 * Example: openTime = 2026-08-07 11:00 UTC  →  ET = 7am ET
 *   slug = "bitcoin-up-or-down-august-7-2026-7am-et"
 */
function buildMarketSlug(openTime: Date): string {
  const timeZone = 'America/New_York';
  const zonedDate = toZonedTime(openTime, timeZone);

  const month = format(zonedDate, 'MMMM', { timeZone }).toLowerCase();
  const day = zonedDate.getDate();
  const year = zonedDate.getFullYear();
  // Remove leading zero: "07" → "7", keep am/pm
  const hourStr = format(zonedDate, 'h', { timeZone });
  const ampm = format(zonedDate, 'a', { timeZone }).toLowerCase();

  return `bitcoin-up-or-down-${month}-${day}-${year}-${hourStr}${ampm}-et`;
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract UP and DOWN token IDs from a market object returned by the TS SDK.
 * Handles multiple response shapes (Gamma API vs CLOB API vs TS SDK wrapper).
 */
function extractTokenIds(market: unknown): { up?: string; down?: string } {
  const result: { up?: string; down?: string } = {};
  const m = market as Record<string, unknown>;

  // --- Shape 1: TS SDK `fetchMarket` → market.outcomes.yes/no.tokenId
  if (m.outcomes && typeof m.outcomes === 'object') {
    const outcomes = m.outcomes as Record<string, { tokenId?: string }>;
    // BTC Up/Down markets use yes/no
    if (outcomes.yes?.tokenId) result.up = outcomes.yes.tokenId;
    if (outcomes.no?.tokenId) result.down = outcomes.no.tokenId;
    if (result.up && result.down) return result;

    // Or explicit up/down keys
    if (outcomes.up?.tokenId) result.up = outcomes.up.tokenId;
    if (outcomes.down?.tokenId) result.down = outcomes.down.tokenId;
    if (result.up && result.down) return result;
  }

  // --- Shape 2: Gamma API → market.clobTokenIds (JSON string or array) + market.outcomes
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
  } catch {
    // ignore parse errors, fall through
  }

  // --- Shape 3: market.tokens array (some SDK versions)
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
