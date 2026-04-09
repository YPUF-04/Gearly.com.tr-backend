// =============================================
// GameVault Backend — v3
// =============================================
const express = require("express");
const cors = require("cors");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => { const ext = path.extname(file.originalname); cb(null, `game_${Date.now()}${ext}`); }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ codes: {}, games: [], users: {}, purchases: [], siteSettings: { rating: 5, serverStatus: true }, supportRequests: [] }));
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE));
  if (!data.users) data.users = {};
  if (!data.purchases) data.purchases = [];
  if (!data.siteSettings) data.siteSettings = { rating: 5, serverStatus: true };
  if (!data.supportRequests) data.supportRequests = [];
  return data;
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// KAYIT / GİRİŞ
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Kullanıcı adı ve şifre gerekli." });
  const db = loadDB();
  const key = username.toLowerCase();
  if (db.users[key]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });
  db.users[key] = { username, password, createdAt: new Date().toISOString(), balance: 0 };
  saveDB(db);
  res.json({ success: true, message: "Kayıt başarılı." });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const db = loadDB();
  const key = username?.toLowerCase();
  const user = db.users[key];
  if (!user || user.password !== password) return res.json({ success: false, message: "Kullanıcı adı veya şifre hatalı." });
  res.json({ success: true, username: user.username, balance: user.balance });
});

// İSTATİSTİKLER
app.get("/api/stats", (req, res) => {
  const db = loadDB();
  res.json({ success: true, userCount: Object.keys(db.users).length, gameCount: db.games.length, rating: (db.siteSettings || {}).rating || 5, serverStatus: (db.siteSettings || {}).serverStatus !== false });
});

// DESTEK TALEBİ
app.post("/api/support-request", (req, res) => {
  const { username, message, type } = req.body;
  if (!username || !message) return res.json({ success: false, message: "Eksik bilgi." });
  const db = loadDB();
  db.supportRequests.push({ id: Date.now().toString(), username, message, type: type || "general", createdAt: new Date().toISOString(), status: "open", adminReply: null });
  saveDB(db);
  res.json({ success: true, message: "Destek talebiniz alındı." });
});

// KOD YÜKLEME
app.post("/api/redeem-code", (req, res) => {
  const { username, code } = req.body;
  const db = loadDB();
  const userKey = username?.toLowerCase();
  const user = db.users[userKey];
  const entry = db.codes[code?.toUpperCase()];
  if (!user) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  if (!entry) return res.json({ success: false, message: "Geçersiz kod." });
  if (entry.redeemedBy) return res.json({ success: false, message: "Bu kod daha önce kullanıldı." });
  entry.redeemedBy = username;
  entry.redeemedAt = new Date().toISOString();
  user.balance += entry.balance;
  saveDB(db);
  res.json({ success: true, balance: user.balance, added: entry.balance });
});

// OYUNLAR
app.get("/api/games", (req, res) => {
  const db = loadDB();
  const safeGames = db.games.map(({ gmailPass, steamPass, steamUser, gmailUser, ...rest }) => rest);
  res.json({ success: true, games: safeGames });
});

// SATIN AL
app.post("/api/purchase", (req, res) => {
  const { username, gameId } = req.body;
  const db = loadDB();
  const userKey = username?.toLowerCase();
  const user = db.users[userKey];
  const game = db.games.find(g => g.id === gameId);
  if (!user) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  if (!game) return res.json({ success: false, message: "Oyun bulunamadı." });
  if (user.balance <= 0) return res.json({ success: false, message: "Bakiye yetersiz." });
  const purchaseId = Date.now().toString();
  user.balance -= 1;
  db.purchases.push({ id: purchaseId, username, gameId, gameName: game.name, gameEmoji: game.emoji, steamUser: game.steamUser, steamPass: game.steamPass, gmailUser: game.gmailUser, gmailPass: game.gmailPass, purchasedAt: new Date().toISOString(), steamCodeRequests: 0, lastSteamCode: null });
  saveDB(db);
  res.json({ success: true, purchaseId, balance: user.balance, gameName: game.name, steamUser: game.steamUser, steamPass: game.steamPass });
});

