// =============================================
// GameVault Backend — v4 (Firebase + fixes)
// =============================================
const express = require("express");
const cors = require("cors");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const path = require("path");
const fs = require("fs");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// ── Firebase init ──────────────────────────────────────────────
let firebaseApp;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require("./service-account.json");
  firebaseApp = initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  console.error("❌ Firebase başlatılamadı:", e.message);
  console.error("   FIREBASE_SERVICE_ACCOUNT env var veya service-account.json gerekli.");
  process.exit(1);
}
const db = getFirestore(firebaseApp);

// ── Express ────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// ── Basit in-memory cache ──────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttlMs = 60_000) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}

// Basit rate limiter
const rlMap = new Map();
function rateLimit(key, maxPerMin = 10) {
  const now = Date.now();
  const e = rlMap.get(key) || { n: 0, reset: now + 60_000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 60_000; }
  e.n++; rlMap.set(key, e);
  return e.n > maxPerMin;
}

// Koleksiyon referansları
const C = {
  users:    () => db.collection("users"),
  games:    () => db.collection("games"),
  purchases:() => db.collection("purchases"),
  codes:    () => db.collection("codes"),
  support:  () => db.collection("supportRequests"),
  settings: () => db.collection("settings").doc("site"),
  reviews:  () => db.collection("reviews"),
  chat:     () => db.collection("liveChat"),
};

// ══════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════

app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Kullanıcı adı ve şifre gerekli." });
  const key = username.toLowerCase();
  const snap = await C.users().doc(key).get();
  if (snap.exists) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });
  await C.users().doc(key).set({ username, email: email || "", password, balance: 0, createdAt: new Date().toISOString() });
  res.json({ success: true, message: "Kayıt başarılı." });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const snap = await C.users().doc(username?.toLowerCase()).get();
  if (!snap.exists || snap.data().password !== password)
    return res.json({ success: false, message: "Kullanıcı adı veya şifre hatalı." });
  const u = snap.data();
  res.json({ success: true, username: u.username, balance: u.balance, email: u.email || "" });
});

// ══════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════

app.get("/api/stats", async (req, res) => {
  const cached = cacheGet("stats");
  if (cached) return res.json(cached);
  const [usersSnap, gamesSnap, settingsSnap] = await Promise.all([
    C.users().count().get(),
    C.games().count().get(),
    C.settings().get(),
  ]);
  const s = settingsSnap.exists ? settingsSnap.data() : {};
  const result = { success: true, userCount: usersSnap.data().count, gameCount: gamesSnap.data().count, rating: s.rating ?? 5, serverStatus: s.serverStatus ?? true };
  cacheSet("stats", result, 300_000); // 5 dakika
  res.json(result);
});

// ══════════════════════════════════════════════════
// KOD YÜKLEME
// ══════════════════════════════════════════════════

app.post("/api/redeem-code", async (req, res) => {
  const { username, code } = req.body;
  const key = username?.toLowerCase();
  const [uSnap, cSnap] = await Promise.all([C.users().doc(key).get(), C.codes().doc(code?.toUpperCase()).get()]);
  if (!uSnap.exists) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  if (!cSnap.exists) return res.json({ success: false, message: "Geçersiz kod." });
  const cd = cSnap.data();
  if (cd.redeemedBy) return res.json({ success: false, message: "Bu kod daha önce kullanıldı." });

  // ── Exclusive kod: direkt oyun ver, bakiye değiştirme ──
  if (cd.exclusive && cd.exclusiveGameId) {
    const gSnap = await C.games().doc(cd.exclusiveGameId).get();
    if (!gSnap.exists) return res.json({ success: false, message: "Bağlı oyun bulunamadı." });
    const g = gSnap.data();
    const pid = Date.now().toString();
    await Promise.all([
      C.codes().doc(code.toUpperCase()).update({ redeemedBy: username, redeemedAt: new Date().toISOString() }),
      C.purchases().doc(pid).set({
        username,
        gameId: cd.exclusiveGameId,
        gameName: g.name,
        gameEmoji: g.emoji || "🎮",
        steamUser: g.steamUser,
        steamPass: g.steamPass,
        gmailUser: g.gmailUser,
        gmailPass: g.gmailPass,
        purchasedAt: new Date().toISOString(),
        steamCodeRequests: 0,
        lastSteamCode: null,
        requiresCode: g.requiresCode !== false,
        fromExclusiveCode: code.toUpperCase(),
      }),
    ]);
    cache.delete("recent-purchases");
    const u = uSnap.data();
    return res.json({
      success: true,
      exclusive: true,
      balance: u.balance,
      added: 0,
      gameName: g.name,
      gameEmoji: g.emoji || "🎮",
      purchaseId: pid,
      steamUser: g.steamUser,
      steamPass: g.steamPass,
      requiresCode: g.requiresCode !== false,
    });
  }

  // ── Normal kod: bakiye ekle ──
  const newBal = (uSnap.data().balance || 0) + (cd.balance || 1);
  await Promise.all([
    C.users().doc(key).update({ balance: newBal }),
    C.codes().doc(code.toUpperCase()).update({ redeemedBy: username, redeemedAt: new Date().toISOString() }),
  ]);
  res.json({ success: true, exclusive: false, balance: newBal, added: cd.balance || 1 });
});

