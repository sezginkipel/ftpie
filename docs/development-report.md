# ftpie — Geliştirme Raporu

> **Sürüm:** 0.1 (Kavramsal Tasarım)
> **Tarih:** Nisan 2026
> **Durum:** Ön Tasarım

---

## 1. Vizyon

**ftpie**, dosya aktarım protokollerini (FTP, FTPS, SFTP, WebDAV, S3) tek çatı altında birleştiren, modern bir geliştirici deneyimi sunan ve rakiplerinden farklı olarak **git entegrasyonu**, **dahili yapay zeka desteği** ve **gerçek zamanlı ekip işbirliği** özellikleriyle donatılmış açık kaynaklı bir masaüstü FTP istemcisidir.

FileZilla'nın yapabildiği her şeyi yapmanın ötesine geçerek, ftpie bir **deployment aracına** dönüşür: sunucuya sadece dosya göndermekle kalmaz, projeyi git geçmişiyle senkronize tutar, AI destekli otomasyon sunar ve tüm bunları yüksek performanslı, güvenli ve çapraz platform bir uygulama içinde paketler.

---

## 2. Teknoloji Yığını

### 2.1 Neden Tauri v2? (Rust + Web UI)

Saf Rust GUI framework'leri (egui, iced, slint) performans açısından güçlü olsa da FileZilla düzeyini geçecek bir arayüz için yetersiz kalır. Tauri v2, bu ikiliği çözer:

| Katman | Teknoloji | Neden |
|--------|-----------|-------|
| **Backend (Core)** | Rust + Tokio | Tüm iş mantığı Rust'ta: FTP/SFTP, dosya işlemleri, git, AI proxy, şifreleme |
| **UI (View)** | React + TypeScript | Zengin sürükle-bırak, animasyon, tema sistemi — web teknolojisi burada doğal |
| **Köprü** | Tauri v2 Commands | Rust fonksiyonları TypeScript'ten çağrılır, ikisi arasında `serde` ile JSON köprüsü |
| **Paketleme** | Tauri Bundler | Windows MSI/NSIS, macOS DMG, Linux AppImage/deb — tek komutla |

> **Önemli Not:** Tauri bir Electron değildir. Node.js yoktur. Browser engine olarak sistem webview'ı kullanılır (WebKit/Chromium). Binary boyutu Electron'un ~%10'u kadardır (~5-15 MB). Uygulama hâlâ **bir Rust uygulamasıdır** — UI sadece görüntüleme katmanıdır.

### 2.2 Temel Rust Kütüphaneleri

```toml
[dependencies]
# Async runtime
tokio = { version = "1", features = ["full"] }

# FTP/FTPS
suppaftp = { version = "6", features = ["async", "secure"] }

# SFTP
russh = "0.45"
russh-sftp = "2"

# Git
git2 = "0.19"

# HTTP (AI API çağrıları, WebDAV)
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }

# Serializasyon
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Şifreleme (bookmark sync, credential store)
aes-gcm = "0.10"
argon2 = "0.5"

# Tauri
tauri = { version = "2", features = ["protocol-asset"] }

# AWS S3
aws-sdk-s3 = "1"

# Dosya izleme (auto-sync)
notify = "7"

# Scripting (otomasyon DSL)
rhai = "1"
```

### 2.3 Frontend

- **React 19** + TypeScript
- **TanStack Query** (transfer durumu, sunucu dosya listesi)
- **Zustand** (UI state management)
- **Radix UI** + **Tailwind CSS** (erişilebilir, temaya uyumlu bileşenler)
- **Monaco Editor** (dahili kod editörü)
- **xterm.js** (SSH terminal)

---

## 3. Özellik Matrisi

### 3.1 FileZilla Paritesi (Temel)

| Özellik | FileZilla | ftpie |
|---------|-----------|-------|
| FTP | ✅ | ✅ |
| FTPS (Explicit/Implicit) | ✅ | ✅ |
| SFTP | ✅ | ✅ |
| Pasif/Aktif mod | ✅ | ✅ |
| Transfer kuyruğu | ✅ | ✅ (gelişmiş) |
| Site yöneticisi | ✅ | ✅ (şifreli, senkronize) |
| Dosya izinleri (chmod) | ✅ | ✅ |
| Sembolik link desteği | ✅ | ✅ |
| Bant genişliği limiti | ✅ | ✅ |
| Yeniden bağlanma | ✅ | ✅ |
| Büyük dosya desteği | ✅ | ✅ |
| Filtre/arama | ✅ | ✅ (regex + fuzzy) |

### 3.2 ftpie'ye Özgü Özellikler

Aşağıdaki özellikler **hiçbir mevcut FTP istemcisinde** bu bütünlükte bulunmamaktadır.

---

## 4. Benzersiz Özellikler (Rekabet Avantajı)