// GEÇMİŞ
app.get("/api/my-purchases", (req, res) => {
  const { username } = req.query;
  const db = loadDB();
  const purchases = db.purchases.filter(p => p.username?.toLowerCase() === username?.toLowerCase()).map(p => ({ id: p.id, gameName: p.gameName, gameEmoji: p.gameEmoji, steamUser: p.steamUser, steamPass: p.steamPass, purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0, lastSteamCode: p.lastSteamCode }));
  res.json({ success: true, purchases });
});

// STEAM KODU
app.post("/api/get-steam-code", async (req, res) => {
  const { purchaseId } = req.body;
  const db = loadDB();
  const purchase = db.purchases.find(p => p.id === purchaseId);
  if (!purchase) return res.json({ success: false, message: "Satın alma bulunamadı." });
  if (purchase.steamCodeRequests >= 5) return res.json({ success: false, message: "Maksimum doğrulama talebi aşıldı (5/5).", limitReached: true });
  try {
    const steamCode = await fetchSteamCodeFromGmail(purchase.gmailUser, purchase.gmailPass);
    purchase.steamCodeRequests = (purchase.steamCodeRequests || 0) + 1;
    if (steamCode) purchase.lastSteamCode = steamCode;
    saveDB(db);
    if (!steamCode) return res.json({ success: false, message: "Kod henüz gelmedi. 30 saniye sonra tekrar dene.", requestsLeft: 5 - purchase.steamCodeRequests });
    res.json({ success: true, steamCode, steamUser: purchase.steamUser, steamPass: purchase.steamPass, requestsLeft: 5 - purchase.steamCodeRequests });
  } catch (err) {
    res.json({ success: false, message: "Mail sunucusuna bağlanılamadı." });
  }
});

