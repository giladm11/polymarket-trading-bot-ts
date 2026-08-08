import TelegramBot from 'node-telegram-bot-api';
import {
  loadConfig, saveConfig,
  setActiveStrategy, updateRsiConfig, setRsiBuyLevel, removeRsiBuyLevel,
} from './config.js';
import type { StrategyName } from './config.js';
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

  // ── General Commands ──

  bot.onText(/^\/view/, (msg) => {
    const id = msg.chat.id.toString();
    const config = loadConfig();

    let text =
      `📋 <b>Configuration</b>\n\n` +
      `🔀 Active Strategy: <b>${config.activeStrategy}</b>\n` +
      `💵 Order Size: <b>$${config.orderSizeUsd}</b>\n`;
      // `🟢 Buy Price: <b>${config.buyPrice}</b>\n` +
      // `🔴 Sell Price: <b>${config.sellPrice}</b>`;

    if (config.activeStrategy === 'rsi') {
      const rsi = config.rsi;
      const levels = rsi.buyLevels.map((l, i) => `  L${i}: ${l}`).join('\n');
      const totalExposure = rsi.buyLevels.length * config.orderSizeUsd;

      text +=
        `\n\n📊 <b>RSI Settings</b>\n` +
        `Symbol: <b>${rsi.symbol}</b>\n` +
        `Interval: <b>${rsi.interval}</b>\n` +
        `Period: <b>${rsi.period}</b>\n` +
        `Overbought: <b>${rsi.overbought}</b>\n` +
        `Oversold: <b>${rsi.oversold}</b>\n` +
        `Max Exposure: <b>$${totalExposure}</b>\n\n` +
        `Buy Prices:\n${levels}`;
    }

    bot.sendMessage(id, text, { parse_mode: 'HTML' });
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

  // ── Strategy Switching ──

  bot.onText(/^\/strategy(?:\s+(\w+))?/, (msg, match) => {
    const id = msg.chat.id.toString();
    const strategy = match?.[1]?.toLowerCase();

    if (!strategy || !['hourly', 'rsi'].includes(strategy)) {
      bot.sendMessage(id,
        '⚠️ Usage: /strategy <name>\n\n' +
        'Available strategies:\n' +
        '  • <b>hourly</b> — Fixed price per hour\n' +
        '  • <b>rsi</b> — RSI-based BTC signals',
        { parse_mode: 'HTML' }
      );
      return;
    }

    setActiveStrategy(strategy as StrategyName);
    bot.sendMessage(id, `✅ Active strategy set to <b>${strategy}</b>`, { parse_mode: 'HTML' });
  });

  // ── RSI Commands ──

  bot.onText(/^\/rsiview/, (msg) => {
    const id = msg.chat.id.toString();
    const config = loadConfig();
    const rsi = config.rsi;
    const levels = rsi.buyLevels.map((l, i) => `  L${i}: ${l}`).join('\n');
    const totalExposure = rsi.buyLevels.length * config.orderSizeUsd;

    bot.sendMessage(id,
      `📊 <b>RSI Strategy Config</b>\n\n` +
      `Symbol: <b>${rsi.symbol}</b>\n` +
      `Interval: <b>${rsi.interval}</b>\n` +
      `Period: <b>${rsi.period}</b>\n` +
      `Overbought: <b>${rsi.overbought}</b>\n` +
      `Oversold: <b>${rsi.oversold}</b>\n` +
      `Max Exposure: <b>$${totalExposure}</b>\n\n` +
      `Buy Prices:\n${levels}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/^\/rsisymbol (\w+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    updateRsiConfig({ symbol: match[1].toUpperCase() });
    bot.sendMessage(id, `✅ RSI symbol set to <b>${match[1].toUpperCase()}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/rsiperiod (\d+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const val = parseInt(match[1]);
    if (isNaN(val) || val < 2) {
      bot.sendMessage(id, '❌ Period must be at least 2.');
      return;
    }
    updateRsiConfig({ period: val });
    bot.sendMessage(id, `✅ RSI period set to <b>${val}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/rsiob ([\d.]+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 50 || val >= 100) {
      bot.sendMessage(id, '❌ Overbought must be between 50 and 100. Usage: /rsiob 83');
      return;
    }
    updateRsiConfig({ overbought: val });
    bot.sendMessage(id, `✅ RSI overbought set to <b>${val}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/rsios ([\d.]+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val <= 0 || val >= 50) {
      bot.sendMessage(id, '❌ Oversold must be between 0 and 50. Usage: /rsios 13');
      return;
    }
    updateRsiConfig({ oversold: val });
    bot.sendMessage(id, `✅ RSI oversold set to <b>${val}</b>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/rsilevel (\d+) ([\d.]+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1] || !match?.[2]) return;
    const index = parseInt(match[1]);
    const price = parseFloat(match[2]);

    if (isNaN(price) || price <= 0 || price >= 1) {
      bot.sendMessage(id, '❌ Price must be between 0 and 1. Usage: /rsilevel 0 0.50');
      return;
    }

    setRsiBuyLevel(index, price);
    bot.sendMessage(id, `✅ RSI buy level ${index}: ${price}`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/rsiremove (\d+)/, (msg, match) => {
    const id = msg.chat.id.toString();
    if (!match?.[1]) return;
    const index = parseInt(match[1]);
    const config = loadConfig();

    if (index < 0 || index >= config.rsi.buyLevels.length) {
      bot.sendMessage(id, `❌ Invalid index. Current levels: 0-${config.rsi.buyLevels.length - 1}`);
      return;
    }

    removeRsiBuyLevel(index);
    const newConfig = loadConfig();
    bot.sendMessage(id, `✅ Removed RSI level ${index}. Remaining: ${newConfig.rsi.buyLevels.length}`, { parse_mode: 'HTML' });
  });
}

function getHelpText(): string {
  return (
    `🤖 <b>Polymarket BTC Bot — Commands</b>\n\n` +
    `<b>General</b>\n` +
    `/view — View current configuration\n` +
    `/balance — Check USDC balance\n` +
    `/setsize &lt;USD&gt; — Set order size per level/side\n` +
    `/setbuy &lt;price&gt; — Set hourly buy price\n` +
    `/setsell &lt;price&gt; — Set hourly sell price\n` +
    `/strategy &lt;name&gt; — Switch strategy (hourly/rsi)\n\n` +
    `<b>RSI Strategy</b>\n` +
    `/rsiview — View RSI config\n` +
    `/rsisymbol &lt;symbol&gt; — Set Binance symbol (e.g. BTCUSDT)\n` +
    `/rsiperiod &lt;n&gt; — Set RSI period\n` +
    `/rsiob &lt;val&gt; — Set overbought threshold\n` +
    `/rsios &lt;val&gt; — Set oversold threshold\n` +
    `/rsilevel &lt;idx&gt; &lt;price&gt; — Add/update buy price\n` +
    `/rsiremove &lt;idx&gt; — Remove a buy level\n\n` +
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
