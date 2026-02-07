require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const WebSocket = require('ws');

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.CHANNEL_ID || '-1003864629972';

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

console.log('✅ Bot initialized - Hybrid scanner: WebSocket (new tokens) + Polling (existing tokens)');

const bot = new TelegramBot(token, { polling: true });
const DATA_FILE = path.join(__dirname, 'memecoins.json');
const TOKENS_FILE = path.join(__dirname, 'tracked_tokens.json');
const POSTED_TOKENS_FILE = path.join(__dirname, 'posted_tokens.json');

// Auto-scanner configuration
const SCANNER_CONFIG = {
  MIN_MARKET_CAP: 12000,      // $12K minimum (Solscan filters this in Stage 1)
  MAX_MARKET_CAP: 250000,     // $250K maximum (Solscan filters this in Stage 1)
  MIN_AGE_HOURS: 0,           // Minimum age (0 = no minimum, Solscan filters 1 day max)
  MAX_AGE_DAYS: 1,            // Max 1 day old (hardcoded in Stage 1 Solscan filter)
  SCAN_INTERVAL: 30 * 60 * 1000, // Polling: Check existing tokens every 30 minutes
  REQUIRE_TIKTOK: true,       // Must have TikTok link (GMGN.ai checks in Stage 2)
  TOKENS_PER_SCAN: 100,       // Fetch 100 tokens from DexScreener per scan
  TOKEN_MATURITY_DELAY: 15 * 60 * 1000 // WebSocket: Wait 15 min for new tokens to mature
};

// Real-time market data cache
let LIVE_DATA = {
  solPrice: null,
  bondingThreshold: null,
  lastUpdate: null
};

// Fetch real-time SOL price from multiple sources
async function fetchLiveSOLPrice() {
  try {
    // Try Jupiter price API first (more reliable for crypto prices)
    try {
      const jupiterResponse = await axios.get('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (jupiterResponse.data?.data?.So11111111111111111111111111111111111111112?.price) {
        return jupiterResponse.data.data.So11111111111111111111111111111111111111112.price;
      }
    } catch (jupErr) {
      // Try fallback
    }

    // Fallback: Try CoinGecko (free tier)
    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'solana',
          vs_currencies: 'usd'
        },
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (response.data?.solana?.usd) {
        return response.data.solana.usd;
      }
    } catch (cgErr) {
      // Continue to manual fallback
    }

    // If all APIs fail, use approximate price (update manually or use last known)
    console.log(`   ⚠️  API price fetch failed, using estimated SOL price`);
    return LIVE_DATA.solPrice || 110; // Use cached price or default estimate
  } catch (error) {
    console.log(`   Failed to fetch SOL price: ${error.message}`);
    return LIVE_DATA.solPrice || 110; // Fallback to approximate current price
  }
}

// Fetch pump.fun bonding curve data
async function fetchBondingCurveData() {
  try {
    // Pump.fun bonding curve requires 85 SOL to graduate
    // This is hardcoded in their smart contract
    const BONDING_CURVE_SOL = 85;

    // Get current SOL price
    const solPrice = await fetchLiveSOLPrice();

    if (solPrice) {
      const graduationMC = BONDING_CURVE_SOL * solPrice;
      LIVE_DATA.solPrice = solPrice;
      LIVE_DATA.bondingThreshold = graduationMC;
      LIVE_DATA.lastUpdate = new Date().toISOString();

      return { solPrice, graduationMC };
    }

    return null;
  } catch (error) {
    console.log(`   Failed to fetch bonding curve data: ${error.message}`);
    return null;
  }
}

// Update live market data (call every 5 minutes)
async function updateLiveMarketData() {
  // Only update if we don't have recent data (within 5 min)
  if (LIVE_DATA.lastUpdate) {
    const timeSinceUpdate = Date.now() - new Date(LIVE_DATA.lastUpdate).getTime();
    if (timeSinceUpdate < 5 * 60 * 1000) {
      return; // Skip if updated within last 5 minutes
    }
  }

  await fetchBondingCurveData();
}

// Auto-scanner state
let scannerInterval = null;
let scannerRunning = false;

// WebSocket state
let ws = null;
let wsReconnectTimeout = null;
let tokenQueue = new Map(); // Track tokens waiting to mature: mint -> { timestamp, timeoutId }

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

// Load tracked tokens (for public bot integration)
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

// Save tracked tokens (for public bot integration)
async function saveTrackedTokens(tokens) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Add token to tracked list
async function addToTrackedTokens(contractAddress, tokenData) {
  const tokens = await loadTrackedTokens();

  // Check if already tracked
  const exists = tokens.find(t => t.contractAddress === contractAddress);
  if (exists) return;

  // Add new token with relevant data
  tokens.push({
    contractAddress,
    name: tokenData.name || 'Unknown',
    symbol: tokenData.symbol || 'Unknown',
    marketCap: tokenData.marketCap,
    price: tokenData.price,
    holders: tokenData.holders,
    imageUrl: tokenData.imageUrl,
    pairCreatedAt: tokenData.pairCreatedAt,
    createdTimestamp: tokenData.createdTimestamp,
    lastUpdated: Date.now()
  });

  await saveTrackedTokens(tokens);
  console.log(`✅ Added to tracked tokens: ${tokenData.name}`);
}

