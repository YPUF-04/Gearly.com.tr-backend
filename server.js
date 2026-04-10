// =============================================
// GameVault Backend — v4 (Firebase + fixes)
// =============================================
const express = require("express");
const cors = require("cors");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const path = require("path");
const multer = require("multer");
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
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `game_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
app.use("/uploads", express.static(UPLOAD_DIR));

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
  const [usersSnap, gamesSnap, settingsSnap] = await Promise.all([
    C.users().count().get(),
    C.games().count().get(),
    C.settings().get(),
  ]);
  const s = settingsSnap.exists ? settingsSnap.data() : {};
  res.json({ success: true, userCount: usersSnap.data().count, gameCount: gamesSnap.data().count, rating: s.rating ?? 5, serverStatus: s.serverStatus ?? true });
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
  const newBal = (uSnap.data().balance || 0) + (cd.balance || 1);
  await Promise.all([
    C.users().doc(key).update({ balance: newBal }),
    C.codes().doc(code.toUpperCase()).update({ redeemedBy: username, redeemedAt: new Date().toISOString() }),
  ]);
  res.json({ success: true, balance: newBal, added: cd.balance || 1 });
});

// ══════════════════════════════════════════════════
// OYUNLAR
// ══════════════════════════════════════════════════

app.get("/api/games", async (req, res) => {
  const snap = await C.games().get();
  const games = snap.docs.map(d => {
    const { gmailPass, steamPass, steamUser, gmailUser, ...rest } = d.data();
    return { id: d.id, ...rest };
  }).sort((a,b) => (a.createdAt||"").localeCompare(b.createdAt||""));
  res.json({ success: true, games });
});

app.get("/api/popular-games", async (req, res) => {
  const snap = await C.games().get();
  const games = snap.docs.map(d => {
    const { gmailPass, steamPass, steamUser, gmailUser, ...rest } = d.data();
    return { id: d.id, ...rest };
  }).filter(g => g.popular)
    .sort((a,b) => (a.popularOrder||99) - (b.popularOrder||99))
    .slice(0,6);
  res.json({ success: true, games });
});

// ══════════════════════════════════════════════════
// SATIN ALMA
// ══════════════════════════════════════════════════

app.post("/api/purchase", async (req, res) => {
  const { username, gameId } = req.body;
  const key = username?.toLowerCase();
  const [uSnap, gSnap] = await Promise.all([C.users().doc(key).get(), C.games().doc(gameId).get()]);
  if (!uSnap.exists) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  if (!gSnap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  const u = uSnap.data(), g = gSnap.data();
  if (u.balance <= 0) return res.json({ success: false, message: "Bakiye yetersiz." });
  const pid = Date.now().toString();
  await Promise.all([
    C.users().doc(key).update({ balance: u.balance - 1 }),
    C.purchases().doc(pid).set({ username, gameId, gameName: g.name, gameEmoji: g.emoji || "🎮", steamUser: g.steamUser, steamPass: g.steamPass, gmailUser: g.gmailUser, gmailPass: g.gmailPass, purchasedAt: new Date().toISOString(), steamCodeRequests: 0, lastSteamCode: null }),
  ]);
  res.json({ success: true, purchaseId: pid, balance: u.balance - 1, gameName: g.name, steamUser: g.steamUser, steamPass: g.steamPass });
});

app.get("/api/my-purchases", async (req, res) => {
  const { username } = req.query;
  const snap = await C.purchases().where("username", "==", username).get();
  const purchases = snap.docs
    .map(d => { const p = d.data(); return { id: d.id, gameName: p.gameName, gameEmoji: p.gameEmoji, steamUser: p.steamUser, steamPass: p.steamPass, purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0, lastSteamCode: p.lastSteamCode || null }; })
    .sort((a,b) => (a.purchasedAt||"").localeCompare(b.purchasedAt||""));
  res.json({ success: true, purchases });
});

app.get("/api/recent-purchases", async (req, res) => {
  const snap = await C.purchases().get();
  const purchases = snap.docs
    .map(d => { const p = d.data(); return { username: p.username ? p.username.substring(0,3)+"***" : "???", gameName: p.gameName, gameEmoji: p.gameEmoji || "🎮", purchasedAt: p.purchasedAt }; })
    .sort((a,b) => (b.purchasedAt||"").localeCompare(a.purchasedAt||""))
    .slice(0,30);
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
  if ((p.steamCodeRequests || 0) >= 5)
    return res.json({ success: false, message: "Maksimum doğrulama talebi aşıldı (5/5).", limitReached: true });
  try {
    const steamCode = await fetchSteamCodeFromGmail(p.gmailUser, p.gmailPass);
    const newReqs = (p.steamCodeRequests || 0) + 1;
    const upd = { steamCodeRequests: newReqs };
    if (steamCode) upd.lastSteamCode = steamCode;
    await C.purchases().doc(purchaseId).update(upd);
    if (!steamCode) return res.json({ success: false, message: "Kod henüz gelmedi. 20-30 saniye bekleyip tekrar dene.", requestsLeft: 5 - newReqs });
    res.json({ success: true, steamCode, steamUser: p.steamUser, steamPass: p.steamPass, requestsLeft: 5 - newReqs });
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

app.post("/api/admin/add-game", upload.single("image"), async (req, res) => {
  const { adminKey, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const id = Date.now().toString();
  const gd = { name: gameName, steamUser, steamPass, gmailUser, gmailPass, emoji: emoji || "🎮", platform: platform || "PC / Steam", price: price || "Hesap", image: req.file ? `/uploads/${req.file.filename}` : null, createdAt: new Date().toISOString() };
  await C.games().doc(id).set(gd);
  const { gmailPass: _gp, steamPass: _sp, ...safe } = gd;
  res.json({ success: true, message: "Oyun eklendi.", game: { id, ...safe } });
});

app.post("/api/admin/edit-game", upload.single("image"), async (req, res) => {
  const { adminKey, gameId, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const snap = await C.games().doc(gameId).get();
  if (!snap.exists) return res.json({ success: false, message: "Oyun bulunamadı." });
  const upd = {};
  if (gameName) upd.name = gameName; if (steamUser) upd.steamUser = steamUser;
  if (steamPass) upd.steamPass = steamPass; if (gmailUser) upd.gmailUser = gmailUser;
  if (gmailPass) upd.gmailPass = gmailPass; if (platform) upd.platform = platform;
  if (price) upd.price = price; if (emoji) upd.emoji = emoji;
  if (req.file) upd.image = `/uploads/${req.file.filename}`;
  await C.games().doc(gameId).update(upd);
  res.json({ success: true, message: "Oyun güncellendi." });
});

app.post("/api/admin/delete-game", async (req, res) => {
  const { adminKey, gameId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  await C.games().doc(gameId).delete();
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
    .map(d => { const p = d.data(); return { id: d.id, username: p.username, gameName: p.gameName, gameEmoji: p.gameEmoji, purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0 }; })
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
  const newVal = Math.max(0, cur - add);
  await ref.update({ steamCodeRequests: newVal });
  res.json({ success: true, newRequests: newVal });
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
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// REVIEWS
// ══════════════════════════════════════════════════

app.get("/api/reviews", async (req, res) => {
  const snap = await C.reviews().get();
  const reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.order||99) - (b.order||99));
  res.json({ success: true, reviews });
});

app.post("/api/admin/add-review", async (req, res) => {
  const { adminKey, username, message, avatar, rating, order } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  if (!username || !message) return res.json({ success: false, message: "Ad ve mesaj zorunlu." });
  const ref = await C.reviews().add({ username, message, avatar: avatar||"😊", rating: parseInt(rating)||5, order: parseInt(order)||99, createdAt: new Date().toISOString() });
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
  res.json({ success: true });
});

app.post("/api/admin/delete-review", async (req, res) => {
  const { adminKey, reviewId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  await C.reviews().doc(reviewId).delete();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════
// CANLI DESTEK CHAT (Admin ↔ Kullanıcı)
// ══════════════════════════════════════════════════

// Kullanıcı mesaj gönderir
app.post("/api/chat/send", async (req, res) => {
  const { username, message, isAdmin, adminKey } = req.body;
  if (!username || !message) return res.json({ success: false, message: "Eksik alan." });
  if (isAdmin && adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const chatId = username.toLowerCase();
  await C.chat().doc(chatId).collection("messages").add({
    text: message, sender: isAdmin ? "admin" : "user",
    createdAt: new Date().toISOString(), read: false
  });
  // Okunmamış mesaj sayısını güncelle
  const chatRef = C.chat().doc(chatId);
  const chatSnap = await chatRef.get();
  const cur = chatSnap.exists ? chatSnap.data() : {};
  await chatRef.set({
    username, lastMessage: message,
    lastAt: new Date().toISOString(),
    unreadUser: isAdmin ? (cur.unreadUser||0) + 1 : cur.unreadUser||0,
    unreadAdmin: isAdmin ? cur.unreadAdmin||0 : (cur.unreadAdmin||0) + 1,
  }, { merge: true });
  res.json({ success: true });
});

// Mesajları getir
app.get("/api/chat/messages", async (req, res) => {
  const { username, adminKey } = req.query;
  if (!username) return res.json({ success: false });
  const chatId = username.toLowerCase();
  const snap = await C.chat().doc(chatId).collection("messages").get();
  const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.createdAt||"").localeCompare(b.createdAt||""));
  // Admin okursa unreadAdmin sıfırla
  if (adminKey === process.env.ADMIN_KEY) {
    await C.chat().doc(chatId).set({ unreadAdmin: 0 }, { merge: true });
  } else {
    await C.chat().doc(chatId).set({ unreadUser: 0 }, { merge: true });
  }
  res.json({ success: true, messages });
});

// Tüm chatları listele (admin için)
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
