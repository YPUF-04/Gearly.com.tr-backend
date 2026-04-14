// =============================================
// CONFIG
// =============================================
const BACKEND = "https://backendsite-production-6bcb.up.railway.app";

let ADMIN_KEY = "";
let allCodes = [];
let allUsers = [];
let allPurchases = [];
let allTickets = [];
let generatedCodes = [];
let editingGameId = null;
let editingUsername = null;
let cachedGames = [];
let serverIsActive = true;

// =============================================
// GİRİŞ / ÇIKIŞ
// =============================================
function adminLogin() {
  const key = document.getElementById("admin-key-input").value.trim();
  if (!key) { document.getElementById("login-error").textContent = "Anahtar girin."; return; }
  ADMIN_KEY = key;
  fetch(`${BACKEND}/api/admin/get-games`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminKey: key })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      document.getElementById("login-screen").style.display = "none";
      document.getElementById("admin-panel").style.display = "flex";
      cachedGames = data.games || [];
      loadDashboard();
    } else {
      document.getElementById("login-error").textContent = "Hatalı anahtar.";
      ADMIN_KEY = "";
    }
  })
  .catch(() => {
    document.getElementById("login-error").textContent = "Sunucuya bağlanılamadı.";
    ADMIN_KEY = "";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("admin-key-input");
  if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") adminLogin(); });
});

function adminLogout() {
  ADMIN_KEY = "";
  document.getElementById("admin-panel").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("admin-key-input").value = "";
}

// =============================================
// NAVİGASYON
// =============================================
function showSection(name, btn) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`section-${name}`).classList.add("active");
  if (btn) btn.classList.add("active");

  if (name === "dashboard") loadDashboard();
  else if (name === "games") loadGames();
  else if (name === "codes") loadCodes();
  else if (name === "users") loadUsers();
  else if (name === "purchases") loadPurchases();
  else if (name === "tickets") loadTickets();
  else if (name === "chat") loadChats();
  else if (name === "reviews") loadReviews();
  else if (name === "settings") loadSettings();
}

// =============================================
// TOAST
// =============================================
function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.classList.remove("show"), 3500);
}

// =============================================
// DASHBOARD
// =============================================
// Admin taraf bellek cache'i — sekme geçişinde tekrar Firestore'a gitme
let adminDataCache = null;
let adminDataCacheAt = 0;
const ADMIN_CACHE_TTL = 60_000; // 1 dakika

async function fetchAdminData(force = false) {
  if (!force && adminDataCache && (Date.now() - adminDataCacheAt < ADMIN_CACHE_TTL)) {
    return adminDataCache;
  }
  const [gamesRes, usersRes, purchasesRes, ticketsRes, codesRes, statsRes] = await Promise.all([
    fetch(`${BACKEND}/api/admin/get-games`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({adminKey: ADMIN_KEY}) }),
    fetch(`${BACKEND}/api/admin/get-users`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({adminKey: ADMIN_KEY}) }),
    fetch(`${BACKEND}/api/admin/get-purchases`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({adminKey: ADMIN_KEY}) }),
    fetch(`${BACKEND}/api/admin/get-support`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({adminKey: ADMIN_KEY}) }),
    fetch(`${BACKEND}/api/admin/get-codes`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({adminKey: ADMIN_KEY}) }),
    fetch(`${BACKEND}/api/stats`)
  ]);
  const [games, users, purchases, tickets, codes, stats] = await Promise.all([
    gamesRes.json(), usersRes.json(), purchasesRes.json(),
    ticketsRes.json(), codesRes.json(), statsRes.json()
  ]);
  adminDataCache = { games, users, purchases, tickets, codes, stats };
  adminDataCacheAt = Date.now();
  return adminDataCache;
}

async function loadDashboard() {
  try {
    const { games, users, purchases, tickets, codes, stats } = await fetchAdminData();

    cachedGames = games.games || [];
    allPurchases = purchases.purchases || [];
    allTickets = tickets.requests || [];
    allUsers = users.users || [];
    allCodes = codes.codes || [];

    const openTickets = allTickets.filter(t => t.status !== "closed").length;
    const unusedCodes = allCodes.filter(c => !c.redeemedBy).length;

    setDash("dc-games", cachedGames.length);
    setDash("dc-users", allUsers.length);
    setDash("dc-purchases", allPurchases.length);
    setDash("dc-tickets", openTickets, openTickets > 0 ? "warn" : "");
    setDash("dc-codes", unusedCodes);
    setDash("dc-rating", stats.rating ? parseFloat(stats.rating).toFixed(1) : "5.0");

    // Açık talep badge
    const badge = document.getElementById("open-ticket-count");
    if (openTickets > 0) { badge.textContent = openTickets; badge.style.display = "inline-block"; }
    else badge.style.display = "none";

    // Son 5 satın alım
    const rp = document.getElementById("dash-recent-purchases");
    const recentP = [...allPurchases].reverse().slice(0, 5);
    rp.innerHTML = recentP.length ? recentP.map(p => `
      <div class="dash-list-item">
        <div class="dli-main"><strong>${p.username}</strong> — ${p.gameName}</div>
        <div class="dli-meta">${formatDate(p.purchasedAt)}</div>
      </div>
    `).join("") : "<div class='empty'>Henüz yok.</div>";

    // Son 5 açık destek
    const rt = document.getElementById("dash-recent-tickets");
    const recentT = allTickets.filter(t => t.status !== "closed").slice(-5).reverse();
    rt.innerHTML = recentT.length ? recentT.map(t => `
      <div class="dash-list-item">
        <div class="dli-main"><strong>${t.username}</strong> — ${typeLabel(t.type)}</div>
        <div class="dli-meta">${(t.message||"").substring(0,50)}...</div>
      </div>
    `).join("") : "<div class='empty'>Açık talep yok. 🎉</div>";

  } catch(e) {
    console.error("Dashboard yükleme hatası:", e);
  }
}

function setDash(id, val, cls) {
  const el = document.getElementById(id);
  if (el) { el.textContent = val; if (cls) el.classList.add(cls); }
}

function typeLabel(t) {
  const m = {steam_code:"🔑 Steam Kodu", extra_code:"🔄 Ekstra Kod", account:"👤 Hesap", general:"💬 Genel"};
  return m[t] || t || "—";
}

