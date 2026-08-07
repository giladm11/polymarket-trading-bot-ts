import { sendTelegramMessage } from './telegram.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Set minimum level: debug < info < warn < error
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

/**
 * Central logger — every error goes to both console AND Telegram.
 */
export function logError(context: string, e: unknown): void {
  if (!shouldLog('error')) return;
  const msg = e instanceof Error
    ? `${e.message}${e.stack ? `\n${e.stack.split('\n').slice(1, 3).join('\n')}` : ''}`
    : String(e);
  console.error(`[${context}]`, msg);
  sendTelegramMessage(`🔴 <b>ERROR [${context}]</b>\n${escapeHtml(msg)}`);
}

export function logWarn(context: string, msg: string): void {
  if (!shouldLog('warn')) return;
  console.warn(`[${context}] ${msg}`);
  sendTelegramMessage(`⚠️ <b>WARN [${context}]</b> ${escapeHtml(msg)}`);
}

export function logInfo(context: string, msg: string): void {
  if (!shouldLog('info')) return;
  console.log(`[${context}] ${msg}`);
}

export function logDebug(context: string, msg: string): void {
  if (!shouldLog('debug')) return;
  console.log(`[${context}] ${msg}`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 3000); // Telegram message limit guard
}
