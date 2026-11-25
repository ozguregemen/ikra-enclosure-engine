# Ikra Enclosure Engine

PCB'nin STEP montajından, seçilen üretim yöntemine ve malzemeye uygun muhafaza (enclosure) tasarımı üreten motor.
Tamamen tarayıcıda çalışır: STEP dosyası hiçbir sunucuya gönderilmez, sunucu maliyeti yoktur.
GitHub Pages gibi statik bir barındırmada link ile paylaşılabilir.

## Şu anki durum: V1 tamam (M0–M4)

**Analiz (M0)**
- STEP (.step / .stp) yükleme: dosya seçme ya da sürükle-bırak
- OpenCascade (WebAssembly) ile okuma, three.js ile 3B önizleme
- PCB tespiti (ince ve geniş plaka + isim ipucu), kart ölçüsü ve kalınlığı
- Üst yüzeyden en yüksek bileşen, alt yüzeyden taşan bileşen/pin
- Bileşen zarfı (taşan konnektörler dahil), kenara yakın/taşan bileşenler
- Tek parçaya düzleştirilmiş montajlarda (ör. SolidWorks "parça olarak kaydet") bileşenleri gövde adlarından gruplama
- Analiz raporunu JSON olarak indirme

**Muhafaza (M1)**
- Üretim yöntemi (3D baskı, CNC, enjeksiyon) ve malzeme seçimi
- Kural dosyalarından gelen et kalınlığı, boşluk, köşe radyüsü; kullanıcı değiştirebilir
- Alt gövde + kapak (kenar başına konumlandırma dili; yüksek bileşen varsa kısaltılır/kaldırılır)
- DFM kontrolleri: et kalınlığı aralığı, nozzle katı (FDM), takım yarıçapı ve cep derinliği (CNC),
  draft ve çöküntü riski (enjeksiyon), metal muhafazada RF uyarısı, duvardan geçen konnektörler
- STEP (gövde + kapak, PCB ile aynı koordinatlarda) ve STL indirme

**Bağlantı (M2)**
- PCB gövdesindeki montaj deliklerini tespit (pin delikleri ayıklanır), delik çapından vida boyutu (M2–M4)
- Gövdede standoff: FDM'de ısıyla gömülen insert, CNC'de kılavuz veya insert, enjeksiyonda sac vidası ön deliği
- Kapakta PCB'ye inen vida boruları: aynı vida kapağı ve kartı birlikte sıkıştırır (deliğin üstü doluysa yalnızca PCB vidası)
- Standart vida boyu seçimi; PCB altı yükseklik insert derinliği ve vida boyuna göre otomatik ayarlanır
- Bağlantı elemanları listesi (vida, insert/kılavuz), uyarılarda tek tıkla uygulanan öneriler

**Port açıklıkları ve DFM paneli (M3)**
- Duvardan geçen gövdeler üçgen ağın duvar düzlemindeki kesitiyle bulunur: yalnızca duvara taşan kısım
  (ör. modül içindeki RJ45) açıklığı belirler, kart altındaki pinler hesaba katılmaz
- Duvara dayalı konnektörler (USB, jack, terminal…) aday olarak listelenir; diğer kenar bileşenleri kapalı gelir
- Açıklık tipi: pencere veya üstten açık çentik (kapak kapatır). Üstte ince duvar kalırsa otomatik çentik;
  enjeksiyonda yan maça gerektirmemesi için varsayılan çentik. CNC'de köşe radyüsü takım yarıçapına göre
- Kontroller: konnektör ön yüzünün duvar içinde kalma payı, köşeye yakınlık, komşu açıklıklar arası duvar,
  FDM köprü uzunluğu, kapalı bırakılmış ama duvardan geçen bileşen
- DFM paneli: kategorilere ayrılmış kontroller (genel, süreç, port, kapak, bağlantı), seviye sayaçları,
  üzerine gelince ilgili bileşenin 3B'de vurgulanması

