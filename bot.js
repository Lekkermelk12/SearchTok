require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const DATA_FILE = path.join(__dirname, 'memecoins.json');

// Load memecoins data from file
async function loadMemecoins() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

// Save memecoins data to file
async function saveMemecoins(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// Get user's memecoins
async function getUserMemecoins(userId) {
  const allData = await loadMemecoins();
  return allData[userId] || [];
}

// Save user's memecoins
async function saveUserMemecoins(userId, memecoins) {
  const allData = await loadMemecoins();
  allData[userId] = memecoins;
  await saveMemecoins(allData);
}

// Fetch token data from Solscan v2 API
async function fetchSolscanV2Data(contractAddress) {
  try {
    const response = await axios.get(`https://pro-api.solscan.io/v2.0/token/meta`, {
      params: { address: contractAddress },
      timeout: 15000
    });

    if (response.data && response.data.success && response.data.data) {
      return response.data.data;
    }
    return null;
  } catch (error) {
    console.log('Solscan v2 fetch failed:', error.message);
    return null;
  }
}

// Fetch token data from DexScreener (fallback)
async function fetchDexScreenerData(contractAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, {
      timeout: 15000
    });

    if (response.data && response.data.pairs && response.data.pairs.length > 0) {
      return response.data.pairs[0];
    }
    return null;
  } catch (error) {
    console.log('DexScreener fetch failed:', error.message);
    return null;
  }
}

// Get token data with fallback
async function getTokenData(contractAddress) {
  // Try Solscan first
  let solscanData = await fetchSolscanV2Data(contractAddress);

  if (solscanData) {
    return { source: 'solscan', data: solscanData };
  }

  // Fallback to DexScreener
  console.log('Trying DexScreener fallback...');
  let dexData = await fetchDexScreenerData(contractAddress);

  if (dexData) {
    return { source: 'dexscreener', data: dexData };
  }

  return null;
}

// Calculate token age from created_time
function calculateTokenAge(createdTime) {
  if (!createdTime) return null;

  const createdDate = new Date(createdTime * 1000); // Unix timestamp to milliseconds
  const now = new Date();
  const ageMs = now - createdDate;

  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const ageMinutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));

  if (ageDays > 0) {
    return `${ageDays}d ${ageHours}h`;
  } else if (ageHours > 0) {
    return `${ageHours}h ${ageMinutes}m`;
  } else {
    return `${ageMinutes}m`;
  }
}

// Format token data for posting
function formatTokenData(result, contractAddress) {
  if (!result || !result.data) return null;

  const source = result.source;
  const data = result.data;

  let name, symbol, marketCap, holders, age, price;

  if (source === 'solscan') {
    name = data.name || 'Unknown';
    symbol = data.symbol || 'Unknown';
    marketCap = data.market_cap;
    holders = data.holder;
    age = calculateTokenAge(data.created_time);
    price = data.price;
  } else if (source === 'dexscreener') {
    name = data.baseToken?.name || 'Unknown';
    symbol = data.baseToken?.symbol || 'Unknown';
    marketCap = data.marketCap || data.fdv;
    price = data.priceUsd;
    // DexScreener doesn't have holders or created_time
    holders = null;
    age = null;
  }

  let message = `🪙 *${name}* ($${symbol})\n\n`;

  if (price) {
    message += `💰 *Price:* $${parseFloat(price).toFixed(8)}\n`;
  }

  if (marketCap) {
    const mcFormatted = marketCap >= 1000000
      ? `$${(marketCap / 1000000).toFixed(2)}M`
      : marketCap >= 1000
      ? `$${(marketCap / 1000).toFixed(2)}K`
      : `$${marketCap.toFixed(2)}`;
    message += `📊 *Market Cap:* ${mcFormatted}\n`;
  }

  if (holders) {
    message += `👥 *Holders:* ${holders.toLocaleString()}\n`;
  }

  if (age) {
    message += `⏰ *Age:* ${age}\n`;
  }

  message += `\n📝 *CA:* \`${contractAddress}\`\n`;
  message += `\n🔗 [Solscan](https://solscan.io/token/${contractAddress}) • [DexScreener](https://dexscreener.com/solana/${contractAddress})`;

  if (source === 'dexscreener') {
    message += `\n\n⚠️ _Data from DexScreener (Solscan unavailable)_`;
  }

  return message;
}

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🚀 Welcome to SearchTok Memecoin Tracker!

