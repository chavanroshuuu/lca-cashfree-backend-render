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

app.get('/health', (req, res) => {
  const cfg = cashfreeConfig();
  res.json({ ok: true, mode: cfg.mode, keysSet: !!(cfg.appId && cfg.secretKey) });
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

    const cfRes = await fetch(cfg.baseUrl + '/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': cfg.appId,
        'x-client-secret': cfg.secretKey,
        'x-api-version': '2023-08-01',
      },
      body: JSON.stringify({
        link_id: linkId,
        link_amount: sum,
        link_currency: 'INR',
        link_purpose: purpose,
        customer_details: email ? { customer_email: email } : undefined,
      }),
    });
    const data = await cfRes.json();
    if (!cfRes.ok || !data.link_url) {
      return res.status(502).json({ error: 'Cashfree se link nahi bana.', cashfree: data });
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
