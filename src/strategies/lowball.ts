import cron from 'node-cron';
import {
  getMarketBySlug, placeLimitOrderWithRetry, fetchOrderStatus, getBalance, buildMarketSlug,
} from '../polymarket.js';
import { loadConfig, type LowballConfig } from '../config.js';
import { sendTelegramMessage, sendTelegramError } from '../telegram.js';
import { logError, logInfo, logWarn } from '../logger.js';
import { OrderSide } from '@polymarket/client';

// --- Constants ---
// Short poll interval: the buy window is only ~60s, so we check fills frequently.
const ORDER_POLL_INTERVAL_MS = 1_000;
const SAFETY_BUFFER_MS = 30_000; // stop watching a buy 30s after its exchange expiry
const MAX_SELL_WAIT_MS = 24 * 60 * 60 * 1000; // GTC sell — watch up to 24h
const SELL_DELAY_MS = 1_000; // wait after a buy fills before placing the sell

const enteredCycles = new Set<string>(); // `${symbol}:${boundaryTs}`
// When each tracked market cycle ends (unix seconds). Used to prune enteredCycles
// and to stop sell monitoring once the market closes.
const cycleEnds = new Map<string, number>();

interface TrackedBuy {
  orderId: string;
  tokenId: string;
  buyPrice: number;
  placedAt: number;
  sideLabel: string;
  symbol: string;
  expiration: number;
  marketEndTs: number;
}

const trackedBuys: TrackedBuy[] = [];

// ────────────────────────────────────────────────────────────────────────────

export function startLowballStrategy() {
  cron.schedule('* * * * *', async () => {
    try {
      await tryEnterNextMarkets();
    } catch (e: unknown) {
      logError('LowballStrategy', e);
    }
  });

  const config = loadConfig();
  const lb = config.lowball;
  sendTelegramMessage(
    `🔻 <b>Lowball strategy started</b>\n` +
    `Symbols: ${lb.symbols.join(', ')} | Interval: ${lb.intervalMinutes}m\n` +
    `Pre-market: ${lb.preMarketMinutes} min | Buy levels: ${lb.buyLevels.join(', ')}\n` +
    `Buy TTL: ${lb.buyExpirySeconds}s | Sell @ ${lb.sellMultiplier}x | Sell ${lb.sellFraction * 100}%`
  );
}

// ────────────────────────────────────────────────────────────────────────────

async function tryEnterNextMarkets() {
  // Clear entered cycles once their market has ended so stale entries don't
  // accumulate forever. Runs every minute regardless of the entry window.
  pruneEndedCycles();

  const config = loadConfig();
  const lb = config.lowball;
  const intervalMs = lb.intervalMinutes * 60 * 1000;

  const now = new Date();
  const nextBoundary = new Date(Math.ceil(now.getTime() / intervalMs) * intervalMs);
  const msUntil = nextBoundary.getTime() - now.getTime();
  const windowMs = lb.preMarketMinutes * 60 * 1000;

  // Only act when we're inside the pre-market window (and not past the boundary).
  if (msUntil <= 0 || msUntil > windowMs) return;

  await Promise.all(lb.symbols.map(symbol => tryEnterSymbol(symbol, nextBoundary, lb)));
}

async function tryEnterSymbol(symbol: string, nextBoundary: Date, lb: LowballConfig) {
  const boundaryTs = Math.floor(nextBoundary.getTime() / 1000);
  const cycleKey = `${symbol}:${boundaryTs}`;
  if (enteredCycles.has(cycleKey)) return;

  const slug = buildMarketSlug(nextBoundary, lb.intervalMinutes, symbol);
  logInfo('Lowball', `[${symbol}] Looking for market slug: ${slug}`);

  const market = await getMarketBySlug(slug);
  if (!market) {
    logWarn('Lowball', `[${symbol}] Market not found: ${slug}`);
    return;
  }

  const acceptingOrders =
    market.acceptingOrders ??
    market.state?.acceptingOrders ??
    false;

  if (!acceptingOrders) {
    logWarn('Lowball', `[${symbol}] Market found but not accepting orders yet: ${slug}`);
    return;
  }

  const marketEndTs = getMarketEndTime(market, nextBoundary, lb.intervalMinutes);
  cycleEnds.set(cycleKey, marketEndTs);
  enteredCycles.add(cycleKey);

  const tokens = extractTokenIds(market);
  if (!tokens.up || !tokens.down) {
    logError('Lowball.tokenParse', `[${symbol}] Failed to parse token IDs for: ${slug}`);
    return;
  }

  const config = loadConfig();
  const { orderSizeUsd } = config;
  // Buy order lives until the market opens plus its time-in-force, so it keeps
  // working through the open instead of dying seconds after placement.
  const expiration = Math.floor(nextBoundary.getTime() / 1000) + lb.buyExpirySeconds;

  const sides: Array<[string, string]> = [
    ['UP', tokens.up],
    ['DOWN', tokens.down],
  ];
  const placements: Promise<void>[] = [];
  for (const [sideLabel, tokenId] of sides) {
    for (const level of lb.buyLevels) {
      placements.push(doBuyOrder(tokenId, level, orderSizeUsd, sideLabel, symbol, expiration, marketEndTs));
    }
  }
  await Promise.all(placements);
}