Track your favorite TikTok Solana memecoins with these commands:

/post <CA> - Get token data (MC, holders, age, name, ticker)
  Example: /post 8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump

/bulkpost - Process multiple tokens at once
  (Then send CAs, one per line)

/add <symbol> <CA> - Add a memecoin to your tracker
/list - Show your tracked memecoins
/remove <symbol> - Remove from tracker

/help - Show this message
  `;
  bot.sendMessage(chatId, welcomeMessage);
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
📚 *Available Commands:*

*Token Data (Solscan):*
/post <CA> - Get token info
  • Market Cap
  • Holder Count
  • Token Age
  • Name & Ticker
  • Price
  Example: /post 8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump

*Bulk Processing:*
/bulkpost - Process multiple tokens
  1. Send /bulkpost
  2. Paste contract addresses (one per line)
  3. Get data for all tokens

*Tracker Commands:*
/add <symbol> <CA> - Add to your tracker
/list - Show tracked memecoins
/remove <symbol> - Remove from tracker

💡 *Tip:* Use bulk mode for posting 100 coins per day!
  `;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// /add command
bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1].trim().split(/\s+/);

  if (input.length < 2) {
    bot.sendMessage(
      chatId,
      '❌ Invalid format! Use: /add <symbol> <contract_address>\n\nExample: /add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV'
    );
    return;
  }

  const symbol = input[0].toUpperCase();
  const contractAddress = input[1];

  try {
    const memecoins = await getUserMemecoins(userId);

    // Check if symbol already exists
    const existingIndex = memecoins.findIndex(coin => coin.symbol === symbol);
    if (existingIndex !== -1) {
      bot.sendMessage(
        chatId,
        `❌ ${symbol} is already in your list!\n\nUse /remove ${symbol} first if you want to update it.`
      );
      return;
    }

    // Add new memecoin
    memecoins.push({
      symbol,
      contractAddress,
      addedAt: new Date().toISOString()
    });

    await saveUserMemecoins(userId, memecoins);

    bot.sendMessage(
      chatId,
      `✅ Added ${symbol} to your tracker!\n\n💎 Symbol: ${symbol}\n📝 Contract: ${contractAddress}`
    );
  } catch (error) {
    console.error('Error adding memecoin:', error);
    bot.sendMessage(chatId, '❌ An error occurred while adding the memecoin.');
  }
});

// /list command
bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  try {
    const memecoins = await getUserMemecoins(userId);

    if (memecoins.length === 0) {
      bot.sendMessage(
        chatId,
        '📭 Your memecoin list is empty!\n\nUse /add to start tracking memecoins.'
      );
      return;
    }

    let message = '💎 Your Tracked Memecoins:\n\n';
    memecoins.forEach((coin, index) => {
      const date = new Date(coin.addedAt).toLocaleDateString();
      message += `${index + 1}. ${coin.symbol}\n`;
      message += `   📝 ${coin.contractAddress}\n`;
      message += `   📅 Added: ${date}\n\n`;
    });

    bot.sendMessage(chatId, message);
  } catch (error) {
    console.error('Error listing memecoins:', error);
    bot.sendMessage(chatId, '❌ An error occurred while fetching your memecoins.');
  }
});

