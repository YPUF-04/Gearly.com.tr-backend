# Gearly.com.tr - Backend Servis ve API Projesi

Bu proje, Gearly.com.tr e-ticaret platformunun iş mantığını (business logic), bulut veri tabanı mimarisini, sunucu yönetimini ve gerçek zamanlı haberleşme altyapısını barındıran Arka Yüz (Backend) projesidir.

### 🛠️ Kullanılan Teknolojiler & Mimari Yapı
- **Çalışma Ortamı (Runtime):** Node.js (Express.js Framework).
- **Bulut Veri Tabanı (Cloud Database):** **Google Firebase Admin SDK & Firestore (NoSQL)** mimarisi. Veriler NoSQL döküman yapısında gerçek zamanlı yönetilmektedir.
- **Gerçek Zamanlı Haberleşme (Real-Time Push):** **SSE (Server-Sent Events)** teknolojisi kullanılarak kullanıcı ve admin arasında sıfır Firestore okuma maliyetiyle anlık chat akışı kurulmuştur (SSE Push Architecture).
- **E-Posta & Otomasyon Sistemi:** **IMAP Altyapısı (`imap` ve `mailparser`)** kullanılarak, gelen mailler (Steam Guard 2FA kodları) anlık olarak taranır, regex desenleri ile parse edilir ve kullanıcıya saniyeler içinde dinamik olarak iletilir.
- **Bulut Dağıtım (Cloud DevOps):** **Railway.com** üzerinde bulut ortamında canlıya alınmıştır. Gelişmiş güvenlik için hassas anahtarlar `process.env` (Environment Variables) üzerinden beslenmektedir.

### ⚙️ Öne Çıkan Güvenlik ve Optimizasyonlar
- **Performans & Cache Sistemi:** Sık sorgulanan statik veriler ve oyun listeleri için in-memory cache mekanizması uygulanmıştır.
- **Güvenlik (Rate Limiter):** Kötü niyetli istekleri ve bot saldırılarını engellemek adına bellek içi (in-memory) özel Rate Limiting algoritması entegre edilmiştir.
- **Veri Güvenliği:** Firebase servis hesabı verileri kod bloğu dışında, çevre değişkenleri üzerinden şifrelenmiş olarak okunur.
