import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type StrategyName = 'hourly' | 'rsi';

export interface RsiConfig {
  symbol: string;
  interval: string;
  period: number;
  overbought: number;
  oversold: number;
  buyLevels: number[];
}

export interface BotConfig {
  orderSizeUsd: number;
  buyPrice: number;
  sellPrice: number;
  activeStrategy: StrategyName;
  rsi: RsiConfig;
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
