// Cashfree Auto Link + Automatic My Purchases + VIP Subscription (TEST) Backend - v3 (auto-purchases-v3-vip-test)
// VIP TEST NOTE: VIP is a 30-day plan sold via the SAME Cashfree payment-link backend, NOT true autopay/NACH.
// True recurring autopay needs Cashfree Subscriptions + mandate, which is NOT activated yet.
// Test VIP: one Cashfree link for Rs 99, backend verifies PAID, then auto-grants isVIP/vipUntil.
// Discount is then AUTOMATIC in Resources (VIP_RATE 0.30 already in Resources code, no Resources change needed).
// Cancel VIP: backend requires Firebase ID token (owner only), sets isVIP false immediately,
// records 60% admin / 40% user refund split. In TEST mode no real money moves, refund is only a record.
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
// VIP TEST PLAN (temporary Rs 99/month, final price user will state later - do NOT treat as final live price)
const VIP_PRICE = 99;
const VIP_DAYS = 30;
const VIP_PLAN = 'Monthly VIP (Test)';

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
  res.json({ ok: true, mode: cfg.mode, keysSet: !!(cfg.appId && cfg.secretKey), adminReady: !!adminDb, adminError: adminInitError || null, version: 'auto-purchases-v3-vip-test' });
});

// ---------- Purchase grant (ek hi jagah, webhook aur check-payment dono isi ko bulate hain) ----------
async function grantPurchase(linkId) {
  if (!adminDb) return { granted: false, error: 'Firebase Admin ready nahi hai. Render me FIREBASE_SERVICE_ACCOUNT_JSON set karo.' };
  const orderRef = adminDb.collection('pending_orders').doc(linkId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { granted: false, error: 'Pending order nahi mila: ' + linkId };
  const order = orderSnap.data();
  const wasPaid = order.status === 'paid';
  // Early return mat karo: agar admin ne galti se purchase doc delete kar diya ho to
  // dobara check-payment karne par wahi purchase wapas ban jani chahiye, warna order paid
  // hone ke baad purchase kabhi wapas nahi aayegi. Neeche ka code har file ka doc check karke
  // sirf missing wali ko dobara banata hai, maujood wali ko chhedta nahi hai.
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
  await userRef.set({ purchases: newPurchases, purchasesUseSubcollection: true }, { merge: true });
  await orderRef.set({ status: 'paid', grantedAt: new Date().toISOString() }, { merge: true });
  return { granted: true, already: wasPaid, files: order.files || [], email: order.email, uid };
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


// ---------- VIP helpers ----------
async function findUidByEmail(email) {
  let uid = null;
  try { if (adminAuth) { const u = await adminAuth.getUserByEmail(email); uid = u.uid; } } catch (e) {}
  if (!uid && adminDb) {
    const q = await adminDb.collection('users').where('email', '==', email).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
  }
  return uid;
}
function vipSplit(price) {
  const adminShare = Math.round(price * 0.6);
  return { adminShare, userRefund: price - adminShare };
}
async function grantVip(linkId) {
  if (!adminDb) return { granted: false, error: 'Firebase Admin ready nahi hai. Render me FIREBASE_SERVICE_ACCOUNT_JSON set karo.' };
  const vipRef = adminDb.collection('pending_vip_orders').doc(linkId);
  const vipSnap = await vipRef.get();
  if (!vipSnap.exists) return { granted: false, error: 'Pending VIP order nahi mila: ' + linkId };
  const order = vipSnap.data();
  const uid = await findUidByEmail(order.email);
  if (!uid) return { granted: false, error: 'User account nahi mila email se: ' + order.email };
  const userRef = adminDb.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const old = userSnap.exists ? userSnap.data() : {};
  const oldUntil = old.vipUntil && typeof old.vipUntil.toDate === 'function' ? old.vipUntil.toDate() : (old.vipUntil ? new Date(old.vipUntil) : null);
  if (order.status === 'paid' && old.isVIP === true && old.vipLinkId === linkId && oldUntil && oldUntil > new Date()) {
    return { granted: true, already: true, email: order.email, uid, vipUntil: oldUntil.toISOString() };
  }
  const price = Number(order.price) || VIP_PRICE;
  const split = vipSplit(price);
  const now = new Date();
  const until = new Date(now.getTime() + VIP_DAYS * 86400000);
  await userRef.set({
    email: order.email, isVIP: true, vipUntil: until, vipStart: now, vipPlan: order.plan || VIP_PLAN,
    vipLinkId: linkId, vipPaidAt: now.toISOString(), vipStatus: 'active', vipPrice: price,
    vipAdminShare: split.adminShare, vipUserRefund: split.userRefund, vipRefundStatus: null, vipCancelAt: null,
  }, { merge: true });
  await vipRef.set({ status: 'paid', grantedAt: now.toISOString() }, { merge: true });
  return { granted: true, already: false, email: order.email, uid, vipUntil: until.toISOString(), vipPrice: price };
}
async function verifyAndGrantVip(linkId) {
  const cfg = cashfreeConfig();
  if (!cfg.appId || !cfg.secretKey) return { paid: false, error: 'Cashfree keys set nahi hain.' };
  const cf = await cashfreeReq(cfg.baseUrl, '/links/' + encodeURIComponent(linkId), 'GET', cfg.appId, cfg.secretKey, null);
  if (!cf.ok) return { paid: false, error: 'Cashfree VIP link check fail: ' + (cf.data.message || JSON.stringify(cf.data).slice(0, 200)) };
  const status = String(cf.data.link_status || '').toUpperCase();
  if (status !== 'PAID') return { paid: false, status, linkId };
  const g = await grantVip(linkId);
  if (!g.granted) return { paid: true, status, granted: false, error: g.error };
  return { paid: true, status, granted: true, already: !!g.already, email: g.email, vipUntil: g.vipUntil, vipPrice: g.vipPrice };
}

// ---------- VIP link banao (TEST) ----------
app.post('/api/vip-link', async (req, res) => {
  try {
    const cfg = cashfreeConfig();
    if (!cfg.appId || !cfg.secretKey) return res.status(500).json({ error: 'Cashfree keys backend me set nahi hain.' });
    const { email, returnUrl } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Login email nahi mila. Dobara login karke Buy VIP dabao.' });
    if (adminDb) {
      const uid = await findUidByEmail(email);
      if (uid) {
        const snap = await adminDb.collection('users').doc(uid).get();
        if (snap.exists) {
          const d = snap.data();
          const until = d.vipUntil && typeof d.vipUntil.toDate === 'function' ? d.vipUntil.toDate() : (d.vipUntil ? new Date(d.vipUntil) : null);
          if (d.isVIP === true && until && until > new Date()) {
            return res.status(400).json({ error: 'VIP pehle se active hai, expiry: ' + until.toISOString().slice(0, 10) + '. Pehle cancel karo ya expiry ka wait karo.' });
          }
        }
      }
    }
    const linkId = 'lca_vip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const customerName = String(email).split('@')[0] || 'LCA Customer';
    const base = publicUrl();
    const linkMeta = {};
    if (base) linkMeta.notify_url = base + '/api/cashfree-webhook';
    if (returnUrl) linkMeta.return_url = returnUrl;
    const cf = await cashfreeReq(cfg.baseUrl, '/links', 'POST', cfg.appId, cfg.secretKey, {
      link_id: linkId, link_amount: VIP_PRICE, link_currency: 'INR', link_purpose: 'Light Console Academy - VIP Monthly (Test)',
      customer_details: { customer_name: customerName, customer_phone: '9999999999', customer_email: email },
      link_notify: { send_email: false, send_sms: false },
      link_meta: linkMeta,
    });
    if (!cf.ok || !cf.data.link_url) {
      const msg = cf.data.message || cf.data.error || (cf.data.errors && cf.data.errors[0] && cf.data.errors[0].message) || JSON.stringify(cf.data).slice(0, 300);
      return res.status(502).json({ error: 'Cashfree se VIP link nahi bana: ' + msg, cashfree: cf.data });
    }
    if (adminDb) {
      try {
        await adminDb.collection('pending_vip_orders').doc(linkId).set({
          link_id: linkId, email, plan: VIP_PLAN, price: VIP_PRICE, durationDays: VIP_DAYS, status: 'pending', mode: cfg.mode, createdAt: new Date().toISOString(),
        });
      } catch (e) { console.log('pending vip order save fail:', e.message); }
    }
    return res.json({ link_url: cf.data.link_url, link_id: cf.data.link_id || linkId, amount: VIP_PRICE, plan: VIP_PLAN, durationDays: VIP_DAYS, mode: cfg.mode });
  } catch (e) {
    return res.status(500).json({ error: 'Backend error: ' + e.message });
  }
});

// ---------- VIP return check ----------
app.post('/api/check-vip-payment', async (req, res) => {
  try {
    const { link_id } = req.body || {};
    if (!link_id) return res.status(400).json({ error: 'link_id nahi mila.' });
    const out = await verifyAndGrantVip(link_id);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'Backend error: ' + e.message });
  }
});

