require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Public bot token for @nichedbot
const token = '8546188408:AAGqFI28Qqvht6CnXUNwj2W9QoobevRd4OM';
const channelId = '-1003864629972'; // Channel to monitor

const bot = new TelegramBot(token, { polling: true });
const TOKENS_FILE = path.join(__dirname, 'tracked_tokens.json');

// Load tracked tokens from file
async function loadTrackedTokens() {
  try {
    const data = await fs.readFile(TOKENS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Save tracked tokens to file
async function saveTrackedTokens(tokens) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Extract contract address from message
function extractContractAddress(text) {
  // Look for contract address pattern (32-44 alphanumeric characters)
  const caMatch = text.match(/\b([A-Za-z0-9]{32,44})\b/);
  return caMatch ? caMatch[1] : null;
}

// Fetch token data from DexScreener
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
    console.log(`DexScreener fetch failed for ${contractAddress}:`, error.message);
    return null;
  }
}

// Fetch holder count from gmgn.ai
async function fetchGmgnData(contractAddress) {
  try {
    const response = await axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${contractAddress}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.data) {
      return response.data.data;
    }
    return null;
  } catch (error) {
    console.log(`gmgn.ai fetch failed for ${contractAddress}:`, error.message);
    return null;
  }
}

// Get full token data
async function getTokenData(contractAddress) {
  const dexData = await fetchDexScreenerData(contractAddress);
  const gmgnData = await fetchGmgnData(contractAddress);

  if (!dexData && !gmgnData) return null;

  let tokenData = {
    contractAddress,
    name: dexData?.baseToken?.name || gmgnData?.name || 'Unknown',
    symbol: dexData?.baseToken?.symbol || gmgnData?.symbol || 'Unknown',
    marketCap: dexData?.marketCap || dexData?.fdv || gmgnData?.market_cap,
    price: dexData?.priceUsd || gmgnData?.price,
    holders: gmgnData?.holder_count || null,
    imageUrl: dexData?.info?.imageUrl || gmgnData?.logo,
    pairCreatedAt: dexData?.pairCreatedAt,
    createdTimestamp: gmgnData?.creation_timestamp,
    lastUpdated: Date.now()
  };

  return tokenData;
}

// Calculate age in days from timestamp
function getAgeInDays(tokenData) {
  let createdTime;

  if (tokenData.pairCreatedAt) {
    createdTime = new Date(tokenData.pairCreatedAt).getTime();
  } else if (tokenData.createdTimestamp) {
    createdTime = tokenData.createdTimestamp * 1000;
  } else {
    return null;
  }

  const ageMs = Date.now() - createdTime;
  return ageMs / (1000 * 60 * 60 * 24); // Convert to days
}

