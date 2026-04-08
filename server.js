// =============================================
// GameVault Backend — v3.0
// =============================================
const express = require("express");
const cors    = require("cors");
const Imap    = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const fs   = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT       = process.env.PORT || 3000;
const DB_FILE    = path.join(__dirname, "db.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// ── Multer ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `game_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Nodemailer ──────────────────────────────
function getMailer() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SITE_MAIL, pass: process.env.SITE_MAIL_PASS }
  });
}

// ── DB ──────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      codes: {}, games: [], users: {}, purchases: [],
      supportTickets: [], extraCodeRequests: [],
      siteStats: { rating: 5, baseUserCount: 137, baseUserDate: new Date().toISOString() },
      pendingVerifications: {}, passwordResetTokens: {}
    }));
  }
  const d = JSON.parse(fs.readFileSync(DB_FILE));
  if (!d.supportTickets)       d.supportTickets = [];
  if (!d.extraCodeRequests)    d.extraCodeRequests = [];
  if (!d.siteStats)            d.siteStats = { rating: 5, baseUserCount: 137, baseUserDate: new Date().toISOString() };
  if (!d.pendingVerifications) d.pendingVerifications = {};
  if (!d.passwordResetTokens)  d.passwordResetTokens = {};
  if (!d.purchases)            d.purchases = [];
  if (!d.users)                d.users = {};
  return d;
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function makeOTP()  { return Math.floor(100000 + Math.random() * 900000).toString(); }
function adminCheck(key) { return key === process.env.ADMIN_KEY; }

// ─────────────────────────────────────────────
// İSTATİSTİK
// ─────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const db = loadDB();
  const s = db.siteStats;
  const hoursPassed = (Date.now() - new Date(s.baseUserDate).getTime()) / 3600000;
  const currentUsers = Math.floor(s.baseUserCount + (hoursPassed * 0.3)); // Saatte ~0.3 kullanıcı artışı
  
  res.json({
    success: true,
    userCount: currentUsers,
    gameCount: db.games.length,
    rating: s.rating,
    serverStatus: "online"
  });
});