// ---------- VIP cancel (owner only, Firebase ID token required) ----------
app.post('/api/cancel-vip', async (req, res) => {
  try {
    if (!adminDb || !adminAuth) return res.status(500).json({ error: 'Firebase Admin ready nahi hai.' });
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Login token nahi mila. Dobara login karke Cancel dabao.' });
    let decoded;
    try { decoded = await adminAuth.verifyIdToken(token); } catch (e) { return res.status(401).json({ error: 'Login token invalid hai. Dobara login karo.' }); }
    const uid = decoded.uid;
    const userRef = adminDb.collection('users').doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'User doc nahi mila.' });
    const d = snap.data();
    const until = d.vipUntil && typeof d.vipUntil.toDate === 'function' ? d.vipUntil.toDate() : (d.vipUntil ? new Date(d.vipUntil) : null);
    if (!(d.isVIP === true && until && until > new Date())) {
      return res.status(400).json({ error: 'Koi active VIP nahi hai jo cancel ho sake. VIP pehle se expire ya cancel hai.' });
    }
    const price = Number(d.vipPrice) || VIP_PRICE;
    const split = vipSplit(price);
    const now = new Date();
    await userRef.set({
      isVIP: false, vipStatus: 'cancelled', vipCancelAt: now, vipRefundAmount: split.userRefund,
      vipAdminShare: split.adminShare, vipRefundStatus: 'pending',
    }, { merge: true });
    await adminDb.collection('vip_cancellations').doc(uid + '_' + now.getTime()).set({
      uid, email: d.email || decoded.email || '', vipLinkId: d.vipLinkId || '', vipPrice: price,
      adminShare: split.adminShare, userRefund: split.userRefund, cancelledAt: now.toISOString(), refundStatus: 'pending',
    });
    return res.json({ cancelled: true, vipPrice: price, adminShare: split.adminShare, userRefund: split.userRefund, refundNote: 'Refund 5-7 working days me original payment method par aayega (TEST mode me asli paisa nahi hilta, sirf record banega).' });
  } catch (e) {
    return res.status(500).json({ error: 'Backend error: ' + e.message });
  }
});

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

