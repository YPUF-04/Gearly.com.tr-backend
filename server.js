// =============================================
// GameVault Backend — Tam Sürüm
// =============================================

const express = require("express");
const cors = require("cors");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");

const app = express();

// CORS Ayarları - Frontend'in bağlanabilmesi için kritik
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// Ayarlar
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

// =============================================
// VERİTABANI YÖNETİMİ
// =============================================
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ 
      codes: {}, 
      games: [], 
      usedSteamCodes: [] 
    }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// =============================================
// ADMIN: OYUN / ÜRÜN EKLEME
// =============================================
app.post("/api/admin/add-game", (req, res) => {
  const { adminKey, gameName, steamUser, steamPass, gmailUser, gmailPass } = req.body;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.json({ success: false, message: "Yetkisiz admin girişi." });
  }

  const db = loadDB();
  const newGame = {
    id: Date.now().toString(),
    name: gameName,
    steamUser: steamUser,
    steamPass: steamPass,
    gmailUser: gmailUser,
    gmailPass: gmailPass, // Uygulama şifresi olmalı
    emoji: "🎮",
    platform: "PC / Steam"
  };

  db.games.push(newGame);
  saveDB(db);
  res.json({ success: true, message: "Oyun ve hesap bilgileri başarıyla eklendi." });
});

// =============================================
// ADMIN: ERİŞİM KODU OLUŞTURMA
// =============================================
app.post("/api/admin/add-code", (req, res) => {
  const { adminKey, code, balance } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.json({ success: false, message: "Yetkisiz." });
  }
  
  const db = loadDB();
  db.codes[code.toUpperCase()] = { 
    balance: balance || 1, 
    used: false, 
    selectedGame: null 
  };
  saveDB(db);
  res.json({ success: true, message: "Erişim kodu oluşturuldu." });
});

// =============================================
// KULLANICI: OYUNLARI LİSTELE
// =============================================
app.get("/api/games", (req, res) => {
  const db = loadDB();
  // Güvenlik için Gmail şifrelerini listede göndermiyoruz
  const safeGames = db.games.map(({ gmailPass, ...rest }) => rest);
  res.json({ success: true, games: safeGames });
});

// =============================================
// KULLANICI: KOD DOĞRULAMA
// =============================================
app.post("/api/validate-code", (req, res) => {
  const { code } = req.body;
  const db = loadDB();
  const entry = db.codes[code?.toUpperCase()];

  if (!entry) return res.json({ success: false, message: "Geçersiz kod." });
  if (entry.balance <= 0) return res.json({ success: false, message: "Bakiye yetersiz." });

  res.json({ success: true, balance: entry.balance });
});

// =============================================
// KULLANICI: OYUN SEÇİMİ
// =============================================
app.post("/api/select-game", (req, res) => {
  const { code, gameId } = req.body;
  const db = loadDB();
  const entry = db.codes[code?.toUpperCase()];

  if (!entry || entry.balance <= 0) {
    return res.json({ success: false, message: "İşlem geçersiz." });
  }

  entry.selectedGame = gameId;
  saveDB(db);
  res.json({ success: true, message: "Oyun seçildi." });
});

// =============================================
// KULLANICI: STEAM KODUNU ÇEK (GMAİL BAĞLANTISI)
// =============================================
app.post("/api/get-steam-code", async (req, res) => {
  const { code, gameId } = req.body;
  const db = loadDB();
  const entry = db.codes[code?.toUpperCase()];
  const game = db.games.find(g => g.id === gameId);

  if (!entry || !game) return res.json({ success: false, message: "Kayıt bulunamadı." });
  if (entry.balance <= 0) return res.json({ success: false, message: "Bakiye bitmiş." });

  try {
    // Oyuna özel tanımlanmış Gmail bilgilerini kullanıyoruz
    const steamCode = await fetchSteamCodeFromGmail(game.gmailUser, game.gmailPass);

    if (!steamCode) {
      return res.json({ success: false, message: "Kod henüz mail kutusuna düşmedi. Lütfen 30 saniye sonra tekrar deneyin." });
    }

    // Başarılı ise bakiyeyi düş
    entry.balance -= 1;
    db.usedSteamCodes.push({ 
      userCode: code, 
      game: game.name, 
      steamCode, 
      date: new Date().toISOString() 
    });
    saveDB(db);

    res.json({ 
      success: true, 
      steamCode,
      steamUser: game.steamUser,
      steamPass: game.steamPass
    });
  } catch (err) {
    console.error("Gmail hatası:", err);
    res.json({ success: false, message: "Mail sunucusuna bağlanılamadı. Ayarları kontrol edin." });
  }
});

// =============================================
// GMAİL OKUMA FONKSİYONU
// =============================================
function fetchSteamCodeFromGmail(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: user,
      password: pass,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once("error", reject);
    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) { imap.end(); return reject(err); }

        const since = new Date();
        since.setMinutes(since.getMinutes() - 10); // Son 10 dakikadaki mailler

        imap.search(["UNSEEN", ["FROM", "noreply@steampowered.com"], ["SINCE", since]], (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end();
            return resolve(null);
          }

          const f = imap.fetch(results[results.length - 1], { bodies: "" });
          let foundCode = null;

          f.on("message", (msg) => {
            msg.on("body", (stream) => {
              simpleParser(stream, (err, parsed) => {
                const content = (parsed.text || "") + (parsed.html || "");
                // Steam Guard kodu (5 haneli sayı veya harf kombinasyonu)
                const match = content.match(/\b([A-Z0-9]{5})\b/);
                if (match) foundCode = match[1];
              });
            });
          });

          f.once("end", () => {
            imap.end();
            setTimeout(() => resolve(foundCode), 1000);
          });
        });
      });
    });
    imap.connect();
  });
}

app.listen(PORT, () => {
  console.log(`✅ Sunucu aktif: Port ${PORT}`);
});
