require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const token = process.env.PUBLIC_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL || null;

if (!token) {
  console.error('Error: PUBLIC_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const COINS_FILE = path.join(__dirname, 'channel-coins.json');

// Fetch token metadata from Solscan
async function fetchTokenMetadata(contractAddress) {
  try {
    const response = await axios.get(
      `https://pro-api.solscan.io/v1.0/token/meta?tokenAddress=${contractAddress}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data) {
      return {
        symbol: response.data.symbol || null,
        name: response.data.name || null,
        decimals: response.data.decimals || null,
        icon: response.data.icon || null
      };
    }
  } catch (error) {
    console.log('Solscan API failed, trying alternative method...');
    // Try DexScreener as fallback
    try {
      const dexResponse = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${contractAddress}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );

      if (dexResponse.data?.pairs?.[0]) {
        const pair = dexResponse.data.pairs[0];
        return {
          symbol: pair.baseToken?.symbol || null,
          name: pair.baseToken?.name || null,
          icon: pair.info?.imageUrl || null
        };
      }
    } catch (dexError) {
      console.log('DexScreener fallback also failed');
    }
  }

  return null;
}

// Load coins data from file
async function loadCoins() {
  try {
    const data = await fs.readFile(COINS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Save coins data to file
async function saveCoins(coins) {
  await fs.writeFile(COINS_FILE, JSON.stringify(coins, null, 2));
}

// Parse coin data from channel message
function parseCoinFromMessage(text) {
  try {
    const lines = text.split('\n');
    let symbol = null;
    let name = null;
    let contract = null;
    let price = null;
    let marketCap = null;
    let age = null;
    let postedAt = null;

    for (const line of lines) {
      // Extract symbol and name from first line (e.g., "💎 PENGUIN | Nietzschean Penguin")
      if (line.includes('💎') && line.includes('|')) {
        const match = line.match(/💎\s+([A-Z0-9]+)\s+\|\s+(.+)/);
        if (match) {
          symbol = match[1];
          name = match[2].trim();
        }
      }

      // Extract market cap (format: "📈 Market Cap: $22K" or "Market Cap: $22K")
      if (line.includes('Market Cap:')) {
        const match = line.match(/Market Cap:\s*(.+)/);
        if (match) marketCap = match[1].trim();
      }

      // Extract price
      if (line.includes('Price:')) {
        const match = line.match(/Price:\s+(.+)/);
        if (match) price = match[1].trim();
      }

      // Extract age (format: "🕐 Age: 11 days old" or "🕐 11 days old (Created:...")
      if (line.includes('Age:')) {
        const match = line.match(/Age:\s*(.+)/);
        if (match) age = match[1].trim();
      } else if (line.match(/🕐\s+(.+)\s+\(Created:/)) {
        const match = line.match(/🕐\s+(.+?)\s+\(/);
        if (match) age = match[1].trim();
      }

      // Extract contract address (look for lines that are just contract addresses)
      const trimmed = line.trim();
      // Match contract address in backticks or plain
      if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
        const addr = trimmed.slice(1, -1);
        if (addr.length >= 32 && addr.length <= 44) {
          contract = addr;
        }
      } else if (trimmed.length >= 32 && trimmed.length <= 44 && !line.includes(':') && !line.includes('http') && !line.includes('//')) {
        contract = trimmed;
      }

      // Extract posted time
      if (line.includes('Posted:')) {
        const match = line.match(/Posted:\s+(.+)/);
        if (match) postedAt = match[1].trim();
      }
    }

    // Return coin data if we have at least a contract address
    if (contract) {
      return {
        symbol: symbol || 'UNKNOWN',
        name: name || 'Unknown Token',
        contract,
        price: price || 'N/A',
        marketCap: marketCap || 'N/A',
        marketCapRaw: marketCap ? parseMarketCap(marketCap) : 0,
        age: age || 'Unknown',
        ageRaw: age ? parseAge(age) : 0,
        postedAt: postedAt || new Date().toISOString(),
        addedToDbAt: new Date().toISOString()
      };
    }

    return null;
  } catch (error) {
    console.error('Error parsing coin from message:', error);
    return null;
  }
}

// Convert market cap string to number for sorting
function parseMarketCap(mcStr) {
  if (!mcStr) return 0;
  const match = mcStr.match(/\$?([\d.]+)([KMBT])?/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const suffix = match[2];

  const multipliers = {
    'K': 1000,
    'M': 1000000,
    'B': 1000000000,
    'T': 1000000000000
  };

  return value * (multipliers[suffix] || 1);
}

// Convert age string to minutes for sorting
function parseAge(ageStr) {
  if (!ageStr) return 0;

  const dayMatch = ageStr.match(/(\d+)\s+day/);
  const hourMatch = ageStr.match(/(\d+)\s+hour/);
  const minuteMatch = ageStr.match(/(\d+)\s+minute/);

  let minutes = 0;
  if (dayMatch) minutes += parseInt(dayMatch[1]) * 24 * 60;
  if (hourMatch) minutes += parseInt(hourMatch[1]) * 60;
  if (minuteMatch) minutes += parseInt(minuteMatch[1]);

  return minutes;
}

// Listen to channel messages
bot.on('channel_post', async (msg) => {
  if (msg.chat.username === channelId.replace('@', '')) {
    console.log('New channel post detected');

    const text = msg.text || msg.caption || '';
    const coin = parseCoinFromMessage(text);

    if (coin) {
      console.log('Coin parsed:', coin.symbol);
      const coins = await loadCoins();

      // Check if coin already exists
      const exists = coins.find(c => c.contract === coin.contract);
      if (!exists) {
        // If symbol/name are unknown, try to fetch from Solscan
        if (coin.symbol === 'UNKNOWN' || !coin.symbol) {
          console.log(`Fetching metadata for ${coin.contract}...`);
          const metadata = await fetchTokenMetadata(coin.contract);
          if (metadata && metadata.symbol) {
            coin.symbol = metadata.symbol;
            coin.name = metadata.name || metadata.symbol;
            console.log(`Found token: ${coin.symbol} - ${coin.name}`);
          }
        }

        coins.push(coin);
        await saveCoins(coins);
        console.log(`Added ${coin.symbol} to database`);
      }
    }
  }
});

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📊 Top 100 by Market Cap', callback_data: 'top_marketcap' },
      ],
      [
        { text: '🆕 Top 100 by Age (Newest)', callback_data: 'top_age' }
      ],
      [
        { text: '🔄 Refresh Data', callback_data: 'refresh' }
      ]
    ]
  };

  const welcomeMessage = `
🚀 Welcome to TikTok Memecoin Tracker!

Browse the hottest TikTok-related memecoins on Solana 🔥

📊 Choose what you want to see:
  `;

  bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🏠 Back to Home', callback_data: 'start' }
      ]
    ]
  };

  const helpMessage = `
📚 How to Use This Bot:

🔹 Use the buttons to browse memecoins
🔹 View top 100 by market cap or age
🔹 Copy contract addresses directly
🔹 Stay updated with the latest TikTok memes!

📊 Commands:
/start - Show main menu
/help - Show this help message
  `;

  bot.sendMessage(chatId, helpMessage, { reply_markup: keyboard });
});

// Handle callback queries
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  try {
    if (data === 'start') {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '📊 Top 100 by Market Cap', callback_data: 'top_marketcap' },
          ],
          [
            { text: '🆕 Top 100 by Age (Newest)', callback_data: 'top_age' }
          ],
          [
            { text: '🔄 Refresh Data', callback_data: 'refresh' }
          ]
        ]
      };

      const welcomeMessage = `
🚀 Welcome to TikTok Memecoin Tracker!

Browse the hottest TikTok-related memecoins on Solana 🔥

📊 Choose what you want to see:
      `;

      bot.editMessageText(welcomeMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });

    } else if (data === 'top_marketcap') {
      await showTopByMarketCap(chatId, messageId, 0);

    } else if (data === 'top_age') {
      await showTopByAge(chatId, messageId, 0);

    } else if (data === 'refresh') {
      bot.answerCallbackQuery(query.id, { text: '🔄 Data refreshed!' });

    } else if (data.startsWith('mc_page_')) {
      const page = parseInt(data.split('_')[2]);
      await showTopByMarketCap(chatId, messageId, page);

    } else if (data.startsWith('age_page_')) {
      const page = parseInt(data.split('_')[2]);
      await showTopByAge(chatId, messageId, page);
    }

    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Error handling callback query:', error);
    bot.answerCallbackQuery(query.id, { text: '❌ Error occurred' });
  }
});

// Show top coins by market cap
async function showTopByMarketCap(chatId, messageId, page = 0) {
  const coins = await loadCoins();

  if (coins.length === 0) {
    bot.editMessageText('📭 No coins available yet. Check back soon!', {
      chat_id: chatId,
      message_id: messageId
    });
    return;
  }

  // Sort by market cap (highest first)
  const sorted = coins.sort((a, b) => b.marketCapRaw - a.marketCapRaw);

  // Pagination: 10 per page
  const perPage = 10;
  const start = page * perPage;
  const end = start + perPage;
  const pageCoins = sorted.slice(start, end);
  const totalPages = Math.ceil(sorted.length / perPage);

  let message = `📊 *Top Memecoins by Market Cap* (Page ${page + 1}/${totalPages})\n\n`;

  pageCoins.forEach((coin, index) => {
    const rank = start + index + 1;
    message += `${rank}. *${coin.symbol}* | ${coin.name}\n`;
    message += `   💰 MC: ${coin.marketCap}\n`;
    message += `   📝 \`${coin.contract}\`\n\n`;
  });

  // Pagination buttons
  const buttons = [];
  if (page > 0) {
    buttons.push({ text: '◀️ Previous', callback_data: `mc_page_${page - 1}` });
  }
  if (end < sorted.length) {
    buttons.push({ text: 'Next ▶️', callback_data: `mc_page_${page + 1}` });
  }

  const keyboard = {
    inline_keyboard: [
      buttons.length > 0 ? buttons : [],
      [
        { text: '🏠 Home', callback_data: 'start' },
        { text: '🆕 By Age', callback_data: 'top_age' }
      ]
    ].filter(row => row.length > 0)
  };

  bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// Show top coins by age (newest first)
async function showTopByAge(chatId, messageId, page = 0) {
  const coins = await loadCoins();

  if (coins.length === 0) {
    bot.editMessageText('📭 No coins available yet. Check back soon!', {
      chat_id: chatId,
      message_id: messageId
    });
    return;
  }

  // Sort by age (newest first = lowest age value)
  const sorted = coins.sort((a, b) => a.ageRaw - b.ageRaw);

  // Pagination: 10 per page
  const perPage = 10;
  const start = page * perPage;
  const end = start + perPage;
  const pageCoins = sorted.slice(start, end);
  const totalPages = Math.ceil(sorted.length / perPage);

  let message = `🆕 *Newest TikTok Memecoins* (Page ${page + 1}/${totalPages})\n\n`;

  pageCoins.forEach((coin, index) => {
    const rank = start + index + 1;
    message += `${rank}. *${coin.symbol}* | ${coin.name}\n`;
    message += `   🕐 Age: ${coin.age}\n`;
    message += `   💰 MC: ${coin.marketCap}\n`;
    message += `   📝 \`${coin.contract}\`\n\n`;
  });

  // Pagination buttons
  const buttons = [];
  if (page > 0) {
    buttons.push({ text: '◀️ Previous', callback_data: `age_page_${page - 1}` });
  }
  if (end < sorted.length) {
    buttons.push({ text: 'Next ▶️', callback_data: `age_page_${page + 1}` });
  }

  const keyboard = {
    inline_keyboard: [
      buttons.length > 0 ? buttons : [],
      [
        { text: '🏠 Home', callback_data: 'start' },
        { text: '📊 By Market Cap', callback_data: 'top_marketcap' }
      ]
    ].filter(row => row.length > 0)
  };

  bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

console.log('🤖 Public TikTok Memecoin Tracker Bot is running...');
console.log('📢 Monitoring channel:', channelId);
