require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIds = process.env.ADMIN_USER_IDS
  ? process.env.ADMIN_USER_IDS.split(',').map(id => id.trim())
  : [];
const channelId = process.env.TELEGRAM_CHANNEL || null;

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

// Get all subscribers
async function getSubscribers() {
  const allData = await loadMemecoins();
  return allData.subscribers || [];
}

// Add subscriber
async function addSubscriber(userId, username, firstName) {
  const allData = await loadMemecoins();
  if (!allData.subscribers) {
    allData.subscribers = [];
  }

  const existing = allData.subscribers.find(sub => sub.userId === userId);
  if (!existing) {
    allData.subscribers.push({
      userId,
      username: username || null,
      firstName: firstName || 'User',
      subscribedAt: new Date().toISOString()
    });
    await saveMemecoins(allData);
    return true;
  }
  return false;
}

// Remove subscriber
async function removeSubscriber(userId) {
  const allData = await loadMemecoins();
  if (!allData.subscribers) {
    return false;
  }

  const index = allData.subscribers.findIndex(sub => sub.userId === userId);
  if (index !== -1) {
    allData.subscribers.splice(index, 1);
    await saveMemecoins(allData);
    return true;
  }
  return false;
}

// Check if user is admin
function isAdmin(userId) {
  return adminIds.includes(userId.toString());
}

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🚀 Welcome to SearchTok Memecoin Tracker!

Get notified about trending TikTok Solana memecoins!

📬 SUBSCRIBE to get notifications:
/subscribe - Get alerts when new memecoins are posted

📊 PERSONAL TRACKING:
/add <symbol> <contract_address> - Add a memecoin
  Example: /add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV

/list - Show all your tracked memecoins

/remove <symbol> - Remove a memecoin

/help - Show all commands
  `;
  bot.sendMessage(chatId, welcomeMessage);
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  let helpMessage = `
📚 Available Commands:

📬 NOTIFICATIONS:
/subscribe - Subscribe to memecoin alerts
/unsubscribe - Unsubscribe from alerts

📊 PERSONAL TRACKING:
/add <symbol> <contract_address> - Add a memecoin to track
  Example: /add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV

/list - Display all your tracked memecoins

/remove <symbol> - Remove a memecoin from your list
  Example: /remove BONK

/help - Show this help message
  `;

  if (isAdmin(userId)) {
    helpMessage += `
👑 ADMIN COMMANDS:
/post <symbol> <contract> <name> <description> - Post memecoin to all subscribers
  Example: /post BONK 7Bg...MV BonkCoin A fun dog-themed memecoin

/subscribers - View subscriber count
    `;
  }

  bot.sendMessage(chatId, helpMessage);
});

// /subscribe command
bot.onText(/\/subscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const username = msg.from.username;
  const firstName = msg.from.first_name;

  try {
    const added = await addSubscriber(userId, username, firstName);

    if (added) {
      bot.sendMessage(
        chatId,
        `✅ You're now subscribed to memecoin alerts!\n\nYou'll receive notifications when new TikTok memecoins are posted.\n\nUse /unsubscribe anytime to stop receiving alerts.`
      );
    } else {
      bot.sendMessage(
        chatId,
        `ℹ️ You're already subscribed to memecoin alerts!\n\nUse /unsubscribe if you want to stop receiving notifications.`
      );
    }
  } catch (error) {
    console.error('Error subscribing user:', error);
    bot.sendMessage(chatId, '❌ An error occurred while subscribing.');
  }
});

