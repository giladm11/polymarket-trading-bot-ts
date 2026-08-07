import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface BotConfig {
  orderSizeUsd: number;
  buyPrice: number;
  sellPrice: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'bot_config.json');

const DEFAULT_CONFIG: BotConfig = {
  orderSizeUsd: parseFloat(process.env.ORDER_AMOUNT_USD ?? '10'),
  buyPrice: 0.3,
  sellPrice: 0.35,
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
