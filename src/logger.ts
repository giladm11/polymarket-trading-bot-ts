import { sendTelegramError } from './telegram.js';

/**
 * Central logger — every error goes to both console AND Telegram.
 */
export function logError(context: string, e: unknown): void {
  const msg = e instanceof Error
    ? `${e.message}${e.stack ? `\n${e.stack.split('\n').slice(1, 3).join('\n')}` : ''}`
    : String(e);
  console.error(`[${context}]`, msg);
  sendTelegramError(`<b>[${context}]</b> ${escapeHtml(msg)}`);
}

export function logWarn(context: string, msg: string): void {
  console.warn(`[${context}] ${msg}`);
}

export function logInfo(context: string, msg: string): void {
  console.log(`[${context}] ${msg}`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 3000); // Telegram message limit guard
}