### 4.1 Git-Aware Deployment

FTP istemcilerinin en büyük eksikliği: dosyaları manuel seçerek göndermek zorunda kalmak. ftpie bunu tamamen ortadan kaldırır.

**Nasıl çalışır:**
1. Proje klasörünü bir FTP sunucusuyla eşleştirirsiniz
2. ftpie yerel git reposunu okur (`git2` crate ile)
3. "Deploy" dediğinizde sadece **son commit'ten bu yana değişen dosyalar** gönderilir
4. Sunucu üzerindeki dosya yapısı git ağacını yansıtır

**Özellikler:**
- **Branch deployment:** `feature/login` branch'ini staging sunucusuna, `main`'i production'a eşleştir
- **Tag-based release:** `v2.3.0` tag'ini tek tıkla production'a gönder
- **Rollback:** Sunucudaki dosyaları önceki bir commit durumuna geri al (git stash gibi, FTP üzerinde)
- **Diff görünümü:** Sunucuya gönderilecek değişiklikleri göndermeden önce inceleme paneli
- **`.ftpieignore`:** `.gitignore` mantığıyla belirli dosyaları deployment'tan hariç tut

**Desteklenen git servisleri:** GitHub, GitLab, Gitea, Bitbucket, Azure DevOps, Forgejo (öz-barındırılan)

---

### 4.2 Dahili AI Asistanı

Sohbet tabanlı değil, **bağlama duyarlı ve eyleme geçebilen** bir AI.

**Akıllı Yeniden Adlandırma:**
```
Kullanıcı: "img/ klasöründeki tüm dosyaları kebab-case'e çevir"
AI: 20 dosyayı analiz eder, önizleme gösterir, onay alır, yeniden adlandırır
```

**Deployment Önerileri:**
- Sunucudaki dosya yapısını tarar
- "Bu dizinde 3 farklı PHP sürümü var, hangisini silmemi istersiniz?" gibi öneride bulunur
- Yanlış yüklenen dosyaları tespit eder (örn. `.env` dosyasının public klasöründe olması)

**Transfer Optimizasyonu:**
- Tekrarlı dosyaları tespit eder (aynı içerik, farklı isim)
- Sıkıştırılabilir dosyaları gruplar
- Transfer sıralamasını bant genişliğine göre optimize eder

**Doğal Dil Dosya Arama:**
```
"Geçen ay değiştirilen 1MB'dan büyük PHP dosyaları"
→ Rust tarafında sorgu parse edilir, filtreleme uygulanır
```

**AI Sağlayıcı Desteği:**
- Anthropic Claude (varsayılan)
- OpenAI GPT
- Ollama (yerel, çevrimdışı mod)
- Özel OpenAI-uyumlu endpoint

---

### 4.3 Gerçek Zamanlı Ekip İşbirliği (Session Sharing)

Birden fazla kişinin aynı FTP oturumunu görmesi ve yönetmesi.

- Bağlantı kodu oluşturulur, ekip arkadaşı bu kodla oturuma katılır
- Dosya ağacı anlık senkronize görünür
- Kim ne yapıyor: renkli imleçler (Google Docs benzeri)
- Çakışma koruması: iki kişi aynı dosyayı aynı anda değiştirmeye çalışırsa uyarı
- Oturum kaydı: yapılan tüm işlemlerin zaman damgalı logu

**Kullanım senaryosu:** Bir müşteriye canlı destek sırasında onun sunucusuna birlikte bakmak; uzaktan pair-programming deploy oturumu.

---

### 4.4 Otomasyon DSL (Rhai Script)

Rust tabanlı `rhai` script motoru ile FTP işlemlerini otomatize etme.

```javascript
// ftpie_scripts/daily_backup.rhai
let conn = ftp.connect("backup.server.com", #{
    user: env("FTP_USER"),
    pass: env("FTP_PASS")
});

let files = conn.list("/var/www/html")
    .filter(|f| f.modified_days_ago() < 1);

for file in files {
    conn.download(file.path, local("./backups/" + today()));
}

notify.slack("Yedekleme tamamlandı: " + files.len() + " dosya");
```

- Yerleşik zamanlayıcı (cron benzeri)
- Webhook trigger desteği (GitHub Actions ile entegrasyon)
- Script marketplace (topluluk scriptleri)

---

### 4.5 Akıllı Transfer Kuyruğu

Mevcut istemcilerdeki transfer kuyruklarının çok ötesinde:

- **Öncelik kuyruğu:** "Bu dosyayı kuyruğun önüne al"
- **Bağımlılık tanımı:** "A dosyası yüklendikten sonra B'yi yükle"
- **Koşullu transfer:** "Sunucudaki bu dosya değiştiyse yükleme"
- **Bant genişliği takvimi:** Gece yarısı büyük transferler için zamanlama
- **Hata politikası:** Hata durumunda atla / yeniden dene (N kez) / dur / bildir
- **Transfer istatistikleri:** Geçmişe dönük grafik, ortalama hız, toplam veri