// ---------- Migrate: purani array-only purchases ko subcollection me copy karo ----------
// Body: { email } - sirf wahi files copy hongi jo user doc ke purchases array me pehle se hain,
// koi nayi file invent nahi hogi. Isse paid_file_links ka permission-denied thik hoga,
// kyunki rules subcollection doc ko check karta hai.
app.post('/api/migrate-purchases', async (req, res) => {
  try {
    if (!adminDb) return res.status(500).json({ error: 'Firebase Admin ready nahi hai.' });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email nahi mila.' });
    let uid = null;
    try { if (adminAuth) { const u = await adminAuth.getUserByEmail(email); uid = u.uid; } } catch (e) {}
    if (!uid) {
      const q = await adminDb.collection('users').where('email', '==', email).limit(1).get();
      if (!q.empty) uid = q.docs[0].id;
    }
    if (!uid) return res.status(404).json({ error: 'User account nahi mila email se: ' + email });
    const userRef = adminDb.collection('users').doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'User doc nahi mila.' });
    const arr = Array.isArray(snap.data().purchases) ? snap.data().purchases : [];
    let migrated = 0;
    for (const p of arr) {
      const fileId = String(typeof p === 'string' ? p : (p.fileId || '')).toLowerCase();
      if (!fileId) continue;
      await userRef.collection('purchases').doc(fileId).set({
        fileId, fileName: (typeof p === 'object' && p.fileName) ? p.fileName : (FILE_TITLES[fileId] || fileId),
        amount: (typeof p === 'object' && p.amount) ? Number(p.amount) : 0,
        cashfreeLinkId: (typeof p === 'object' && p.cashfreeLinkId) ? p.cashfreeLinkId : 'manual',
        paidAt: (typeof p === 'object' && p.paidAt) ? p.paidAt : new Date().toISOString(),
      }, { merge: true });
      migrated++;
    }
    await userRef.set({ purchasesUseSubcollection: true }, { merge: true });
    return res.json({ ok: true, uid, migrated, totalArray: arr.length });
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
    let out;
    if (adminDb) {
      try {
        const vipSnap = await adminDb.collection('pending_vip_orders').doc(linkId).get();
        out = vipSnap.exists ? await verifyAndGrantVip(linkId) : await verifyAndGrant(linkId);
      } catch (e) { out = await verifyAndGrant(linkId); }
    } else {
      out = await verifyAndGrant(linkId);
    }
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