// Load posted tokens (to prevent duplicates)
async function loadPostedTokens() {
  try {
    const data = await fs.readFile(POSTED_TOKENS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Save posted tokens
async function savePostedTokens(tokens) {
  await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Check if token was already posted
async function isTokenPosted(contractAddress) {
  const posted = await loadPostedTokens();
  return posted.includes(contractAddress);
}

// Mark token as posted
async function markTokenAsPosted(contractAddress) {
  const posted = await loadPostedTokens();
  if (!posted.includes(contractAddress)) {
    posted.push(contractAddress);
    await savePostedTokens(posted);
  }
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
      console.log('📊 Solscan response:', JSON.stringify(response.data, null, 2));
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
      const pair = response.data.pairs[0];
      // Log all available fields to find holder count
      console.log('📊 Available DexScreener fields:', Object.keys(pair));
      if (pair.info) {
        console.log('📊 Info fields:', Object.keys(pair.info));
      }
      return pair;
    }
    return null;
  } catch (error) {
    console.log('DexScreener fetch failed:', error.message);
    return null;
  }
}

// Fetch full token data from gmgn.ai
async function fetchGmgnFullData(contractAddress) {
  try {
    const response = await axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${contractAddress}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.data) {
      console.log('📊 gmgn.ai full data received');
      return response.data.data;
    }
    return null;
  } catch (error) {
    console.log('gmgn.ai fetch failed:', error.message);
    return null;
  }
}

// Fetch token data from pump.fun API (official source for socials)
async function fetchPumpFunData(contractAddress) {
  try {
    const response = await axios.get(`https://frontend-api-v3.pump.fun/coins/${contractAddress}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://pump.fun/'
      }
    });

    if (response.data) {
      console.log('🎯 pump.fun data received');
      return response.data;
    }
    return null;
  } catch (error) {
    console.log('pump.fun fetch failed:', error.message);
    return null;
  }
}

// Get token data with fallback and combine sources
async function getTokenData(contractAddress) {
  // Try DexScreener first (best for images and socials)
  console.log('Trying DexScreener...');
  let dexData = await fetchDexScreenerData(contractAddress);

  // Also try gmgn.ai for full data
  console.log('Trying gmgn.ai for holder count and fallback...');
  let gmgnData = await fetchGmgnFullData(contractAddress);

  // Check if DexScreener has socials or images
  let hasSocials = dexData?.info?.socials && dexData.info.socials.length > 0;
  let hasImage = dexData?.info?.imageUrl;

  // If DexScreener has data but no socials or images, use gmgn.ai as fallback
  if (dexData && (!hasSocials && !hasImage) && gmgnData) {
    console.log('📊 DexScreener has no socials/images, using gmgn.ai fallback');
    return {
      source: 'gmgn',
      data: gmgnData,
      dexData: dexData // Keep DexScreener data for price/MC
    };
  }

  // Return DexScreener data if available
  if (dexData) {
    return {
      source: 'dexscreener',
      data: dexData,
      gmgnData: gmgnData // Include gmgn data for holder count
    };
  }

  // If DexScreener failed but gmgn.ai has data, use gmgn.ai
  if (gmgnData) {
    console.log('📊 DexScreener failed, using gmgn.ai');
    return {
      source: 'gmgn',
      data: gmgnData
    };
  }

  // Fallback: try scraping Solscan
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
  const gmgnData = result.gmgnData; // gmgn.ai data for holder count
  const dexData = result.dexData; // DexScreener data when gmgn is primary

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
  } else if (source === 'gmgn') {
    // Using gmgn.ai as primary data source
    name = data.name || 'Unknown';
    symbol = data.symbol || 'Unknown';
    marketCap = data.market_cap || data.fdv;
    price = data.price;
    holders = data.holder_count;

    // Get age from gmgn.ai creation_timestamp (Unix timestamp in seconds)
    if (data.creation_timestamp) {
      age = calculateTokenAge(data.creation_timestamp);
    } else {
      age = null;
    }

    // Get image from gmgn.ai
    imageUrl = data.logo || null;

    // Extract socials from gmgn.ai
    socials = {};
    if (data.twitter) socials.twitter = data.twitter;
    if (data.telegram) socials.telegram = data.telegram;
    if (data.website) {
      // Smart TikTok detection for website field
      if (data.website.includes('tiktok.com')) {
        socials.tiktok = data.website;
      } else {
        socials.website = data.website;
      }
    }

    // If we have DexScreener data too, prefer its price/MC if available
    if (dexData) {
      price = dexData.priceUsd || price;
      marketCap = dexData.marketCap || dexData.fdv || marketCap;
    }
  } else if (source === 'dexscreener') {
    name = data.baseToken?.name || 'Unknown';
    symbol = data.baseToken?.symbol || 'Unknown';
    marketCap = data.marketCap || data.fdv;
    price = data.priceUsd;

    // Get age from DexScreener's pairCreatedAt (Unix timestamp in milliseconds)
    if (data.pairCreatedAt) {
      const createdDate = new Date(data.pairCreatedAt);
      const now = new Date();
      const ageMs = now - createdDate;

      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
      const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const ageMinutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));

      if (ageDays > 0) {
        age = `${ageDays}d ${ageHours}h`;
      } else if (ageHours > 0) {
        age = `${ageHours}h ${ageMinutes}m`;
      } else {
        age = `${ageMinutes}m`;
      }
    } else {
      age = null;
    }

    // Use holder count from gmgn.ai if available
    holders = gmgnData?.holder_count || null;

    // Extract image from DexScreener
    imageUrl = data.info?.imageUrl || null;

    // Extract socials from DexScreener
    socials = {};
    if (data.info?.socials) {
      data.info.socials.forEach(social => {
        // Smart TikTok detection - check if URL contains tiktok.com
        if (social.url && social.url.includes('tiktok.com')) {
          socials.tiktok = social.url;
        } else if (social.type === 'twitter') {
          socials.twitter = social.url;
        } else if (social.type === 'telegram') {
          socials.telegram = social.url;
        } else if (social.type === 'website') {
          socials.website = social.url;
        } else if (social.type === 'tiktok') {
          socials.tiktok = social.url;
        }
      });
    }
    if (data.info?.websites && data.info.websites.length > 0 && !socials.website) {
      // Check if website is actually a TikTok link
      const websiteUrl = data.info.websites[0].url;
      if (websiteUrl && websiteUrl.includes('tiktok.com')) {
        socials.tiktok = websiteUrl;
      } else {
        socials.website = websiteUrl;
      }
    }
  }

  // Override socials with pump.fun data if available (most accurate source)
  const pumpData = result.pumpData;
  if (pumpData) {
    console.log('🎯 Using pump.fun socials data');

    // Extract image from pump.fun if not already set
    if (!imageUrl && pumpData.image_uri) {
      imageUrl = pumpData.image_uri;
    }

    // Override socials with pump.fun data
    if (pumpData.twitter) socials.twitter = pumpData.twitter;
    if (pumpData.telegram) socials.telegram = pumpData.telegram;

    // Check website field for TikTok
    if (pumpData.website) {
      if (pumpData.website.includes('tiktok.com')) {
        socials.tiktok = pumpData.website;
      } else {
        socials.website = pumpData.website;
      }
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

  // Add text socials if they exist (keeping for backwards compatibility)
  const socialLinks = [];
  if (socials?.website) socialLinks.push(`[Website](${socials.website})`);
  if (socials?.twitter) socialLinks.push(`[Twitter](${socials.twitter})`);
  if (socials?.telegram) socialLinks.push(`[Telegram](${socials.telegram})`);

  if (socialLinks.length > 0) {
    message += `\n🔗 ${socialLinks.join(' • ')}\n`;
  }

  message += `\n📊 [Solscan](https://solscan.io/token/${contractAddress}) • [DexScreener](https://dexscreener.com/solana/${contractAddress})`;

  // Add Bloom referral link
  message += `\n\n🌸 [Trade on Bloom](https://t.me/BloomSolana_bot?start=ref_cardboardg_${contractAddress})`;

  // If no TikTok link, create a search link
  if (!socials?.tiktok && name !== 'Unknown') {
    const encodedName = encodeURIComponent(name);
    socials.tiktok = `https://www.tiktok.com/search/video?q=${encodedName}&t=1769361824988`;
  }

  return { message, imageUrl, socials, name, symbol, marketCap, price, holders };
}

// ============= AUTO-SCANNER FUNCTIONS =============

// Check GMGN.ai for TikTok links (Stage 2)
async function checkGMGNForTikTok(contractAddress) {
  try {
    const response = await axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${contractAddress}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.data) {
      const tokenData = response.data.data;

      // Check for TikTok in various social fields
      const socials = tokenData.socials || {};
      const twitter = socials.twitter || '';
      const telegram = socials.telegram || '';
      const website = socials.website || '';
      const discord = socials.discord || '';

      const hasTikTok =
        twitter.includes('tiktok.com') ||
        telegram.includes('tiktok.com') ||
        website.includes('tiktok.com') ||
        discord.includes('tiktok.com');

      return {
        hasTikTok,
        socials: {
          twitter: socials.twitter || null,
          telegram: socials.telegram || null,
          website: socials.website || null
        }
      };
    }

    return { hasTikTok: false, socials: {} };
  } catch (error) {
    // Silently fail for gmgn checks (token might not be indexed yet)
    return { hasTikTok: false, socials: {} };
  }
}

// STAGE 1: Fetch tokens using DexScreener (real-time market data)
async function fetchPumpFunTokens() {
  try {
    console.log(`   📡 STAGE 1: Fetching pump.fun tokens from DexScreener...`);

    // Use DexScreener to search for pump.fun tokens directly
    // This gives us both token data AND market cap in one call
    const response = await axios.get('https://api.dexscreener.com/latest/dex/search', {
      params: {
        q: 'pump.fun'
      },
      timeout: 15000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.data || !Array.isArray(response.data.pairs)) {
      console.log('   ❌ Unexpected API response format');
      return [];
    }

    const allPairs = response.data.pairs || [];
    console.log(`   ✅ Fetched ${allPairs.length} pairs from DexScreener`);

    // Filter for actual pump.fun tokens
    const pumpFunPairs = allPairs.filter(pair => {
      const dexId = (pair.dexId || '').toLowerCase();
      const url = (pair.url || '').toLowerCase();
      const chainId = (pair.chainId || '').toLowerCase();

      // Must be on Solana and related to pump.fun
      return chainId === 'solana' && (
        dexId.includes('pump') ||
        url.includes('pump.fun') ||
        dexId === 'raydium' // pump.fun tokens that graduated to Raydium
      );
    });

    console.log(`   ✅ Found ${pumpFunPairs.length} pump.fun-related pairs`);

    // DEBUG: Show first 3 pairs
    console.log(`\n🔍 DEBUG: Showing first 3 pairs:`);
    for (let i = 0; i < Math.min(3, pumpFunPairs.length); i++) {
      const pair = pumpFunPairs[i];
      const createdTime = pair.pairCreatedAt || 0;
      const marketCap = pair.fdv || pair.marketCap || 0;
      const ageHours = (Date.now() - createdTime) / (1000 * 60 * 60);
      console.log(`   [${i + 1}] ${pair.baseToken?.symbol || '???'}`);
      console.log(`       MC: $${marketCap.toLocaleString()}`);
      console.log(`       Age: ${ageHours > 24 ? (ageHours / 24).toFixed(1) + ' days' : ageHours.toFixed(1) + ' hours'}`);
      console.log(`       DEX: ${pair.dexId}`);
    }
    console.log('');

    // Filter by age and MC
    const now = Date.now();
    const oneDayAgo = now - (SCANNER_CONFIG.MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

    const filtered = pumpFunPairs.filter(pair => {
      const createdTime = pair.pairCreatedAt || 0;
      const marketCap = pair.fdv || pair.marketCap || 0;

      // Age filter
      if (createdTime && createdTime < oneDayAgo) return false;

      // MC filter
      if (marketCap < SCANNER_CONFIG.MIN_MARKET_CAP || marketCap > SCANNER_CONFIG.MAX_MARKET_CAP) {
        return false;
      }

      return true;
    });

    console.log(`   ✅ Filtered to ${filtered.length} tokens (${SCANNER_CONFIG.MAX_AGE_DAYS} day old, $${SCANNER_CONFIG.MIN_MARKET_CAP.toLocaleString()}-$${SCANNER_CONFIG.MAX_MARKET_CAP.toLocaleString()} MC)`);

    // Convert to standard format
    const convertedTokens = filtered.map(pair => ({
      mint: pair.baseToken?.address || pair.tokenAddress,
      name: pair.baseToken?.name || 'Unknown',
      symbol: pair.baseToken?.symbol || '???',
      market_cap: pair.fdv || pair.marketCap || 0,
      usd_market_cap: pair.fdv || pair.marketCap || 0,
      created_timestamp: pair.pairCreatedAt || now,
      decimals: 9,
      holder: 0,
      twitter: pair.info?.socials?.find(s => s.type === 'twitter')?.url || null,
      telegram: pair.info?.socials?.find(s => s.type === 'telegram')?.url || null,
      website: pair.info?.websites?.[0] || null,
      image_uri: pair.info?.imageUrl || null
    }));

    // STAGE 2: Check each token on GMGN.ai for TikTok links
    console.log(`   🔍 STAGE 2: Checking GMGN.ai for TikTok links...`);

    const tokensWithTikTok = [];
    for (let i = 0; i < convertedTokens.length; i++) {
      const token = convertedTokens[i];

      const gmgnData = await checkGMGNForTikTok(token.mint);

      if (gmgnData.hasTikTok) {
        // Add social data from GMGN
        token.twitter = gmgnData.socials.twitter;
        token.telegram = gmgnData.socials.telegram;
        token.website = gmgnData.socials.website;
        tokensWithTikTok.push(token);
        console.log(`   ✅ [${i + 1}/${convertedTokens.length}] ${token.symbol} - HAS TikTok link`);
      } else {
        console.log(`   ⏭️  [${i + 1}/${convertedTokens.length}] ${token.symbol} - No TikTok`);
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`   🎯 Found ${tokensWithTikTok.length} tokens with TikTok links!`);
    return tokensWithTikTok;

  } catch (error) {
    console.log('❌ Error fetching pump.fun tokens from DexScreener:', error.message);
    if (error.response) {
      console.log(`   HTTP Status: ${error.response.status}`);
      console.log(`   Response: ${JSON.stringify(error.response.data).substring(0, 300)}`);
    }
    return [];
  }
}

// ============= WEBSOCKET FUNCTIONS (PumpPortal Real-Time) =============

// Connect to PumpPortal WebSocket for real-time token events
function connectWebSocket() {
  console.log('🔌 Connecting to PumpPortal WebSocket...');

  ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    console.log('✅ Connected to PumpPortal WebSocket');

    // Subscribe to new token creation events
    const subscribeMessage = {
      method: 'subscribeNewToken'
    };
    ws.send(JSON.stringify(subscribeMessage));
    console.log('📡 Subscribed to new token creation events');
    console.log(`⏱️  Token maturity delay: ${SCANNER_CONFIG.TOKEN_MATURITY_DELAY / 60000} minutes`);
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Handle new token creation event
      if (message && message.mint) {
        await queueTokenForProcessing(message);
      }
    } catch (error) {
      console.log('Error parsing WebSocket message:', error.message);
    }
  });

  ws.on('error', (error) => {
    console.log('❌ WebSocket error:', error.message);
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket disconnected');

    // Auto-reconnect if scanner is still running
    if (scannerRunning) {
      console.log('🔄 Reconnecting in 5 seconds...');
      wsReconnectTimeout = setTimeout(() => {
        connectWebSocket();
      }, 5000);
    }
  });
}

// Disconnect WebSocket
function disconnectWebSocket() {
  console.log('🔌 Disconnecting WebSocket...');

  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }

  // Clear all pending token timeouts
  for (const [mint, queuedToken] of tokenQueue.entries()) {
    if (queuedToken.timeoutId) {
      clearTimeout(queuedToken.timeoutId);
    }
  }
  tokenQueue.clear();

  if (ws) {
    ws.close();
    ws = null;
  }

  console.log('✅ WebSocket disconnected and queue cleared');
}

// Queue a new token for processing after maturity delay
async function queueTokenForProcessing(tokenData) {
  try {
    const mint = tokenData.mint;

    if (!mint) {
      return;
    }

    // Skip if already posted
    if (await isTokenPosted(mint)) {
      return;
    }

    // Skip if already queued
    if (tokenQueue.has(mint)) {
      return;
    }

    console.log(`\n🆕 New token detected: ${tokenData.name || 'Unknown'} ($${tokenData.symbol || '???'})`);
    console.log(`   Mint: ${mint}`);
    console.log(`   ⏳ Queued for processing in ${SCANNER_CONFIG.TOKEN_MATURITY_DELAY / 60000} minutes`);

    // Schedule token for processing after maturity delay
    const timeoutId = setTimeout(async () => {
      await processQueuedToken(mint, tokenData);
      tokenQueue.delete(mint);
    }, SCANNER_CONFIG.TOKEN_MATURITY_DELAY);

    // Add to queue
    tokenQueue.set(mint, {
      timestamp: Date.now(),
      timeoutId: timeoutId,
      tokenData: tokenData
    });

  } catch (error) {
    console.log(`  ❌ Error queuing token: ${error.message}`);
  }
}

// Process a queued token after maturity delay
async function processQueuedToken(mint, initialTokenData) {
  try {
    console.log(`\n🔍 Processing matured token: ${initialTokenData.name || 'Unknown'} ($${initialTokenData.symbol || '???'})`);
    console.log(`   Mint: ${mint}`);

    // Skip if already posted (check again in case it was posted manually)
    if (await isTokenPosted(mint)) {
      console.log('   ⏭️  Already posted, skipping');
      return;
    }

    // Fetch fresh data from DexScreener for market cap
    console.log('   📡 Fetching current market data from DexScreener...');
    const dexData = await fetchDexScreenerData(mint);

    if (!dexData) {
      console.log('   ❌ Could not fetch DexScreener data');
      return;
    }

    const marketCap = dexData.market_cap || dexData.usd_market_cap || 0;
    console.log(`   💰 Current MC: $${marketCap.toLocaleString()}`);

    // Check market cap criteria
    if (marketCap < SCANNER_CONFIG.MIN_MARKET_CAP) {
      console.log(`   ⏭️  Skipped: MC too low ($${marketCap.toFixed(0)} < $${SCANNER_CONFIG.MIN_MARKET_CAP})`);
      return;
    }

    if (marketCap > SCANNER_CONFIG.MAX_MARKET_CAP) {
      console.log(`   ⏭️  Skipped: MC too high ($${marketCap.toFixed(0)} > $${SCANNER_CONFIG.MAX_MARKET_CAP})`);
      return;
    }

    // Check for TikTok link if required
    if (SCANNER_CONFIG.REQUIRE_TIKTOK) {
      console.log('   🔍 Checking GMGN.ai for TikTok link...');
      const gmgnData = await checkGMGNForTikTok(mint);

      if (!gmgnData.hasTikTok) {
        console.log('   ⏭️  Skipped: No TikTok link found');
        return;
      }

      console.log('   ✅ TikTok link found!');
    }

    // Token qualifies! Auto-post it
    console.log('   ✅ Token meets all criteria, posting...');
    const success = await autoPostToken(mint);

    if (success) {
      console.log('   ✅ Successfully auto-posted!');
    } else {
      console.log('   ❌ Failed to auto-post');
    }

  } catch (error) {
    console.log(`   ❌ Error processing queued token: ${error.message}`);
  }
}

// Check if token meets auto-post criteria (pump.fun data)
async function meetsAutoPostCriteria(tokenData) {
  // Get market cap from pump.fun data
  const marketCap = tokenData.market_cap || tokenData.usd_market_cap || 0;
  if (marketCap < SCANNER_CONFIG.MIN_MARKET_CAP) {
    return { pass: false, reason: `MC too low: $${marketCap.toFixed(0)}` };
  }

  // Check age using created_timestamp
  if (tokenData.created_timestamp) {
    const createdDate = new Date(tokenData.created_timestamp);
    const ageMs = Date.now() - createdDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const ageDays = ageHours / 24;

    if (ageHours < SCANNER_CONFIG.MIN_AGE_HOURS) {
      return { pass: false, reason: `Too new: ${ageHours.toFixed(1)}h` };
    }

    if (ageDays > SCANNER_CONFIG.MAX_AGE_DAYS) {
      return { pass: false, reason: `Too old: ${ageDays.toFixed(1)}d` };
    }
  }

  // Check for TikTok link if required
  if (SCANNER_CONFIG.REQUIRE_TIKTOK) {
    let hasTikTok = false;

    // Check twitter, telegram, and website fields for TikTok links
    if (tokenData.twitter && tokenData.twitter.includes('tiktok.com')) {
      hasTikTok = true;
    }
    if (tokenData.telegram && tokenData.telegram.includes('tiktok.com')) {
      hasTikTok = true;
    }
    if (tokenData.website && tokenData.website.includes('tiktok.com')) {
      hasTikTok = true;
    }

    if (!hasTikTok) {
      return { pass: false, reason: 'No TikTok link' };
    }
  }

  return { pass: true };
}

// Scan existing tokens and post qualifying ones
async function runScanCycle() {
  console.log('\n🔍 Scanning existing pump.fun tokens...');

  try {
    const tokens = await fetchPumpFunTokens();
    console.log(`   Total tokens fetched: ${tokens.length}`);

    let checked = 0;
    let posted = 0;
    let withTikTok = 0;
    let passedMC = 0;
    let passedAge = 0;

    for (const token of tokens) {
      const mint = token.mint;
      if (!mint) continue;

      // Skip if already posted
      if (await isTokenPosted(mint)) {
        continue;
      }

      checked++;

      // Track stats
      const hasTikTok = (token.twitter?.includes('tiktok.com') ||
                         token.telegram?.includes('tiktok.com') ||
                         token.website?.includes('tiktok.com'));
      if (hasTikTok) withTikTok++;

      const mc = token.market_cap || token.usd_market_cap || 0;
      if (mc >= SCANNER_CONFIG.MIN_MARKET_CAP) passedMC++;

      const ageHours = (Date.now() - token.created_timestamp) / (1000 * 60 * 60);
      if (ageHours >= SCANNER_CONFIG.MIN_AGE_HOURS && (ageHours / 24) <= SCANNER_CONFIG.MAX_AGE_DAYS) {
        passedAge++;
      }

      // Check if meets ALL criteria
      const check = await meetsAutoPostCriteria(token);

      if (check.pass) {
        console.log(`\n✅ Qualifying token: ${token.name} ($${token.symbol})`);
        console.log(`   MC: $${mc.toFixed(0)}`);
        console.log(`   Age: ${ageHours.toFixed(1)}h`);
        console.log(`   TikTok: ${hasTikTok ? 'Yes' : 'No'}`);

        const success = await autoPostToken(mint);
        if (success) {
          posted++;
          console.log(`   ✅ Posted successfully!`);
          // Add delay between posts
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    console.log(`\n📊 Scan complete:`);
    console.log(`   Checked: ${checked} new tokens`);
    console.log(`   With TikTok: ${withTikTok}`);
    console.log(`   MC $${SCANNER_CONFIG.MIN_MARKET_CAP}+: ${passedMC}`);
    console.log(`   Age ${SCANNER_CONFIG.MIN_AGE_HOURS}h-${SCANNER_CONFIG.MAX_AGE_DAYS}d: ${passedAge}`);
    console.log(`   Posted: ${posted}`);
  } catch (error) {
    console.log('Error in scan cycle:', error.message);
  }
}

// Auto-post a qualifying token
async function autoPostToken(contractAddress) {
  try {
    console.log(`🤖 Auto-posting token: ${contractAddress}`);

    // Fetch pump.fun data for accurate socials
    const pumpData = await fetchPumpFunData(contractAddress);

    const tokenData = await getTokenData(contractAddress);

    if (!tokenData) {
      console.log('  ❌ Could not fetch token data');
      return false;
    }

    // Merge pump.fun socials into token data
    if (pumpData) {
      tokenData.pumpData = pumpData;
    }

    const formatted = formatTokenData(tokenData, contractAddress);

    if (!formatted || !formatted.message) {
      console.log('  ❌ Could not format token data');
      return false;
    }

    // Create inline keyboard with TikTok button
    let inlineKeyboard = null;
    if (formatted.socials?.tiktok) {
      inlineKeyboard = {
        inline_keyboard: [[
          {
            text: '🎵 TikTok',
            url: formatted.socials.tiktok
          }
        ]]
      };
    }

    // Post to channel
    const messageOptions = {
      parse_mode: 'Markdown'
    };

    if (inlineKeyboard) {
      messageOptions.reply_markup = inlineKeyboard;
    }

    if (formatted.imageUrl) {
      messageOptions.caption = formatted.message;
      await bot.sendPhoto(channelId, formatted.imageUrl, messageOptions);
    } else {
      messageOptions.disable_web_page_preview = false;
      await bot.sendMessage(channelId, formatted.message, messageOptions);
    }

    // Add to tracked tokens
    await addToTrackedTokens(contractAddress, {
      name: formatted.name,
      symbol: formatted.symbol,
      marketCap: formatted.marketCap,
      price: formatted.price,
      holders: formatted.holders,
      imageUrl: formatted.imageUrl,
      pairCreatedAt: tokenData.data?.pairCreatedAt,
      createdTimestamp: tokenData.data?.creation_timestamp || tokenData.gmgnData?.creation_timestamp
    });

    // Mark as posted
    await markTokenAsPosted(contractAddress);

    console.log(`  ✅ Successfully auto-posted: ${formatted.name}`);
    return true;
  } catch (error) {
    console.log(`  ❌ Error auto-posting token: ${error.message}`);
    return false;
  }
}

// Start auto-scanner (Hybrid: WebSocket + Polling)
function startAutoScanner() {
  if (scannerRunning) {
    return false;
  }

  console.log('🚀 Starting auto-scanner (Hybrid Mode: WebSocket + Polling)...');
  console.log(`📊 Settings: MC $${SCANNER_CONFIG.MIN_MARKET_CAP.toLocaleString()}-$${SCANNER_CONFIG.MAX_MARKET_CAP.toLocaleString()}, Age ${SCANNER_CONFIG.MIN_AGE_HOURS}h-${SCANNER_CONFIG.MAX_AGE_DAYS}d, TikTok: ${SCANNER_CONFIG.REQUIRE_TIKTOK ? 'Required' : 'Optional'}`);
  console.log('');
  console.log('📡 WebSocket: Real-time new token detection');
  console.log(`   ⏱️  Maturity delay: ${SCANNER_CONFIG.TOKEN_MATURITY_DELAY / 60000} minutes`);
  console.log('');
  console.log('🔄 Polling: Existing token discovery');
  console.log(`   ⏱️  Scan interval: ${SCANNER_CONFIG.SCAN_INTERVAL / 60000} minutes`);
  console.log('');

  scannerRunning = true;

  // 1. Connect to WebSocket for real-time NEW token events
  connectWebSocket();

  // 2. Run first polling scan immediately to catch EXISTING tokens
  console.log('🔍 Running initial scan for existing tokens...');
  runScanCycle();

  // 3. Then poll every SCAN_INTERVAL to catch tokens that have matured
  scannerInterval = setInterval(runScanCycle, SCANNER_CONFIG.SCAN_INTERVAL);

  return true;
}

// Stop auto-scanner
function stopAutoScanner() {
  if (!scannerRunning) {
    return false;
  }

  console.log('⏹️  Stopping auto-scanner...');

  // Disconnect WebSocket
  disconnectWebSocket();

  // Clear polling interval if it exists (for backward compatibility)
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }

  scannerRunning = false;
  console.log('✅ Auto-scanner stopped');
  return true;
}

// ============= BOT COMMANDS =============

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

/autoscan start - Auto-post pump.fun tokens with TikTok links
/autoscan stop - Turn off auto-posting
/autoscan status - Check scanner status

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

*Auto-Scanner (pump.fun):*
/autoscan start - Auto-post qualifying tokens
/autoscan stop - Turn off auto-posting
/autoscan status - Check scanner status
  • Scans pump.fun launches every 5 minutes
  • Posts tokens with TikTok links
  • Filters by MC, volume, and age

*Market Data:*
/marketdata - Live SOL price & bonding curve info
  • Current SOL price
  • Graduation threshold ($)
  • Updated in real-time

*Tracker Commands:*
/add <symbol> <CA> - Add to your tracker
/list - Show tracked memecoins
/remove <symbol> - Remove from tracker

*Debug:*
/chatid - Get current chat ID

💡 *Tip:* Use auto-scanner to find TikTok memes automatically!
  `;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// /chatid command - Get chat ID for debugging
bot.onText(/\/chatid/, (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || 'N/A';
  const chatUsername = msg.chat.username || 'N/A';

  bot.sendMessage(chatId,
    `📋 *Chat Information:*\n\n` +
    `*Chat ID:* \`${chatId}\`\n` +
    `*Type:* ${chatType}\n` +
    `*Title:* ${chatTitle}\n` +
    `*Username:* @${chatUsername}\n\n` +
    `Use this Chat ID in your .env file if username doesn't work!`,
    { parse_mode: 'Markdown' }
  );
});

// /autoscan command - Control auto-scanner
bot.onText(/\/autoscan (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  const parts = input.split(/\s+/);
  const action = parts[0].toLowerCase();

  if (action === 'start') {
    const started = startAutoScanner();
    if (started) {
      bot.sendMessage(chatId,
        `🤖 *Auto-Scanner Started!*\n\n` +
        `📊 *Settings:*\n` +
        `• Min Market Cap: $${SCANNER_CONFIG.MIN_MARKET_CAP.toLocaleString()}\n` +
        `• Min 24h Volume: $${SCANNER_CONFIG.MIN_VOLUME_24H.toLocaleString()}\n` +
        `• Age Range: ${SCANNER_CONFIG.MIN_AGE_HOURS}h - ${SCANNER_CONFIG.MAX_AGE_DAYS}d\n` +
        `• TikTok Required: ${SCANNER_CONFIG.REQUIRE_TIKTOK ? 'Yes' : 'No'}\n` +
        `• Scan Interval: ${SCANNER_CONFIG.SCAN_INTERVAL / 60000} minutes\n\n` +
        `🔍 Scanning for pump.fun tokens with TikTok links...\n\n` +
        `Use \`/autoscan stop\` to turn off.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      bot.sendMessage(chatId, '⚠️ Auto-scanner is already running!');
    }
  } else if (action === 'stop') {
    const stopped = stopAutoScanner();
    if (stopped) {
      bot.sendMessage(chatId, '⏹️ *Auto-Scanner Stopped!*', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, '⚠️ Auto-scanner is not running!');
    }
  } else if (action === 'status') {
    bot.sendMessage(chatId,
      `📊 *Auto-Scanner Status*\n\n` +
      `Status: ${scannerRunning ? '🟢 Running' : '🔴 Stopped'}\n\n` +
      `*Settings:*\n` +
      `• Min Market Cap: $${SCANNER_CONFIG.MIN_MARKET_CAP.toLocaleString()}\n` +
      `• Min 24h Volume: $${SCANNER_CONFIG.MIN_VOLUME_24H.toLocaleString()}\n` +
      `• Age Range: ${SCANNER_CONFIG.MIN_AGE_HOURS}h - ${SCANNER_CONFIG.MAX_AGE_DAYS}d\n` +
      `• TikTok Required: ${SCANNER_CONFIG.REQUIRE_TIKTOK ? 'Yes' : 'No'}\n` +
      `• Scan Interval: ${SCANNER_CONFIG.SCAN_INTERVAL / 60000} minutes\n\n` +
      `Commands: \`/autoscan start\` | \`/autoscan stop\` | \`/autoscan config\``,
      { parse_mode: 'Markdown' }
    );
  } else if (action === 'config') {
    if (parts.length < 3) {
      // Show config help
      bot.sendMessage(chatId,
        `⚙️ *Auto-Scanner Configuration*\n\n` +
        `*Current Settings:*\n` +
        `• Min Market Cap: $${SCANNER_CONFIG.MIN_MARKET_CAP.toLocaleString()}\n` +
        `• Min 24h Volume: $${SCANNER_CONFIG.MIN_VOLUME_24H.toLocaleString()}\n` +
        `• Min Age: ${SCANNER_CONFIG.MIN_AGE_HOURS}h\n` +
        `• Max Age: ${SCANNER_CONFIG.MAX_AGE_DAYS}d\n` +
        `• TikTok Required: ${SCANNER_CONFIG.REQUIRE_TIKTOK ? 'Yes' : 'No'}\n` +
        `• Scan Interval: ${SCANNER_CONFIG.SCAN_INTERVAL / 60000} minutes\n\n` +
        `*Usage:*\n` +
        `\`/autoscan config mc <amount>\` - Set min MC (e.g., 50000 for $50K)\n` +
        `\`/autoscan config volume <amount>\` - Set min volume (e.g., 10000)\n` +
        `\`/autoscan config minage <hours>\` - Set min age in hours (e.g., 1)\n` +
        `\`/autoscan config maxage <days>\` - Set max age in days (e.g., 7)\n` +
        `\`/autoscan config tiktok <yes/no>\` - Require TikTok link\n` +
        `\`/autoscan config interval <minutes>\` - Scan interval (e.g., 5)\n\n` +
        `*Examples:*\n` +
        `\`/autoscan config mc 100000\` - Set min MC to $100K\n` +
        `\`/autoscan config volume 20000\` - Set min volume to $20K\n` +
        `\`/autoscan config tiktok no\` - Don't require TikTok`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const setting = parts[1].toLowerCase();
    const value = parts[2];

    try {
      if (setting === 'mc' || setting === 'marketcap') {
        const amount = parseInt(value);
        if (isNaN(amount) || amount < 0) {
          bot.sendMessage(chatId, '❌ Invalid amount! Use a positive number (e.g., 50000)');
          return;
        }
        SCANNER_CONFIG.MIN_MARKET_CAP = amount;
        bot.sendMessage(chatId, `✅ Min Market Cap set to $${amount.toLocaleString()}`);
      } else if (setting === 'volume' || setting === 'vol') {
        const amount = parseInt(value);
        if (isNaN(amount) || amount < 0) {
          bot.sendMessage(chatId, '❌ Invalid amount! Use a positive number (e.g., 10000)');
          return;
        }
        SCANNER_CONFIG.MIN_VOLUME_24H = amount;
        bot.sendMessage(chatId, `✅ Min 24h Volume set to $${amount.toLocaleString()}`);
      } else if (setting === 'minage') {
        const hours = parseFloat(value);
        if (isNaN(hours) || hours < 0) {
          bot.sendMessage(chatId, '❌ Invalid hours! Use a positive number (e.g., 0.5 for 30 min)');
          return;
        }
        SCANNER_CONFIG.MIN_AGE_HOURS = hours;

        // Format hours nicely (show as minutes if < 1 hour)
        const displayText = hours < 1
          ? `${(hours * 60).toFixed(0)} minutes`
          : `${hours} hour${hours !== 1 ? 's' : ''}`;
        bot.sendMessage(chatId, `✅ Min Age set to ${displayText}`);
      } else if (setting === 'maxage') {
        const days = parseInt(value);
        if (isNaN(days) || days < 0) {
          bot.sendMessage(chatId, '❌ Invalid days! Use a positive number (e.g., 7)');
          return;
        }
        SCANNER_CONFIG.MAX_AGE_DAYS = days;
        bot.sendMessage(chatId, `✅ Max Age set to ${days} day${days !== 1 ? 's' : ''}`);
      } else if (setting === 'tiktok') {
        const enabled = value.toLowerCase() === 'yes' || value.toLowerCase() === 'true' || value === '1';
        SCANNER_CONFIG.REQUIRE_TIKTOK = enabled;
        bot.sendMessage(chatId, `✅ TikTok requirement ${enabled ? 'enabled' : 'disabled'}`);
      } else if (setting === 'interval') {
        const minutes = parseInt(value);
        if (isNaN(minutes) || minutes < 1) {
          bot.sendMessage(chatId, '❌ Invalid minutes! Use a positive number (e.g., 5)');
          return;
        }
        SCANNER_CONFIG.SCAN_INTERVAL = minutes * 60 * 1000;
        bot.sendMessage(chatId,
          `✅ Scan interval set to ${minutes} minute${minutes !== 1 ? 's' : ''}\n\n` +
          `⚠️ Restart the scanner (\`/autoscan stop\` then \`/autoscan start\`) for this to take effect.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(chatId,
          `❌ Unknown setting: ${setting}\n\n` +
          `Valid settings: mc, volume, minage, maxage, tiktok, interval\n` +
          `Use \`/autoscan config\` for help.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error) {
      bot.sendMessage(chatId, `❌ Error updating config: ${error.message}`);
    }
  } else {
    bot.sendMessage(chatId,
      `❌ Invalid command!\n\n` +
      `Usage:\n` +
      `• \`/autoscan start\` - Start auto-posting\n` +
      `• \`/autoscan stop\` - Stop auto-posting\n` +
      `• \`/autoscan status\` - Check status\n` +
      `• \`/autoscan config\` - Configure settings`,
      { parse_mode: 'Markdown' }
    );
  }
});

// /marketdata command - Show live SOL price and bonding curve data
bot.onText(/\/marketdata/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Fetch fresh data
    const data = await fetchBondingCurveData();

    if (!data) {
      bot.sendMessage(chatId, '❌ Failed to fetch live market data. Try again in a moment.');
      return;
    }

    const { solPrice, graduationMC } = data;

    bot.sendMessage(chatId,
      `💰 *Live Market Data*\n\n` +
      `*Solana (SOL):*\n` +
      `• Current Price: $${solPrice.toFixed(2)}\n\n` +
      `*Pump.fun Bonding Curve:*\n` +
      `• Graduation Threshold: 85 SOL\n` +
      `• Graduation MC: $${graduationMC.toFixed(0).toLocaleString()}\n` +
      `• Graduates to: PumpSwap DEX\n\n` +
      `*What this means:*\n` +
      `When a pump.fun token raises 85 SOL through its bonding curve, it graduates to PumpSwap with full liquidity.\n\n` +
      `Last updated: ${new Date().toLocaleString()}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(chatId, '❌ Error fetching market data: ' + error.message);
  }
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
    // Fetch pump.fun data for accurate socials
    const pumpData = await fetchPumpFunData(contractAddress);

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

    // Merge pump.fun socials into token data
    if (pumpData) {
      tokenData.pumpData = pumpData;
    }

    const formatted = formatTokenData(tokenData, contractAddress);

    if (!formatted || !formatted.message) {
      await bot.editMessageText(
        `❌ Error formatting token data.`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
      return;
    }

    // Create inline keyboard with TikTok button only
    let inlineKeyboard = null;

    // Add TikTok button if TikTok link exists
    if (formatted.socials?.tiktok) {
      inlineKeyboard = {
        inline_keyboard: [[
          {
            text: '🎵 TikTok',
            url: formatted.socials.tiktok
          }
        ]]
      };
    }

    // Post to channel
    try {
      const messageOptions = {
        parse_mode: 'Markdown'
      };

      if (inlineKeyboard) {
        messageOptions.reply_markup = inlineKeyboard;
      }

      if (formatted.imageUrl) {
        // Send with image
        messageOptions.caption = formatted.message;
        await bot.sendPhoto(channelId, formatted.imageUrl, messageOptions);
      } else {
        // Send text only
        messageOptions.disable_web_page_preview = false;
        await bot.sendMessage(channelId, formatted.message, messageOptions);
      }

      // Add to tracked tokens for public bot
      await addToTrackedTokens(contractAddress, {
        name: formatted.name,
        symbol: formatted.symbol,
        marketCap: formatted.marketCap,
        price: formatted.price,
        holders: formatted.holders,
        imageUrl: formatted.imageUrl,
        pairCreatedAt: tokenData.data?.pairCreatedAt,
        createdTimestamp: tokenData.data?.creation_timestamp || tokenData.gmgnData?.creation_timestamp
      });

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
      // Fetch pump.fun data for accurate socials
      const pumpData = await fetchPumpFunData(ca);

      const tokenData = await getTokenData(ca);

      if (tokenData) {
        // Merge pump.fun socials into token data
        if (pumpData) {
          tokenData.pumpData = pumpData;
        }

        const formatted = formatTokenData(tokenData, ca);

        if (formatted && formatted.message) {
          // Create inline keyboard with TikTok button only
          let inlineKeyboard = null;

          // Add TikTok button if TikTok link exists
          if (formatted.socials?.tiktok) {
            inlineKeyboard = {
              inline_keyboard: [[
                {
                  text: '🎵 TikTok',
                  url: formatted.socials.tiktok
                }
              ]]
            };
          }

          // Post to channel
          try {
            const messageOptions = {
              parse_mode: 'Markdown'
            };

            if (inlineKeyboard) {
              messageOptions.reply_markup = inlineKeyboard;
            }

            if (formatted.imageUrl) {
              messageOptions.caption = formatted.message;
              await bot.sendPhoto(channelId, formatted.imageUrl, messageOptions);
            } else {
              messageOptions.disable_web_page_preview = false;
              await bot.sendMessage(channelId, formatted.message, messageOptions);
            }

            // Add to tracked tokens for public bot
            await addToTrackedTokens(ca, {
              name: formatted.name,
              symbol: formatted.symbol,
              marketCap: formatted.marketCap,
              price: formatted.price,
              holders: formatted.holders,
              imageUrl: formatted.imageUrl,
              pairCreatedAt: tokenData.data?.pairCreatedAt,
              createdTimestamp: tokenData.data?.creation_timestamp || tokenData.gmgnData?.creation_timestamp
            });

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