---

### 4.6 Dahili Kod Editörü + Anlık Düzenleme

FileZilla'da uzak dosyayı düzenleme: indir → düzenle → yükle (manuel).

ftpie'de:
- Uzak dosyaya çift tıkla → Monaco Editor'de açılır (VS Code motoru)
- Kaydet → otomatik FTP upload
- Syntax highlighting: 200+ dil desteği
- Değişiklikler izlenir; bağlantı kesilse bile yerel draft korunur
- Diff görünümü: orijinal (sunucu) vs mevcut (lokal draft)

---

### 4.7 Protokol Genişletilmişliği

| Protokol | Durum |
|----------|-------|
| FTP | MVP |
| FTPS (Explicit) | MVP |
| FTPS (Implicit) | MVP |
| SFTP | MVP |
| WebDAV / WebDAVS | v1.0 |
| AWS S3 | v1.0 |
| Backblaze B2 | v1.1 |
| Rclone backend | v1.2 |
| rsync (SSH) | v1.2 |

---

### 4.8 Şifreli Bulut Bookmark Senkronizasyonu

- Tüm bağlantı ayarları AES-256-GCM ile şifrelenir (master password ile Argon2 key derivation)
- Senkronizasyon backend'leri: kendi sunucun (S3/WebDAV), GitHub Gist (şifreli), yerel export/import
- Master password hiçbir zaman sunucuya gönderilmez (zero-knowledge model)
- QR kod ile cihazlar arası transfer

---

### 4.9 Güvenlik Merkezi

- **Sunucu parmak izi yönetimi** (SFTP host key)
- **Credential vault:** Parola yöneticisi entegrasyonu (1Password, Bitwarden CLI, sistem keychain)
- **Bağlantı denetim logu:** Her bağlantı, transfer ve işlem tarih-saat ile kaydedilir
- **Tehdit uyarıları:** Sunucu parmak izi değişirse uyarı; beklenmedik dosya silme tespiti
- **TLS sertifika doğrulama:** Self-signed sertifika pinning desteği

---

### 4.10 Plugin Sistemi

- Rust veya JavaScript (Deno runtime) ile plugin yazılabilir
- Plugin API: dosya olayları, transfer kancaları, UI paneli ekleme
- Örnek pluginler:
  - **WordPress deployer:** wp-content/ yapısını otomatik tanı
  - **Image optimizer:** Upload öncesi WebP'ye dönüştür
  - **Slack notifier:** Transfer tamamlandığında bildir
  - **Sentry uploader:** Source map'leri otomatik yükle

---

## 5. Arayüz Tasarım Prensipleri

### 5.1 Düzen

