import { createSecureClient, OrderSide } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { logError, logInfo } from './logger.js';
import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

export async function initPolymarket() {
  const wallet = process.env.POLY_SAFE_ADDRESS;
  const pkey = process.env.POLY_PRIVATE_KEY;
  const apiKey = process.env.POLY_BUILDER_API_KEY;
  const apiSecret = process.env.POLY_BUILDER_API_SECRET;
  const apiPassphrase = process.env.POLY_BUILDER_API_PASSPHRASE;

  if (!wallet || !pkey) {
    throw new Error('POLY_SAFE_ADDRESS and POLY_PRIVATE_KEY are required in .env');
  }

  // Use the CLOB API credentials for gasless (zero transaction fee) trading.
  // The polymarket SDK uses these to sign and submit orders without on-chain gas.
  client = await createSecureClient({
    wallet,
    signer: privateKey(pkey as `0x${string}`),
    credentials: (apiKey && apiSecret && apiPassphrase) ? {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      key: apiKey as any,
      secret: apiSecret,
      passphrase: apiPassphrase
    } : undefined
  });

  logInfo('Polymarket', `Client initialized for wallet: ${wallet}`);
}

export async function getMarketBySlug(slug: string) {
  if (!client) await initPolymarket();
  try {
    const market = await client.fetchMarket({ slug });
    return market;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // 404 is expected when market doesn't exist yet — don't spam telegram
    if (!msg.includes('404') && !msg.includes('not found')) {
      logError('Polymarket.fetchMarket', e);
    } else {
      console.warn(`[Polymarket] Market not found: ${slug}`);
    }
    return null;
  }
}

export async function placeLimitOrder(
  tokenId: string,
  side: OrderSide,
  price: number,
  size: number,
  expiration?: number  // Unix timestamp in seconds — omit for GTC
): Promise<string> {
  if (!client) await initPolymarket();
  try {
    const response = await client.placeLimitOrder({
      tokenId,
      side,
      price,
      size,
      ...(expiration !== undefined && { expiration }),
    });
    if (!response.ok) {
      throw new Error(`Order rejected: ${response.message} (code: ${response.code})`);
    }
    return response.orderId;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('Polymarket.placeLimitOrder', e);
    throw e;
  }
}

/**
 * Poll open orders for a specific tokenId to detect a fill.
 * Returns the filled size if the order is no longer open (i.e. fully matched).
 */
export async function fetchOrderStatus(orderId: string): Promise<{ status: string; sizeMatched: number }> {
  if (!client) await initPolymarket();
  try {
    const order = await client.fetchOrder({ orderId });
    // The SDK returns an OpenOrder with status field
    const status: string = order.status ?? 'unknown';
    const sizeMatched: number = parseFloat(order.sizeMatched ?? order.matched_amount ?? '0');
    return { status, sizeMatched };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Order 404 means it's been cancelled/resolved — expected, not an error
    if (msg.includes('404') || msg.includes('not found')) {
      return { status: 'not_found', sizeMatched: 0 };
    }
    logError('Polymarket.fetchOrderStatus', e);
    throw e;
  }
}

export async function getBalance(): Promise<number | null> {
  if (!client) await initPolymarket();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientAny = client as any;
    // Fetch balance via CLOB API — balance is in base units (USDC has 6 decimals)
    const result = await clientAny.secureClob
      .get('/balance-allowance', {
        params: { asset_type: 'COLLATERAL', signature_type: 2 },
      });

    // secureClob.get returns a neverthrow ResultAsync<Response>
    // Read the body stream and parse JSON
    if (result.isOk?.()) {
      const responseBody = result.value;
      const text = await responseBody.text?.() ?? await responseBody.body?.text?.() ?? '';
      const data = JSON.parse(text);
      const rawBalance = data?.balance ?? '0';
      return parseInt(String(rawBalance), 10) / 1e6;
    }
    return null;
  } catch (e: unknown) {
    logError('Polymarket.getBalance', e);
    return null;
  }
}

export async function getTokenBalance(tokenId: string): Promise<number | null> {
  if (!client) await initPolymarket();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientAny = client as any;
    const result = await clientAny.secureClob
      .get('/balance-allowance', {
        params: { asset_type: 'CONDITIONAL', token_id: tokenId, signature_type: 2 },
      });

    if (result.isOk?.()) {
      const responseBody = result.value;
      const text = await responseBody.text?.() ?? await responseBody.body?.text?.() ?? '';
      const data = JSON.parse(text);
      const rawBalance = data?.balance ?? '0';
      return parseInt(String(rawBalance), 10) / 1e6;
    }
    return null;
  } catch (e: unknown) {
    logError('Polymarket.getTokenBalance', e);
    return null;
  }
}

export async function cancelOrders(orderIds: string[]): Promise<string[]> {
  if (!client) await initPolymarket();
  if (orderIds.length === 0) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client as any).cancelOrders({ orderIds });
    return response.canceled ?? [];
  } catch (e: unknown) {
    logError('Polymarket.cancelOrders', e);
    return [];
  }
}
