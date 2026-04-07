// =============================================
// GameVault Backend — Node.js / Express
// Gmail'den Steam kodunu otomatik çeker
// =============================================

const express = require("express");
const cors = require("cors");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// =============================================
// AYARLAR — .env dosyana yaz
// =============================================
const GMAIL_USER = process.env.GMAIL_USER;       // ornek@gmail.com
const GMAIL_PASS = process.env.GMAIL_PASS;       // Gmail uygulama şifresi
const PORT = process.env.PORT || 3000;

// =============================================
// VERİTABANI (JSON dosyası — basit, çalışır)
// Gerçek kullanımda MongoDB/Supabase önerilir
// =============================================
const DB_FILE = path.join(__dirname, "db.json");

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ codes: {}, usedSteamCodes: [] }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// =============================================
// KOD EKLE (manuel — admin için)
// POST /api/admin/add-code
// Body: { adminKey, code, balance }
// =============================================
app.post("/api/admin/add-code", (req, res) => {
  const { adminKey, code, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.json({ success: false, message: "Yetkisiz." });
  }
  const db = loadDB();
  db.codes[code.toUpperCase()] = { balance: balance || 1, used: false, selectedGame: null };
  saveDB(db);
  res.json({ success: true, message: "Kod eklendi." });
});

// =============================================
// KODLARI LİSTELE (admin)
// GET /api/admin/codes?adminKey=xxx
// =============================================
app.get("/api/admin/codes", (req, res) => {
  if (req.query.adminKey !== process.env.ADMIN_KEY) {
    return res.json({ success: false, message: "Yetkisiz." });
  }
  const db = loadDB();
  res.json({ success: true, codes: db.codes });
});

// =============================================
// KOD DOĞRULA
// POST /api/validate-code
// Body: { code }
// =============================================
app.post("/api/validate-code", (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false, message: "Kod gerekli." });

  const db = loadDB();
  const entry = db.codes[code.toUpperCase()];

  if (!entry) return res.json({ success: false, message: "Geçersiz kod." });
  if (entry.balance <= 0) return res.json({ success: false, message: "Bu kod daha önce kullanılmış." });

  res.json({ success: true, balance: entry.balance, selectedGame: entry.selectedGame });
});

// =============================================
// OYUN SEÇ
// POST /api/select-game
// Body: { code, gameId }
// =============================================
app.post("/api/select-game", (req, res) => {
  const { code, gameId } = req.body;
  if (!code || !gameId) return res.json({ success: false, message: "Eksik parametre." });

  const db = loadDB();
  const entry = db.codes[code.toUpperCase()];

  if (!entry) return res.json({ success: false, message: "Geçersiz kod." });
  if (entry.balance <= 0) return res.json({ success: false, message: "Bakiye yok." });

  entry.selectedGame = gameId;
  saveDB(db);

  res.json({ success: true, message: "Oyun seçildi." });
});

// =============================================
// STEAM KODU AL — Gmail'den çeker
// POST /api/get-steam-code
// Body: { code, gameId }
// =============================================
app.post("/api/get-steam-code", async (req, res) => {
  const { code, gameId } = req.body;
  if (!code) return res.json({ success: false, message: "Kod gerekli." });

  const db = loadDB();
  const entry = db.codes[code.toUpperCase()];

  if (!entry) return res.json({ success: false, message: "Geçersiz kod." });
  if (entry.balance <= 0) return res.json({ success: false, message: "Bakiye yok." });

  try {
    const steamCode = await fetchSteamCodeFromGmail(gameId);

    if (!steamCode) {
      return res.json({ success: false, message: "Steam kodu henüz gelmedi. Birkaç dakika bekle ve tekrar dene." });
    }

    // Bakiyeyi düş
    entry.balance -= 1;
    entry.selectedGame = gameId;
    db.usedSteamCodes.push({ code, gameId, steamCode, date: new Date().toISOString() });
    saveDB(db);

    res.json({ success: true, steamCode });
  } catch (err) {
    console.error("Gmail hatası:", err);
    res.json({ success: false, message: "Mail sunucusuna bağlanılamadı." });
  }
});

// =============================================
// GMAİL'DEN STEAM KODU ÇEK
// =============================================
function fetchSteamCodeFromGmail(gameId) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_PASS,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once("error", reject);

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) { imap.end(); return reject(err); }

        // Son 24 saatte gelen Steam maillerini ara
        const since = new Date();
        since.setDate(since.getDate() - 1);

        imap.search(
          ["UNSEEN", ["FROM", "noreply@steampowered.com"], ["SINCE", since]],
          (err, results) => {
            if (err || !results || results.length === 0) {
              imap.end();
              return resolve(null);
            }

            // En son maili al
            const latest = results[results.length - 1];
            const fetch = imap.fetch(latest, { bodies: "" });
            let found = null;

            fetch.on("message", (msg) => {
              msg.on("body", (stream) => {
                simpleParser(stream, (err, parsed) => {
                  if (err) return;
                  const text = (parsed.text || "") + (parsed.html || "");

                  // Steam doğrulama kodu — genellikle 5 haneli sayı
                  // veya XXXXX-XXXXX-XXXXX formatında CD key
                  const codeMatch =
                    text.match(/\b([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})\b/) ||
                    text.match(/doğrulama kodu[:\s]+([A-Z0-9]{5})/i) ||
                    text.match(/verification code[:\s]+([A-Z0-9]{5})/i) ||
                    text.match(/\b(\d{5})\b/);

                  if (codeMatch) found = codeMatch[1];
                });
              });
            });

            fetch.once("end", () => {
              // Maili okundu olarak işaretle
              imap.setFlags([latest], ["\\Seen"], () => {});
              imap.end();
              setTimeout(() => resolve(found), 500);
            });

            fetch.once("error", (e) => {
              imap.end();
              reject(e);
            });
          }
        );
      });
    });

    imap.connect();
  });
}

// =============================================
// SUNUCUYU BAŞLAT
// =============================================
app.listen(PORT, () => {
  console.log(`✅ GameVault çalışıyor: http://localhost:${PORT}`);
});
