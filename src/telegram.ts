import TelegramBot from 'node-telegram-bot-api';
import { loadConfig, saveConfig } from './config.js';
import { getBalance } from './polymarket.js';

let bot: TelegramBot | null = null;
let chatId: string = '';

export function initTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  chatId = process.env.TELEGRAM_CHAT_ID || '';

  if (!token) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN is not set. Telegram notifications are disabled.');
    return;
  }

  bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.message);
  });

  registerCommands(bot);

  sendTelegramMessage('🤖 <b>Polymarket BTC Bot started!</b>\n\nType /help for available commands.');
}

function registerCommands(bot: TelegramBot) {
  bot.onText(/^\/start/, (msg) => {
    const id = msg.chat.id.toString();
    bot.sendMessage(id, '🤖 <b>Polymarket BTC Bot</b>\n\nType /help for available commands.', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/help/, (msg) => {
    const id = msg.chat.id.toString();
    bot.sendMessage(id, getHelpText(), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/view/, (msg) => {
    const id = msg.chat.id.toString();
    const config = loadConfig();
    bot.sendMessage(id,
      `📋 <b>Current Configuration</b>\n\n` +
      `💵 Order Size: <b>$${config.orderSizeUsd}</b>\n` +
      `🟢 Buy Price: <b>${config.buyPrice}</b>\n` +
      `🔴 Sell Price: <b>${config.sellPrice}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/^\/setsize ([\d.]+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0) {
      bot.sendMessage(id, '❌ Invalid size. Usage: /setsize 5');
      return;
    }
    const config = loadConfig();
    config.orderSizeUsd = val;
    saveConfig(config);
    bot.sendMessage(id, `✅ Order size updated to <b>$${val}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/setbuy ([\d.]+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0 || val >= 1) {
      bot.sendMessage(id, '❌ Invalid price. Must be between 0 and 1. Usage: /setbuy 0.3');
      return;
    }
    const config = loadConfig();
    config.buyPrice = val;
    saveConfig(config);
    bot.sendMessage(id, `✅ Buy price updated to <b>${val}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/setsell ([\d.]+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0 || val >= 1) {
      bot.sendMessage(id, '❌ Invalid price. Must be between 0 and 1. Usage: /setsell 0.35');
      return;
    }
    const config = loadConfig();
    config.sellPrice = val;
    saveConfig(config);
    bot.sendMessage(id, `✅ Sell price updated to <b>${val}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/balance/, async (msg) => {
    const id = msg.chat.id.toString();
    const balance = await getBalance();
    if (balance !== null) {
      bot.sendMessage(id, `💰 <b>Balance:</b> $${balance.toFixed(2)} USDC`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(id, '❌ Failed to fetch balance.');
    }
  });
}

function getHelpText(): string {
  return (
    `🤖 <b>Polymarket BTC Bot — Commands</b>\n\n` +
    `/view — View current configuration\n` +
    `/balance — Check USDC balance\n` +
    `/setsize &lt;USD&gt; — Set order size in USD (e.g. /setsize 5)\n` +
    `/setbuy &lt;price&gt; — Set buy price (e.g. /setbuy 0.3)\n` +
    `/setsell &lt;price&gt; — Set sell price (e.g. /setsell 0.35)\n` +
    `/help — Show this message`
  );
}

export function sendTelegramMessage(message: string): void {
  if (bot && chatId) {
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(err => {
      console.error('[Telegram] Failed to send message:', err.message);
    });
  } else {
    console.log(`[Telegram] ${message}`);
  }
}

export function sendTelegramError(errorMsg: string): void {
  sendTelegramMessage(`❌ <b>ERROR:</b> ${errorMsg}`);
}
