// Cashfree Auto Link + Automatic My Purchases Backend - v2 (auto-purchases-v1)
// Ye file Blogger theme / Resources code me NAHI dalni hai. Sirf Render / Vercel par host karo.
// Secret Key aur Firebase Service Account sirf yahan environment variables me rahenge, kabhi frontend code me nahi.
//
// Environment variables (hosting dashboard me set karo):
//   CASHFREE_ENV=test
//   CASHFREE_TEST_APP_ID, CASHFREE_TEST_SECRET_KEY (Test Mode)
//   CASHFREE_LIVE_APP_ID, CASHFREE_LIVE_SECRET_KEY (live ke liye, test me zaroori nahi)
//   BACKEND_PUBLIC_URL=https://lca-cashfree-backend-render.onrender.com  (apna Render URL, bina / ke)
//   FIREBASE_SERVICE_ACCOUNT_JSON={...poora JSON, ek line me...}  (Firebase Console > Project Settings > Service accounts > Generate new private key)
//     Ya alag se: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//   PORT (Render khud deta hai)
//
// Kaam kaise karta hai:
// 1. Frontend /api/cashfree-link mangta hai -> backend Cashfree link banata hai, link_meta me
//    notify_url (webhook) aur return_url (site wapas) set karta hai, aur pending_orders/{link_id}
//    Firestore me order save karta hai (email + files + total).
// 2. User Cashfree par pay karta hai -> Cashfree webhook /api/cashfree-webhook par bhejta hai,
//    aur user return_url par site par wapas aata hai -> Resources /api/check-payment mangta hai.
// 3. Dono raste me backend Cashfree se GET /links/{link_id} karke PAID verify karta hai
//    (sirf webhook ki baat par bharosa nahi karta), phir Admin SDK se user ke account me
//    users/{uid}/purchases/{fileId} + users/{uid}.purchases array me purchase add karta hai.
// 4. User My Account > My Purchases kholta hai, theme Firestore se purchases + paid_file_links
//    padhta hai, aur har kharidi file ka Download button dikhata hai. 1 file = 1 button, 3 files = 3 buttons.

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
const FILE_TITLES = {
  'wire-patch': 'Resolume Wire Patch Collection',
  'titan-palette': 'Avolites Titan Palette Pack',
  'ma3-effects': 'grandMA3 Effects Preset Pack',
};

function cashfreeConfig() {
  const env = (process.env.CASHFREE_ENV || 'test').toLowerCase();
  if (env === 'production' || env === 'live') {
    return { mode: 'production', baseUrl: 'https://api.cashfree.com/pg', appId: process.env.CASHFREE_LIVE_APP_ID, secretKey: process.env.CASHFREE_LIVE_SECRET_KEY };
  }
  return { mode: 'test', baseUrl: 'https://sandbox.cashfree.com/pg', appId: process.env.CASHFREE_TEST_APP_ID, secretKey: process.env.CASHFREE_TEST_SECRET_KEY };
}

function cashfreeReq(baseUrl, path, method, appId, secretKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : '';
    const url = new URL(baseUrl + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-client-id': appId, 'x-client-secret': secretKey, 'x-api-version': '2023-08-01',
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
    if (data) req.write(data);
    req.end();
  });
}

// ---------- Firebase Admin (sirf backend me) ----------
let adminDb = null;
let adminAuth = null;
let adminInitError = '';
try {
  const admin = require('firebase-admin');
  let cred = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    cred = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
    });
  }
  if (cred) {
    if (!admin.apps.length) admin.initializeApp({ credential: cred });
    adminDb = admin.firestore();
    adminAuth = admin.auth();
  } else {
    adminInitError = 'Firebase service account env var set nahi hai.';
  }
} catch (e) {
  adminInitError = 'Firebase Admin init fail: ' + e.message;
}

