# SearchTok Memecoin Tracker Bot

A Telegram bot for tracking TikTok Solana memecoins. Add, list, and manage your favorite memecoin contract addresses with ease.

## Features

- Add memecoins with symbol and contract address
- List all your tracked memecoins
- Remove memecoins from your tracker
- Persistent storage (data saved between restarts)
- User-specific tracking (each user has their own list)

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

Edit `.env` and add your bot token:

```
TELEGRAM_BOT_TOKEN=your_actual_bot_token_here
```

### 5. Run the bot

```bash
npm start
```

You should see: `🤖 SearchTok Memecoin Tracker Bot is running...`

## Usage

### Commands

- `/start` - Get welcome message and instructions
- `/help` - Show available commands
- `/add <symbol> <contract_address>` - Add a memecoin to track
- `/list` - Show all your tracked memecoins
- `/remove <symbol>` - Remove a memecoin from your list

### Examples

**Add a memecoin:**
```
/add BONK 7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx4e7PCRMV
```

**List your memecoins:**
```
/list
```

**Remove a memecoin:**
```
/remove BONK
```

## Data Storage

Memecoin data is stored in `memecoins.json` in the project root. Each user's data is stored separately, indexed by their Telegram user ID.

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
