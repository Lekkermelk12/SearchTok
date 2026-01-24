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

// Common headers for API requests
const commonHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Fetch token data from gmgn.ai
async function fetchGmgnData(contractAddress) {
  try {
    // Try the common gmgn.ai API endpoint pattern
    const response = await axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${contractAddress}`, {
      timeout: 10000,
      headers: {
        ...commonHeaders,
        'Host': 'gmgn.ai',
        'Referer': 'https://gmgn.ai/'
      }
    });
    return response.data;
  } catch (error) {
    console.log('GMGN fetch failed:', error.message);
    return null;
  }
}

// Fetch token data from Birdeye API
async function fetchBirdeyeData(contractAddress) {
  try {
    const response = await axios.get(`https://public-api.birdeye.so/defi/token_overview`, {
      params: { address: contractAddress },
      headers: {
        ...commonHeaders,
        'X-API-KEY': 'public',
        'Host': 'public-api.birdeye.so'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.log('Birdeye fetch failed:', error.message);
    return null;
  }
}

// Fetch token data from Solscan
async function fetchSolscanData(contractAddress) {
  try {
    const response = await axios.get(`https://api.solscan.io/token/meta`, {
      params: { token: contractAddress },
      headers: {
        ...commonHeaders,
        'Host': 'api.solscan.io'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.log('Solscan fetch failed:', error.message);
    return null;
  }
}

// Fetch token data from DexScreener
async function fetchDexScreenerData(contractAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, {
      headers: {
        ...commonHeaders,
        'Host': 'api.dexscreener.com',
        'Referer': 'https://dexscreener.com/'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.log('DexScreener fetch failed:', error.message);
    return null;
  }
}

// Get comprehensive token data
async function getTokenData(contractAddress) {
  const results = await Promise.allSettled([
    fetchGmgnData(contractAddress),
    fetchBirdeyeData(contractAddress),
    fetchSolscanData(contractAddress),
    fetchDexScreenerData(contractAddress)
  ]);

  const gmgnData = results[0].status === 'fulfilled' ? results[0].value : null;
  const birdeyeData = results[1].status === 'fulfilled' ? results[1].value : null;
  const solscanData = results[2].status === 'fulfilled' ? results[2].value : null;
  const dexScreenerData = results[3].status === 'fulfilled' ? results[3].value : null;

  return {
    gmgn: gmgnData,
    birdeye: birdeyeData,
    solscan: solscanData,
    dexScreener: dexScreenerData
  };
}

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🚀 Welcome to SearchTok Memecoin Tracker!

Track your favorite TikTok Solana memecoins with these commands:

/add <symbol> <contract_address> - Add a memecoin
  Example: /add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV

/list - Show all your tracked memecoins

/remove <symbol> - Remove a memecoin
  Example: /remove BONK

/post <contract_address> - Get detailed token info
  Example: /post 8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump

/help - Show this message
  `;
  bot.sendMessage(chatId, welcomeMessage);
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
📚 Available Commands:

/add <symbol> <contract_address> - Add a memecoin to track
  Example: /add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV

/list - Display all your tracked memecoins

/remove <symbol> - Remove a memecoin from your list
  Example: /remove BONK

/post <contract_address> - Get detailed token information with price, market cap, socials, and image
  Example: /post 8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump

/help - Show this help message
  `;
  bot.sendMessage(chatId, helpMessage);
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
    const { gmgn, birdeye, solscan, dexScreener } = tokenData;

    // Extract data from available sources
    let tokenName = 'Unknown';
    let tokenSymbol = 'Unknown';
    let tokenImage = null;
    let marketCap = null;
    let price = null;
    let volume24h = null;
    let priceChange24h = null;
    let liquidity = null;
    let holders = null;
    let createdAt = null;
    let website = null;
    let twitter = null;
    let telegram = null;

    // Parse DexScreener data (most reliable for new tokens)
    if (dexScreenerData && dexScreenerData.pairs && dexScreenerData.pairs.length > 0) {
      const pair = dexScreenerData.pairs[0];
      tokenName = pair.baseToken?.name || tokenName;
      tokenSymbol = pair.baseToken?.symbol || tokenSymbol;
      tokenImage = pair.info?.imageUrl || pair.baseToken?.logo || tokenImage;
      marketCap = pair.marketCap || pair.fdv;
      price = pair.priceUsd;
      volume24h = pair.volume?.h24;
      priceChange24h = pair.priceChange?.h24;
      liquidity = pair.liquidity?.usd;

      // Social links
      if (pair.info?.websites && pair.info.websites.length > 0) {
        website = pair.info.websites[0].url;
      }
      if (pair.info?.socials) {
        const twitterLink = pair.info.socials.find(s => s.type === 'twitter');
        const telegramLink = pair.info.socials.find(s => s.type === 'telegram');
        twitter = twitterLink?.url;
        telegram = telegramLink?.url;
      }
    }

    // Parse Birdeye data
    if (birdeyeData && birdeyeData.data) {
      const data = birdeyeData.data;
      tokenName = data.name || tokenName;
      tokenSymbol = data.symbol || tokenSymbol;
      tokenImage = data.logoURI || tokenImage;
      marketCap = marketCap || data.mc;
      price = price || data.price;
      volume24h = volume24h || data.v24hUSD;
      liquidity = liquidity || data.liquidity;
    }

    // Parse Solscan data
    if (solscanData && solscanData.data) {
      tokenName = solscanData.data.name || tokenName;
      tokenSymbol = solscanData.data.symbol || tokenSymbol;
      tokenImage = solscanData.data.icon || tokenImage;
      holders = solscanData.data.holder;
    }

    // Parse GMGN data if available
    if (gmgnData && gmgnData.data) {
      const data = gmgnData.data;
      tokenName = data.name || tokenName;
      tokenSymbol = data.symbol || tokenSymbol;
      tokenImage = data.logo || tokenImage;
      marketCap = marketCap || data.market_cap;
      price = price || data.price;
      createdAt = data.created_at;

      // GMGN has social data
      if (data.twitter) twitter = `https://twitter.com/${data.twitter}`;
      if (data.telegram) telegram = data.telegram;
      if (data.website) website = data.website;
    }

    // Check if we have any data
    if (tokenName === 'Unknown' && !price && !marketCap) {
      await bot.editMessageText(
        `❌ Could not find token data for this address.\n\n` +
        `Tried:\n• DexScreener API\n• Birdeye API\n• Solscan API\n• GMGN.ai\n\n` +
        `The token might be too new or not yet indexed.`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    // Format the message
    let message = `🪙 *${tokenName}* (${tokenSymbol})\n\n`;

    if (price) {
      message += `💰 *Price:* $${parseFloat(price).toFixed(8)}\n`;
    }

    if (marketCap) {
      const mcFormatted = marketCap >= 1000000
        ? `$${(marketCap / 1000000).toFixed(2)}M`
        : `$${marketCap.toLocaleString()}`;
      message += `📊 *Market Cap:* ${mcFormatted}\n`;
    }

    if (volume24h) {
      const volFormatted = volume24h >= 1000000
        ? `$${(volume24h / 1000000).toFixed(2)}M`
        : `$${volume24h.toLocaleString()}`;
      message += `📈 *24h Volume:* ${volFormatted}\n`;
    }

    if (priceChange24h) {
      const changeEmoji = priceChange24h >= 0 ? '📈' : '📉';
      message += `${changeEmoji} *24h Change:* ${priceChange24h > 0 ? '+' : ''}${priceChange24h.toFixed(2)}%\n`;
    }

    if (liquidity) {
      const liqFormatted = liquidity >= 1000000
        ? `$${(liquidity / 1000000).toFixed(2)}M`
        : `$${liquidity.toLocaleString()}`;
      message += `💧 *Liquidity:* ${liqFormatted}\n`;
    }

    if (holders) {
      message += `👥 *Holders:* ${holders.toLocaleString()}\n`;
    }

    if (createdAt) {
      const createdDate = new Date(createdAt);
      const now = new Date();
      const ageMs = now - createdDate;
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
      const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

      if (ageDays > 0) {
        message += `⏰ *Age:* ${ageDays}d ${ageHours}h\n`;
      } else {
        message += `⏰ *Age:* ${ageHours}h\n`;
      }
    }

    message += `\n📝 *Contract:* \`${contractAddress}\`\n`;

    // Add social links
    const socials = [];
    if (website) socials.push(`[Website](${website})`);
    if (twitter) socials.push(`[Twitter](${twitter})`);
    if (telegram) socials.push(`[Telegram](${telegram})`);

    if (socials.length > 0) {
      message += `\n🔗 *Socials:* ${socials.join(' • ')}\n`;
    }

    // Send the message with image if available
    if (tokenImage) {
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        await bot.sendPhoto(chatId, tokenImage, {
          caption: message,
          parse_mode: 'Markdown'
        });
      } catch (imageError) {
        console.error('Error sending image:', imageError);
        // Fall back to text only
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'Markdown'
        });
      }
    } else {
      // Send text only
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown'
      });
    }

  } catch (error) {
    console.error('Error in /post command:', error);
    await bot.editMessageText(
      '❌ An error occurred while fetching token data. Please try again later.',
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
  }
});

console.log('🤖 SearchTok Memecoin Tracker Bot is running...');
