import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type StrategyName = 'hourly' | 'rsi' | 'lowball';

export interface RsiConfig {
  symbol: string;
  interval: string;
  period: number;
  overbought: number;
  oversold: number;
  buyLevels: number[];
}

export interface LowballConfig {
  symbols: string[];          // e.g. ['BTC', 'SOL']
  intervalMinutes: number;    // 15
  preMarketMinutes: number;   // place this many minutes before market open
  buyLevels: number[];        // e.g. [0.25, 0.20]
  buyExpirySeconds: number;   // buy order time-in-force (e.g. 60)
  sellMultiplier: number;     // sell price = buyPrice * sellMultiplier (e.g. 2)
  sellFraction: number;       // fraction of a fill to sell (e.g. 0.5)
}

export interface BotConfig {
  orderSizeUsd: number;
  buyPrice: number;
  sellPrice: number;
  activeStrategy: StrategyName;
  rsi: RsiConfig;
  lowball: LowballConfig;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'bot_config.json');

const DEFAULT_CONFIG: BotConfig = {
  orderSizeUsd: parseFloat(process.env.ORDER_AMOUNT_USD ?? '10'),
  buyPrice: 0.3,
  sellPrice: 0.35,
  activeStrategy: 'hourly',
  rsi: {
    symbol: 'BTCUSDT',
    interval: '15m',
    period: 6,
    overbought: 83,
    oversold: 13,
    buyLevels: [0.50, 0.40],
  },
  lowball: {
    symbols: ['BTC'],
    intervalMinutes: 15,
    preMarketMinutes: 5,
    buyLevels: [0.25, 0.20, 0.15],
    buyExpirySeconds: 120, // put 60 seconds more because api cancel 60 seconds before
    sellMultiplier: 2,
    sellFraction: 0.5,
  },
};

/**
 * Load config from file. If file doesn't exist, write defaults so they
 * persist across restarts and are visible to the user.
 */
export function loadConfig(): BotConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(data) as Partial<BotConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (e) {
      console.error('[Config] Failed to parse config file, using defaults:', e);
    }
  }

  // First run — write defaults to disk so the user can see / edit them
  const defaults = { ...DEFAULT_CONFIG };
  saveConfig(defaults);
  console.log(`[Config] Created default config at ${CONFIG_PATH}`);
  return defaults;
}

export function saveConfig(config: BotConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Config] Failed to save config file:', e);
  }
}

export function setActiveStrategy(strategy: StrategyName): void {
  const config = loadConfig();
  config.activeStrategy = strategy;
  saveConfig(config);
}

export function updateRsiConfig(updates: Partial<RsiConfig>): void {
  const config = loadConfig();
  config.rsi = { ...config.rsi, ...updates };
  saveConfig(config);
}

export function setRsiBuyLevel(index: number, price: number): void {
  const config = loadConfig();
  if (index < 0 || index >= config.rsi.buyLevels.length) {
    config.rsi.buyLevels.push(price);
  } else {
    config.rsi.buyLevels[index] = price;
  }
  saveConfig(config);
}

export function removeRsiBuyLevel(index: number): void {
  const config = loadConfig();
  if (index >= 0 && index < config.rsi.buyLevels.length) {
    config.rsi.buyLevels.splice(index, 1);
    saveConfig(config);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lowball config helpers
// ─────────────────────────────────────────────────────────────────────────────

export function updateLowballConfig(updates: Partial<LowballConfig>): void {
  const config = loadConfig();
  config.lowball = { ...config.lowball, ...updates };
  saveConfig(config);
}

export function setLowballSymbols(symbols: string[]): void {
  const config = loadConfig();
  config.lowball.symbols = symbols.map(s => s.toUpperCase());
  saveConfig(config);
}

export function setLowballBuyLevels(levels: number[]): void {
  const config = loadConfig();
  config.lowball.buyLevels = levels;
  saveConfig(config);
}

export function setLowballMultiplier(multiplier: number): void {
  const config = loadConfig();
  config.lowball.sellMultiplier = multiplier;
  saveConfig(config);
}

export function setLowballFraction(fraction: number): void {
  const config = loadConfig();
  config.lowball.sellFraction = fraction;
  saveConfig(config);
}

export function setLowballPreMarket(minutes: number): void {
  const config = loadConfig();
  config.lowball.preMarketMinutes = minutes;
  saveConfig(config);
}

export function setLowballExpiry(seconds: number): void {
  const config = loadConfig();
  config.lowball.buyExpirySeconds = seconds;
  saveConfig(config);
}