// ══════════════════════════════════════════════════
// OYUNLAR
// ══════════════════════════════════════════════════

app.get("/api/games", async (req, res) => {
  const cached = cacheGet("games");
  if (cached) return res.json({ success: true, games: cached });
  const snap = await C.games().get();
  const games = snap.docs.map(d => {
    const { gmailPass, steamPass, steamUser, gmailUser, ...rest } = d.data();
    return { id: d.id, ...rest };
  }).sort((a,b) => (a.createdAt||"").localeCompare(b.createdAt||""));
  cacheSet("games", games, 600_000); // 10 dakika
  res.json({ success: true, games });
});

app.get("/api/popular-games", async (req, res) => {
  const cached = cacheGet("popular-games");
  if (cached) return res.json({ success: true, games: cached });
  const snap = await C.games().get();
  const games = snap.docs.map(d => {
    const { gmailPass, steamPass, steamUser, gmailUser, ...rest } = d.data();
    return { id: d.id, ...rest };
  }).filter(g => g.popular)
    .sort((a,b) => (a.popularOrder||99) - (b.popularOrder||99))
    .slice(0,6);
  cacheSet("popular-games", games, 600_000); // 10 dakika
  res.json({ success: true, games });
});

// ══════════════════════════════════════════════════
// SATIN ALMA
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
// KOD İLE SATIN ALMA (anonim — kullanıcı hesabı yok)
// 1. Kod kontrol edilir (normal bakiye kodu)
// 2. Oyun seçilir
// 3. Kod kullanılır → purchase oluşturulur
// ══════════════════════════════════════════════════

// Kodu doğrula (oyun seçmeden önce)
app.post("/api/verify-code", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, message: "Kod gerekli." });
  const cSnap = await C.codes().doc(code.toUpperCase()).get();
  if (!cSnap.exists) return res.json({ success: false, message: "Geçersiz kod." });
  const cd = cSnap.data();
  if (cd.redeemedBy) return res.json({ success: false, message: "Bu kod zaten kullanılmış." });
  if (cd.exclusive) {
    // Exclusive kod: direkt oyuna bağlı, oyun seçimi yok
    return res.json({ success: true, type: "exclusive", exclusiveGameId: cd.exclusiveGameId, exclusiveGameName: cd.exclusiveGameName });
  }
  return res.json({ success: true, type: "normal", balance: cd.balance || 1 });
});

