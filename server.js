// =============================================
// GameVault Backend — Geliştirilmiş Sürüm v3
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
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `game_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// =============================================
// VERİTABANI YÖNETİMİ
// =============================================
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      codes: {},
      games: [],
      users: {},
      purchases: [],
      usedSteamCodes: [],
      supportTickets: [],
      siteStats: { rating: 5.0, ratingCount: 0 }
    }));
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE));
  if (!data.users) data.users = {};
  if (!data.purchases) data.purchases = [];
  if (!data.supportTickets) data.supportTickets = [];
  if (!data.siteStats) data.siteStats = { rating: 5.0, ratingCount: 0 };
  return data;
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// =============================================
// STATS: Kullanıcı sayısı, oyun sayısı, puan
// =============================================
app.get("/api/stats", (req, res) => {
  const db = loadDB();
  const userCount = Object.keys(db.users).length;
  const gameCount = db.games.length;
  res.json({
    success: true,
    userCount,
    gameCount,
    rating: db.siteStats.rating,
    ratingCount: db.siteStats.ratingCount
  });
});

// ADMIN: puan güncelle
app.post("/api/admin/update-rating", (req, res) => {
  const { adminKey, rating } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  db.siteStats.rating = parseFloat(rating);
  saveDB(db);
  res.json({ success: true });
});

// =============================================
// DESTEK TALEP SİSTEMİ
// =============================================
app.post("/api/support/request", (req, res) => {
  const { username, purchaseId, gameName, message } = req.body;
  const db = loadDB();
  const ticket = {
    id: Date.now().toString(),
    username,
    purchaseId,
    gameName,
    message: message || "5 kullanma hakkı bitti, ek hak talebi",
    status: "open",
    createdAt: new Date().toISOString(),
    adminReply: null,
    extraGranted: false
  };
  db.supportTickets.push(ticket);
  saveDB(db);
  res.json({ success: true, ticketId: ticket.id });
});

app.get("/api/support/my-tickets", (req, res) => {
  const { username } = req.query;
  const db = loadDB();
  const tickets = db.supportTickets
    .filter(t => t.username?.toLowerCase() === username?.toLowerCase())
    .map(t => ({ id: t.id, gameName: t.gameName, status: t.status, createdAt: t.createdAt, adminReply: t.adminReply, extraGranted: t.extraGranted }));
  res.json({ success: true, tickets });
});

// ADMIN: Destek taleplerini gör
app.post("/api/admin/get-tickets", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  res.json({ success: true, tickets: db.supportTickets });
});

// ADMIN: Talebe cevap ver + hak ver
app.post("/api/admin/reply-ticket", (req, res) => {
  const { adminKey, ticketId, reply, grantExtra } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  const ticket = db.supportTickets.find(t => t.id === ticketId);
  if (!ticket) return res.json({ success: false, message: "Bilet bulunamadı." });

  ticket.adminReply = reply;
  ticket.status = "closed";

  if (grantExtra && ticket.purchaseId) {
    const purchase = db.purchases.find(p => p.id === ticket.purchaseId);
    if (purchase) {
      purchase.steamCodeRequests = Math.max(0, purchase.steamCodeRequests - 3);
      ticket.extraGranted = true;
    }
  }

  saveDB(db);
  res.json({ success: true });
});

// =============================================
// KULLANICI KAYIT / GİRİŞ
// =============================================
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Kullanıcı adı ve şifre gerekli." });

  const db = loadDB();
  const key = username.toLowerCase();
  if (db.users[key]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

  db.users[key] = {
    username,
    password,
    createdAt: new Date().toISOString(),
    balance: 0
  };
  saveDB(db);
  res.json({ success: true, message: "Kayıt başarılı." });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const db = loadDB();
  const key = username?.toLowerCase();
  const user = db.users[key];

  if (!user || user.password !== password) {
    return res.json({ success: false, message: "Kullanıcı adı veya şifre hatalı." });
  }

  res.json({ success: true, username: user.username, balance: user.balance });
});

// =============================================
// KOD YÜKLEME
// =============================================
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

// =============================================
// OYUNLAR
// =============================================
app.get("/api/games", (req, res) => {
  const db = loadDB();
  const safeGames = db.games.map(({ gmailPass, steamPass, steamUser, ...rest }) => rest);
  res.json({ success: true, games: safeGames });
});

// =============================================
// SATIN ALMA
// =============================================
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

  const purchase = {
    id: purchaseId,
    username,
    gameId,
    gameName: game.name,
    gameEmoji: game.emoji,
    steamUser: game.steamUser,
    steamPass: game.steamPass,
    gmailUser: game.gmailUser,
    gmailPass: game.gmailPass,
    purchasedAt: new Date().toISOString(),
    steamCodeRequests: 0,
    lastSteamCode: null
  };

  db.purchases.push(purchase);
  saveDB(db);

  res.json({
    success: true,
    purchaseId,
    balance: user.balance,
    gameName: game.name,
    steamUser: game.steamUser,
    steamPass: game.steamPass
  });
});

app.get("/api/my-purchases", (req, res) => {
  const { username } = req.query;
  const db = loadDB();
  const purchases = db.purchases
    .filter(p => p.username?.toLowerCase() === username?.toLowerCase())
    .map(p => ({
      id: p.id,
      gameName: p.gameName,
      gameEmoji: p.gameEmoji,
      steamUser: p.steamUser,
      steamPass: p.steamPass,
      purchasedAt: p.purchasedAt,
      steamCodeRequests: p.steamCodeRequests || 0,
      lastSteamCode: p.lastSteamCode
    }));

  res.json({ success: true, purchases });
});

// Son satın almalar (sol alt bildirim için)
app.get("/api/recent-purchases", (req, res) => {
  const db = loadDB();
  const recent = db.purchases
    .slice(-20)
    .reverse()
    .map(p => ({
      username: p.username ? p.username.substring(0, 3) + "***" : "???",
      gameName: p.gameName,
      gameEmoji: p.gameEmoji || "🎮",
      purchasedAt: p.purchasedAt
    }));
  res.json({ success: true, purchases: recent });
});

// =============================================
// STEAM KODU ÇEK
// =============================================
app.post("/api/get-steam-code", async (req, res) => {
  const { purchaseId } = req.body;
  const db = loadDB();
  const purchase = db.purchases.find(p => p.id === purchaseId);

  if (!purchase) return res.json({ success: false, message: "Satın alma bulunamadı." });
  if (purchase.steamCodeRequests >= 5) {
    return res.json({ success: false, message: "Maksimum doğrulama talebi aşıldı (5/5).", limitReached: true });
  }

  try {
    const steamCode = await fetchSteamCodeFromGmail(purchase.gmailUser, purchase.gmailPass);
    purchase.steamCodeRequests = (purchase.steamCodeRequests || 0) + 1;
    if (steamCode) purchase.lastSteamCode = steamCode;
    saveDB(db);

    if (!steamCode) {
      return res.json({ success: false, message: "Kod henüz gelmedi. 30 saniye sonra tekrar dene.", requestsLeft: 5 - purchase.steamCodeRequests });
    }

    res.json({ success: true, steamCode, steamUser: purchase.steamUser, steamPass: purchase.steamPass, requestsLeft: 5 - purchase.steamCodeRequests });
  } catch (err) {
    console.error("Gmail hatası:", err);
    res.json({ success: false, message: "Mail sunucusuna bağlanılamadı." });
  }
});

// =============================================
// ADMIN: OYUN İŞLEMLERİ
// =============================================
app.post("/api/admin/add-game", upload.single("image"), (req, res) => {
  const { adminKey, gameName, steamUser, steamPass, gmailUser, gmailPass, platform, price, emoji } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  const newGame = {
    id: Date.now().toString(),
    name: gameName,
    steamUser, steamPass, gmailUser, gmailPass,
    emoji: emoji || "🎮",
    platform: platform || "PC / Steam",
    price: price || "Hesap",
    image: req.file ? `/uploads/${req.file.filename}` : null,
    createdAt: new Date().toISOString()
  };

  db.games.push(newGame);
  saveDB(db);
  res.json({ success: true, message: "Oyun eklendi.", game: { ...newGame, gmailPass: undefined, steamPass: undefined } });
});

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

app.post("/api/admin/delete-game", (req, res) => {
  const { adminKey, gameId } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  db.games = db.games.filter(g => g.id !== gameId);
  saveDB(db);
  res.json({ success: true });
});

app.post("/api/admin/get-games", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });
  const db = loadDB();
  res.json({ success: true, games: db.games });
});

// =============================================
// ADMIN: KODLAR
// =============================================
app.post("/api/admin/add-code", (req, res) => {
  const { adminKey, code, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  db.codes[code.toUpperCase()] = {
    balance: balance || 1,
    redeemedBy: null, redeemedAt: null,
    createdAt: new Date().toISOString()
  };
  saveDB(db);
  res.json({ success: true });
});

app.post("/api/admin/get-codes", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  const codes = Object.entries(db.codes).map(([code, data]) => ({ code, ...data }));
  res.json({ success: true, codes });
});

// =============================================
// ADMIN: KULLANICILAR
// =============================================
app.post("/api/admin/get-users", (req, res) => {
  const { adminKey, search } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  let users = Object.entries(db.users).map(([key, u]) => ({
    username: u.username, balance: u.balance, createdAt: u.createdAt
  }));

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

// =============================================
// ADMIN: SATIN ALMALAR
// =============================================
app.post("/api/admin/get-purchases", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.json({ success: false, message: "Yetkisiz." });

  const db = loadDB();
  const purchases = db.purchases.map(p => ({
    id: p.id, username: p.username, gameName: p.gameName,
    purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0
  }));

  res.json({ success: true, purchases });
});

// =============================================
// GMAİL OKUMA
// =============================================
function fetchSteamCodeFromGmail(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user, password: pass, host: "imap.gmail.com", port: 993,
      tls: true, tlsOptions: { rejectUnauthorized: false }
    });

    imap.once("error", reject);
    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) { imap.end(); return reject(err); }

        const since = new Date();
        since.setMinutes(since.getMinutes() - 10);

        imap.search(["UNSEEN", ["FROM", "noreply@steampowered.com"], ["SINCE", since]], (err, results) => {
          if (err || !results || results.length === 0) { imap.end(); return resolve(null); }

          const f = imap.fetch(results[results.length - 1], { bodies: "" });
          let foundCode = null;

          f.on("message", (msg) => {
            msg.on("body", (stream) => {
              simpleParser(stream, (err, parsed) => {
                const content = (parsed.text || "") + (parsed.html || "");
                const match = content.match(/\b([A-Z0-9]{5})\b/);
                if (match) foundCode = match[1];
              });
            });
          });

          f.once("end", () => { imap.end(); setTimeout(() => resolve(foundCode), 1000); });
        });
      });
    });
    imap.connect();
  });
}

app.listen(PORT, () => console.log(`✅ Sunucu aktif: Port ${PORT}`));
