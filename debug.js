require('dotenv').config();
const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const fs = require('fs');

const cookieJar = new tough.CookieJar();
const client = wrapper(axios.create({ jar: cookieJar, withCredentials: true, timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
}));

const baseUrl = 'https://ewms.anchanto.com';

async function debug() {
  try {
    // Login
    const loginPage = await client.get(`${baseUrl}/login`);
    const $ = cheerio.load(loginPage.data);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="authenticity_token"]').val();
    
    const loginData = new URLSearchParams({
      'user[email]': process.env.ANCHANTO_EMAIL,
      'user[password]': process.env.ANCHANTO_PASSWORD,
      'commit': 'Sign In'
    });
    if (csrfToken) loginData.append('authenticity_token', csrfToken);
    
    await client.post(`${baseUrl}/login`, loginData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 5,
    });
    console.log('✓ Logged in\n');

    // Get JSON
    const jsonUrl = `${baseUrl}/order_pickup_lists.json?state=unassigned&per_page=500&page=1`;
    const resp = await client.get(jsonUrl, { headers: { 'Accept': 'application/json' }});
    
    console.log('JSON Keys:', Object.keys(resp.data));
    fs.writeFileSync('debug_response.json', JSON.stringify(resp.data, null, 2));
    console.log('✓ Saved to debug_response.json');
    
    // Show structure
    for (const key of Object.keys(resp.data)) {
      const val = resp.data[key];
      if (Array.isArray(val)) console.log(`  "${key}": Array[${val.length}]`);
      else console.log(`  "${key}":`, typeof val === 'object' ? Object.keys(val) : val);
    }
  } catch (e) { console.error('Error:', e.message); }
}

debug();