function publicUrl() {
  return String(process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
}

app.get('/health', (req, res) => {
  const cfg = cashfreeConfig();
  res.json({ ok: true, mode: cfg.mode, keysSet: !!(cfg.appId && cfg.secretKey), adminReady: !!adminDb, adminError: adminInitError || null, version: 'auto-purchases-v1' });
});

// ---------- Purchase grant (ek hi jagah, webhook aur check-payment dono isi ko bulate hain) ----------
async function grantPurchase(linkId) {
  if (!adminDb) return { granted: false, error: 'Firebase Admin ready nahi hai. Render me FIREBASE_SERVICE_ACCOUNT_JSON set karo.' };
  const orderRef = adminDb.collection('pending_orders').doc(linkId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { granted: false, error: 'Pending order nahi mila: ' + linkId };
  const order = orderSnap.data();
  if (order.status === 'paid') {
    return { granted: true, already: true, files: order.files || [], email: order.email };
  }
  // User UID nikalo: pehle Auth se email se, nahi to users collection me email se
  let uid = null;
  try {
    if (adminAuth) { const u = await adminAuth.getUserByEmail(order.email); uid = u.uid; }
  } catch (e) { /* Auth me nahi mila, Firestore me dhoondho */ }
  if (!uid) {
    const q = await adminDb.collection('users').where('email', '==', order.email).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
  }
  if (!uid) return { granted: false, error: 'User account nahi mila email se: ' + order.email + '. User ko login karke wahi email se account banana hoga jo payment me diya tha.' };
  const userRef = adminDb.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const oldPurchases = (userSnap.exists && Array.isArray(userSnap.data().purchases)) ? userSnap.data().purchases : [];
  const newPurchases = oldPurchases.slice();
  for (const f of (order.files || [])) {
    const fileId = String(f.id || '').toLowerCase();
    const entry = { fileId, fileName: f.title || FILE_TITLES[fileId] || fileId, amount: Number(f.finalPrice) || 0, cashfreeLinkId: linkId, paidAt: new Date().toISOString() };
    await userRef.collection('purchases').doc(fileId).set(entry, { merge: true });
    if (!newPurchases.some((p) => p && (p.fileId === fileId))) newPurchases.push(entry);
  }
  await userRef.set({ purchases: newPurchases }, { merge: true });
  await orderRef.set({ status: 'paid', grantedAt: new Date().toISOString() }, { merge: true });
  return { granted: true, already: false, files: order.files || [], email: order.email, uid };
}

async function verifyAndGrant(linkId) {
  const cfg = cashfreeConfig();
  if (!cfg.appId || !cfg.secretKey) return { paid: false, error: 'Cashfree keys set nahi hain.' };
  const cf = await cashfreeReq(cfg.baseUrl, '/links/' + encodeURIComponent(linkId), 'GET', cfg.appId, cfg.secretKey, null);
  if (!cf.ok) return { paid: false, error: 'Cashfree link check fail: ' + (cf.data.message || JSON.stringify(cf.data).slice(0, 200)) };
  const status = String(cf.data.link_status || '').toUpperCase();
  if (status !== 'PAID') return { paid: false, status, linkId };
  const g = await grantPurchase(linkId);
  if (!g.granted) return { paid: true, status, granted: false, error: g.error };
  return { paid: true, status, granted: true, already: !!g.already, files: g.files, email: g.email };
}

// ---------- Link banao ----------
app.post('/api/cashfree-link', async (req, res) => {
  try {
    const cfg = cashfreeConfig();
    if (!cfg.appId || !cfg.secretKey) return res.status(500).json({ error: 'Cashfree keys backend me set nahi hain.' });
    const { email, files, total, returnUrl } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Login email nahi mila. Dobara login karke Buy dabao.' });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Koi file nahi bheji gayi.' });
    let sum = 0; const titles = [];
    for (const f of files) {
      const base = KNOWN_FILES[String(f.id || '').toLowerCase()];
      if (!base) return res.status(400).json({ error: 'Unknown file: ' + f.id });
      const price = Number(f.finalPrice);
      if (!price || price <= 0 || price > base) return res.status(400).json({ error: 'Galat price file ke liye: ' + f.id });
      sum += price; titles.push(f.title || f.id);
    }
    if (Number(total) !== sum) return res.status(400).json({ error: 'Total match nahi hua. Frontend total: ' + total + ', server sum: ' + sum });
    const linkId = 'lca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const purpose = titles.length === 1 ? 'Light Console Academy - ' + titles[0] : 'Light Console Academy Cart - ' + titles.join(', ');
    const customerName = String(email).split('@')[0] || 'LCA Customer';
    const base = publicUrl();
    const linkMeta = {};
    if (base) linkMeta.notify_url = base + '/api/cashfree-webhook';
    if (returnUrl) linkMeta.return_url = returnUrl;
    const cf = await cashfreeReq(cfg.baseUrl, '/links', 'POST', cfg.appId, cfg.secretKey, {
      link_id: linkId, link_amount: sum, link_currency: 'INR', link_purpose: purpose,
      customer_details: { customer_name: customerName, customer_phone: '9999999999', customer_email: email },
      link_notify: { send_email: false, send_sms: false },
      link_meta: linkMeta,
    });
    if (!cf.ok || !cf.data.link_url) {
      const msg = cf.data.message || cf.data.error || (cf.data.errors && cf.data.errors[0] && cf.data.errors[0].message) || JSON.stringify(cf.data).slice(0, 300);
      return res.status(502).json({ error: 'Cashfree se link nahi bana: ' + msg, cashfree: cf.data });
    }
    // Pending order save karo, taaki webhook / return check baad me files jaan sake
    if (adminDb) {
      try {
        await adminDb.collection('pending_orders').doc(linkId).set({
          link_id: linkId, email, files: files.map((f) => ({ id: String(f.id).toLowerCase(), title: f.title || f.id, finalPrice: Number(f.finalPrice) })), total: sum, status: 'pending', mode: cfg.mode, createdAt: new Date().toISOString(),
        });
      } catch (e) { console.log('pending order save fail:', e.message); }
    }
    return res.json({ link_url: cf.data.link_url, link_id: cf.data.link_id || linkId, amount: sum, mode: cfg.mode });
  } catch (e) {
    return res.status(500).json({ error: 'Backend error: ' + e.message });
  }
});

// ---------- Return check: user payment ke baad site par wapas aaye to turant grant karo ----------
app.post('/api/check-payment', async (req, res) => {
  try {
    const { link_id } = req.body || {};
    if (!link_id) return res.status(400).json({ error: 'link_id nahi mila.' });
    const out = await verifyAndGrant(link_id);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'Backend error: ' + e.message });
  }
});

// ---------- Webhook: Cashfree payment hone par bhejta hai, user tab band bhi kare to bhi grant hoga ----------
app.post('/api/cashfree-webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || body;
    const linkId = data.link_id || data.payment_link_id || data.linkId || body.link_id || '';
    // Cashfree ko turant 200 do, warna wo retry karega. Grant background me karo.
    res.json({ ok: true, received: !!linkId });
    if (!linkId) return;
    const out = await verifyAndGrant(linkId);
    console.log('webhook grant:', linkId, out.paid, out.granted, out.error || '');
  } catch (e) {
    console.log('webhook error:', e.message);
  }
});

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Cashfree auto purchases backend running on port ' + PORT + ', mode=' + cashfreeConfig().mode));
}