// ────────────────────────────────────────────────────────────────────────────

async function doBuyOrder(
  tokenId: string,
  buyPrice: number,
  orderSizeUsd: number,
  sideLabel: string,
  symbol: string,
  expiration: number,
  marketEndTs: number,
): Promise<void> {
  const size = parseFloat((orderSizeUsd / buyPrice).toFixed(2));
  if (size < 0.01) {
    logWarn('Lowball.Buy', `[${symbol}] Size too small for level ${buyPrice}, skipping.`);
    return;
  }

  console.log('exp', expiration);

  try {
    const orderId = await placeLimitOrderWithRetry(tokenId, OrderSide.BUY, buyPrice, size, expiration);
    logInfo(`Lowball.${symbol}.${sideLabel}`, `BUY order placed: ${orderId} @ ${buyPrice} (${size} shares)`);
    const tracked: TrackedBuy = {
      orderId, tokenId, buyPrice, placedAt: Date.now(), sideLabel, symbol, expiration, marketEndTs,
    };
    trackedBuys.push(tracked);
    void monitorBuyFill(tracked);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`Lowball.BuyOrder.${symbol}.${sideLabel}`, e);
    sendTelegramError(`Lowball BUY placement failed after all retries (${symbol} ${sideLabel} @ ${buyPrice}): ${msg}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorBuyFill(tracked: TrackedBuy): Promise<void> {
  const { orderId, tokenId, buyPrice, sideLabel, symbol, expiration, marketEndTs } = tracked;
  const lb = loadConfig().lowball;

  // Stop watching 30s after the order's exchange expiry — no point polling a dead order.
  const stopAt = expiration * 1000 + SAFETY_BUFFER_MS;

  logInfo('Lowball.Monitor', `[${symbol}] Watching buy ${orderId} (${sideLabel}) for fill...`);

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    if (Date.now() > stopAt) {
      logInfo('Lowball.Monitor', `[${symbol}] Buy ${orderId} (${sideLabel}) expired — stopping monitor.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        // Order expired/cancelled on the exchange — nothing filled we can act on.
        logInfo('Lowball.Monitor', `[${symbol}] Buy ${orderId} (${sideLabel}) is gone.`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        logInfo('Lowball.Monitor', `[${symbol}] Buy ${orderId} (${sideLabel}) FILLED — ${sizeMatched} shares`);
        sendTelegramMessage(
          `🟡 <b>LOWBALL BUY FILLED (${symbol} ${sideLabel})</b>\n` +
          `Filled: <b>${sizeMatched}</b> shares @ ${buyPrice}\n` +
          `Cost: <b>$${(sizeMatched * buyPrice).toFixed(2)}</b>`
        );

        await doSellOrder(tokenId, sizeMatched, buyPrice, sideLabel, symbol, lb, marketEndTs);
        break;
      }
    } catch (e: unknown) {
      logError(`Lowball.Monitor.${symbol}.${sideLabel}`, e);
    }
  }

  const idx = trackedBuys.findIndex(o => o.orderId === orderId);
  if (idx !== -1) trackedBuys.splice(idx, 1);
}

// ────────────────────────────────────────────────────────────────────────────

