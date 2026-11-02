// Cashfree Auto Link Backend - Node.js (Express)
// Ye file Blogger theme / Resources code me NAHI dalni hai.
// Isko alag server par host karo (Vercel / Render / apna server).
// Secret Key sirf yahan environment variables me rahegi, kabhi frontend code me nahi.
//
// Environment variables (hosting dashboard me set karo, .env file me ya hosting settings me):
//   CASHFREE_ENV=test            // test mode ke liye 'test', live ke liye 'production'
//   CASHFREE_TEST_APP_ID=...     // Cashfree dashboard > Developers > API Keys > Test Mode se
//   CASHFREE_TEST_SECRET_KEY=... // Test Mode wali Secret Key
//   CASHFREE_LIVE_APP_ID=...     // Production Mode wali App ID (live ke liye, test me zaroori nahi)
//   CASHFREE_LIVE_SECRET_KEY=... // Production Mode wali Secret Key (live ke liye)
//   PORT=3000
//
// Frontend (Resources page) sirf is backend ka URL jaanta hai:
//   LCA_CASHFREE_BACKEND_URL = 'https://tumhara-backend-url'
// Frontend kabhi App ID / Secret Key nahi bhejta, sirf files + total + email bhejta hai.

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const KNOWN_FILES = {
  'wire-patch': 199,
  'titan-palette': 199,
  'ma3-effects': 199,
};

function cashfreeConfig() {
  const env = (process.env.CASHFREE_ENV || 'test').toLowerCase();
  if (env === 'production' || env === 'live') {
    return {
      mode: 'production',
      baseUrl: 'https://api.cashfree.com/pg',
      appId: process.env.CASHFREE_LIVE_APP_ID,
      secretKey: process.env.CASHFREE_LIVE_SECRET_KEY,
    };
  }
  // Default: test mode, test keys hi use honge, live keys se alag
  return {
    mode: 'test',
    baseUrl: 'https://sandbox.cashfree.com/pg',
    appId: process.env.CASHFREE_TEST_APP_ID,
    secretKey: process.env.CASHFREE_TEST_SECRET_KEY,
  };
}


function cashfreePost(baseUrl, path, appId, secretKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const url = new URL(baseUrl + path);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-client-id': appId,
        'x-client-secret': secretKey,
        'x-api-version': '2023-08-01',
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(out || '{}') }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, data: { message: out.slice(0, 300) } }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

app.get('/health', (req, res) => {
  const cfg = cashfreeConfig();
  res.json({ ok: true, mode: cfg.mode, keysSet: !!(cfg.appId && cfg.secretKey), version: 'customer-details-fix-v3-https' });
});

// POST /api/cashfree-link
// Body: { email, files: [{ id, title, finalPrice }], total }
// Response: { link_url, link_id, amount, mode }
// Cart me jo files hain, unke hisab se hi link banega, amount = cart total.
app.post('/api/cashfree-link', async (req, res) => {
  try {
    const cfg = cashfreeConfig();
    if (!cfg.appId || !cfg.secretKey) {
      return res.status(500).json({ error: 'Cashfree keys backend me set nahi hain. Hosting me CASHFREE_TEST_APP_ID / SECRET_KEY set karo.' });
    }
    const { email, files, total } = req.body || {};
    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ error: 'Koi file nahi bheji gayi.' });
    }
    // Amount validate karo: har file ka base price known hona chahiye, total sum se match hona chahiye
    let sum = 0;
    const titles = [];
    for (const f of files) {
      const base = KNOWN_FILES[String(f.id || '').toLowerCase()];
      if (!base) return res.status(400).json({ error: 'Unknown file: ' + f.id });
      const price = Number(f.finalPrice);
      if (!price || price <= 0 || price > base) {
        return res.status(400).json({ error: 'Galat price file ke liye: ' + f.id });
      }
      sum += price;
      titles.push(f.title || f.id);
    }
    if (Number(total) !== sum) {
      return res.status(400).json({ error: 'Total match nahi hua. Frontend total: ' + total + ', server sum: ' + sum });
    }

    const linkId = 'lca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const purpose = titles.length === 1
      ? 'Light Console Academy - ' + titles[0]
      : 'Light Console Academy Cart - ' + titles.join(', ');

    // FIX: Cashfree ko customer_details me sirf email kaafi nahi hota, docs example me
    // customer_name + customer_phone + customer_email teeno hote hain.
    // Site login me phone nahi hai, isliye test ke liye Cashfree docs wala test phone use karo.
    // Email khali ho to link nahi banega, pehle hi clear error do.
    if (!email) {
      return res.status(400).json({ error: 'Login email nahi mila. Dobara login karke Buy dabao.' });
    }
    const customerName = String(email).split('@')[0] || 'LCA Customer';
    const cfResult = await cashfreePost(cfg.baseUrl, '/links', cfg.appId, cfg.secretKey, {
        link_id: linkId,
        link_amount: sum,
        link_currency: 'INR',
        link_purpose: purpose,
        customer_details: {
          customer_name: customerName,
          customer_phone: '9999999999',
          customer_email: email,
        },
        link_notify: { send_email: false, send_sms: false },
      });
    const cfRes = { ok: cfResult.ok };
    const data = cfResult.data;
    if (!cfRes.ok || !data.link_url) {
      const cfMsg = data.message || data.error || (data.errors && data.errors[0] && data.errors[0].message) || JSON.stringify(data).slice(0, 300);
      return res.status(502).json({ error: 'Cashfree se link nahi bana: ' + cfMsg, cashfree: data });
    }
    return res.json({ link_url: data.link_url, link_id: data.link_id || linkId, amount: sum, mode: cfg.mode });
  } catch (e) {
    return res.status(500).json({ error: 'Backend error: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Cashfree auto backend running on port ' + PORT + ', mode=' + cashfreeConfig().mode));

// package.json ke liye dependencies:
//   npm install express cors
// Run: node cashfree-auto-backend.js