// Kod + oyun ile satın al
app.post("/api/purchase-with-code", async (req, res) => {
  const { code, gameId } = req.body;
  if (!code || !gameId) return res.json({ success: false, message: "Kod ve oyun ID gerekli." });
  const [cSnap, gSnap] = await Promise.all([
    C.codes().doc(code.toUpperCase()).get(),
    C.games().doc(gameId).get(),
  ]);
  if (!cSnap.exists) return res.json({ success: false, message: "Geçersiz kod." });
  if (!gSnap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  const cd = cSnap.data(), g = gSnap.data();
  if (cd.redeemedBy) return res.json({ success: false, message: "Bu kod zaten kullanılmış." });
  if (cd.exclusive) return res.json({ success: false, message: "Özel kod farklı bir oyuna bağlıdır." });
  if (g.exclusive) return res.json({ success: false, message: "Bu özel oyun için özel kod gereklidir." });
  const pid = Date.now().toString();
  await Promise.all([
    C.codes().doc(code.toUpperCase()).update({ redeemedBy: code.toUpperCase(), redeemedAt: new Date().toISOString(), usedForGameId: gameId, usedForGameName: g.name }),
    C.purchases().doc(pid).set({
      code: code.toUpperCase(),
      gameId, gameName: g.name, gameEmoji: g.emoji || "🎮",
      steamUser: g.steamUser, steamPass: g.steamPass,
      gmailUser: g.gmailUser, gmailPass: g.gmailPass,
      purchasedAt: new Date().toISOString(),
      steamCodeRequests: 0, lastSteamCode: null,
      requiresCode: g.requiresCode !== false,
    }),
  ]);
  cache.delete("recent-purchases");
  res.json({ success: true, purchaseId: pid, gameName: g.name, steamUser: g.steamUser, steamPass: g.steamPass, requiresCode: g.requiresCode !== false });
});

// Kod ile satın alınan oyunu görüntüle
app.post("/api/my-purchase-by-code", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, message: "Kod gerekli." });
  const cSnap = await C.codes().doc(code.toUpperCase()).get();
  if (!cSnap.exists) return res.json({ success: false, message: "Geçersiz kod." });
  const cd = cSnap.data();
  if (!cd.redeemedBy) return res.json({ success: false, message: "Bu kod henüz kullanılmamış." });
  // purchases koleksiyonunda bu kodu bul
  const pSnap = await C.purchases().where("code", "==", code.toUpperCase()).limit(1).get();
  if (pSnap.empty) return res.json({ success: false, message: "Satın alım bulunamadı." });
  const p = pSnap.docs[0].data();
  const pid = pSnap.docs[0].id;
  res.json({
    success: true,
    purchaseId: pid,
    gameName: p.gameName, gameEmoji: p.gameEmoji,
    steamUser: p.steamUser, steamPass: p.steamPass,
    steamCodeRequests: p.steamCodeRequests || 0,
    lastSteamCode: p.lastSteamCode || null,
    requiresCode: p.requiresCode !== false,
  });
});

// Eski purchase endpoint — artık kullanılmıyor, compat için bırakıldı
app.post("/api/purchase", async (req, res) => {
  res.json({ success: false, message: "Bu endpoint artık kullanılmıyor. /api/purchase-with-code kullanın." });
});

// my-purchases — artık kod bazlı sistem kullanıldığı için /api/my-purchase-by-code endpoint'i kullanılıyor
app.get("/api/my-purchases", async (req, res) => {
  res.json({ success: true, purchases: [] });
});

app.get("/api/recent-purchases", async (req, res) => {
  const cached = cacheGet("recent-purchases");
  if (cached) return res.json({ success: true, purchases: cached });
  // Sadece son 50 kaydı çek — tüm koleksiyonu okuma
  const snap = await C.purchases().orderBy("purchasedAt", "desc").limit(50).get();
  const purchases = snap.docs
    .map(d => { const p = d.data(); return { username: p.username ? p.username.substring(0,3)+"***" : "???", gameName: p.gameName, gameEmoji: p.gameEmoji || "🎮", purchasedAt: p.purchasedAt }; })
    .slice(0,30);
  cacheSet("recent-purchases", purchases, 300_000); // 5 dakika
  res.json({ success: true, purchases });
});

// ══════════════════════════════════════════════════
// STEAM KODU — GELİŞTİRİLMİŞ
// ══════════════════════════════════════════════════