// =============================================
// OYUNLAR
// =============================================
async function loadGames() {
  const el = document.getElementById("games-list");
  el.innerHTML = "<div class='loading'>Yükleniyor...</div>";
  try {
    const d = await fetchAdminData();
    cachedGames = d.games.games || [];
    renderGamesList(cachedGames);
  } catch(e) { el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function renderGamesList(games) {
  const el = document.getElementById("games-list");
  if (!games.length) { el.innerHTML = "<div class='empty'>Henüz oyun eklenmemiş.</div>"; return; }
  el.innerHTML = games.map((g, idx) => `
    <div class="game-admin-card">
      <div class="gac-thumb" style="${g.image ? `background-image:url('${g.image.startsWith('http') ? g.image : BACKEND+g.image}'); background-size:cover; background-position:center;` : ''}">
        ${g.image ? '' : (g.emoji || '🎮')}
      </div>
      <div class="gac-body">
        <div class="gac-platform">${g.platform || 'PC / Steam'}</div>
        <div class="gac-name">${g.name} ${g.popular ? '<span style="color:#f5c518;font-size:0.78rem;">⭐ Popüler</span>' : ''}</div>
        <div class="gac-account">👤 ${g.steamUser || '—'}</div>
        <div class="gac-account" style="color:var(--text3);">📧 ${g.gmailUser || '—'}</div>
        <div class="gac-actions">
          <button class="btn-edit" onclick="openGameModal('${g.id}')">✏️ Düzenle</button>
          <button style="padding:0.4rem 0.85rem;border-radius:8px;font-size:0.78rem;font-weight:600;cursor:pointer;border:1px solid ${g.popular ? 'rgba(245,197,24,0.4)' : 'rgba(255,255,255,0.08)'};background:${g.popular ? 'rgba(245,197,24,0.1)' : 'rgba(255,255,255,0.03)'};color:${g.popular ? '#f5c518' : 'var(--text2)'};" onclick="togglePopular('${g.id}', ${!g.popular}, ${idx+1})">
            ${g.popular ? '⭐ Popülerden Çıkar' : '☆ Popüler Yap'}
          </button>
          <button style="padding:0.4rem 0.85rem;border-radius:8px;font-size:0.78rem;font-weight:600;cursor:pointer;border:1px solid ${g.exclusive ? 'rgba(250,189,0,0.5)' : 'rgba(255,255,255,0.08)'};background:${g.exclusive ? 'rgba(250,189,0,0.12)' : 'rgba(255,255,255,0.03)'};color:${g.exclusive ? '#fabd00' : 'var(--text2)'};" onclick="toggleExclusive('${g.id}', ${!g.exclusive})">
            ${g.exclusive ? '💎 Özel (Kaldır)' : '◇ Özel Yap'}
          </button>
          <button class="btn-danger" onclick="deleteGame('${g.id}', '${escJs(g.name)}')">🗑 Sil</button>
        </div>
      </div>
    </div>
  `).join("");
}

// ── Görsel Sekme Geçişi ──
window.switchImgTab = function(tab) {
  const fileDiv = document.getElementById("img-input-file");
  const urlDiv  = document.getElementById("img-input-url");
  const tabFile = document.getElementById("img-tab-file");
  const tabUrl  = document.getElementById("img-tab-url");
  const prev    = document.getElementById("img-preview");
  if (!fileDiv || !urlDiv) return;

  if (tab === "url") {
    fileDiv.style.display = "none";
    urlDiv.style.display  = "block";
    tabFile && tabFile.classList.remove("active");
    tabUrl  && tabUrl.classList.add("active");
    // URL input'una oninput ekle
    const urlInput = document.getElementById("gm-image-url");
    if (urlInput && !urlInput._listenerAdded) {
      urlInput.addEventListener("input", () => window.previewImageUrl(urlInput.value));
      urlInput._listenerAdded = true;
    }
  } else {
    urlDiv.style.display  = "none";
    fileDiv.style.display = "block";
    tabUrl  && tabUrl.classList.remove("active");
    tabFile && tabFile.classList.add("active");
    if (prev) prev.style.display = "none";
  }
};

// ── Görsel URL önizleme ──
window.previewImageUrl = function(val) {
  const prev = document.getElementById("img-preview");
  const img  = document.getElementById("img-preview-el");
  if (!prev || !img) return;
  if (val && val.trim()) {
    img.src = val.trim();
    prev.style.display = "block";
  } else {
    prev.style.display = "none";
  }
};

// ── Hesap türü seçimi ──
window.setAccountType = function(type) {
  document.getElementById("gm-account-type").value = type;
  document.getElementById("acct-btn-personal").classList.toggle("active", type === "personal");
  document.getElementById("acct-btn-general").classList.toggle("active",  type === "general");
};


window.toggleRequiresCode = function() {
  const cb     = document.getElementById("gm-requires-code");
  const track  = document.getElementById("requires-toggle-track");
  const label  = document.getElementById("gm-requires-code-label");
  const fields = document.getElementById("steam-fields");
  if (!cb) return;
  cb.checked = !cb.checked;
  if (cb.checked) {
    track && track.classList.add("on");
    if (label) label.textContent = "Açık — kullanıcıya doğrulama kodu ekranı çıkar";
    if (fields) fields.style.display = "contents";
    // Guard açıksa → Kişisel hesap öner (override edilebilir)
    if (typeof window.setAccountType === "function") window.setAccountType("personal");
  } else {
    track && track.classList.remove("on");
    if (label) label.textContent = "Kapalı — kullanıcıya sadece kullanıcı adı/şifre gösterilir";
    if (fields) fields.style.display = "none";
    // Guard kapalıysa → Genel hesap öner
    if (typeof window.setAccountType === "function") window.setAccountType("general");
  }
};

function setRequiresCode(val) {
  const cb     = document.getElementById("gm-requires-code");
  const track  = document.getElementById("requires-toggle-track");
  const label  = document.getElementById("gm-requires-code-label");
  const fields = document.getElementById("steam-fields");
  if (!cb) return;
  cb.checked = val;
  if (val) {
    track && track.classList.add("on");
    if (label) label.textContent = "Açık — kullanıcıya doğrulama kodu ekranı çıkar";
    if (fields) fields.style.display = "contents";
  } else {
    track && track.classList.remove("on");
    if (label) label.textContent = "Kapalı — kullanıcıya sadece kullanıcı adı/şifre gösterilir";
    if (fields) fields.style.display = "none";
  }
}

function openGameModal(gameId) {
  editingGameId = gameId || null;
  document.getElementById("game-modal-title").textContent = gameId ? "Oyun Düzenle" : "Oyun Ekle";
  document.getElementById("edit-game-id").value = gameId || "";
  document.getElementById("game-modal-error").textContent = "";

  // Görsel alanlarını sıfırla
  
  const imgUrl  = document.getElementById("gm-image-url");
  const imgPrev = document.getElementById("img-preview");
  
  if (imgUrl)  imgUrl.value  = "";
  if (imgPrev) imgPrev.style.display = "none";
  // Her açılışta file sekmesine dön
  if (typeof window.switchImgTab === "function") window.switchImgTab("file");
  

  if (!gameId) {
    // Yeni oyun — alanları temizle
    document.getElementById("gm-name").value     = "";
    document.getElementById("gm-platform").value = "PC / Steam";
    document.getElementById("gm-price").value    = "";
    document.getElementById("gm-emoji").value    = "🎮";
    document.getElementById("gm-steam-user").value = "";
    document.getElementById("gm-steam-pass").value = "";
    document.getElementById("gm-gmail-user").value = "";
    document.getElementById("gm-gmail-pass").value = "";
    setRequiresCode(true);
  } else {
    // Düzenleme — mevcut değerleri doldur (şifreler dahil)
    const game = cachedGames.find(g => g.id === gameId);
    if (game) {
      document.getElementById("gm-name").value     = game.name     || "";
      document.getElementById("gm-platform").value = game.platform || "PC / Steam";
      document.getElementById("gm-price").value    = game.price    || "";
      document.getElementById("gm-emoji").value    = game.emoji    || "🎮";
      // ŞİFRELER GÖRÜNSÜN
      document.getElementById("gm-steam-user").value = game.steamUser || "";
      document.getElementById("gm-steam-pass").value = game.steamPass || "";
      document.getElementById("gm-gmail-user").value = game.gmailUser || "";
      document.getElementById("gm-gmail-pass").value = game.gmailPass || "";
      // Mevcut görsel varsa URL sekmesinde göster
      if (game.image && imgUrl && imgPrev) {
        imgUrl.value = game.image;
        const imgEl = document.getElementById("img-preview-el");
        if (imgEl) imgEl.src = game.image;
        imgPrev.style.display = "block";
        // URL sekmesine geç ki mevcut URL görünsün
        if (typeof window.switchImgTab === "function") window.switchImgTab("url");
      }
      setRequiresCode(game.requiresCode !== false);
      // Hesap türünü yükle
      if (typeof window.setAccountType === "function") {
        window.setAccountType(game.accountType || (game.requiresCode !== false ? "personal" : "general"));
      }
    }
  }
  document.getElementById("game-modal").style.display = "flex";
}

function closeGameModal() {
  document.getElementById("game-modal").style.display = "none";
  editingGameId = null;
}

async function saveGame() {
  const name     = document.getElementById("gm-name").value.trim();
  const platform = document.getElementById("gm-platform").value.trim();
  const price    = document.getElementById("gm-price").value.trim();
  const emoji    = document.getElementById("gm-emoji").value.trim();
  const errEl    = document.getElementById("game-modal-error");

  // requiresCode toggle
  const rcEl = document.getElementById("gm-requires-code");
  const requiresCode = rcEl ? rcEl.checked : true;

  // Görsel URL — sadece URL sekmesi aktifse oku, dosya sekmesindeyse mevcut görseli koru
  const imgTabUrl   = document.getElementById("img-tab-url");
  const imageUrlEl  = document.getElementById("gm-image-url");
  const urlTabActive = imgTabUrl && imgTabUrl.classList.contains("active");
  const imageUrl    = urlTabActive && imageUrlEl ? imageUrlEl.value.trim() : "";

  // Steam her zaman oku
  const steamUser = document.getElementById("gm-steam-user").value.trim();
  const steamPass = document.getElementById("gm-steam-pass").value.trim();
  // Gmail sadece requiresCode açıksa
  const gmailUser = requiresCode ? document.getElementById("gm-gmail-user").value.trim() : "";
  const gmailPass = requiresCode ? document.getElementById("gm-gmail-pass").value.trim() : "";

  if (!name) { errEl.textContent = "Oyun adı zorunlu."; errEl.style.color = "var(--red)"; return; }
  if (!steamUser || !steamPass) {
    errEl.textContent = "Steam kullanıcı adı ve şifre zorunlu.";
    errEl.style.color = "var(--red)"; return;
  }

  const accountTypeEl = document.getElementById("gm-account-type");
  const accountType   = accountTypeEl ? accountTypeEl.value : "personal";

  const payload = {
    adminKey: ADMIN_KEY,
    gameName:    name,
    platform,
    price,
    emoji,
    requiresCode: requiresCode ? "true" : "false",
    accountType,
    steamUser,
    steamPass,
    gmailUser,
    gmailPass,
    imageUrl:    imageUrl || "",
  };
  if (editingGameId) payload.gameId = editingGameId;

  errEl.textContent = "Kaydediliyor...";
  errEl.style.color = "var(--text2)";

  const endpoint = editingGameId
    ? `${BACKEND}/api/admin/edit-game`
    : `${BACKEND}/api/admin/add-game`;
  try {
    const res  = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeGameModal();
      adminDataCache = null; // cache sıfırla
      loadGames();
      showToast(editingGameId ? "Oyun güncellendi. ✓" : "Oyun eklendi. ✓");
    } else {
      errEl.style.color  = "var(--red)";
      errEl.textContent  = data.message || "Hata oluştu.";
    }
  } catch(e) {
    errEl.style.color  = "var(--red)";
    errEl.textContent  = "Sunucu hatası: " + (e.message || "");
  }
}

async function deleteGame(gameId, name) {
  if (!confirm(`"${name}" oyununu silmek istediğine emin misin?`)) return;
  try {
    const res = await fetch(`${BACKEND}/api/admin/delete-game`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({adminKey: ADMIN_KEY, gameId})
    });
    const data = await res.json();
    if (data.success) { adminDataCache = null; loadGames(); showToast("Oyun silindi."); }
    else showToast(data.message, "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

// =============================================
// KODLAR
// =============================================
async function loadCodes() {
  const el = document.getElementById("codes-list");
  el.innerHTML = "<div class='loading'>Yükleniyor...</div>";
  try {
    const d = await fetchAdminData();
    allCodes = d.codes.codes || [];
    renderCodesTable(allCodes);
  } catch(e) { el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function renderCodesTable(codes) {
  const el = document.getElementById("codes-list");
  if (!codes.length) { el.innerHTML = "<div class='empty'>Kod bulunamadı.</div>"; return; }
  el.innerHTML = `
    <table>
      <thead><tr><th>Kod</th><th>Tür</th><th>Durum</th><th>Kullanan</th><th>Tarih</th><th>İşlem</th></tr></thead>
      <tbody>
        ${codes.map(c => `
          <tr>
            <td><span class="code-mono">${c.code}</span></td>
            <td>${c.exclusive
              ? `<span style="color:#fabd00;font-size:11px;font-weight:700;">💎 Özel<br><span style="color:var(--text3);font-weight:400;">${c.exclusiveGameName||''}</span></span>`
              : `<span class="balance-chip">${c.balance} hak</span>`
            }</td>
            <td>${c.redeemedBy ? '<span class="badge-used">Kullanıldı</span>' : '<span class="badge-unused">Bekliyor</span>'}</td>
            <td style="color:var(--text2);">${c.redeemedBy || '<span style="color:var(--text3)">—</span>'}</td>
            <td style="color:var(--text2); font-size:12px;">${c.redeemedAt ? formatDate(c.redeemedAt) : '—'}</td>
            <td>${!c.redeemedBy ? `<button class="btn-danger" onclick="deleteCode('${c.code}')">🗑</button>` : '—'}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function filterCodes() {
  const search = document.getElementById("code-search").value.toLowerCase();
  const filter = document.getElementById("code-filter").value;
  let filtered = allCodes.filter(c => c.code.toLowerCase().includes(search));
  if (filter === "used") filtered = filtered.filter(c => c.redeemedBy);
  if (filter === "unused") filtered = filtered.filter(c => !c.redeemedBy);
  renderCodesTable(filtered);
}

async function deleteCode(code) {
  if (!confirm(`"${code}" kodunu silmek istiyor musun?`)) return;
  try {
    const res = await fetch(`${BACKEND}/api/admin/delete-code`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({adminKey: ADMIN_KEY, code})
    });
    const data = await res.json();
    if (data.success) { loadCodes(); showToast("Kod silindi."); }
    else showToast(data.message || "Hata.", "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

function openCodeModal() {
  document.getElementById("cm-result").innerHTML = "";
  document.getElementById("cm-codes-list").style.display = "none";
  document.getElementById("cm-copy-btn-area").style.display = "none";
  document.getElementById("cm-codes-list").innerHTML = "";
  generatedCodes = [];
  document.getElementById("code-modal").style.display = "flex";
}

function closeCodeModal() {
  document.getElementById("code-modal").style.display = "none";
  loadCodes();
}

async function generateCodes() {
  const count = parseInt(document.getElementById("cm-count").value) || 1;
  const balance = parseInt(document.getElementById("cm-balance").value) || 1;
  const resultEl = document.getElementById("cm-result");
  resultEl.innerHTML = "⏳ Oluşturuluyor...";
  generatedCodes = [];

  for (let i = 0; i < count; i++) {
    const code = makeCode();
    try {
      const res = await fetch(`${BACKEND}/api/admin/add-code`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({adminKey: ADMIN_KEY, code, balance})
      });
      const data = await res.json();
      if (data.success) generatedCodes.push(code);
    } catch(e) {}
  }

  if (generatedCodes.length) {
    resultEl.innerHTML = `<span style="color:var(--green)">✓ ${generatedCodes.length} kod oluşturuldu.</span>`;
    const listEl = document.getElementById("cm-codes-list");
    listEl.style.display = "block";
    listEl.innerHTML = generatedCodes.map(c => `
      <div class="generated-code-item">
        <span>${c}</span>
        <button onclick="copySingle('${c}')">Kopyala</button>
      </div>
    `).join("");
    document.getElementById("cm-copy-btn-area").style.display = "flex";
  } else {
    resultEl.innerHTML = `<span style="color:var(--red)">Hata oluştu.</span>`;
  }
}

function makeCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let c = "";
  for (let i = 0; i < 24; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c.match(/.{1,4}/g).join("-");
}

// ── Exclusive Kod Oluştur ──
function openExclusiveCodeModal() {
  const sel = document.getElementById("ecm-game-select");
  if (!sel) return;
  const exclusiveGames = cachedGames.filter(g => g.exclusive);
  if (!exclusiveGames.length) {
    showToast("Önce en az bir oyunu 'Özel' yapmalısın.", "error");
    return;
  }
  sel.innerHTML = exclusiveGames.map(g => `<option value="${g.id}">${g.emoji||'🎮'} ${g.name}</option>`).join("");
  document.getElementById("ecm-result").innerHTML = "";
  document.getElementById("ecm-codes-list").style.display = "none";
  document.getElementById("ecm-codes-list").innerHTML = "";
  document.getElementById("exclusive-code-modal").style.display = "flex";
}

function closeExclusiveCodeModal() {
  document.getElementById("exclusive-code-modal").style.display = "none";
  loadCodes();
}

async function generateExclusiveCodes() {
  const gameId = document.getElementById("ecm-game-select").value;
  const count = parseInt(document.getElementById("ecm-count").value) || 1;
  const resultEl = document.getElementById("ecm-result");
  resultEl.innerHTML = "⏳ Oluşturuluyor...";
  const generated = [];

  for (let i = 0; i < Math.min(count, 50); i++) {
    const code = makeCode();
    try {
      const res = await fetch(`${BACKEND}/api/admin/add-exclusive-code`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ adminKey: ADMIN_KEY, code, gameId })
      });
      const data = await res.json();
      if (data.success) generated.push({ code, gameName: data.gameName });
    } catch(e) {}
  }

  if (generated.length) {
    resultEl.innerHTML = `<span style="color:var(--green)">✓ ${generated.length} özel kod oluşturuldu → ${generated[0].gameName}</span>`;
    const listEl = document.getElementById("ecm-codes-list");
    listEl.style.display = "block";
    listEl.innerHTML = generated.map(c => `
      <div class="generated-code-item">
        <span>${c.code}</span>
        <button onclick="copySingle('${c.code}')">Kopyala</button>
      </div>
    `).join("");
    // Tüm kodları kopyala butonu
    const copyAll = document.getElementById("ecm-copy-all");
    if (copyAll) { copyAll.style.display = "block"; copyAll._codes = generated.map(c=>c.code); }
  } else {
    resultEl.innerHTML = `<span style="color:var(--red)">Kod oluşturulamadı.</span>`;
  }
}

function copySingle(code) { navigator.clipboard.writeText(code).then(() => showToast("Kopyalandı!")); }
function copyAllGenerated() { navigator.clipboard.writeText(generatedCodes.join("\n")).then(() => showToast("Tüm kodlar kopyalandı!")); }
function exportGenerated() {
  const csv = "Kod,Bakiye\n" + generatedCodes.map(c => `${c},${document.getElementById("cm-balance").value}`).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gamevault-codes.csv";
  a.click();
}

// =============================================
// KULLANICILAR
// =============================================
async function loadUsers(search = "") {
  const el = document.getElementById("users-list");
  el.innerHTML = "<div class='loading'>Yükleniyor...</div>";
  try {
    // Arama varsa her zaman taze çek; yoksa cache kullan
    if (search) {
      const res = await fetch(`${BACKEND}/api/admin/get-users`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({adminKey: ADMIN_KEY, search})
      });
      const data = await res.json();
      if (!data.success) { el.innerHTML = "<div class='empty'>Hata.</div>"; return; }
      allUsers = data.users;
    } else {
      const d = await fetchAdminData();
      allUsers = d.users.users || [];
    }
    renderUsersTable(allUsers);
  } catch(e) { el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function renderUsersTable(users) {
  const el = document.getElementById("users-list");
  if (!users.length) { el.innerHTML = "<div class='empty'>Kullanıcı bulunamadı.</div>"; return; }
  el.innerHTML = `
    <table>
      <thead><tr><th>Kullanıcı Adı</th><th>E-posta</th><th>Bakiye</th><th>Kayıt Tarihi</th><th>İşlem</th></tr></thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td><strong>${u.username}</strong></td>
            <td style="font-size:12px;color:var(--text2);">${u.email || '<span style="color:var(--text3)">—</span>'}</td>
            <td><span class="balance-chip">${u.balance}</span></td>
            <td style="color:var(--text2); font-size:12px;">${formatDate(u.createdAt)}</td>
            <td><button class="btn-sm-balance" onclick="openUserModal('${escJs(u.username)}', ${u.balance})">✏️ Bakiye Düzenle</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function searchUsers() {
  const q = document.getElementById("user-search").value;
  if (q.length >= 2 || q.length === 0) loadUsers(q);
}

let _currentUserBalance = 0;

function openUserModal(username, balance) {
  editingUsername = username;
  _currentUserBalance = parseInt(balance) || 0;
  document.getElementById("um-username-label").innerHTML = `<span>👤</span><strong>${username}</strong>`;
  document.getElementById("um-balance").value = "";
  document.getElementById("um-grant-amount").value = "";
  document.getElementById("um-deduct-amount").value = "";
  document.getElementById("um-current-balance").textContent = _currentUserBalance;
  document.getElementById("um-result").textContent = "";
  document.getElementById("um-result").style.color = "";
  document.getElementById("user-modal").style.display = "flex";
}

function closeUserModal() {
  document.getElementById("user-modal").style.display = "none";
  editingUsername = null;
}

function _setResultMsg(msg, ok) {
  const el = document.getElementById("um-result");
  el.textContent = msg;
  el.style.color = ok ? "var(--green)" : "var(--red)";
}

async function _doUpdateBalance(newBal) {
  try {
    const res = await fetch(`${BACKEND}/api/admin/update-balance`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ adminKey: ADMIN_KEY, username: editingUsername, balance: newBal })
    });
    const data = await res.json();
    if (data.success) {
      _currentUserBalance = newBal;
      document.getElementById("um-current-balance").textContent = newBal;
      adminDataCache = null;
      loadUsers();
      return true;
    } else {
      _setResultMsg(data.message || "Hata.", false);
      return false;
    }
  } catch(e) { _setResultMsg("Sunucu hatası.", false); return false; }
}

// Hızlı +N ekleme
async function quickGrant(amount) {
  const newBal = _currentUserBalance + amount;
  const ok = await _doUpdateBalance(newBal);
  if (ok) _setResultMsg(`✓ +${amount} eklendi. Yeni bakiye: ${newBal}`, true);
}

// Özel miktar ekleme
async function grantBalance() {
  const amount = parseInt(document.getElementById("um-grant-amount").value) || 0;
  if (amount <= 0) { _setResultMsg("Geçerli bir miktar gir.", false); return; }
  const newBal = _currentUserBalance + amount;
  const ok = await _doUpdateBalance(newBal);
  if (ok) { _setResultMsg(`✓ +${amount} eklendi. Yeni bakiye: ${newBal}`, true); document.getElementById("um-grant-amount").value = ""; }
}

// Hızlı -N çıkarma
async function deductBalance(amount) {
  const newBal = Math.max(0, _currentUserBalance - amount);
  const ok = await _doUpdateBalance(newBal);
  if (ok) _setResultMsg(`✓ -${amount} çıkarıldı. Yeni bakiye: ${newBal}`, true);
}

// Özel miktar çıkarma
async function deductBalanceCustom() {
  const amount = parseInt(document.getElementById("um-deduct-amount").value) || 0;
  if (amount <= 0) { _setResultMsg("Geçerli bir miktar gir.", false); return; }
  const newBal = Math.max(0, _currentUserBalance - amount);
  const ok = await _doUpdateBalance(newBal);
  if (ok) { _setResultMsg(`✓ -${amount} çıkarıldı. Yeni bakiye: ${newBal}`, true); document.getElementById("um-deduct-amount").value = ""; }
}

// Direkt bakiye ayarla
async function saveUserBalance() {
  const val = parseInt(document.getElementById("um-balance").value);
  if (isNaN(val) || val < 0) { _setResultMsg("Geçerli bir değer gir.", false); return; }
  const ok = await _doUpdateBalance(val);
  if (ok) { _setResultMsg(`✓ Bakiye ${val} olarak ayarlandı.`, true); document.getElementById("um-balance").value = ""; }
}

// =============================================
// SATIN ALMALAR
// =============================================
async function loadPurchases() {
  const el = document.getElementById("purchases-list");
  el.innerHTML = "<div class='loading'>Yükleniyor...</div>";
  try {
    const d = await fetchAdminData();
    allPurchases = d.purchases.purchases || [];
    renderPurchasesTable(allPurchases);
  } catch(e) { el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function renderPurchasesTable(purchases) {
  const el = document.getElementById("purchases-list");
  if (!purchases.length) { el.innerHTML = "<div class='empty'>Henüz satın alım yok.</div>"; return; }
  el.innerHTML = `
    <table>
      <thead><tr><th>Kod</th><th>Oyun</th><th>Tarih</th><th>2FA Talebi</th><th>İşlem</th></tr></thead>
      <tbody>
        ${purchases.map(p => {
          const raw   = p.steamCodeRequests || 0;
          // raw negatifse admin bonus vermiş: kapasite = 5 + |negatif|
          const cap   = raw < 0 ? 5 + Math.abs(raw) : 5;
          const used  = Math.max(0, raw);
          const left  = cap - used;
          const pct   = Math.min(100, (used / cap) * 100);
          const isMax = left <= 0;
          const hasBonus = raw < 0;
          // Renk: doluysa kırmızı, bonus varsa yeşil→mor, normal mavi
          const barColor = isMax
            ? "var(--red)"
            : hasBonus
              ? "linear-gradient(90deg,#00e87a,#7b2ff7)"
              : "linear-gradient(90deg,var(--accent),var(--accent2))";
          const countColor = isMax ? "var(--red)" : hasBonus ? "#00e87a" : "var(--text2)";
          return `
          <tr>
            <td><span class="code-mono" style="font-size:11px;letter-spacing:1px;">${p.code || '—'}</span></td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:1rem;">${p.gameEmoji||'🎮'}</span>
                <span>${p.gameName}</span>
              </div>
            </td>
            <td style="color:var(--text2);font-size:12px;">${formatDate(p.purchasedAt)}</td>
            <td>
              <div style="display:flex;align-items:center;gap:10px;min-width:160px;">
                <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;">
                  <div style="height:100%;width:${pct}%;background:${barColor};border-radius:4px;transition:width 0.4s;"></div>
                </div>
                <span style="font-size:12px;font-weight:800;color:${countColor};min-width:36px;text-align:right;">
                  ${used}/${cap}${hasBonus ? ' <span style="font-size:10px;color:#7b2ff7;">+bonus</span>' : ''}
                </span>
              </div>
              <div style="font-size:10px;color:${isMax?'var(--red)':hasBonus?'#00e87a':'var(--text3)'};margin-top:3px;padding-left:0;">
                ${isMax ? '⛔ Limit doldu' : `${left} hak kaldı`}
              </div>
            </td>
            <td>
              <button
                class="btn-grant-req"
                onclick="grantRequests('${p.id}', this)"
                title="+3 hak ekle"
              >➕ +3 Hak</button>
            </td>
          </tr>
        `}).join("")}
      </tbody>
    </table>
  `;
}

async function grantRequests(purchaseId, btn) {
  btn.disabled = true;
  btn.textContent = "⏳";
  try {
    const res = await fetch(`${BACKEND}/api/admin/grant-requests`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ adminKey: ADMIN_KEY, purchaseId, amount: 3 })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ +3 hak eklendi. Toplam kapasite: ${data.remaining}`);
      adminDataCache = null;
      loadPurchases();
    } else {
      showToast(data.message || "Hata.", "error");
      btn.disabled = false;
      btn.textContent = "➕ +3 Hak";
    }
  } catch(e) {
    showToast("Sunucu hatası.", "error");
    btn.disabled = false;
    btn.textContent = "➕ +3 Hak";
  }
}

function filterPurchases() {
  const q = document.getElementById("purchase-search").value.toLowerCase();
  const filtered = allPurchases.filter(p =>
    p.username.toLowerCase().includes(q) || p.gameName.toLowerCase().includes(q)
  );
  renderPurchasesTable(filtered);
}

// =============================================
// DESTEK TALEPLERİ
// =============================================
async function loadTickets() {
  const el = document.getElementById("tickets-list");
  el.innerHTML = "<div class='loading'>Yükleniyor...</div>";
  try {
    const d = await fetchAdminData();
    allTickets = d.tickets.requests || [];
    filterTickets();
  } catch(e) { el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function filterTickets() {
  const filter = document.getElementById("ticket-filter").value;
  let filtered = allTickets;
  if (filter === "open") filtered = allTickets.filter(t => t.status !== "closed");
  if (filter === "closed") filtered = allTickets.filter(t => t.status === "closed");
  renderTicketsTable(filtered);
}

function renderTicketsTable(tickets) {
  const el = document.getElementById("tickets-list");
  if (!tickets.length) { el.innerHTML = "<div class='empty'>Talep bulunamadı.</div>"; return; }
  el.innerHTML = `
    <table>
      <thead><tr><th>Kullanıcı</th><th>Konu</th><th>Mesaj</th><th>Durum</th><th>Tarih</th><th>İşlem</th></tr></thead>
      <tbody>
        ${tickets.map(t => `
          <tr>
            <td><strong>${t.username || '—'}</strong></td>
            <td><span style="font-size:12px;">${typeLabel(t.type)}</span></td>
            <td style="font-size:12px; color:var(--text2); max-width:200px;">${(t.message||'—').substring(0,60)}${(t.message||'').length>60?'...':''}</td>
            <td>
              ${t.status === 'closed'
                ? '<span class="badge-used">Kapatıldı</span>'
                : '<span class="badge-open">Açık</span>'}
            </td>
            <td style="color:var(--text2); font-size:12px;">${formatDate(t.createdAt)}</td>
            <td>
              ${t.status !== 'closed'
                ? `<button class="btn-edit" onclick="openTicketModal('${t.id}', \`${escJs(t.username||'')}\`, \`${escJs(t.type||'')}\`, \`${escJs(t.message||'')}\`)">💬 Cevapla</button>`
                : `<span style="color:var(--text3);font-size:11px;">${t.adminReply ? t.adminReply.substring(0,20)+'...' : '—'}</span>`}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function openTicketModal(ticketId, username, type, message) {
  document.getElementById("tm-ticket-id").value = ticketId;
  document.getElementById("tm-reply").value = "";
  document.getElementById("tm-grant").checked = false;
  document.getElementById("tm-ticket-info").innerHTML = `
    <div class="tinfo-row"><strong>Kullanıcı:</strong> ${username}</div>
    <div class="tinfo-row"><strong>Konu:</strong> ${typeLabel(type)}</div>
    <div class="tinfo-row tinfo-msg">${message}</div>
  `;
  document.getElementById("ticket-modal").style.display = "flex";
}

function closeTicketModal() { document.getElementById("ticket-modal").style.display = "none"; }

async function saveTicketReply() {
  const ticketId = document.getElementById("tm-ticket-id").value;
  const reply = document.getElementById("tm-reply").value.trim();
  const grantExtra = document.getElementById("tm-grant").checked;
  if (!reply) { showToast("Cevap yaz.", "error"); return; }
  try {
    const res = await fetch(`${BACKEND}/api/admin/reply-support`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({adminKey: ADMIN_KEY, requestId: ticketId, reply, status: "closed", grantExtra})
    });
    const data = await res.json();
    if (data.success) {
      closeTicketModal(); loadTickets();
      showToast(grantExtra ? "Cevap gönderildi ve ek hak verildi. ✓" : "Cevap gönderildi. ✓");
    } else showToast(data.message || "Hata.", "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

// =============================================
// AYARLAR
// =============================================
async function loadSettings() {
  try {
    const res = await fetch(`${BACKEND}/api/stats`);
    const data = await res.json();
    if (data.success) {
      document.getElementById("settings-rating").value = data.rating || 5;
      serverIsActive = data.serverStatus !== false;
      updateServerToggleUI();
    }
  } catch(e) {}
}

function updateServerToggleUI() {
  const btn = document.getElementById("server-toggle");
  if (serverIsActive) {
    btn.textContent = "✅ Aktif";
    btn.style.background = "rgba(0,232,122,0.1)";
    btn.style.color = "var(--green)";
    btn.style.border = "1px solid rgba(0,232,122,0.3)";
  } else {
    btn.textContent = "🔴 Bakımda";
    btn.style.background = "rgba(255,63,92,0.1)";
    btn.style.color = "var(--red)";
    btn.style.border = "1px solid rgba(255,63,92,0.3)";
  }
}

async function toggleServer() {
  serverIsActive = !serverIsActive;
  updateServerToggleUI();
  try {
    await fetch(`${BACKEND}/api/admin/update-settings`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({adminKey: ADMIN_KEY, serverStatus: serverIsActive})
    });
    showToast(`Sunucu durumu: ${serverIsActive ? "Aktif" : "Bakımda"}`);
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

async function saveSettings() {
  const rating = parseFloat(document.getElementById("settings-rating").value);
  if (isNaN(rating) || rating < 0 || rating > 5) { showToast("Puan 0-5 arasında olmalı.", "error"); return; }
  try {
    const res = await fetch(`${BACKEND}/api/admin/update-settings`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({adminKey: ADMIN_KEY, rating})
    });
    const data = await res.json();
    if (data.success) showToast("Puan güncellendi. ✓");
    else showToast(data.message, "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

// =============================================
// POPULAR TOGGLE
// =============================================
async function toggleExclusive(gameId, makeExclusive) {
  try {
    const res = await fetch(`${BACKEND}/api/admin/toggle-exclusive`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ adminKey: ADMIN_KEY, gameId, exclusive: makeExclusive })
    });
    const data = await res.json();
    if (data.success) {
      adminDataCache = null;
      loadGames();
      showToast(makeExclusive ? "💎 Oyun özel yapıldı." : "Özel durum kaldırıldı.");
    } else showToast(data.message, "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

async function togglePopular(gameId, makePopular, orderVal) {
  if (makePopular && cachedGames.filter(g => g.popular).length >= 6) {
    showToast("En fazla 6 popüler oyun olabilir. Önce birini çıkar.", "error"); return;
  }
  try {
    const res = await fetch(`${BACKEND}/api/admin/toggle-popular`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ adminKey: ADMIN_KEY, gameId, popular: makePopular, popularOrder: orderVal })
    });
    const data = await res.json();
    if (data.success) { showToast(makePopular ? "⭐ Popüler oyunlara eklendi!" : "Popülerden çıkarıldı."); adminDataCache = null; loadGames(); }
    else showToast(data.message || "Hata.", "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

// =============================================
// CANLI DESTEK CHAT YÖNETİMİ
// =============================================
let allChats = [];
let activeChatUser = null;
let chatPollTimer = null; // artık kullanılmıyor
let adminSSE = null;
let adminSseHeartbeat = null;
let adminSseLastBeat = 0;

async function loadChats() {
  const el = document.getElementById("chats-list");
  if (!el) return;
  try {
    const res = await fetch(`${BACKEND}/api/admin/get-chats`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ adminKey: ADMIN_KEY })
    });
    const data = await res.json();
    allChats = data.chats || [];
    renderChatList();
    // Okunmamış badge
    const total = allChats.reduce((s,c) => s + (c.unreadAdmin||0), 0);
    const badge = document.getElementById("chat-unread-badge");
    if (badge) badge.style.display = total > 0 ? "inline" : "none";
  } catch(e) { if(el) el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function renderChatList() {
  const el = document.getElementById("chats-list");
  if (!el) return;
  if (!allChats.length) { el.innerHTML = "<div class='empty'>Henüz mesaj yok.</div>"; return; }
  el.innerHTML = allChats.map(c => `
    <div class="chat-user-item ${activeChatUser === c.username ? 'active' : ''}" onclick="openChat('${escJs(c.username)}')">
      <div class="cui-avatar">${c.username[0].toUpperCase()}</div>
      <div class="cui-info">
        <div class="cui-name">${c.username} ${c.unreadAdmin > 0 ? `<span class="cui-badge">${c.unreadAdmin}</span>` : ''}</div>
        <div class="cui-last">${(c.lastMessage||'').substring(0,40)}</div>
      </div>
      <div class="cui-time">${c.lastAt ? new Date(c.lastAt).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}) : ''}</div>
    </div>
  `).join("");
}

async function openChat(username) {
  activeChatUser = username;
  renderChatList();
  const win = document.getElementById("chat-window");
  const titleEl = document.getElementById("chat-window-title");
  if (titleEl) titleEl.textContent = "💬 " + username;
  if (win) win.style.display = "flex";
  await loadChatMessages();
  adminSubscribeSSE(username); // SSE ile dinle — polling yok
}

// Admin SSE — kullanıcı mesaj atınca push gelir
function adminSubscribeSSE(username) {
  // Önceki bağlantıyı kapat
  if (adminSSE) { adminSSE.close(); adminSSE = null; }
  if (adminSseHeartbeat) { clearInterval(adminSseHeartbeat); adminSseHeartbeat = null; }

  const url = `${BACKEND}/api/chat/subscribe-admin?username=${encodeURIComponent(username)}&adminKey=${encodeURIComponent(ADMIN_KEY)}`;
  adminSSE = new EventSource(url);
  adminSseLastBeat = Date.now();

  adminSSE.onopen = () => { adminSseLastBeat = Date.now(); };

  adminSSE.onmessage = function(e) {
    adminSseLastBeat = Date.now();
    if (!e.data || e.data.trim() === "") return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.sender === "user") {
        const msgs = document.getElementById("chat-messages");
        if (msgs) {
          const el = document.createElement("div");
          el.className = "chat-msg chat-msg-user";
          el.innerHTML = `<div class="chat-bubble">${escHtmlAdmin(msg.text)}</div><div class="chat-time">${new Date(msg.createdAt).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}</div>`;
          msgs.appendChild(el);
          msgs.scrollTop = msgs.scrollHeight;
        }
        // Badge güncelle — Firestore okuma YOK, bellekteki listeyi kullan
        updateChatBadgeLocal(activeChatUser);
      }
    } catch(_) {}
  };

  adminSSE.onerror = function() {
    if (adminSSE) { adminSSE.close(); adminSSE = null; }
    if (activeChatUser) setTimeout(() => adminSubscribeSSE(activeChatUser), 2000);
  };

  // Heartbeat watchdog
  adminSseHeartbeat = setInterval(() => {
    if (!activeChatUser) return;
    if (Date.now() - adminSseLastBeat > 35000) {
      if (adminSSE) { adminSSE.close(); adminSSE = null; }
      adminSubscribeSSE(activeChatUser);
    }
  }, 10000);
}

function escHtmlAdmin(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// Badge'i bellek içi sayaçla güncelle — Firestore okuma yok
function updateChatBadgeLocal(fromUsername) {
  // allChats listesindeki ilgili kullanıcının unreadAdmin sayısını artır
  const chat = allChats.find(c => c.username === fromUsername);
  if (chat) chat.unreadAdmin = (chat.unreadAdmin || 0) + 1;
  const total = allChats.reduce((s, c) => s + (c.unreadAdmin || 0), 0);
  const badge = document.getElementById("chat-unread-badge");
  if (badge) badge.style.display = total > 0 ? "inline" : "none";
  renderChatList();
}

async function loadChatMessages() {
  if (!activeChatUser) return;
  try {
    const res = await fetch(`${BACKEND}/api/chat/messages?username=${encodeURIComponent(activeChatUser)}&adminKey=${encodeURIComponent(ADMIN_KEY)}`);
    const data = await res.json();
    if (!data.success) return;
    const msgs = document.getElementById("chat-messages");
    if (!msgs) return;
    msgs.innerHTML = data.messages.map(m => `
      <div class="chat-msg ${m.sender === 'admin' ? 'chat-msg-admin' : 'chat-msg-user'}">
        <div class="chat-bubble">${escHtmlAdmin(m.text)}</div>
        <div class="chat-time">${new Date(m.createdAt).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    `).join("");
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) {}
}

async function sendAdminChatMsg() {
  const inp = document.getElementById("chat-admin-input");
  const msg = inp?.value.trim();
  if (!msg || !activeChatUser) return;
  inp.value = "";

  // Anında göster
  const msgs = document.getElementById("chat-messages");
  if (msgs) {
    const el = document.createElement("div");
    el.className = "chat-msg chat-msg-admin";
    el.innerHTML = `<div class="chat-bubble">${escHtmlAdmin(msg)}</div><div class="chat-time">${new Date().toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}</div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  try {
    await fetch(`${BACKEND}/api/chat/send`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ username: activeChatUser, message: msg, isAdmin: true, adminKey: ADMIN_KEY })
    });
    // loadChats() kaldırıldı — admin mesaj gönderince Firestore okuma gerekmez
  } catch(e) { showToast("Mesaj gönderilemedi.", "error"); }
}

// =============================================
// REVIEWS YÖNETİMİ
// =============================================
let allReviews = [];
let editingReviewId = null;

async function loadReviews() {
  const el = document.getElementById("reviews-list");
  if (!el) return;
  el.innerHTML = "<div class='loading'>Yükleniyor...</div>";
  try {
    const res = await fetch(`${BACKEND}/api/reviews`);
    const data = await res.json();
    allReviews = data.reviews || [];
    renderReviewsList();
  } catch(e) { el.innerHTML = "<div class='empty'>Sunucu hatası.</div>"; }
}

function renderReviewsList() {
  const el = document.getElementById("reviews-list");
  if (!el) return;
  if (!allReviews.length) { el.innerHTML = "<div class='empty'>Henüz yorum eklenmemiş.</div>"; return; }
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px;">` + allReviews.map(r => `
    <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:1rem 1.25rem;display:flex;align-items:center;gap:1rem;">
      <div style="font-size:1.5rem;">${r.avatar||'😊'}</div>
      <div style="flex:1;">
        <div style="font-weight:700;color:#f0f2f8;font-size:0.9rem;">${r.username} <span style="color:#f5c518;">${'★'.repeat(r.rating||5)}</span></div>
        <div style="font-size:0.8rem;color:#5a6478;margin-top:3px;">"${r.message}"</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn-edit" onclick="openReviewModal('${r.id}')">✏️</button>
        <button class="btn-danger" onclick="deleteReview('${r.id}')">🗑</button>
      </div>
    </div>
  `).join("") + `</div>`;
}

function openReviewModal(reviewId) {
  editingReviewId = reviewId || null;
  if (reviewId) {
    const r = allReviews.find(x => x.id === reviewId);
    if (r) {
      document.getElementById("rv-username").value = r.username||"";
      document.getElementById("rv-message").value = r.message||"";
      document.getElementById("rv-avatar").value = r.avatar||"😊";
      document.getElementById("rv-rating").value = r.rating||5;
      document.getElementById("rv-order").value = r.order||99;
    }
  } else {
    document.getElementById("rv-username").value = "";
    document.getElementById("rv-message").value = "";
    document.getElementById("rv-avatar").value = "😊";
    document.getElementById("rv-rating").value = 5;
    document.getElementById("rv-order").value = allReviews.length + 1;
  }
  document.getElementById("review-modal-error").textContent = "";
  document.getElementById("review-modal").style.display = "flex";
}
function closeReviewModal() { document.getElementById("review-modal").style.display = "none"; editingReviewId = null; }

async function saveReview() {
  const username = document.getElementById("rv-username").value.trim();
  const message = document.getElementById("rv-message").value.trim();
  const avatar = document.getElementById("rv-avatar").value.trim();
  const rating = document.getElementById("rv-rating").value;
  const order = document.getElementById("rv-order").value;
  const errEl = document.getElementById("review-modal-error");
  if (!username || !message) { errEl.textContent = "Ad ve mesaj zorunlu."; errEl.style.color = "var(--red)"; return; }
  const endpoint = editingReviewId ? `${BACKEND}/api/admin/update-review` : `${BACKEND}/api/admin/add-review`;
  const body = { adminKey: ADMIN_KEY, username, message, avatar, rating, order };
  if (editingReviewId) body.reviewId = editingReviewId;
  try {
    const res = await fetch(endpoint, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.success) { closeReviewModal(); loadReviews(); showToast(editingReviewId ? "Yorum güncellendi. ✓" : "Yorum eklendi. ✓"); }
    else { errEl.textContent = data.message; errEl.style.color = "var(--red)"; }
  } catch(e) { errEl.textContent = "Sunucu hatası."; errEl.style.color = "var(--red)"; }
}

async function deleteReview(reviewId) {
  if (!confirm("Yorumu silmek istiyor musun?")) return;
  try {
    const res = await fetch(`${BACKEND}/api/admin/delete-review`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ adminKey: ADMIN_KEY, reviewId })
    });
    const data = await res.json();
    if (data.success) { loadReviews(); showToast("Yorum silindi."); }
    else showToast(data.message, "error");
  } catch(e) { showToast("Sunucu hatası.", "error"); }
}

// =============================================
// YARDIMCILAR
// =============================================
function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("tr-TR", {day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"});
}

function escJs(str) { return (str || "").replace(/`/g, "\\`").replace(/'/g, "\\'"); }
