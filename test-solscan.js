require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;

async function testSolscanAPI() {
  console.log('🧪 Testing Solscan Pro API Integration...\n');

  if (!SOLSCAN_API_KEY) {
    console.error('❌ SOLSCAN_API_KEY not found in .env');
    process.exit(1);
  }

  console.log('✅ API Key loaded:', SOLSCAN_API_KEY.substring(0, 20) + '...\n');

  try {
    console.log('📡 Fetching latest pump.fun tokens from Solscan...');
    const response = await axios.get('https://pro-api.solscan.io/v2.0/token/latest', {
      params: {
        platform_id: 'pumpfun',
        page: 1,
        page_size: 10
      },
      timeout: 15000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Origin': 'https://solscan.io',
        'Referer': 'https://solscan.io/',
        'token': SOLSCAN_API_KEY
      }
    });

    console.log('\n✅ API Response Status:', response.status);
    console.log('✅ Response Structure:', {
      success: response.data.success,
      dataLength: response.data.data?.length || 0,
      hasNextPage: response.data.pagination?.hasNext
    });

    if (response.data.data && response.data.data.length > 0) {
      console.log('\n📊 First 3 Tokens:\n');
      for (let i = 0; i < Math.min(3, response.data.data.length); i++) {
        const token = response.data.data[i];
        const createdTime = token.created_time ? new Date(token.created_time * 1000).toISOString() : 'N/A';
        const ageHours = token.created_time ? ((Date.now() - token.created_time * 1000) / (1000 * 60 * 60)).toFixed(1) : 'N/A';

        console.log(`[${i + 1}] ${token.symbol || '???'}`);
        console.log(`    Name: ${token.name || 'Unknown'}`);
        console.log(`    Address: ${token.address}`);
        console.log(`    Created: ${createdTime}`);
        console.log(`    Age: ${ageHours} hours`);
        console.log(`    Decimals: ${token.decimals || 'N/A'}`);
        console.log(`    Platform: ${token.platform || 'N/A'}`);
        console.log('');
      }

      console.log('✅ Solscan Pro API is working correctly!');
      console.log('✅ Successfully fetching pump.fun tokens');
    } else {
      console.log('⚠️  No tokens returned (this might be normal if no new pump.fun tokens exist)');
    }

  } catch (error) {
    console.error('\n❌ Error testing Solscan API:', error.message);
    if (error.response) {
      console.error('   HTTP Status:', error.response.status);
      console.error('   Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

testSolscanAPI();