// ─────────────────────────────────────────────
// KAYIT — OTP ile
// ─────────────────────────────────────────────
app.post("/api/send-register-otp", async (req, res) => {
  const { email, username } = req.body;
  if (!email || !username) return res.json({ success: false, message: "Eksik bilgi." });
  const db = loadDB();
  if (db.users[username.toLowerCase()])
    return res.json({ success: false, message: "Bu kullanıcı adı alınmış." });
  if (Object.values(db.users).find(u => u.email === email.toLowerCase()))
    return res.json({ success: false, message: "Bu mail zaten kayıtlı." });

  const otp = makeOTP();
  db.pendingVerifications[email.toLowerCase()] = { otp, username, createdAt: Date.now() };
  saveDB(db);

  try {
    await getMailer().sendMail({
      from: `"GameVault" <${process.env.SITE_MAIL}>`,
      to: email,
      subject: "GameVault — Kayıt Doğrulama Kodu",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0b0e1a;color:#e4eaff;border-radius:16px;border:1px solid #1e2540;">
        <h2 style="color:#00d4ff;margin-bottom:8px;">⬡ GameVault</h2>
        <p>Merhaba <strong>${username}</strong>, kayıt doğrulama kodun:</p>
        <div style="font-size:40px;font-weight:900;letter-spacing:10px;color:#00d4ff;text-align:center;margin:24px 0;padding:16px;background:#06080f;border-radius:12px;">${otp}</div>
        <p style="color:#6b7899;font-size:12px;">Kod 10 dakika geçerlidir. Bu işlemi siz başlatmadıysanız dikkate almayın.</p>
      </div>`
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: "Mail gönderilemedi. Lütfen geçerli bir mail gir." });
  }
});

app.post("/api/register", (req, res) => {
  const { username, password, email, otp } = req.body;
  if (!username || !password || !email || !otp)
    return res.json({ success: false, message: "Tüm alanlar zorunlu." });
  const db      = loadDB();
  const pending = db.pendingVerifications[email.toLowerCase()];
  if (!pending)              return res.json({ success: false, message: "Önce doğrulama kodu gönder." });
  if (pending.otp !== otp)   return res.json({ success: false, message: "Doğrulama kodu hatalı." });
  if (Date.now() - pending.createdAt > 600000)
    return res.json({ success: false, message: "Kodun süresi dolmuş, yeniden gönder." });

  const key = username.toLowerCase();
  if (db.users[key]) return res.json({ success: false, message: "Bu kullanıcı adı alınmış." });

  db.users[key] = { username, password, email: email.toLowerCase(), balance: 0, createdAt: new Date().toISOString() };
  delete db.pendingVerifications[email.toLowerCase()];
  saveDB(db);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// GİRİŞ
// ─────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const db   = loadDB();
  const user = db.users[username?.toLowerCase()];
  if (!user || user.password !== password)
    return res.json({ success: false, message: "Kullanıcı adı veya şifre hatalı." });
  res.json({ success: true, username: user.username, balance: user.balance, email: user.email });
});

// ─────────────────────────────────────────────
// ŞİFRE SIFIRLAMA
// ─────────────────────────────────────────────
app.post("/api/send-password-otp", async (req, res) => {
  const { username } = req.body;
  const db = loadDB();
  const user = db.users[username?.toLowerCase()];
  if (!user) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  db.passwordResetTokens[username.toLowerCase()] = { otp, createdAt: Date.now() };
  saveDB(db);

  try {
    await getMailer().sendMail({
      from: `"AşkımÇokPardon" <${process.env.SITE_MAIL}>`,
      to: user.email,
      subject: "Şifre Sıfırlama Kodu",
      html: `<b>Kodunuz: ${otp}</b><p>Bu kod 10 dakika geçerlidir.</p>`
    });
    res.json({ success: true, maskedEmail: user.email.replace(/(.{2}).+(@.+)/, "$1***$2") });
  } catch (e) {
    res.json({ success: false, message: "Mail gönderilemedi." });
  }
});

app.post("/api/change-password", (req, res) => {
  const { username, otp, newPassword } = req.body;
  const db    = loadDB();
  const token = db.passwordResetTokens[username?.toLowerCase()];
  if (!token)              return res.json({ success: false, message: "Önce kod gönder." });
  if (token.otp !== otp)   return res.json({ success: false, message: "Kod hatalı." });
  if (Date.now() - token.createdAt > 600000)
    return res.json({ success: false, message: "Kodun süresi dolmuş." });

  db.users[username.toLowerCase()].password = newPassword;
  delete db.passwordResetTokens[username.toLowerCase()];
  saveDB(db);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// KOD YÜKLEME
// ─────────────────────────────────────────────
app.post("/api/redeem-code", (req, res) => {
  const { username, code } = req.body;
  const db    = loadDB();
  const user  = db.users[username?.toLowerCase()];
  const entry = db.codes[code?.toUpperCase()];
  if (!user)         return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  if (!entry)        return res.json({ success: false, message: "Geçersiz kod." });
  if (entry.redeemedBy) return res.json({ success: false, message: "Bu kod daha önce kullanıldı." });
  entry.redeemedBy = username; entry.redeemedAt = new Date().toISOString();
  user.balance += entry.balance;
  saveDB(db);
  res.json({ success: true, balance: user.balance, added: entry.balance });
});

// ─────────────────────────────────────────────
// OYUNLAR (public)
// ─────────────────────────────────────────────
app.get("/api/games", (req, res) => {
  const db = loadDB();
  const safe = db.games.map(({ gmailPass, steamPass, steamUser, gmailUser, ...rest }) => rest);
  res.json({ success: true, games: safe });
});

// ─────────────────────────────────────────────
// SATIN ALMA
// ─────────────────────────────────────────────
app.post("/api/purchase", (req, res) => {
  const { username, gameId } = req.body;
  const db   = loadDB();
  const user = db.users[username?.toLowerCase()];
  const game = db.games.find(g => g.id === gameId);
  if (!user) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  if (!game) return res.json({ success: false, message: "Oyun bulunamadı." });
  if (user.balance <= 0) return res.json({ success: false, message: "Bakiye yetersiz." });
  user.balance -= 1;
  const purchase = {
    id: Date.now().toString(), username, gameId,
    gameName: game.name, gameEmoji: game.emoji, gameImage: game.image,
    steamUser: game.steamUser, steamPass: game.steamPass,
    gmailUser: game.gmailUser, gmailPass: game.gmailPass,
    purchasedAt: new Date().toISOString(), steamCodeRequests: 0, lastSteamCode: null
  };
  db.purchases.push(purchase);
  saveDB(db);
  res.json({ success: true, purchaseId: purchase.id, balance: user.balance, gameName: game.name, steamUser: game.steamUser, steamPass: game.steamPass });
});

// ─────────────────────────────────────────────
// SATIN ALMA GEÇMİŞİ
// ─────────────────────────────────────────────
app.get("/api/my-purchases", (req, res) => {
  const db = loadDB();
  const purchases = db.purchases
    .filter(p => p.username?.toLowerCase() === req.query.username?.toLowerCase())
    .map(p => ({ id: p.id, gameName: p.gameName, gameEmoji: p.gameEmoji, gameImage: p.gameImage, steamUser: p.steamUser, steamPass: p.steamPass, purchasedAt: p.purchasedAt, steamCodeRequests: p.steamCodeRequests || 0 }));
  res.json({ success: true, purchases });
});

// ─────────────────────────────────────────────
// SON ALIMLAR (bildirim)
// ─────────────────────────────────────────────
app.get("/api/recent-purchases", (req, res) => {
  const db = loadDB();
  const recent = db.purchases.slice(-30).reverse().map(p => ({
    username: p.username, gameName: p.gameName, gameEmoji: p.gameEmoji, purchasedAt: p.purchasedAt
  }));
  res.json({ success: true, purchases: recent });
});

// ─────────────────────────────────────────────
// STEAM KODU
// ─────────────────────────────────────────────
app.post("/api/get-steam-code", async (req, res) => {
  const { purchaseId } = req.body;
  const db = loadDB();
  const p  = db.purchases.find(x => x.id === purchaseId);
  if (!p) return res.json({ success: false, message: "Satın alma bulunamadı." });
  if (p.steamCodeRequests >= 5) return res.json({ success: false, message: "Maksimum talep aşıldı (5/5).", limitReached: true });
  try {
    const steamCode = await fetchSteamCodeFromGmail(p.gmailUser, p.gmailPass);
    p.steamCodeRequests = (p.steamCodeRequests || 0) + 1;
    if (steamCode) p.lastSteamCode = steamCode;
    saveDB(db);
    if (!steamCode) return res.json({ success: false, message: "Kod henüz gelmedi. 30 saniye sonra tekrar dene.", requestsLeft: 5 - p.steamCodeRequests });
    res.json({ success: true, steamCode, steamUser: p.steamUser, steamPass: p.steamPass, requestsLeft: 5 - p.steamCodeRequests });
  } catch (e) {
    res.json({ success: false, message: "Mail sunucusuna bağlanılamadı." });
  }
});

// ─────────────────────────────────────────────
// EK KOD TALEBİ
// ─────────────────────────────────────────────
app.post("/api/request-extra-code", (req, res) => {
  const { username, purchaseId, message } = req.body;
  const db = loadDB();
  const p  = db.purchases.find(x => x.id === purchaseId);
  if (!p) return res.json({ success: false, message: "Satın alma bulunamadı." });
  const already = db.extraCodeRequests.find(x => x.purchaseId === purchaseId && x.status === "pending");
  if (already) return res.json({ success: false, message: "Bu oyun için zaten açık bir talebiniz var." });
  db.extraCodeRequests.push({ id: Date.now().toString(), username, purchaseId, gameName: p.gameName, message: message || "", createdAt: new Date().toISOString(), status: "pending" });
  saveDB(db);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// DESTEK / ÖNERİ
// ─────────────────────────────────────────────
app.post("/api/support/send", (req, res) => {
  const { username, message, type } = req.body;
  if (!username || !message) return res.json({ success: false, message: "Eksik bilgi." });
  const db = loadDB();
  const ticket = { id: Date.now().toString(), username, message, type: type || "chat", createdAt: new Date().toISOString(), status: "open", adminReply: null };
  db.supportTickets.push(ticket);
  saveDB(db);
  res.json({ success: true, ticketId: ticket.id });
});

app.get("/api/support/my-tickets", (req, res) => {
  const db = loadDB();
  const tickets = db.supportTickets.filter(t => t.username?.toLowerCase() === req.query.username?.toLowerCase()).map(t => ({ id: t.id, message: t.message, type: t.type, status: t.status, adminReply: t.adminReply, createdAt: t.createdAt }));
  res.json({ success: true, tickets });
});

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────
app.post("/api/admin/get-games",     (req, res) => { if (!adminCheck(req.body.adminKey)) return res.json({success:false}); res.json({success:true,games:loadDB().games}); });
app.post("/api/admin/add-game",      upload.single("image"), (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false,message:"Yetkisiz."});
  const { gameName,steamUser,steamPass,gmailUser,gmailPass,platform,price,emoji } = req.body;
  const db = loadDB();
  db.games.push({ id:Date.now().toString(), name:gameName, steamUser, steamPass, gmailUser, gmailPass, emoji:emoji||"🎮", platform:platform||"PC / Steam", price:price||"Hesap", image:req.file?`/uploads/${req.file.filename}`:null, createdAt:new Date().toISOString() });
  saveDB(db); res.json({success:true});
});
app.post("/api/admin/edit-game",     upload.single("image"), (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false,message:"Yetkisiz."});
  const { gameId,gameName,steamUser,steamPass,gmailUser,gmailPass,platform,price,emoji } = req.body;
  const db = loadDB(); const g = db.games.find(x=>x.id===gameId);
  if (!g) return res.json({success:false,message:"Oyun bulunamadı."});
  if(gameName)  g.name=gameName; if(steamUser) g.steamUser=steamUser; if(steamPass) g.steamPass=steamPass;
  if(gmailUser) g.gmailUser=gmailUser; if(gmailPass) g.gmailPass=gmailPass;
  if(platform)  g.platform=platform; if(price) g.price=price; if(emoji) g.emoji=emoji;
  if(req.file)  g.image=`/uploads/${req.file.filename}`;
  saveDB(db); res.json({success:true});
});
app.post("/api/admin/delete-game",   (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); db.games=db.games.filter(g=>g.id!==req.body.gameId); saveDB(db); res.json({success:true});
});
app.post("/api/admin/add-code",      (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); db.codes[req.body.code.toUpperCase()]={balance:req.body.balance||1,redeemedBy:null,redeemedAt:null,createdAt:new Date().toISOString()};
  saveDB(db); res.json({success:true});
});
app.post("/api/admin/get-codes",     (req, res) => { if (!adminCheck(req.body.adminKey)) return res.json({success:false}); const db=loadDB(); res.json({success:true,codes:Object.entries(db.codes).map(([code,d])=>({code,...d}))}); });
app.post("/api/admin/get-users",     (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); let users=Object.values(db.users).map(u=>({username:u.username,email:u.email,balance:u.balance,createdAt:u.createdAt}));
  if(req.body.search) users=users.filter(u=>u.username.toLowerCase().includes(req.body.search.toLowerCase()));
  res.json({success:true,users});
});
app.post("/api/admin/update-balance",(req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); const u=db.users[req.body.username?.toLowerCase()];
  if(!u) return res.json({success:false,message:"Kullanıcı bulunamadı."});
  u.balance=parseInt(req.body.balance); saveDB(db); res.json({success:true});
});
app.post("/api/admin/get-purchases", (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); res.json({success:true,purchases:db.purchases.map(p=>({id:p.id,username:p.username,gameName:p.gameName,purchasedAt:p.purchasedAt,steamCodeRequests:p.steamCodeRequests||0}))});
});
app.post("/api/admin/get-leaderboard",(req,res)=>{
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); const counts={};
  db.purchases.forEach(p=>{counts[p.username]=(counts[p.username]||0)+1;});
  res.json({success:true,leaderboard:Object.entries(counts).map(([u,c])=>({username:u,count:c})).sort((a,b)=>b.count-a.count)});
});
app.post("/api/admin/get-support",   (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); res.json({success:true,tickets:db.supportTickets,extraCodeRequests:db.extraCodeRequests});
});
app.post("/api/admin/reply-ticket",  (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); const t=db.supportTickets.find(x=>x.id===req.body.ticketId);
  if(!t) return res.json({success:false,message:"Bulunamadı."});
  t.adminReply=req.body.reply; t.status="answered"; saveDB(db); res.json({success:true});
});
app.post("/api/admin/grant-extra-code",(req,res)=>{
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB();
  const p=db.purchases.find(x=>x.id===req.body.purchaseId);
  if(p) p.steamCodeRequests=Math.max(0,p.steamCodeRequests-(req.body.extraCodes||1));
  const r=db.extraCodeRequests.find(x=>x.id===req.body.requestId);
  if(r) r.status="granted"; saveDB(db); res.json({success:true});
});
app.post("/api/admin/update-stats",  (req, res) => {
  if (!adminCheck(req.body.adminKey)) return res.json({success:false});
  const db=loadDB(); if(req.body.rating!==undefined) db.siteStats.rating=parseFloat(req.body.rating);
  saveDB(db); res.json({success:true});
});

// ─────────────────────────────────────────────
// Gmail IMAP
// ─────────────────────────────────────────────
function fetchSteamCodeFromGmail(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({ user, password:pass, host:"imap.gmail.com", port:993, tls:true, tlsOptions:{rejectUnauthorized:false} });
    imap.once("error", reject);
    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) { imap.end(); return reject(err); }
        const since = new Date(); since.setMinutes(since.getMinutes() - 10);
        imap.search(["UNSEEN",["FROM","noreply@steampowered.com"],["SINCE",since]], (err, results) => {
          if (err || !results || !results.length) { imap.end(); return resolve(null); }
          const f = imap.fetch(results[results.length-1], {bodies:""});
          let foundCode = null;
          f.on("message", msg => { msg.on("body", stream => { simpleParser(stream,(err,parsed) => { const c=(parsed.text||"")+(parsed.html||""); const m=c.match(/\b([A-Z0-9]{5})\b/); if(m) foundCode=m[1]; }); }); });
          f.once("end", () => { imap.end(); setTimeout(()=>resolve(foundCode),1000); });
        });
      });
    });
    imap.connect();
  });
}

app.listen(PORT, () => console.log(`✅ GameVault v3 — Port ${PORT}`));