app.post("/api/get-steam-code", async (req, res) => {
  const { purchaseId } = req.body;
  const snap = await C.purchases().doc(purchaseId).get();
  if (!snap.exists) return res.json({ success: false, message: "Satın alma bulunamadı." });
  const p = snap.data();
  // steamCodeRequests negatifse admin bonus hak vermiş (örn: -3 = 8 hak kapasitesi)
  const maxRequests = Math.max(5, 5 + Math.abs(Math.min(0, p.steamCodeRequests || 0)));
  if ((p.steamCodeRequests || 0) >= maxRequests)
    return res.json({ success: false, message: `Maksimum doğrulama talebi aşıldı (${maxRequests}/${maxRequests}).`, limitReached: true });
  try {
    const steamCode = await fetchSteamCodeFromGmail(p.gmailUser, p.gmailPass);
    const newReqs = (p.steamCodeRequests || 0) + 1;
    const upd = { steamCodeRequests: newReqs };
    if (steamCode) upd.lastSteamCode = steamCode;
    await C.purchases().doc(purchaseId).update(upd);
    const maxReqs = Math.max(5, 5 + Math.abs(Math.min(0, p.steamCodeRequests || 0)));
    const left = maxReqs - newReqs;
    if (!steamCode) return res.json({ success: false, message: "Kod henüz gelmedi. 20-30 saniye bekleyip tekrar dene.", requestsLeft: left, maxRequests: maxReqs });
    res.json({ success: true, steamCode, steamUser: p.steamUser, steamPass: p.steamPass, requestsLeft: left, maxRequests: maxReqs });
  } catch (err) {
    console.error("Steam kodu hatası:", err.message);
    res.json({ success: false, message: "Mail sunucusuna bağlanılamadı." });
  }
});

// ══════════════════════════════════════════════════
// DESTEK
// ══════════════════════════════════════════════════

app.post("/api/support-request", async (req, res) => {
  const { username, message, type } = req.body;
  if (!username || !message) return res.json({ success: false, message: "Eksik bilgi." });
  await C.support().add({ username, message, type: type || "general", createdAt: new Date().toISOString(), status: "open", adminReply: null });
  res.json({ success: true, message: "Destek talebiniz alındı." });
});

app.get("/api/my-support", async (req, res) => {
  const { username } = req.query;
  const snap = await C.support().where("username", "==", username).get();
  const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));
  res.json({ success: true, tickets });
});

// ══════════════════════════════════════════════════
// ADMIN — OYUNLAR
// ══════════════════════════════════════════════════

app.post("/api/admin/get-games", async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.games().get();
  const games = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.createdAt||"").localeCompare(b.createdAt||""));
  res.json({ success: true, games });
});

app.post("/api/admin/add-game", async (req, res) => {
  const { adminKey, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji, imageUrl, accountType } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const id = Date.now().toString();
  // Steam Guard: default true — sadece açıkça 'false' gönderilirse kapalı sayılır
  const requiresCodeVal = req.body.requiresCode !== "false";
  const gd = {
    name: gameName,
    steamUser: steamUser || null,
    steamPass: steamPass || null,
    gmailUser: requiresCodeVal ? (gmailUser || null) : null,
    gmailPass: requiresCodeVal ? (gmailPass || null) : null,
    emoji: emoji || "🎮",
    platform: platform || "PC / Steam",
    price: price || "Hesap",
    image: imageUrl || null,
    requiresCode: requiresCodeVal,
    accountType: accountType || (requiresCodeVal ? "personal" : "general"),
    createdAt: new Date().toISOString()
  };
  await C.games().doc(id).set(gd);
  cache.delete("games"); cache.delete("popular-games"); cache.delete("stats"); cache.delete("recent-purchases");
  const { gmailPass: _gp, steamPass: _sp, ...safe } = gd;
  res.json({ success: true, message: "Oyun eklendi.", game: { id, ...safe } });
});