**IP sızdırmazlık ve teknik resim (M4)**
- IP65 / IP66 / IP67: duvar üstünde kordon conta kanalı (derinlik = çap × (1 − sıkıştırma), genişlik doluluk
  sınırına göre); et kalınlığı kanal + iki yan et payına göre otomatik (FDM'de nozul katına yuvarlanır)
- IP'de port açıklıkları pencere olur ve üstünde kanal için duvar payı bırakılır (gerekirse üst boşluk artırılır)
- Kontroller: kapak sıkıştırma aralığı, vida başı sızdırmazlık pulu, açık portlar için IP konnektör/rakor,
  FDM'de katmanlar arası sızma; malzeme listesine kordon boyu ve pullar eklenir
- Teknik resim: gizli çizgi kaldırmalı izdüşümlerden A4 yatay iki pafta (gövde, kapak); ön/sağ/üst ve port olan
  diğer görünüşler, genel ölçüler, delik ve açıklık tabloları, süreç tolerans notları, bağlantı elemanları, antet;
  tarayıcıda önizleme ve Türkçe fontlu PDF (jsPDF + svg2pdf.js + DejaVu Sans)

**Arayüz**
- Yön küpü (ViewCube): yüz, kenar veya köşeye tıklayarak 26 yönden bakış; tutup sürükleyince model eşzamanlı döner,
  eksen üçlüsü gösterir; ana görünüm ve sığdır düğmeleri, yumuşak kamera geçişleri
- Sekmeli akış: Analiz → Tasarım (katlanır, özetli kartlar) → Çıktılar; ana eylem ve DFM durumu altta hep görünür
- Kısayollar: `H` ana görünüm, `F` sığdır, `1…6` ön/arka/sol/sağ/üst/alt, `G` kılavuzlar (yardım: üst çubuktaki `?`)

## Kural dosyaları

`web/rules/<süreç>/<malzeme>.json` dosyaları süreç × malzeme kural setlerini tutar
(`min_wall`, `recommended_wall_min/max`, `pcb_clearance_xy`, `lid_fit_clearance`, `corner_radius_min`,
`draft_angle_min`, `shrink_factor` …). Değerler genel endüstri pratiğine dayanan başlangıç değerleridir;
kurum standardına göre düzenlenmesi beklenir. Yeni malzeme eklemek için dosyayı oluşturup `web/rules/index.json`'a ekle.
Vida ölçüleri (geçiş deliği, kılavuz matkabı, insert deliği/boyu, baş ölçüleri, standart boylar) `web/rules/fasteners.json`,
IP seviyelerinin kordon çapı, sıkıştırma, et payı ve kapak sıkıştırma aralığı `web/rules/sealing.json` içindedir.

## Yol haritası (V1)

| Aşama | İçerik |
|---|---|
| M0 | STEP yükle, 3B göster, PCB ve bileşen analizi |
| M1 | Kural dosyaları (süreç × malzeme), parametrik alt gövde + kapak, STEP/STL indir |
| M2 | Montaj deliklerini tanıma, standoff/boss ve vida noktaları |
| M3 | Port açıklıkları (kenar bileşenlerinden), DFM uyarı paneli |
| **M4** | IP65/66/67 conta kanalı, temel PDF teknik resim |

## Yerelde çalıştırma

Node.js veya Python gerekmez. PowerShell'de proje klasöründen:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/serve.ps1
```

Sonra tarayıcıda `http://localhost:8080/` adresini aç. (Sayfa `file://` ile doğrudan açılırsa Web Worker çalışmaz.)

## GitHub Pages'e yayınlama

1. Bu klasörü bir GitHub reposuna gönder (`main` dalı).
2. Repo ayarları → **Pages** → **Source: GitHub Actions** seç.
3. `main`'e her gönderimde `.github/workflows/pages.yml` iş akışı `web/` klasörünü yayınlar.

Not: Ücretsiz planda Pages yalnızca public repolarda çalışır. Repo private kalmalıysa GitHub Pro/Team gerekir
ya da aynı `web/` klasörü Cloudflare Pages / Netlify gibi başka bir statik barındırmaya konabilir.

## Klasör yapısı

```
web/                  Yayınlanan statik site
  index.html
  css/style.css
  js/main.js          Arayüz akışı
  js/step-worker.js   STEP okuma (Web Worker, occt-import-js)
  js/step-names.js    Düzleştirilmiş montajlarda gövde adlarını kurtarma
  js/analysis.js      PCB / bileşen analizi (saf fonksiyonlar)
  js/holes.js         Montaj deliği tespiti (B-rep yüzlerine çember uydurma)
  js/ports.js         Port açıklığı tespiti (ağların duvar düzlemindeki kesiti)
  js/design.js        Muhafaza ölçüleri ve DFM kontrolleri (saf fonksiyonlar)
  js/design-ui.js     Süreç/malzeme/parametre paneli, üretim ve indirme
  js/cad-worker.js    Katı model üretimi, STEP/STL çıktısı, teknik resim izdüşümleri (Web Worker, replicad)
  js/drawing.js       Teknik resim paftaları (SVG) ve PDF çıktısı
  js/viewer.js        3B önizleme (three.js)
  js/viewcube.js      Yön küpü
  rules/              Süreç × malzeme kural dosyaları
  samples/            Örnek STEP dosyası
tools/
  serve.ps1           Yerel statik sunucu
  make-sample-step.ps1  Örnek kart STEP üreteci
```

## Kullanılan açık kaynak bileşenler

- [OpenCascade Technology](https://dev.opencascade.org) (LGPL 2.1 + istisna), WebAssembly olarak:
  okuma için [occt-import-js](https://github.com/kovacsv/occt-import-js), modelleme için [replicad](https://replicad.xyz) (MIT) + replicad-opencascadejs
- [three.js](https://threejs.org) (MIT)

- [jsPDF](https://github.com/parallax/jsPDF) (MIT), [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) (MIT), [DejaVu fontları](https://dejavu-fonts.github.io) (serbest lisans)

Hepsi jsDelivr CDN'den sabit sürümle yüklenir. CAD modelleme çekirdeği (~6 MB) yalnızca muhafaza oluşturulurken,
PDF kütüphanesi ve font (~2 MB) yalnızca PDF indirilirken indirilir.
