require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.CHANNEL_ID || '@nichedmemes';

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

// Scrape token data from Solscan website
async function scrapeSolscanData(contractAddress) {
  try {
    console.log(`Scraping Solscan for ${contractAddress}...`);
    const response = await axios.get(`https://solscan.io/token/${contractAddress}`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://solscan.io/'
      }
    });

    const $ = cheerio.load(response.data);

    // Extract data from the page
    const name = $('h1').first().text().trim() || 'Unknown';
    const symbol = $('span.badge').first().text().trim() || 'Unknown';

    // Try to find market cap, price, holders from the page
    let marketCap = null;
    let price = null;
    let holders = null;
    let age = null;

    // Look for data in various elements (Solscan's HTML structure)
    $('div.card').each((i, elem) => {
      const text = $(elem).text();

      if (text.includes('Market Cap')) {
        const mcText = $(elem).find('div').last().text();
        const mcMatch = mcText.match(/\$?[\d,\.]+/);
        if (mcMatch) {
          marketCap = parseFloat(mcMatch[0].replace(/[$,]/g, ''));
        }
      }

      if (text.includes('Price')) {
        const priceText = $(elem).find('div').last().text();
        const priceMatch = priceText.match(/\$?[\d,\.]+/);
        if (priceMatch) {
          price = parseFloat(priceMatch[0].replace(/[$,]/g, ''));
        }
      }

      if (text.includes('Holder')) {
        const holderText = $(elem).find('div').last().text();
        const holderMatch = holderText.match(/[\d,]+/);
        if (holderMatch) {
          holders = parseInt(holderMatch[0].replace(/,/g, ''));
        }
      }
    });

    if (name !== 'Unknown') {
      return {
        name,
        symbol,
        market_cap: marketCap,
        price,
        holder: holders,
        created_time: null // Can't easily scrape this
      };
    }

    return null;
  } catch (error) {
    console.log('Solscan scrape failed:', error.message);
    return null;
  }
}

// Fetch token data from Solscan public API
async function fetchSolscanV2Data(contractAddress) {
  try {
    // Use public Solscan API (no auth required)
    const response = await axios.get(`https://public-api.solscan.io/token/meta`, {
      params: { tokenAddress: contractAddress },
      timeout: 15000
    });

    if (response.data) {
      return response.data;
    }
    return null;
  } catch (error) {
    console.log('Solscan API fetch failed:', error.message);
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

// Get token data with fallback and combine sources
async function getTokenData(contractAddress) {
  // Try DexScreener first (best for images and socials)
  console.log('Trying DexScreener...');
  let dexData = await fetchDexScreenerData(contractAddress);

  // Also try Solscan for age/holders data
  console.log('Trying Solscan API for age/holders...');
  let solscanData = await fetchSolscanV2Data(contractAddress);

  // If we have DexScreener data, combine it with Solscan age/holders
  if (dexData) {
    if (solscanData) {
      // Combine DexScreener with Solscan data
      return {
        source: 'dexscreener',
        data: dexData,
        solscanData: solscanData // Extra data for age/holders
      };
    }
    return { source: 'dexscreener', data: dexData };
  }

  // If DexScreener failed, try Solscan API
  if (solscanData) {
    return { source: 'solscan', data: solscanData };
  }

  // Last resort: try scraping Solscan
  console.log('Trying Solscan scraping...');
  let scrapedData = await scrapeSolscanData(contractAddress);

  if (scrapedData) {
    return { source: 'solscan-scraped', data: scrapedData };
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
  const solscanData = result.solscanData; // Additional Solscan data if available

  let name, symbol, marketCap, holders, age, price, imageUrl, socials;

  if (source === 'solscan' || source === 'solscan-scraped') {
    name = data.name || 'Unknown';
    symbol = data.symbol || 'Unknown';
    marketCap = data.market_cap;
    holders = data.holder;
    age = calculateTokenAge(data.created_time);
    price = data.price;
    imageUrl = null;
    socials = {};
  } else if (source === 'dexscreener') {
    name = data.baseToken?.name || 'Unknown';
    symbol = data.baseToken?.symbol || 'Unknown';
    marketCap = data.marketCap || data.fdv;
    price = data.priceUsd;

    // Get holders and age from Solscan if available
    if (solscanData) {
      holders = solscanData.holder;
      age = calculateTokenAge(solscanData.created_time);
    } else {
      holders = null;
      age = null;
    }

    // Extract image from DexScreener
    imageUrl = data.info?.imageUrl || null;

    // Extract socials from DexScreener
    socials = {};
    if (data.info?.socials) {
      data.info.socials.forEach(social => {
        if (social.type === 'twitter') socials.twitter = social.url;
        if (social.type === 'telegram') socials.telegram = social.url;
        if (social.type === 'website') socials.website = social.url;
        if (social.type === 'tiktok') socials.tiktok = social.url;
      });
    }
    if (data.info?.websites && data.info.websites.length > 0 && !socials.website) {
      socials.website = data.info.websites[0].url;
    }
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

  // Add socials if they exist
  const socialLinks = [];
  if (socials?.website) socialLinks.push(`[Website](${socials.website})`);
  if (socials?.twitter) socialLinks.push(`[Twitter](${socials.twitter})`);
  if (socials?.telegram) socialLinks.push(`[Telegram](${socials.telegram})`);
  if (socials?.tiktok) socialLinks.push(`[TikTok](${socials.tiktok})`);

  if (socialLinks.length > 0) {
    message += `\n🔗 ${socialLinks.join(' • ')}\n`;
  }

  message += `\n📊 [Solscan](https://solscan.io/token/${contractAddress}) • [DexScreener](https://dexscreener.com/solana/${contractAddress})`;

  return { message, imageUrl };
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

// /post command - Fetch and post token data to channel
bot.onText(/\/post (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const contractAddress = match[1].trim();

  // Send initial message to user
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

    const formatted = formatTokenData(tokenData, contractAddress);

    if (!formatted || !formatted.message) {
      await bot.editMessageText(
        `❌ Error formatting token data.`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    // Post to channel
    try {
      if (formatted.imageUrl) {
        // Send with image
        await bot.sendPhoto(channelId, formatted.imageUrl, {
          caption: formatted.message,
          parse_mode: 'Markdown'
        });
      } else {
        // Send text only
        await bot.sendMessage(channelId, formatted.message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        });
      }

      // Notify user of success
      await bot.editMessageText(
        `✅ Posted to channel!\n\n${formatted.message}`,
        {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        }
      );
    } catch (channelError) {
      console.error('Error posting to channel:', channelError);
      await bot.editMessageText(
        `❌ Error posting to channel: ${channelError.message}\n\nMake sure the bot is an admin in the channel!`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
    }

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
        const formatted = formatTokenData(tokenData, ca);

        if (formatted && formatted.message) {
          // Post to channel
          try {
            if (formatted.imageUrl) {
              await bot.sendPhoto(channelId, formatted.imageUrl, {
                caption: formatted.message,
                parse_mode: 'Markdown'
              });
            } else {
              await bot.sendMessage(channelId, formatted.message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: false
              });
            }
            successCount++;
          } catch (postError) {
            console.error(`Error posting ${ca} to channel:`, postError.message);
            failCount++;
          }

          // Add delay between requests to avoid rate limiting
          if (i < contractAddresses.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          failCount++;
        }
      } else {
        failCount++;
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