app.post("/api/admin/edit-game", async (req, res) => {
  const { adminKey, gameId, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji, imageUrl, accountType } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.games().doc(gameId).get();
  if (!snap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  const existing = snap.data();
  // FIX: boş string gelirse mevcut değeri koru (kaydet butonu sorunu)
  const upd = {
    name:        gameName    || existing.name,
    platform:    platform    || existing.platform,
    price:       price       || existing.price,
    emoji:       emoji       || existing.emoji,
    steamUser:   steamUser   || existing.steamUser,
    steamPass:   steamPass   || existing.steamPass,
    gmailUser:   gmailUser   !== undefined ? (gmailUser || existing.gmailUser) : existing.gmailUser,
    gmailPass:   gmailPass   !== undefined ? (gmailPass || existing.gmailPass) : existing.gmailPass,
    accountType: accountType || existing.accountType,
    requiresCode: req.body.requiresCode !== "false",
    image:       imageUrl !== undefined && imageUrl !== "" ? imageUrl : (existing.image || null),
    // exclusive alanları koru — sadece toggle endpoint'ten değişsin
    exclusive:       existing.exclusive       || false,
    exclusiveGameId: existing.exclusiveGameId || null,
  };
  await C.games().doc(gameId).update(upd);
  cache.delete("games"); cache.delete("popular-games");
  res.json({ success: true, message: "Oyun güncellendi." });
});

app.post("/api/admin/delete-game", async (req, res) => {
  const { adminKey, gameId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  await C.games().doc(gameId).delete();
  cache.delete("games"); cache.delete("popular-games"); cache.delete("stats"); cache.delete("recent-purchases");
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// ADMIN — KODLAR
// ══════════════════════════════════════════════════

app.post("/api/admin/add-code", async (req, res) => {
  const { adminKey, code, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  await C.codes().doc(code.toUpperCase()).set({ balance: balance || 1, redeemedBy: null, redeemedAt: null, createdAt: new Date().toISOString() });
  res.json({ success: true });
});

app.post("/api/admin/get-codes", async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.codes().get();
  const codes = snap.docs.map(d => ({ code: d.id, ...d.data() }))
    .sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));
  res.json({ success: true, codes });
});

app.post("/api/admin/delete-code", async (req, res) => {
  const { adminKey, code } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  await C.codes().doc(code).delete();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// ADMIN — KULLANICILAR
// ══════════════════════════════════════════════════

app.post("/api/admin/get-users", async (req, res) => {
  const { adminKey, search } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.users().get();
  let users = snap.docs.map(d => { const u = d.data(); return { username: u.username, email: u.email || "", balance: u.balance, createdAt: u.createdAt }; });
  if (search) users = users.filter(u => u.username.toLowerCase().includes(search.toLowerCase()) || (u.email||"").toLowerCase().includes(search.toLowerCase()));
  res.json({ success: true, users });
});

app.post("/api/admin/update-balance", async (req, res) => {
  const { adminKey, username, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.users().doc(username?.toLowerCase()).get();
  if (!snap.exists) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  await C.users().doc(username.toLowerCase()).update({ balance: parseInt(balance) });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// ADMIN — SATIN ALMALAR + HAK EKLE
// ══════════════════════════════════════════════════

app.post("/api/admin/get-purchases", async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.purchases().get();
  const purchases = snap.docs
    .map(d => { const p = d.data(); return { id: d.id, code: p.code || p.username || "—", gameName: p.gameName, gameEmoji: p.gameEmoji, purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0 }; })
    .sort((a,b) => (b.purchasedAt||"").localeCompare(a.purchasedAt||""));
  res.json({ success: true, purchases });
});

// Admin — satın alım satırından doğrudan hak iade et
app.post("/api/admin/grant-requests", async (req, res) => {
  const { adminKey, purchaseId, amount } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const ref = C.purchases().doc(purchaseId);
  const snap = await ref.get();
  if (!snap.exists) return res.json({ success: false, message: "Satın alma bulunamadı." });
  const cur = snap.data().steamCodeRequests || 0;
  const add = parseInt(amount) || 3;
  // Negatife izin ver: -3 = 8 hak kapasitesi (5 + 3 bonus)
  const newVal = cur - add;
  await ref.update({ steamCodeRequests: newVal });
  // Kullanıcıya gösterilecek kalan hak = 5 - newVal (negatifse 5+|newVal|)
  const remaining = 5 - newVal;
  res.json({ success: true, newRequests: newVal, remaining });
});

// ══════════════════════════════════════════════════
// ADMIN — DESTEK
// ══════════════════════════════════════════════════

app.post("/api/admin/get-support", async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.support().get();
  const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));
  res.json({ success: true, requests });
});

app.post("/api/admin/reply-support", async (req, res) => {
  const { adminKey, requestId, reply, status, grantExtra } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const ref = C.support().doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) return res.json({ success: false, message: "Talep bulunamadı." });
  const upd = { status: status || "closed", repliedAt: new Date().toISOString() };
  if (reply) upd.adminReply = reply;
  if (grantExtra) {
    const pId = snap.data().purchaseId;
    if (pId) {
      const pSnap = await C.purchases().doc(pId).get();
      if (pSnap.exists) {
        await C.purchases().doc(pId).update({ steamCodeRequests: Math.max(0, (pSnap.data().steamCodeRequests || 0) - 3) });
        upd.extraGranted = true;
      }
    }
  }
  await ref.update(upd);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// ADMIN — AYARLAR
// ══════════════════════════════════════════════════

app.post("/api/admin/update-settings", async (req, res) => {
  const { adminKey, rating, serverStatus } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const upd = {};
  if (rating !== undefined) upd.rating = parseFloat(rating);
  if (serverStatus !== undefined) upd.serverStatus = serverStatus;
  await C.settings().set(upd, { merge: true });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// STEAM KODU IMAP — GELİŞTİRİLMİŞ
// Son 30 dakika, tüm mailler (okunmuş/okunmamış), en yeni kodu döndür
// ══════════════════════════════════════════════════

function fetchSteamCodeFromGmail(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user, password: pass,
      host: "imap.gmail.com", port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000, connTimeout: 20000,
    });

    let settled = false;
    function done(err, val) {
      if (settled) return;
      settled = true;
      try { imap.end(); } catch (_) {}
      if (err) reject(err); else resolve(val);
    }

    imap.once("error", done);
    imap.once("end", () => { if (!settled) done(null, null); });

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) return done(err);

        // Son 30 dakika — sadece FROM filtresi (okunmuş/okunmamış fark etmez)
        const since = new Date(Date.now() - 30 * 60 * 1000);
        imap.search([["FROM", "noreply@steampowered.com"], ["SINCE", since]], (sErr, results) => {
          if (sErr || !results || !results.length) return done(null, null);

          // En yeni 5 mail (results küçükten büyüğe sıralı — son 5 al)
          const toFetch = results.slice(-5);
          const f = imap.fetch(toFetch, { bodies: "", markSeen: false });

          let foundCode = null;
          let pending   = 0;
          let fetchDone = false;

          function tryResolve() {
            if (fetchDone && pending === 0 && !settled) done(null, foundCode);
          }

          f.on("message", (msg) => {
            pending++;
            msg.on("body", (stream) => {
              simpleParser(stream, (pErr, parsed) => {
                if (!pErr && parsed && !foundCode) {
                  const text = (parsed.text || "") + " " + (parsed.html || "");
                  foundCode = extractSteamCode(text);
                }
                pending--;
                tryResolve();
              });
            });
          });

          f.once("error", () => { fetchDone = true; tryResolve(); });
          f.once("end", () => {
            fetchDone = true;
            // simpleParser async olduğu için 3sn ekstra bekle
            setTimeout(() => { if (!settled) done(null, foundCode); }, 3000);
          });
        });
      });
    });

    imap.connect();
  });
}