// /remove command
bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const symbol = match[1].trim().toUpperCase();

  try {
    const memecoins = await getUserMemecoins(userId);
    const index = memecoins.findIndex(coin => coin.symbol === symbol);

    if (index === -1) {
      bot.sendMessage(
        chatId,
        `❌ ${symbol} not found in your list!\n\nUse /list to see your tracked memecoins.`
      );
      return;
    }

    memecoins.splice(index, 1);
    await saveUserMemecoins(userId, memecoins);

    bot.sendMessage(chatId, `✅ Removed ${symbol} from your tracker!`);
  } catch (error) {
    console.error('Error removing memecoin:', error);
    bot.sendMessage(chatId, '❌ An error occurred while removing the memecoin.');
  }
});

// /post command - Fetch and display token data
bot.onText(/\/post (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const contractAddress = match[1].trim();

  // Send initial message
  const loadingMsg = await bot.sendMessage(chatId, '🔍 Fetching token data...');

  try {
    const tokenData = await getTokenData(contractAddress);

    if (!tokenData) {
      await bot.editMessageText(
        `❌ Could not find token data for this address.\n\n` +
        `The token might be too new or not yet indexed.\n\n` +
        `📝 CA: \`${contractAddress}\``,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      );
      return;
    }

    const message = formatTokenData(tokenData, contractAddress);

    if (!message) {
      await bot.editMessageText(
        `❌ Error formatting token data.`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    // Send the formatted message
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });

  } catch (error) {
    console.error('Error in /post command:', error);
    await bot.editMessageText(
      '❌ An error occurred while fetching token data. Please try again later.',
      { chat_id: chatId, message_id: loadingMsg.message_id }
    ).catch(err => console.error('Error editing message:', err));
  }
});

// /bulkpost command - Process multiple contract addresses
bot.onText(/\/bulkpost/, async (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId,
    `📋 *Bulk Post Mode*\n\n` +
    `Send me contract addresses (one per line) and I'll fetch data for all of them.\n\n` +
    `Example:\n` +
    `\`\`\`\n` +
    `8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump\n` +
    `4az7oyuUFco8GedLkWYzopurgadkSz8n64xCEXNYpump\n` +
    `H4EkHReWbjJpqNUiUeYNNZbNKLqLfH8Jt9MkceXGpump\n` +
    `\`\`\`\n\n` +
    `Just paste the addresses in your next message!`,
    { parse_mode: 'Markdown' }
  );
});

// Handler for bulk processing (listens to plain text messages with multiple lines)
bot.on('message', async (msg) => {
  // Skip if it's a command
  if (msg.text && msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  // Check if message contains multiple lines that look like contract addresses
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 30);

  if (lines.length < 2) return; // Need at least 2 addresses for bulk mode

  const contractAddresses = lines.filter(line => {
    // Basic validation: Solana addresses are typically 32-44 characters
    return line.length >= 32 && line.length <= 44 && /^[A-Za-z0-9]+$/.test(line);
  });

  if (contractAddresses.length === 0) return;

  await bot.sendMessage(chatId, `🔄 Processing ${contractAddresses.length} tokens...`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < contractAddresses.length; i++) {
    const ca = contractAddresses[i];

    try {
      const tokenData = await getTokenData(ca);

      if (tokenData) {
        const message = formatTokenData(tokenData, ca);

        if (message) {
          await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
          });
          successCount++;

          // Add delay between requests to avoid rate limiting
          if (i < contractAddresses.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          failCount++;
        }
      } else {
        failCount++;
        await bot.sendMessage(chatId, `❌ Failed to fetch data for: \`${ca}\``, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error(`Error processing ${ca}:`, error.message);
      failCount++;
    }
  }

  await bot.sendMessage(chatId,
    `✅ *Bulk Processing Complete*\n\n` +
    `✔️ Success: ${successCount}\n` +
    `❌ Failed: ${failCount}\n` +
    `📊 Total: ${contractAddresses.length}`,
    { parse_mode: 'Markdown' }
  );
});

console.log('🤖 SearchTok Memecoin Tracker Bot is running...');
