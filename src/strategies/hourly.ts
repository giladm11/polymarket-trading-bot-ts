import cron from 'node-cron';
import { getMarketBySlug, placeLimitOrder, fetchOrderStatus, getBalance } from '../polymarket.js';
import { loadConfig } from '../config.js';
import { sendTelegramMessage } from '../telegram.js';
import { logError } from '../logger.js';
import { OrderSide } from '@polymarket/client';
import { toZonedTime, format } from 'date-fns-tz';

// --- Constants ---
const PRE_MARKET_MINUTES = 5;
const ORDER_POLL_INTERVAL_MS = 15_000;
const ORDER_FILL_TIMEOUT_MS = 30 * 60 * 1000; // 5 min pre-market + 20 min market + 5 min buffer
const SELL_DELAY_MS = 3_000;

const enteredCycles = new Set<number>();
let isEntering = false;

interface TrackedOrder {
  orderId: string;
  tokenId: string;
  buyPrice: number;
  placedAt: number;
  sideLabel: string;
  expiration?: number;
}

const trackedOrders: TrackedOrder[] = [];

// ────────────────────────────────────────────────────────────────────────────

export function startHourlyStrategy() {
  cron.schedule('* * * * *', async () => {
    try {
      await tryEnterNextMarket();
    } catch (e: unknown) {
      logError('HourlyStrategy', e);
    }
  });

  sendTelegramMessage(`⏱️ Hourly strategy started — placing orders ${PRE_MARKET_MINUTES} min before each hour.`);
}

// ────────────────────────────────────────────────────────────────────────────

async function tryEnterNextMarket() {
  if (isEntering) return;

  const now = new Date();
  const minutes = now.getMinutes();

  if (minutes < 60 - PRE_MARKET_MINUTES) return;

  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);

  const targetTs = Math.floor(nextHour.getTime() / 1000);
  if (enteredCycles.has(targetTs)) return;

  const slug = buildMarketSlug(nextHour);
  console.log(`[Hourly] Looking for market slug: ${slug}`);

  isEntering = true;
  try {
    const market = await getMarketBySlug(slug);
    if (!market) {
      console.log(`[Hourly] Market not found: ${slug}`);
      return;
    }

    const acceptingOrders =
      market.acceptingOrders ??
      market.state?.acceptingOrders ??
      false;

    if (!acceptingOrders) {
      console.log(`[Hourly] Market found but not accepting orders yet: ${slug}`);
      return;
    }

    enteredCycles.add(targetTs);

    const tokens = extractTokenIds(market);
    if (!tokens.up || !tokens.down) {
      logError('Hourly.tokenParse', `Failed to parse token IDs for market: ${slug}`);
      return;
    }

    const config = loadConfig();
    const { buyPrice, orderSizeUsd } = config;
    const size = parseFloat((orderSizeUsd / buyPrice).toFixed(2));

    const ORDER_EXPIRY_SECONDS = 20 * 60;
    const expiration = Math.floor(nextHour.getTime() / 1000) + ORDER_EXPIRY_SECONDS;

    sendTelegramMessage(
      `🚀 <b>Entering market:</b> ${slug}\n` +
      `Buy Price: <b>${buyPrice}</b> | Size: <b>${size}</b> shares\n` +
      `Expires: ${ORDER_EXPIRY_SECONDS / 60} min after open (GTD)`
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
      console.warn(`[Hourly.${sideLabel}] Order placed but no orderId returned`);
      return;
    }

    console.log(`[Hourly.${sideLabel}] BUY order placed: ${orderId}`);
    trackedOrders.push({ orderId, tokenId, buyPrice, placedAt: Date.now(), sideLabel, expiration });
    void monitorForFill({ orderId, tokenId, buyPrice, placedAt: Date.now(), sideLabel, expiration });

  } catch (e: unknown) {
    logError(`Hourly.BuyOrder.${sideLabel}`, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorForFill(tracked: TrackedOrder): Promise<void> {
  const { orderId, tokenId, buyPrice, sideLabel } = tracked;

  console.log(`[Hourly.Monitor] Watching order ${orderId} (${sideLabel}) for fill...`);

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    if (Date.now() - tracked.placedAt > ORDER_FILL_TIMEOUT_MS) {
      console.log(`[Hourly.Monitor] Order ${orderId} (${sideLabel}) timed out.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        console.log(`[Hourly.Monitor] Order ${orderId} (${sideLabel}) is gone.`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        console.log(`[Hourly.Monitor] Order ${orderId} (${sideLabel}) FILLED — ${sizeMatched} shares`);
        sendTelegramMessage(
          `🟡 <b>BUY FILLED (${sideLabel})</b>\n` +
          `Order: ${orderId}\nFilled: <b>${sizeMatched}</b> shares @ ${buyPrice}`
        );

        await sleep(SELL_DELAY_MS);
        await doSellOrder(tokenId, sizeMatched, sideLabel);
        break;
      }
    } catch (e: unknown) {
      logError(`Hourly.Monitor.${sideLabel}`, e);
    }
  }

  const idx = trackedOrders.findIndex(o => o.orderId === orderId);
  if (idx !== -1) trackedOrders.splice(idx, 1);
}

// ────────────────────────────────────────────────────────────────────────────

async function doSellOrder(tokenId: string, sizeMatched: number, sideLabel: string) {
  const config = loadConfig();
  const sellPrice = config.sellPrice;
  const size = Math.floor(sizeMatched * 100) / 100;

  if (size < 0.01) {
    console.warn(`[Hourly.Sell] Size too small (${size}), skipping.`);
    return;
  }

  try {
    const orderId = await placeLimitOrder(tokenId, OrderSide.SELL, sellPrice, size);
    console.log(`[Hourly.Sell] SELL order placed for ${sideLabel}: ${orderId} @ ${sellPrice}`);
    sendTelegramMessage(
      `📤 <b>SELL ORDER PLACED (${sideLabel})</b>\n` +
      `Size: <b>${size}</b> shares @ <b>${sellPrice}</b>`
    );

    void monitorForSellFill(orderId, sideLabel, size, sellPrice);
  } catch (e: unknown) {
    logError(`Hourly.SellOrder.${sideLabel}`, e);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorForSellFill(orderId: string, sideLabel: string, size: number, sellPrice: number): Promise<void> {
  console.log(`[Hourly.Monitor] Watching sell ${orderId} (${sideLabel}) @ ${sellPrice}...`);
  const startTime = Date.now();
  const MAX_SELL_WAIT_MS = 60 * 60 * 1000;

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    if (Date.now() - startTime > MAX_SELL_WAIT_MS) {
      console.log(`[Hourly.Monitor] Sell ${orderId} (${sideLabel}) timed out.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        console.log(`[Hourly.Monitor] Sell ${orderId} (${sideLabel}) is gone.`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        console.log(`[Hourly.Monitor] Sell ${orderId} (${sideLabel}) FILLED — ${sizeMatched} shares`);
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
      logError(`Hourly.Monitor.Sell.${sideLabel}`, e);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

function buildMarketSlug(openTime: Date): string {
  const timeZone = 'America/New_York';
  const zonedDate = toZonedTime(openTime, timeZone);

  const month = format(zonedDate, 'MMMM', { timeZone }).toLowerCase();
  const day = zonedDate.getDate();
  const year = zonedDate.getFullYear();
  const hourStr = format(zonedDate, 'h', { timeZone });
  const ampm = format(zonedDate, 'a', { timeZone }).toLowerCase();

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
  } catch {
    // ignore parse errors
  }

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
