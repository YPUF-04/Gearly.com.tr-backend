# Gearly.com.tr - Backend Servis Projesi

Bu proje, oyun hesapları ve dijital ürün satışı gerçekleştiren Gearly.com.tr e-ticaret platformunun bulut veri tabanı entegrasyonunu, iş mantığını (business logic) ve arka plan süreçlerini barındıran Backend projesidir.

### 🛠️ Kullanılan Teknolojiler & Mimari
- **Arka Plan Geliştirme (Backend):** Node.js (JavaScript) mimarisi.
- **Bulut Veri Tabanı (Database):** Google **Firebase (NoSQL / Realtime Database / Firestore)** kullanılarak kullanıcı ve ürün verilerinin anlık olarak saklanması sağlanmıştır.
- **Bulut Dağıtım (DevOps):** Bulut tabanlı **Railway.com** altyapısı üzerinden dağıtımı (deployment) yapılarak servislerin canlı ortamda çalışması sağlanmıştır.
- **Mimari Yapı:** Ön yüz (Frontend) ve arka yüz (Backend) süreçlerinin birbirinden bağımsız (Decoupled) yönetildiği modern bir yapı tercih edilmiştir.

### ⚙️ Öne Çıkan Özellikler & Fonksiyonlar
- **Firebase Veri Yönetimi:** JSON formatındaki esnek veri yapıları (NoSQL) sayesinde oyun hesaplarının stok durumları ve fiyatlandırmaları gerçek zamanlı yönetilir.
- **Node.js & Sunucu Yönetimi:** Sunucu tarafında veri akışını ve iş mantığını kontrol eden asenkron kod yapısı kurulmuştur.
- **Railway Entegrasyonu:** Kodların Railway.com üzerinde bulut ortamında kesintisiz çalışması ve canlıda kalması sağlanmıştır.