function extractSteamCode(text) {
  // Kesin Steam Guard pattern'leri
  const strictPatterns = [
    /Steam Guard Mobile Authenticator[^:]*?:\s*([A-Z0-9]{5})\b/i,
    /Steam Guard[^:]*?:\s*([A-Z0-9]{5})\b/i,
    /doğrulama kodu[^:]*?:\s*([A-Z0-9]{5})\b/i,
    /verification code[^:]*?:\s*([A-Z0-9]{5})\b/i,
    /access code[^:]*?:\s*([A-Z0-9]{5})\b/i,
    /your code is[^:]*?:\s*([A-Z0-9]{5})\b/i,
    /font-size:\s*\d+px[^>]*>([A-Z0-9]{5})<\/[a-z]+>/i,
    /letter-spacing[^>]*>([A-Z0-9]{5})<\/[a-z]+>/i,
    /\n\s*([A-Z0-9]{5})\s*\n/,
  ];
  const skip = new Set([
    "STEAM","GUARD","LOGIN","EMAIL","GAMES","VALVE","STORE",
    "TALEP","DESTEK","HESAP","SATIN","ALIMI","OYUNU","OYNA",
    "CLICK","HTTPS","HTTP","GMAIL","INBOX","HELLO","WORLD",
    "TITLE","STYLE","CLASS","COLOR","WIDTH","ALIGN","TABLE",
    "TBODY","THEAD","TFOOT","LABEL","INPUT","TOTAL","PRICE",
    "ORDER","BONUS","EXTRA","POWER","ABOUT","AFTER","AGAIN",
    "EVERY","FIRST","GREAT","GROUP","LARGE","PLACE","RIGHT",
    "THEIR","THERE","THESE","THING","THOSE","THREE","UNDER",
    "UNTIL","USING","WHERE","WHICH","WHILE","WHOLE","WHOSE",
    "WOULD","COULD","FOUND","THINK","NOREPLY","SUPPORT",
  ]);
  for (const pat of strictPatterns) {
    const m = text.match(pat);
    if (m && m[1] && !skip.has(m[1].toUpperCase())) return m[1].toUpperCase();
  }
  // Son çare: rakam içeren 5 karakter blok
  const htmlMatch = text.match(/>([A-HJ-NP-Z2-9]{5})</);
  if (htmlMatch && htmlMatch[1] && !skip.has(htmlMatch[1]) && /[0-9]/.test(htmlMatch[1])) {
    return htmlMatch[1];
  }
  return null;
}

