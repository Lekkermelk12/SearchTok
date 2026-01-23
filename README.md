# SearchTok Memecoin Tracker Bot

A Telegram bot for tracking TikTok Solana memecoins. Subscribe to get notifications about trending memecoins, or track your personal favorites.

## Features

### For Users
- **Subscribe to Alerts**: Get notified when new TikTok-related memecoins are posted
- **Personal Tracking**: Add, list, and manage your favorite memecoin contract addresses
- **Persistent Storage**: Your data is saved between restarts

### For Admins
- **Broadcast Posts**: Manually post memecoin information to all subscribers
- **Channel Integration**: Optionally post to a Telegram channel
- **Subscriber Management**: View subscriber count and recent subscribers

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd SearchTok
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the instructions to create your bot
4. Copy the bot token you receive

### 4. Configure environment variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and configure the following:

```
# Required: Your bot token from @BotFather
TELEGRAM_BOT_TOKEN=your_actual_bot_token_here

# Required for admin features: Comma-separated list of admin user IDs
# Get your user ID from @userinfobot on Telegram
ADMIN_USER_IDS=123456789,987654321

# Optional: Telegram channel for posting (format: @channelname or -100xxxxxxxxxx)
# Make sure to add your bot as an admin to the channel
TELEGRAM_CHANNEL=@yourchannel
```

**How to get your Telegram User ID:**
1. Open Telegram and search for `@userinfobot`
2. Start a chat with the bot
3. Your user ID will be displayed

### 5. Run the bot

```bash
npm start
```

You should see: `🤖 SearchTok Memecoin Tracker Bot is running...`

## Usage

### User Commands

**Subscription & Notifications:**
- `/start` - Get welcome message and instructions
- `/help` - Show available commands
- `/subscribe` - Subscribe to memecoin alerts
- `/unsubscribe` - Unsubscribe from alerts

**Personal Tracking:**
- `/add <symbol> <contract_address>` - Add a memecoin to your personal tracker
- `/list` - Show all your tracked memecoins
- `/remove <symbol>` - Remove a memecoin from your list

### Admin Commands

(Only available to users listed in `ADMIN_USER_IDS`)

- `/post <symbol> <contract> <name> <description>` - Broadcast a memecoin to all subscribers
- `/subscribers` - View subscriber count and recent subscribers

### Examples

**Subscribe to alerts:**
```
/subscribe
```

**Admin posting a memecoin:**
```
/post BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV BonkCoin A fun dog-themed memecoin trending on TikTok
```

**Add a memecoin to personal tracker:**
```
/add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV
```

**List your personal memecoins:**
```
/list
```

**Remove a memecoin:**
```
/remove BONK
```

## Data Storage

All data is stored in `memecoins.json` in the project root:
- **Personal Tracking**: Each user's tracked memecoins are stored separately, indexed by their Telegram user ID
- **Subscribers**: A list of all subscribed users for broadcast notifications

## Channel Setup (Optional)

To enable posting to a Telegram channel:

1. Create a Telegram channel or use an existing one
2. Add your bot as an administrator to the channel
3. Get the channel ID:
   - For public channels: Use `@channelname`
   - For private channels: Use the numeric ID (format: `-100xxxxxxxxxx`)
4. Add the channel ID to your `.env` file as `TELEGRAM_CHANNEL`

When configured, all `/post` commands will send messages to both subscribers and the channel.

## Development

To run in development mode:

```bash
npm run dev
```

## Project Structure

```
SearchTok/
├── bot.js              # Main bot application
├── package.json        # Project dependencies
├── .env               # Environment variables (create this)
├── .env.example       # Example environment file
├── .gitignore         # Git ignore rules
├── memecoins.json     # Data storage (auto-generated)
└── README.md          # This file
```

## License

MIT