// ADMIN: OYUN EKLE
app.post("/api/admin/add-game", upload.single("image"), (req, res) => {
  const { adminKey, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  const newGame = { id: Date.now().toString(), name: gameName, steamUser, steamPass, gmailUser, gmailPass, emoji: emoji || "🎮", platform: platform || "PC / Steam", price: price || "Hesap", image: req.file ? `/uploads/${req.file.filename}` : null, createdAt: new Date().toISOString() };
  db.games.push(newGame);
  saveDB(db);
  res.json({ success: true, message: "Oyun eklendi.", game: { ...newGame, gmailPass: undefined, steamPass: undefined } });
});

// ADMIN: OYUN DÜZENLE
app.post("/api/admin/edit-game", upload.single("image"), (req, res) => {
  const { adminKey, gameId, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  const idx = db.games.findIndex(g => g.id === gameId);
  if (idx === -1) return res.json({ success: false, message: "Oyun bulunamadı." });
  const game = db.games[idx];
  if (gameName) game.name = gameName;
  if (steamUser) game.steamUser = steamUser;
  if (steamPass) game.steamPass = steamPass;
  if (gmailUser) game.gmailUser = gmailUser;
  if (gmailPass) game.gmailPass = gmailPass;
  if (platform) game.platform = platform;
  if (price) game.price = price;
  if (emoji) game.emoji = emoji;
  if (req.file) game.image = `/uploads/${req.file.filename}`;
  saveDB(db);
  res.json({ success: true, message: "Oyun güncellendi." });
});

// ADMIN: OYUN SİL
app.post("/api/admin/delete-game", (req, res) => {
  const { adminKey, gameId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  db.games = db.games.filter(g => g.id !== gameId);
  saveDB(db);
  res.json({ success: true });
});

// ADMIN: KOD OLUŞTUR
app.post("/api/admin/add-code", (req, res) => {
  const { adminKey, code, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  db.codes[code.toUpperCase()] = { balance: balance || 1, redeemedBy: null, redeemedAt: null, createdAt: new Date().toISOString() };
  saveDB(db);
  res.json({ success: true });
});

app.post("/api/admin/get-codes", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  res.json({ success: true, codes: Object.entries(db.codes).map(([code, data]) => ({ code, ...data })) });
});

app.post("/api/admin/get-users", (req, res) => {
  const { adminKey, search } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  let users = Object.entries(db.users).map(([k, u]) => ({ username: u.username, balance: u.balance, createdAt: u.createdAt }));
  if (search) users = users.filter(u => u.username.toLowerCase().includes(search.toLowerCase()));
  res.json({ success: true, users });
});

app.post("/api/admin/update-balance", (req, res) => {
  const { adminKey, username, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  const key = username?.toLowerCase();
  if (!db.users[key]) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  db.users[key].balance = parseInt(balance);
  saveDB(db);
  res.json({ success: true });
});

app.post("/api/admin/get-purchases", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  res.json({ success: true, purchases: db.purchases.map(p => ({ id: p.id, username: p.username, gameName: p.gameName, purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0 })) });
});

app.post("/api/admin/get-games", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  res.json({ success: true, games: db.games });
});

// ADMIN: SİTE AYARLARI
app.post("/api/admin/update-settings", (req, res) => {
  const { adminKey, rating, serverStatus } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  if (!db.siteSettings) db.siteSettings = {};
  if (rating !== undefined) db.siteSettings.rating = parseFloat(rating);
  if (serverStatus !== undefined) db.siteSettings.serverStatus = serverStatus;
  saveDB(db);
  res.json({ success: true });
});

// ADMIN: DESTEK
app.post("/api/admin/get-support", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  res.json({ success: true, requests: db.supportRequests || [] });
});

app.post("/api/admin/reply-support", (req, res) => {
  const { adminKey, requestId, reply, status, grantExtra } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  const r = db.supportRequests.find(x => x.id === requestId);
  if (!r) return res.json({ success: false, message: "Talep bulunamadı." });
  if (reply) r.adminReply = reply;
  if (status) r.status = status;
  r.repliedAt = new Date().toISOString();

  // Ek hak ver: purchase'ın steamCodeRequests sayısını 3 geri al (min 0)
  if (grantExtra && r.purchaseId) {
    const purchase = db.purchases.find(p => p.id === r.purchaseId);
    if (purchase) {
      purchase.steamCodeRequests = Math.max(0, (purchase.steamCodeRequests || 0) - 3);
      r.extraGranted = true;
    }
  }

  saveDB(db);
  res.json({ success: true });
});

// ADMIN: KOD SİL
app.post("/api/admin/delete-code", (req, res) => {
  const { adminKey, code } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  if (!db.codes[code]) return res.json({ success: false, message: "Kod bulunamadı." });
  delete db.codes[code];
  saveDB(db);
  res.json({ success: true });
});

function fetchSteamCodeFromGmail(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password: pass,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
      connTimeout: 15000
    });

    let settled = false;
    function done(err, val) {
      if (settled) return;
      settled = true;
      try { imap.end(); } catch(_) {}
      if (err) reject(err); else resolve(val);
    }

    imap.once("error", (err) => done(err));
    imap.once("end", () => { if (!settled) done(null, null); });

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) return done(err);

        const since = new Date();
        since.setMinutes(since.getMinutes() - 15);

        // Hem UNSEEN hem de son 15 dakika içindeki tüm Steam mailerlarını ara
        imap.search([["FROM", "noreply@steampowered.com"], ["SINCE", since]], (err, results) => {
          if (err || !results || results.length === 0) return done(null, null);

          // En son maili al
          const toFetch = results.slice(-3); // Son 3 maile bak
          const f = imap.fetch(toFetch, { bodies: "" });
          let foundCode = null;
          let pending = 0;

          f.on("message", (msg) => {
            pending++;
            msg.on("body", (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (!err && parsed) {
                  const text = (parsed.text || "") + (parsed.html || "");
                  // Steam 5 haneli doğrulama kodu: genelde "Steam Guard" maili içinde geçer
                  // Daha geniş regex: sadece rakam/büyük harf 5 karakter blokları
                  const patterns = [
                    /Steam Guard kodunuz[:\s]+([A-Z0-9]{5})/i,
                    /your steam guard code[:\s]+([A-Z0-9]{5})/i,
                    /doğrulama kodu[:\s]+([A-Z0-9]{5})/i,
                    /\b([A-Z0-9]{5})\b/
                  ];
                  for (const pat of patterns) {
                    const m = text.match(pat);
                    if (m) { foundCode = m[1]; break; }
                  }
                }
                pending--;
                if (pending === 0) done(null, foundCode);
              });
            });
          });

          f.once("error", (err) => done(null, null));
          f.once("end", () => {
            // simpleParser callbacks henüz bitmemiş olabilir, bekle
            setTimeout(() => { if (!settled) done(null, foundCode); }, 2000);
          });
        });
      });
    });

    imap.connect();
  });
}

app.listen(PORT, () => console.log(`✅ Sunucu aktif: Port ${PORT}`));