```
┌─────────────────────────────────────────────────────────────┐
│  [☁ Bağlantı Yöneticisi]  [⚡ Hızlı Bağlan]  [AI ✨]  [⚙]  │
├──────────────┬──────────────────────┬───────────────────────┤
│  YER İŞARET- │   YEREL DOSYALAR     │   UZAK DOSYALAR       │
│  LERİ / GIT  │                      │                       │
│              │  📁 src/             │  📁 /var/www/html/    │
│  ▼ GitHub    │  📁 public/          │  📁 assets/           │
│    main ●    │  📄 index.html       │  📄 index.php         │
│    staging   │  📄 package.json     │  📄 config.php        │
│  ▼ Gitea     │                      │                       │
│    ...       │  [Filtrele] [Yenile] │ [Filtrele] [Yenile]   │
├──────────────┴──────────────────────┴───────────────────────┤
│  TRANSFER KUYRUĞU                              [Duraklat ⏸] │
│  ████████░░░░░░  index.html  →  /var/www/  14KB/s  %67      │
│  ░░░░░░░░░░░░░░  style.css  (bekliyor)                      │
├─────────────────────────────────────────────────────────────┤
│  ✅ 3 dosya yüklendi  |  ⚠ 1 uyarı  |  🔒 TLS 1.3         │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Tema Sistemi

- Sistem temasını otomatik takip et (Dark/Light)
- 5 dahili tema: Dark, Light, Solarized, Dracula, Nord
- Tam özelleştirme: CSS değişkenleri
- Yüksek kontrast erişilebilirlik modu

### 5.3 Erişilebilirlik

- WCAG 2.1 AA uyumu
- Tam klavye navigasyonu
- Ekran okuyucu desteği (ARIA)
- Büyütme desteği (sistem font boyutu respects edilir)

---

## 6. Geliştirme Yol Haritası

### Faz 1 — MVP (0-3 ay)
- [ ] Tauri v2 proje iskeleti
- [ ] FTP/FTPS/SFTP bağlantı katmanı (Rust)
- [ ] İki panel dosya yöneticisi (React)
- [ ] Transfer kuyruğu (temel)
- [ ] Site yöneticisi (yerel, şifreli)
- [ ] Dosya işlemleri: kopyala, taşı, sil, yeniden adlandır, chmod
- [ ] Dahili metin editörü (Monaco)
- [ ] Tema sistemi

### Faz 2 — v1.0 (3-6 ay)
- [ ] Git entegrasyonu (git2, branch/tag deployment)
- [ ] AI asistanı (temel: akıllı yeniden adlandırma, arama)
- [ ] WebDAV + S3 desteği
- [ ] Rhai otomasyon script motoru
- [ ] Bulut bookmark senkronizasyonu
- [ ] Plugin API (temel)

### Faz 3 — v1.5 (6-12 ay)
- [ ] Ekip işbirliği (session sharing)
- [ ] Gelişmiş AI (deployment önerileri, anomali tespiti)
- [ ] Plugin marketplace
- [ ] Mobil companion app (iOS/Android — sadece izleme/onay)
- [ ] CLI modu (`ftpie deploy --branch main --target production`)

---

## 7. Açık Kaynak Stratejisi

### Lisans
**Apache 2.0** — ticari kullanıma izin verir, patent koruması sağlar. Hem bireysel geliştiriciler hem kurumsal kullanıcılar için çekici.

### Gelir Modeli (Sürdürülebilirlik)
ftpie sonsuza kadar açık kaynak ve ücretsiz kalacak. Ancak projeyi sürdürebilmek için:

| Tier | Fiyat | İçerik |
|------|-------|--------|
| **Community** | Ücretsiz | Tüm temel özellikler |
| **Pro** | $5/ay | AI asistanı (kendi API key'in), bulut senkronizasyon, öncelikli destek |
| **Team** | $12/kullanıcı/ay | Session sharing, merkezi bookmark yönetimi, audit log |
| **Self-Hosted** | Ücretsiz | Tüm Pro/Team özellikleri, kendi altyapında |

> Self-hosted seçeneği tamamen açık kaynak kalır. Bulut servisler opsiyonel.

---

## 8. Topluluk ve Farklılaşma

### Neden Mevcut İstemcilerden Farklı?

| | FileZilla | Cyberduck | WinSCP | **ftpie** |
|--|-----------|-----------|--------|-----------|
| Git entegrasyonu | ❌ | ❌ | ❌ | ✅ |
| AI asistanı | ❌ | ❌ | ❌ | ✅ |
| Otomasyon scripting | ❌ | ❌ | ✅ (sınırlı) | ✅ |
| Ekip işbirliği | ❌ | ❌ | ❌ | ✅ |
| Modern UI | ⚠️ | ✅ | ⚠️ | ✅ |
| S3/WebDAV | ❌ | ✅ | ❌ | ✅ |
| Açık kaynak | ✅ | ✅ (core) | ✅ | ✅ |
| Çapraz platform | ✅ | ✅ | ❌ (Win) | ✅ |
| Plugin sistemi | ❌ | ✅ (sınırlı) | ❌ | ✅ |
| CLI modu | ❌ | ❌ | ❌ | ✅ |

---

## 9. Teknik Riskler ve Azaltma Stratejileri

| Risk | Olasılık | Çözüm |
|------|----------|-------|
| FTP sunucu uyumsuzlukları | Yüksek | suppaftp'nin geniş test coverage'ı; fallback modlar |
| Tauri webview farklılıkları (Win/Mac/Linux) | Orta | CI'da üç platformda e2e test; Tauri'nin platform uyumluluk katmanı |
| Git repo büyük boyutlarda yavaşlama | Orta | `git2`'nin shallow clone + sparse checkout desteği |
| AI API maliyet/gizlilik endişesi | Orta | Ollama (yerel) varsayılan seçenek; API key her zaman kullanıcıda |
| Session sharing güvenliği | Yüksek | E2E şifreleme; izin tabanlı model; kullanıcı onay gerektiren her eylem |

---

## 10. Sonuç

ftpie, "sadece bir FTP istemcisi" olmaktan çıkıp **modern web geliştirme iş akışının merkezine** oturabilecek bir araca dönüşme potansiyeline sahip. Git entegrasyonu tek başına birçok developer'ın günlük FTP kullanımını köklü biçimde değiştirirken, AI asistanı ve otomasyon katmanı manual işlerin büyük çoğunluğunu ortadan kaldırır.

Projenin başarısı için en kritik iki faktör:
1. **MVP kalitesi** — İlk versiyonun FTP/SFTP temelleri kusursuz çalışmalı
2. **Git deployment** — Bu özellik rakiplerden net ayrışmayı sağlayacak killer feature

---

*Bu belge yaşayan bir dokümandır. Geliştirme süreci ilerledikçe güncellenecektir.*
