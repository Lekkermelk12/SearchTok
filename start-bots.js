// Start both bots at the same time
const { spawn } = require('child_process');

console.log('🚀 Starting both Telegram bots...\n');

// Start posting bot
const postingBot = spawn('node', ['bot.js'], {
  stdio: 'inherit',
  shell: true
});

// Start public bot
const publicBot = spawn('node', ['publicbot.js'], {
  stdio: 'inherit',
  shell: true
});

postingBot.on('error', (error) => {
  console.error('❌ Error starting posting bot:', error);
});

publicBot.on('error', (error) => {
  console.error('❌ Error starting public bot:', error);
});

postingBot.on('exit', (code) => {
  console.log(`❌ Posting bot exited with code ${code}`);
  process.exit(code);
});

publicBot.on('exit', (code) => {
  console.log(`❌ Public bot exited with code ${code}`);
  process.exit(code);
});

console.log('✅ Both bots are running!');
console.log('📝 Press Ctrl+C to stop both bots\n');

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n⏹️  Stopping both bots...');
  postingBot.kill();
  publicBot.kill();
  process.exit(0);
});