// Format age for display
function formatAge(tokenData) {
  const ageDays = getAgeInDays(tokenData);
  if (!ageDays) return 'Unknown';

  const days = Math.floor(ageDays);
  const hours = Math.floor((ageDays - days) * 24);
  const minutes = Math.floor(((ageDays - days) * 24 - hours) * 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

// /scan command - Manually add a token to track
bot.onText(/\/scan (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();

  // Check if it's a single address or multiple (bulk scan)
  const addresses = input.split(/[\s\n,]+/).filter(addr => {
    return addr.length >= 32 && addr.length <= 44 && /^[A-Za-z0-9]+$/.test(addr);
  });

  if (addresses.length === 0) {
    bot.sendMessage(chatId, '❌ No valid contract addresses found!', { parse_mode: 'Markdown' });
    return;
  }

  // Single token scan
  if (addresses.length === 1) {
    const contractAddress = addresses[0];
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Scanning token...');

    try {
      const tokens = await loadTrackedTokens();
      const exists = tokens.find(t => t.contractAddress === contractAddress);

      if (exists) {
        await bot.editMessageText(
          `✅ Token already tracked!\n\n*${exists.name}* ($${exists.symbol})`,
          { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
        );
        return;
      }

      const tokenData = await getTokenData(contractAddress);

      if (!tokenData) {
        await bot.editMessageText(
          '❌ Could not fetch token data. Check the contract address and try again.',
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
        return;
      }

      tokens.push(tokenData);
      await saveTrackedTokens(tokens);

      await bot.editMessageText(
        `✅ *Token Added!*\n\n` +
        `*Name:* ${tokenData.name}\n` +
        `*Symbol:* $${tokenData.symbol}\n` +
        `*MC:* $${tokenData.marketCap ? (tokenData.marketCap/1000).toFixed(0)+'K' : 'N/A'}\n\n` +
        `Total tracked: ${tokens.length} tokens`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error scanning token:', error);
      await bot.editMessageText(
        '❌ Error scanning token. Please try again.',
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
    }
    return;
  }

  // Bulk scan multiple tokens
  const loadingMsg = await bot.sendMessage(chatId, `⏳ Scanning ${addresses.length} tokens...\n\nThis may take a while...`);

  try {
    let tokens = await loadTrackedTokens();
    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < addresses.length; i++) {
      const ca = addresses[i];

      // Check if already tracked
      if (tokens.find(t => t.contractAddress === ca)) {
        skipped++;
        continue;
      }

      // Fetch token data
      const tokenData = await getTokenData(ca);

      if (tokenData) {
        tokens.push(tokenData);
        added++;
        console.log(`  [${i+1}/${addresses.length}] Added: ${tokenData.name}`);
      } else {
        failed++;
        console.log(`  [${i+1}/${addresses.length}] Failed: ${ca}`);
      }

      // Update progress every 5 tokens
      if ((i + 1) % 5 === 0 || i === addresses.length - 1) {
        await bot.editMessageText(
          `⏳ Scanning ${addresses.length} tokens...\n\n` +
          `Progress: ${i + 1}/${addresses.length}\n` +
          `✅ Added: ${added}\n` +
          `⏭️ Skipped: ${skipped}\n` +
          `❌ Failed: ${failed}`,
          { chat_id: chatId, message_id: loadingMsg.message_id }
        );
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await saveTrackedTokens(tokens);

    await bot.editMessageText(
      `✅ *Bulk Scan Complete!*\n\n` +
      `📊 Processed: ${addresses.length} addresses\n` +
      `✅ Added: ${added} new tokens\n` +
      `⏭️ Skipped: ${skipped} (already tracked)\n` +
      `❌ Failed: ${failed}\n\n` +
      `Total tracked: ${tokens.length} tokens`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error bulk scanning:', error);
    await bot.editMessageText(
      '❌ Error during bulk scan. Please try again.',
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
  }
});

// Monitor channel for new token posts
bot.on('channel_post', async (msg) => {
  if (msg.chat.id.toString() !== channelId) return;

  const text = msg.text || msg.caption || '';
  const contractAddress = extractContractAddress(text);

  if (!contractAddress) return;

  console.log(`📝 New token detected in channel: ${contractAddress}`);

  // Check if already tracked
  const tokens = await loadTrackedTokens();
  const exists = tokens.find(t => t.contractAddress === contractAddress);

  if (!exists) {
    // Fetch and store token data
    const tokenData = await getTokenData(contractAddress);
    if (tokenData) {
      tokens.push(tokenData);
      await saveTrackedTokens(tokens);
      console.log(`✅ Tracked new token: ${tokenData.name} (${tokenData.symbol})`);
    }
  }
});

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🎯 *Welcome to Niche TikTok Memes Bot!*

Track and rank the hottest TikTok meme coins on Solana.

*Available Commands:*

📊 /rank - View top coins by market cap or age
🔍 /filter - Filter coins by market cap and age ranges
  Example: \`/filter 100k-500k 1d-10d\`
➕ /scan - Add historical tokens (paste multiple CAs)

ℹ️ /help - Show this message

Let's find the next 100x! 🚀
  `;
  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
📚 *Available Commands:*

*Rankings:*
/rank - Show top performing coins
  • Choose top 10, 50, 100, or 250
  • Sort by Market Cap (high→low or low→high)
  • Sort by Age (newest→oldest or oldest→newest)
  • Click "Show Results" button to display

*Filtering:*
/filter <mc_range> <age_range>
  • Market cap range: 100k-500k, 1m-10m, etc.
  • Age range: 1d-10d, 1h-24h, etc.

  Examples:
  \`/filter 100k-500k 1d-10d\` - Coins between $100K-$500K MC, 1-10 days old
  \`/filter 1m-5m 1h-3d\` - Coins between $1M-$5M MC, 1 hour to 3 days old

*Manual Tracking:*
/scan <contract_address> - Add one or more tokens
  Single: \`/scan 6WdHhpRY7vL8SQ69bd89tAj3sk8jsjBrCLDUTZSNpump\`
  Bulk: Paste multiple CAs (space/newline separated)

💡 Tokens are auto-tracked from new channel posts!
💡 Use /scan to add historical tokens in bulk!
  `;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// /rank command - Show inline keyboard
bot.onText(/\/rank/, (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔟 Top 10', callback_data: 'rank_10' },
        { text: '5️⃣0️⃣ Top 50', callback_data: 'rank_50' }
      ],
      [
        { text: '💯 Top 100', callback_data: 'rank_100' },
        { text: '🎯 Top 250', callback_data: 'rank_250' }
      ],
      [
        { text: '📊 Market Cap ⬇️ (High→Low)', callback_data: 'sort_mc_desc' }
      ],
      [
        { text: '📊 Market Cap ⬆️ (Low→High)', callback_data: 'sort_mc_asc' }
      ],
      [
        { text: '⏰ Age (Newest→Oldest)', callback_data: 'sort_age_desc' }
      ],
      [
        { text: '⏰ Age (Oldest→Newest)', callback_data: 'sort_age_asc' }
      ],
      [
        { text: '✅ Show Results', callback_data: 'show_results' }
      ]
    ]
  };

  bot.sendMessage(chatId,
    '📊 *Select Ranking Options:*\n\n' +
    '1️⃣ Choose number of coins (default: Top 10)\n' +
    '2️⃣ Choose sorting method (default: MC High→Low)\n' +
    '3️⃣ Click "Show Results" to display',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }
  );
});

// Store user preferences
const userPreferences = new Map();

// Handle callback queries from inline keyboard
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // Get or create user preferences
  if (!userPreferences.has(userId)) {
    userPreferences.set(userId, { limit: 10, sortBy: 'mc', sortOrder: 'desc' });
  }

  const prefs = userPreferences.get(userId);

  // Handle "Show Results" button
  if (data === 'show_results') {
    await bot.answerCallbackQuery(query.id, { text: 'Loading results...' });
    await showRankings(chatId, query.message.message_id, prefs);
    return;
  }

  // Update preferences based on callback
  if (data.startsWith('rank_')) {
    prefs.limit = parseInt(data.split('_')[1]);
    await bot.answerCallbackQuery(query.id, { text: `Top ${prefs.limit} selected!` });
  } else if (data.startsWith('sort_')) {
    const parts = data.split('_');
    prefs.sortBy = parts[1]; // 'mc' or 'age'
    prefs.sortOrder = parts[2]; // 'asc' or 'desc'

    const sortText = prefs.sortBy === 'mc'
      ? `Market Cap (${prefs.sortOrder === 'desc' ? 'High→Low' : 'Low→High'})`
      : `Age (${prefs.sortOrder === 'desc' ? 'Newest→Oldest' : 'Oldest→Newest'})`;

    await bot.answerCallbackQuery(query.id, { text: `Sorting by ${sortText}` });
  }

  userPreferences.set(userId, prefs);

  // Update the message with current settings
  const currentSettings =
    `✅ *Current Selection:*\n\n` +
    `📊 Showing: Top ${prefs.limit}\n` +
    `🔄 Sort by: ${prefs.sortBy === 'mc' ? 'Market Cap' : 'Age'}\n` +
    `⬆️⬇️ Order: ${prefs.sortOrder === 'desc' ? (prefs.sortBy === 'mc' ? 'High→Low' : 'Newest→Oldest') : (prefs.sortBy === 'mc' ? 'Low→High' : 'Oldest→Newest')}\n\n` +
    `Click "✅ Show Results" to display!`;

  // Keep the keyboard
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔟 Top 10', callback_data: 'rank_10' },
        { text: '5️⃣0️⃣ Top 50', callback_data: 'rank_50' }
      ],
      [
        { text: '💯 Top 100', callback_data: 'rank_100' },
        { text: '🎯 Top 250', callback_data: 'rank_250' }
      ],
      [
        { text: '📊 Market Cap ⬇️ (High→Low)', callback_data: 'sort_mc_desc' }
      ],
      [
        { text: '📊 Market Cap ⬆️ (Low→High)', callback_data: 'sort_mc_asc' }
      ],
      [
        { text: '⏰ Age (Newest→Oldest)', callback_data: 'sort_age_desc' }
      ],
      [
        { text: '⏰ Age (Oldest→Newest)', callback_data: 'sort_age_asc' }
      ],
      [
        { text: '✅ Show Results', callback_data: 'show_results' }
      ]
    ]
  };

  try {
    await bot.editMessageText(currentSettings, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    // Ignore if message is not modified
    if (!error.message.includes('message is not modified')) {
      console.log('Error updating message:', error.message);
    }
  }
});

// Show rankings function
async function showRankings(chatId, originalMessageId, prefs) {
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching latest data from APIs...');

  try {
    // Load and refresh token data
    let tokens = await loadTrackedTokens();

    if (tokens.length === 0) {
      await bot.editMessageText(
        '❌ No tokens tracked yet. Tokens are automatically added when posted to the channel.\n\nTry posting some tokens first!',
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    console.log(`Refreshing data for ${tokens.length} tokens...`);

    // Refresh ALL tokens with fresh data
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      console.log(`  [${i+1}/${tokens.length}] Fetching ${token.contractAddress}...`);
      const fresh = await getTokenData(token.contractAddress);
      if (fresh) {
        Object.assign(token, fresh);
      }
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await saveTrackedTokens(tokens);

    // Filter out tokens without required data
    tokens = tokens.filter(t => {
      if (prefs.sortBy === 'mc') {
        return t.marketCap && t.marketCap > 0;
      } else {
        return getAgeInDays(t) !== null;
      }
    });

    console.log(`Filtered to ${tokens.length} tokens with valid data`);

    // Sort tokens
    tokens.sort((a, b) => {
      if (prefs.sortBy === 'mc') {
        return prefs.sortOrder === 'desc'
          ? (b.marketCap || 0) - (a.marketCap || 0)
          : (a.marketCap || 0) - (b.marketCap || 0);
      } else {
        const ageA = getAgeInDays(a) || 0;
        const ageB = getAgeInDays(b) || 0;
        return prefs.sortOrder === 'desc'
          ? ageA - ageB // Newest first (smaller age value)
          : ageB - ageA; // Oldest first (larger age value)
      }
    });

    // Limit results
    const topTokens = tokens.slice(0, prefs.limit);

    // Format message
    const sortLabel = prefs.sortBy === 'mc'
      ? `Market Cap (${prefs.sortOrder === 'desc' ? 'High→Low' : 'Low→High'})`
      : `Age (${prefs.sortOrder === 'desc' ? 'Newest→Oldest' : 'Oldest→Newest'})`;

    let message = `🏆 *Top ${topTokens.length} TikTok Memes*\n`;
    message += `📊 Sorted by: ${sortLabel}\n`;
    message += `📈 Total tracked: ${tokens.length} tokens\n\n`;

    topTokens.forEach((token, index) => {
      const rank = index + 1;
      const mc = token.marketCap
        ? `$${token.marketCap >= 1000000
          ? (token.marketCap / 1000000).toFixed(2) + 'M'
          : (token.marketCap / 1000).toFixed(2) + 'K'}`
        : 'N/A';
      const age = formatAge(token);
      const holders = token.holders ? token.holders.toLocaleString() : 'N/A';

      message += `${rank}. *${token.name}* ($${token.symbol})\n`;
      message += `   💰 MC: ${mc} | ⏰ ${age} | 👥 ${holders}\n`;
      message += `   📝 \`${token.contractAddress}\`\n\n`;
    });

    message += `\n_Use /rank to change sorting or /filter to filter results_`;

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

  } catch (error) {
    console.error('Error showing rankings:', error);
    await bot.editMessageText(
      '❌ Error fetching rankings. Please try again later.\n\n' + error.message,
      { chat_id: chatId, message_id: loadingMsg.message_id }
    ).catch(err => console.log('Error editing error message'));
  }
}

// Parse size string (e.g., "100k", "5m", "1.5m")
function parseSize(str) {
  const match = str.toLowerCase().match(/^([\d.]+)([km]?)$/);
  if (!match) return null;

  const num = parseFloat(match[1]);
  const unit = match[2];

  if (unit === 'k') return num * 1000;
  if (unit === 'm') return num * 1000000;
  return num;
}

// Parse time string (e.g., "1d", "24h", "30m")
function parseTime(str) {
  const match = str.toLowerCase().match(/^(\d+)([dhm])$/);
  if (!match) return null;

  const num = parseInt(match[1]);
  const unit = match[2];

  if (unit === 'd') return num * 24 * 60 * 60 * 1000; // days to ms
  if (unit === 'h') return num * 60 * 60 * 1000; // hours to ms
  if (unit === 'm') return num * 60 * 1000; // minutes to ms
  return null;
}

// /filter command
bot.onText(/\/filter (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().split(/\s+/);

  if (input.length !== 2) {
    bot.sendMessage(chatId,
      '❌ Invalid format!\n\n' +
      'Usage: `/filter <mc_range> <age_range>`\n\n' +
      'Examples:\n' +
      '• `/filter 100k-500k 1d-10d`\n' +
      '• `/filter 1m-5m 1h-3d`\n' +
      '• `/filter 50k-200k 12h-48h`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const [mcRange, ageRange] = input;

  // Parse market cap range
  const mcParts = mcRange.split('-');
  if (mcParts.length !== 2) {
    bot.sendMessage(chatId, '❌ Invalid market cap range format! Use: 100k-500k');
    return;
  }

  const mcMin = parseSize(mcParts[0]);
  const mcMax = parseSize(mcParts[1]);

  if (!mcMin || !mcMax) {
    bot.sendMessage(chatId, '❌ Invalid market cap values! Use k for thousands, m for millions (e.g., 100k, 5m)');
    return;
  }

  // Parse age range
  const ageParts = ageRange.split('-');
  if (ageParts.length !== 2) {
    bot.sendMessage(chatId, '❌ Invalid age range format! Use: 1d-10d');
    return;
  }

  const ageMin = parseTime(ageParts[0]);
  const ageMax = parseTime(ageParts[1]);

  if (!ageMin || !ageMax) {
    bot.sendMessage(chatId, '❌ Invalid age values! Use d for days, h for hours, m for minutes (e.g., 1d, 24h, 30m)');
    return;
  }

  const loadingMsg = await bot.sendMessage(chatId, '⏳ Filtering tokens...');

  try {
    let tokens = await loadTrackedTokens();

    if (tokens.length === 0) {
      await bot.editMessageText(
        '❌ No tokens tracked yet. Tokens are automatically added when posted to the channel.',
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    // Filter tokens
    const now = Date.now();
    const filtered = tokens.filter(token => {
      const mc = token.marketCap || 0;
      const age = getAgeInDays(token);

      if (!age) return false;

      const ageMs = age * 24 * 60 * 60 * 1000;

      return mc >= mcMin && mc <= mcMax && ageMs >= ageMin && ageMs <= ageMax;
    });

    if (filtered.length === 0) {
      await bot.editMessageText(
        `❌ No tokens found matching your criteria:\n\n` +
        `💰 Market Cap: $${mcMin.toLocaleString()} - $${mcMax.toLocaleString()}\n` +
        `⏰ Age: ${ageParts[0]} - ${ageParts[1]}`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    // Sort by market cap (highest first)
    filtered.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));

    // Format message
    let message = `🔍 *Filter Results* (${filtered.length} tokens)\n\n`;
    message += `💰 MC Range: $${mcMin >= 1000000 ? (mcMin/1000000).toFixed(1)+'M' : (mcMin/1000).toFixed(0)+'K'} - $${mcMax >= 1000000 ? (mcMax/1000000).toFixed(1)+'M' : (mcMax/1000).toFixed(0)+'K'}\n`;
    message += `⏰ Age Range: ${ageParts[0]} - ${ageParts[1]}\n\n`;

    filtered.slice(0, 50).forEach((token, index) => {
      const mc = token.marketCap
        ? `$${token.marketCap >= 1000000
          ? (token.marketCap / 1000000).toFixed(2) + 'M'
          : (token.marketCap / 1000).toFixed(2) + 'K'}`
        : 'N/A';
      const age = formatAge(token);
      const holders = token.holders ? token.holders.toLocaleString() : 'N/A';

      message += `${index + 1}. *${token.name}* ($${token.symbol})\n`;
      message += `   💰 ${mc} | ⏰ ${age} | 👥 ${holders}\n`;
      message += `   📝 \`${token.contractAddress}\`\n\n`;
    });

    if (filtered.length > 50) {
      message += `\n_Showing top 50 of ${filtered.length} results_`;
    }

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error filtering tokens:', error);
    await bot.editMessageText(
      '❌ Error filtering tokens. Please try again later.',
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
  }
});

console.log('🤖 Niche TikTok Memes Bot (@nichedbot) is running...');
console.log('📊 Monitoring channel for new tokens...');
console.log('✅ Bot ready! Users can use /rank, /filter, and /scan commands.');
