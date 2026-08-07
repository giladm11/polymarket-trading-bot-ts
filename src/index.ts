import { initTelegramBot, sendTelegramMessage } from './telegram.js';
import { startScanner } from './scanner.js';
import { initPolymarket } from './polymarket.js';
import { logError } from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('Starting Polymarket Trading Bot...');

  // Initialize telegram first so we can report startup errors
  initTelegramBot();

  // Initialize Polymarket client (throws if credentials are missing)
  try {
    await initPolymarket();
  } catch (e: unknown) {
    logError('Startup.initPolymarket', e);
    process.exit(1);
  }

  // Start the background scanner cron
  startScanner();

  console.log('Bot is running. Press Ctrl+C to exit.');

  // Graceful shutdown
  process.on('SIGINT', () => {
    sendTelegramMessage('🛑 Bot is shutting down.');
    console.log('Shutting down gracefully...');
    process.exit(0);
  });

  // Catch unhandled promise rejections and send to telegram
  process.on('unhandledRejection', (reason) => {
    logError('UnhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });
}

main().catch(err => {
  logError('Startup.fatal', err instanceof Error ? err : new Error(String(err)));
});
