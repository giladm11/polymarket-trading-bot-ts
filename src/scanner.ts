import { loadConfig } from './config.js';
import { sendTelegramMessage } from './telegram.js';
import { startHourlyStrategy } from './strategies/hourly.js';
import { startRsiStrategy } from './strategies/rsi.js';
import { startLowballStrategy } from './strategies/lowball.js';

export function startScanner() {
  const config = loadConfig();
  const strategy = config.activeStrategy;

  sendTelegramMessage(`🚀 <b>Bot starting with strategy: ${strategy}</b>`);

  if (strategy === 'lowball') {
    startLowballStrategy();
  } else if (strategy === 'rsi') {
    startRsiStrategy();
  } else {
    startHourlyStrategy();
  }
}