// ══════════════════════════════════════════════════
// POPULAR TOGGLE
// ══════════════════════════════════════════════════

app.post("/api/admin/toggle-popular", async (req, res) => {
  const { adminKey, gameId, popular, popularOrder } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const ref = C.games().doc(gameId);
  const snap = await ref.get();
  if (!snap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  await ref.update({ popular: !!popular, popularOrder: parseInt(popularOrder) || 99 });
  cache.delete("games"); cache.delete("popular-games");
  res.json({ success: true });
});


// ══════════════════════════════════════════════════
// ADMIN — EXCLUSIVE OYUN TOGGLE
// Özel oyun: sadece özel kodla alınabilir, normal bakiye çalışmaz
// ══════════════════════════════════════════════════

app.post("/api/admin/toggle-exclusive", async (req, res) => {
  const { adminKey, gameId, exclusive } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const ref = C.games().doc(gameId);
  const snap = await ref.get();
  if (!snap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  await ref.update({ exclusive: !!exclusive });
  cache.delete("games"); cache.delete("popular-games");
  res.json({ success: true });
});

// Exclusive kod oluştur — belirli bir oyuna bağlı
app.post("/api/admin/add-exclusive-code", async (req, res) => {
  const { adminKey, code, gameId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  if (!code || !gameId) return res.json({ success: false, message: "Kod ve oyun ID zorunlu." });
  const gSnap = await C.games().doc(gameId).get();
  if (!gSnap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  const gameName = gSnap.data().name;
  await C.codes().doc(code.toUpperCase()).set({
    balance: 0,             // normal bakiye vermez
    exclusive: true,
    exclusiveGameId: gameId,
    exclusiveGameName: gameName,
    redeemedBy: null,
    redeemedAt: null,
    createdAt: new Date().toISOString()
  });
  res.json({ success: true, gameName });
});

// ══════════════════════════════════════════════════
// REVIEWS
// ══════════════════════════════════════════════════

app.get("/api/reviews", async (req, res) => {
  const cached = cacheGet("reviews");
  if (cached) return res.json({ success: true, reviews: cached });
  const snap = await C.reviews().get();
  const reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.order||99) - (b.order||99));
  cacheSet("reviews", reviews, 1_800_000); // 30 dakika
  res.json({ success: true, reviews });
});

app.post("/api/admin/add-review", async (req, res) => {
  const { adminKey, username, message, avatar, rating, order } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  if (!username || !message) return res.json({ success: false, message: "Ad ve mesaj zorunlu." });
  const ref = await C.reviews().add({ username, message, avatar: avatar||"😊", rating: parseInt(rating)||5, order: parseInt(order)||99, createdAt: new Date().toISOString() });
  cache.delete("reviews");
  res.json({ success: true, id: ref.id });
});

app.post("/api/admin/update-review", async (req, res) => {
  const { adminKey, reviewId, username, message, avatar, rating, order } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const upd = {};
  if (username !== undefined) upd.username = username;
  if (message !== undefined) upd.message = message;
  if (avatar !== undefined) upd.avatar = avatar;
  if (rating !== undefined) upd.rating = parseInt(rating);
  if (order !== undefined) upd.order = parseInt(order);
  await C.reviews().doc(reviewId).update(upd);
  cache.delete("reviews");
  res.json({ success: true });
});

app.post("/api/admin/delete-review", async (req, res) => {
  const { adminKey, reviewId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  await C.reviews().doc(reviewId).delete();
  cache.delete("reviews");
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// CANLI DESTEK CHAT — SSE Push (Polling YOK)
// Kullanıcı mesaj atınca → admin SSE'ye push
// Admin mesaj atınca → kullanıcı SSE'ye push
// Boşta iken Firestore okuma = 0
// ══════════════════════════════════════════════════

// SSE bağlantıları — kullanıcı ve admin ayrı
const sseUsers  = new Map(); // username → kullanıcı bağlantısı
const sseAdmins = new Map(); // username → admin bağlantısı

function sseSetup(res, map, key) {
  res.set({
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  map.set(key, res);
  // 20sn'de bir keep-alive gönder (Railway proxy timeout'u önler)
  const ka = setInterval(() => {
    if (res.writableEnded) { clearInterval(ka); map.delete(key); return; }
    res.write(": ping\n\n");
  }, 20000);
  return ka;
}

function ssePush(map, key, data) {
  const client = map.get(key);
  if (client && !client.writableEnded) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// Kullanıcı SSE — admin mesajlarını push alır
app.get("/api/chat/subscribe", (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).end();
  const id = username.toLowerCase();
  const ka = sseSetup(res, sseUsers, id);
  req.on("close", () => { sseUsers.delete(id); clearInterval(ka); });
});

// Admin SSE — kullanıcı mesajlarını push alır
app.get("/api/chat/subscribe-admin", (req, res) => {
  const { username, adminKey } = req.query;
  if (!username || adminKey !== process.env.ADMIN_KEY) return res.status(403).end();
  const id = username.toLowerCase();
  const ka = sseSetup(res, sseAdmins, id);
  req.on("close", () => { sseAdmins.delete(id); clearInterval(ka); });
});

// Mesaj gönder — her iki tarafa push
app.post("/api/chat/send", async (req, res) => {
  const { username, message, isAdmin, adminKey } = req.body;
  if (!username || !message) return res.json({ success: false, message: "Eksik alan." });
  if (isAdmin && adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const chatId = username.toLowerCase();
  const now    = new Date().toISOString();
  const sender = isAdmin ? "admin" : "user";

  await C.chat().doc(chatId).collection("messages").add({
    text: message, sender, createdAt: now, read: false
  });
  // get() kaldırıldı — FieldValue.increment ile tek yazma
  const { FieldValue } = require("firebase-admin/firestore");
  await C.chat().doc(chatId).set({
    username, lastMessage: message, lastAt: now,
    unreadUser:  isAdmin ? FieldValue.increment(1) : FieldValue.increment(0),
    unreadAdmin: isAdmin ? FieldValue.increment(0) : FieldValue.increment(1),
  }, { merge: true });

  const msgObj = { text: message, sender, createdAt: now };

  if (isAdmin) {
    // Admin yazdı → kullanıcıya push
    ssePush(sseUsers, chatId, msgObj);
  } else {
    // Kullanıcı yazdı → admin'e push
    ssePush(sseAdmins, chatId, msgObj);
  }

  res.json({ success: true, lastAt: now });
});

// Mesajları getir (sayfa açılınca 1 kez)
app.get("/api/chat/messages", async (req, res) => {
  const { username, adminKey } = req.query;
  if (!username) return res.json({ success: false });
  const rlKey = `chat-msg-${username.toLowerCase()}`;
  if (rateLimit(rlKey, 10)) return res.json({ success: false, message: "Çok fazla istek." });
  const chatId = username.toLowerCase();
  const snap   = await C.chat().doc(chatId).collection("messages").get();
  const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.createdAt||"").localeCompare(b.createdAt||""));
  if (adminKey === process.env.ADMIN_KEY) {
    await C.chat().doc(chatId).set({ unreadAdmin: 0 }, { merge: true });
  } else {
    await C.chat().doc(chatId).set({ unreadUser: 0 }, { merge: true });
  }
  res.json({ success: true, messages });
});

// Tüm chatları listele (admin)
app.post("/api/admin/get-chats", async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.chat().get();
  const chats = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (b.lastAt||"").localeCompare(a.lastAt||""));
  res.json({ success: true, chats });
});

// ══════════════════════════════════════════════════
app.listen(PORT, () => console.log(`✅ GameVault v4 aktif: Port ${PORT}`));