async function doSellOrder(
  tokenId: string,
  filledShares: number,
  buyPrice: number,
  sideLabel: string,
  symbol: string,
  lb: LowballConfig,
  marketEndTs: number,
): Promise<void> {
  const sellShares = Math.floor(filledShares * lb.sellFraction * 100) / 100;
  if (sellShares < 0.01) {
    logWarn('Lowball.Sell', `[${symbol}] Sell size too small (${sellShares}), skipping sell.`);
    return;
  }

  const sellPrice = Math.round(buyPrice * lb.sellMultiplier * 100) / 100;
  if (sellPrice >= 1) {
    logWarn('Lowball.Sell', `[${symbol}] Sell price ${sellPrice} invalid (>=1), skipping sell.`);
    return;
  }

  try {
    // Give the exchange a moment to settle the buy fill before selling.
    await sleep(SELL_DELAY_MS);
    // No expiration → GTC: rests until the price doubles.
    const orderId = await placeLimitOrderWithRetry(tokenId, OrderSide.SELL, sellPrice, sellShares);
    logInfo('Lowball.Sell', `[${symbol}] SELL order placed for ${sideLabel}: ${orderId} @ ${sellPrice}`);

    void monitorSellFill(orderId, sideLabel, sellShares, sellPrice, symbol, marketEndTs);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`Lowball.SellOrder.${symbol}.${sideLabel}`, e);
    sendTelegramError(`Lowball SELL placement failed after all retries (${symbol} ${sideLabel} @ ${sellPrice}): ${msg}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function monitorSellFill(
  orderId: string,
  sideLabel: string,
  size: number,
  sellPrice: number,
  symbol: string,
  marketEndTs: number,
): Promise<void> {
  logInfo('Lowball.Monitor', `[${symbol}] Watching sell ${orderId} (${sideLabel}) @ ${sellPrice}...`);
  const startTime = Date.now();

  while (true) {
    await sleep(ORDER_POLL_INTERVAL_MS);

    // Market has closed — stop watching the sell order.
    if (marketEndTs && Math.floor(Date.now() / 1000) >= marketEndTs) {
      logInfo('Lowball.Monitor', `[${symbol}] Market ended — stopping sell monitor ${orderId} (${sideLabel}).`);
      break;
    }

    if (Date.now() - startTime > MAX_SELL_WAIT_MS) {
      logWarn('Lowball.Monitor', `[${symbol}] Sell ${orderId} (${sideLabel}) timed out.`);
      break;
    }

    try {
      const { status, sizeMatched } = await fetchOrderStatus(orderId);

      if (status === 'not_found') {
        logInfo('Lowball.Monitor', `[${symbol}] Sell ${orderId} (${sideLabel}) is gone.`);
        break;
      }

      const isFilled = status === 'MATCHED' || status === 'filled' || status === 'closed';
      if (isFilled && sizeMatched > 0) {
        logInfo('Lowball.Monitor', `[${symbol}] Sell ${orderId} (${sideLabel}) FILLED — ${sizeMatched} shares`);
        const balance = await getBalance();
        const balanceStr = balance !== null ? `$${balance.toFixed(2)}` : 'unknown';
        sendTelegramMessage(
          `🟢 <b>LOWBALL SELL FILLED (${symbol} ${sideLabel})</b>\n` +
          `Filled: <b>${sizeMatched}</b> shares @ ${sellPrice}\n` +
          `Revenue: <b>$${(sizeMatched * sellPrice).toFixed(2)}</b>\n` +
          `💰 Balance: <b>${balanceStr}</b>`
        );
        break;
      }
    } catch (e: unknown) {
      logError(`Lowball.Monitor.Sell.${symbol}.${sideLabel}`, e);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

function pruneEndedCycles(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [key, endTs] of cycleEnds) {
    if (nowSec >= endTs) {
      enteredCycles.delete(key);
      cycleEnds.delete(key);
    }
  }
}

/**
 * Determine when a market closes (unix seconds). Polymarket market objects
 * expose `closeTime` (unix) or `endDate` (ISO); fall back to one interval
 * after open if neither is present.
 */
function getMarketEndTime(market: unknown, openTime: Date, intervalMinutes: number): number {
  const m = market as Record<string, unknown>;
  const raw = m.closeTime ?? m.endDate ?? m.end_time;
  if (raw != null) {
    if (typeof raw === 'number') return raw;
    const s = String(raw).trim();
    const asNum = Number(s);
    if (!isNaN(asNum)) return Math.floor(asNum);
    const parsed = Date.parse(s);
    if (!isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(openTime.getTime() / 1000) + intervalMinutes * 60;
}

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
