require('dotenv').config({ path: require('path').join(__dirname, '.env') });

console.log('🔍 Environment Variable Test\n');
console.log('Current directory:', __dirname);
console.log('.env path:', require('path').join(__dirname, '.env'));
console.log('\nLoaded variables:');
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? 'LOADED (' + process.env.TELEGRAM_BOT_TOKEN.length + ' chars)' : 'MISSING');
console.log('SOLSCAN_API_KEY:', process.env.SOLSCAN_API_KEY ? 'LOADED (' + process.env.SOLSCAN_API_KEY.length + ' chars)' : 'MISSING');
console.log('MORALIS_API_KEY:', process.env.MORALIS_API_KEY ? 'LOADED (' + process.env.MORALIS_API_KEY.length + ' chars)' : 'MISSING');

if (process.env.SOLSCAN_API_KEY) {
  console.log('\nSOLSCAN_API_KEY value:', process.env.SOLSCAN_API_KEY.substring(0, 50) + '...');
}
