// server.js
const express = require("express");
const cors    = require("cors");
const Imap    = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const fs   = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

// Veritabanı Başlatma ve İstatistikler
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      codes: {}, games: [], users: {}, purchases: [],
      supportTickets: [], extraCodeRequests: [],
      siteStats: { rating: 5, baseUserCount: 137, baseUserDate: new Date().toISOString() },
      passwordResetTokens: {}
    }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Dinamik İstatistik API
app.get("/api/stats", (req, res) => {
  const db = loadDB();
  const s = db.siteStats;
  const hoursPassed = (Date.now() - new Date(s.baseUserDate).getTime()) / 3600000;
  // Kullanıcı sayısı 137'den başlar ve zamanla artar
  const currentUsers = Math.floor(s.baseUserCount + (hoursPassed * 0.1)); 
  res.json({ 
    success: true, 
    userCount: currentUsers, 
    gameCount: db.games.length, 
    rating: s.rating,
    serverStatus: "online" 
  });
});

// Mail Gönderimi (Şifre Sıfırlama için OTP)
app.post("/api/send-password-otp", async (req, res) => {
  const { username } = req.body;
  const db = loadDB();
  const user = db.users[username?.toLowerCase()];
  if (!user) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  db.passwordResetTokens[username.toLowerCase()] = { otp, createdAt: Date.now() };
  saveDB(db);

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.SITE_MAIL, pass: process.env.SITE_MAIL_PASS }
    });

    await transporter.sendMail({
      from: `"AşkımÇokPardon" <${process.env.SITE_MAIL}>`,
      to: user.email,
      subject: "Şifre Sıfırlama Kodu",
      html: `<h3>Güvenlik Kodu: ${otp}</h3><p>Şifrenizi sıfırlamak için bu kodu kullanın.</p>`
    });
    res.json({ success: true, maskedEmail: user.email.replace(/(.{2}).+(@.+)/, "$1***$2") });
  } catch (e) {
    res.json({ success: false, message: "Mail sunucu hatası." });
  }
});

// Admin Puan Güncelleme
app.post("/api/admin/update-stats", (req, res) => {
  if (req.body.adminKey !== process.env.ADMIN_KEY) return res.json({success:false});
  const db = loadDB();
  if(req.body.rating !== undefined) db.siteStats.rating = parseFloat(req.body.rating);
  saveDB(db);
  res.json({success:true});
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