// /unsubscribe command
bot.onText(/\/unsubscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  try {
    const removed = await removeSubscriber(userId);

    if (removed) {
      bot.sendMessage(
        chatId,
        `✅ You've been unsubscribed from memecoin alerts.\n\nYou won't receive any more notifications.\n\nUse /subscribe anytime to subscribe again.`
      );
    } else {
      bot.sendMessage(
        chatId,
        `ℹ️ You're not currently subscribed to memecoin alerts.\n\nUse /subscribe to start receiving notifications.`
      );
    }
  } catch (error) {
    console.error('Error unsubscribing user:', error);
    bot.sendMessage(chatId, '❌ An error occurred while unsubscribing.');
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

// /post command (admin only)
bot.onText(/\/post (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  // Check if user is admin
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ This command is only available to admins.');
    return;
  }

  const input = match[1].trim();
  const parts = input.split(/\s+/);

  if (parts.length < 4) {
    bot.sendMessage(
      chatId,
      `❌ Invalid format! Use:\n/post <symbol> <contract> <name> <description>\n\nExample:\n/post BONK 7Bg...MV BonkCoin A fun dog-themed memecoin from TikTok`
    );
    return;
  }

  const symbol = parts[0].toUpperCase();
  const contractAddress = parts[1];
  const name = parts[2];
  const description = parts.slice(3).join(' ');

  try {
    const subscribers = await getSubscribers();

    if (subscribers.length === 0) {
      bot.sendMessage(chatId, '⚠️ No subscribers yet! Post will not be sent.');
      return;
    }

    // Create the message
    const message = `
🚀 NEW TIKTOK MEMECOIN ALERT! 🚀

💎 Symbol: ${symbol}
📛 Name: ${name}
📝 Contract: ${contractAddress}

📖 Description:
${description}

⏰ Posted: ${new Date().toLocaleString()}
    `;

    // Send to all subscribers
    let successCount = 0;
    let failCount = 0;

    for (const subscriber of subscribers) {
      try {
        await bot.sendMessage(subscriber.userId, message);
        successCount++;
      } catch (error) {
        console.error(`Failed to send to user ${subscriber.userId}:`, error.message);
        failCount++;
      }
    }

    // Send to channel if configured
    if (channelId) {
      try {
        await bot.sendMessage(channelId, message);
        bot.sendMessage(chatId, `✅ Posted to ${successCount} subscribers and channel!\n\n${failCount > 0 ? `⚠️ ${failCount} failed deliveries.` : ''}`);
      } catch (error) {
        console.error('Failed to send to channel:', error.message);
        bot.sendMessage(chatId, `✅ Posted to ${successCount} subscribers!\n\n${failCount > 0 ? `⚠️ ${failCount} failed deliveries.\n` : ''}❌ Failed to post to channel.`);
      }
    } else {
      bot.sendMessage(chatId, `✅ Posted to ${successCount} subscribers!\n\n${failCount > 0 ? `⚠️ ${failCount} failed deliveries.` : ''}`);
    }
  } catch (error) {
    console.error('Error posting memecoin:', error);
    bot.sendMessage(chatId, '❌ An error occurred while posting the memecoin.');
  }
});

// /subscribers command (admin only)
bot.onText(/\/subscribers/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  // Check if user is admin
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ This command is only available to admins.');
    return;
  }

  try {
    const subscribers = await getSubscribers();

    if (subscribers.length === 0) {
      bot.sendMessage(chatId, '📭 No subscribers yet.');
      return;
    }

    let message = `👥 Total Subscribers: ${subscribers.length}\n\n`;
    message += `📊 Recent Subscribers:\n\n`;

    // Show last 10 subscribers
    const recentSubs = subscribers.slice(-10).reverse();
    recentSubs.forEach((sub, index) => {
      const date = new Date(sub.subscribedAt).toLocaleDateString();
      const username = sub.username ? `@${sub.username}` : sub.firstName;
      message += `${index + 1}. ${username}\n   📅 ${date}\n\n`;
    });

    if (subscribers.length > 10) {
      message += `... and ${subscribers.length - 10} more`;
    }

    bot.sendMessage(chatId, message);
  } catch (error) {
    console.error('Error fetching subscribers:', error);
    bot.sendMessage(chatId, '❌ An error occurred while fetching subscribers.');
  }
});

console.log('🤖 SearchTok Memecoin Tracker Bot is running...');
