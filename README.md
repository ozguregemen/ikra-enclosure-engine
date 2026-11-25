# Ikra Enclosure Engine

PCB'nin STEP montajından, seçilen üretim yöntemine ve malzemeye uygun muhafaza (enclosure) tasarımı üreten motor.
Tamamen tarayıcıda çalışır: STEP dosyası hiçbir sunucuya gönderilmez, sunucu maliyeti yoktur.
GitHub Pages gibi statik bir barındırmada link ile paylaşılabilir.

## Şu anki durum: V1.3 (M0–M4 + Toolbox)

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

**Toolbox · vidalar (V1.1–V1.2)**
- SolidWorks Toolbox benzeri standart bağlantı elemanı kütüphanesi: ISO › Cıvata ve vidalar, 13 tip:

  | Grup | Tipler |
  |---|---|
  | Yıldız (Phillips) | ISO 7045 bombe baş, ISO 7046-1 havşa baş |
  | Düz (tornavida) | ISO 1207 silindir baş, ISO 1580 bombe baş, ISO 2009 havşa baş |
  | İmbus | ISO 4762 silindir baş, ISO 7380-1 mercimek baş, ISO 10642 havşa baş |
  | Torx | ISO 14580 silindir baş, ISO 14583 bombe baş, ISO 14581 havşa baş |
  | Sac vidası (ST) | ISO 7049 bombe baş, ISO 7050 havşa baş |

- Vida tipi, boyut (M2–M4, sac vidasında ST2.2–ST4.2) ve boy seçimi; ölçülü önizleme çizimi (dk, k, L, diş,
  tahrik izi) ve "ISO 7049 - ST2.9 × 13 - C - H" gibi tanım
- Sac vidası seçilince gövdede insert/kılavuz yerine ön delik açılır (diş vidayla açılır, ≥ 2·d tutunma, boss ≥ 2,5 × ön delik);
  enjeksiyonda metrik vida seçiliyse sac vidası, metal gövdede sac vidası seçiliyse metrik vida önerilir
- Her boy için bu karttaki durum canlı hesaplanır: uygun / kısa / standoff uyarlanır. Uzun vida seçilirse
  PCB altı yükseklik kendiliğinden artar; PCB deliğinden geçmeyen boyutlar kapalıdır
- Havşa başlıda kapağa 90° havşa açılır (baş kapakla aynı hizada); 3B önizlemede başlar tipine göre çizilir
- Malzeme listesi, teknik resim delik tablosu ve DFM uyarıları seçilen vidaya göre güncellenir
- Kısayol `T`; Bağlantı kartında seçili vida görünür

**Dişli burçlar (V1.3)** — Toolbox › DIN · üretici › Dişli burçlar
- Isıyla gömülen pirinç insert (ruthex RX serisi, M2–M4; standart ve kısa boy): delik çapı, dış çap ve en az et veri
  sayfasından; boss çapı d1 + 2·et'e göre büyür
- Helicoil tel dişli burç (HELICOIL Plus Free Running, DIN 8140, M2–M4; 1d…3d): STI matkap çapı, yuva dişi, girişte 90° havşa
  (katı modelde de açılır); kör delik derinliği burç boyu + kılavuz payı; vida burcun tamamını kavrar
- Gövde tarafı: Otomatik (kural dosyası) / ısıyla gömülen insert / Helicoil / doğrudan kılavuz; Bağlantı kartında ayrı satır
- Kural dosyalarında `fastening: "helicoil"` ve `helicoil_length_d` (Al 1,5·d, POM/PEEK/ABS 2·d, PTFE 2,5·d);
  CNC'ye PEEK ve Teflon (PTFE) malzemeleri eklendi (varsayılan Helicoil)
- Uyumluluk uyarıları ve tek tık önerileri: metale ısıyla insert olmaz, PTFE'de insert/doğrudan diş tutmaz,
  baskıda doğrudan diş aşınır, enjeksiyonda Helicoil sonradan işleme ister; sac vidası seçiliyse burç kullanılmaz
- 3B önizlemede pirinç insert ve Helicoil standoff içinde; malzeme listesi ve teknik resim notları burca göre

**Arayüz**
- Yön küpü (ViewCube): yüz, kenar veya köşeye tıklayarak 26 yönden bakış; tutup sürükleyince model eşzamanlı döner,
  eksen üçlüsü gösterir; ana görünüm ve sığdır düğmeleri, yumuşak kamera geçişleri
- Sekmeli akış: Analiz → Tasarım (katlanır, özetli kartlar) → Çıktılar; ana eylem ve DFM durumu altta hep görünür
- Kısayollar: `H` ana görünüm, `F` sığdır, `1…6` ön/arka/sol/sağ/üst/alt, `G` kılavuzlar, `T` Toolbox (yardım: üst çubuktaki `?`)

## Kural dosyaları

`web/rules/<süreç>/<malzeme>.json` dosyaları süreç × malzeme kural setlerini tutar
(`min_wall`, `recommended_wall_min/max`, `pcb_clearance_xy`, `lid_fit_clearance`, `corner_radius_min`,
`draft_angle_min`, `shrink_factor` …). Değerler genel endüstri pratiğine dayanan başlangıç değerleridir;
kurum standardına göre düzenlenmesi beklenir. Yeni malzeme eklemek için dosyayı oluşturup `web/rules/index.json`'a ekle.
Vida ölçüleri (geçiş deliği, kılavuz matkabı, insert deliği/boyu, baş ölçüleri, standart boylar) `web/rules/fasteners.json`,
IP seviyelerinin kordon çapı, sıkıştırma, et payı ve kapak sıkıştırma aralığı `web/rules/sealing.json` içindedir.
Toolbox kütüphanesi `web/rules/toolbox/iso-screws.json` (gruplar › tipler): vida tipi başına baş ölçüleri (dk, k), diş adımı, tahrik ölçüsü
ve standart boy serisi. Yeni vida tipi eklemek için bu dosyaya bir `types` kaydı eklemek yeterli.
Dişli burçlar `web/rules/toolbox/inserts.json`: insert varyantları (boy, dış çap, delik, en az et) ve Helicoil boyutları
(matkap, yuva dişi, 1d…3d boyları).

## Yol haritası (V1)

| Aşama | İçerik |
|---|---|
| M0 | STEP yükle, 3B göster, PCB ve bileşen analizi |
| M1 | Kural dosyaları (süreç × malzeme), parametrik alt gövde + kapak, STEP/STL indir |
| M2 | Montaj deliklerini tanıma, standoff/boss ve vida noktaları |
| M3 | Port açıklıkları (kenar bileşenlerinden), DFM uyarı paneli |
| M4 | IP65/66/67 conta kanalı, temel PDF teknik resim |
| V1.1 | Toolbox: ISO vidalar (tip, boyut, boy), havşa |
| V1.2 | Toolbox 13 tipe: yıldız, düz, imbus, torx, sac vidası (ST) |
| **V1.3** | Dişli burçlar: ısıyla gömülen insert, Helicoil; CNC'ye PEEK ve PTFE |

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
  js/toolbox.js       Toolbox penceresi ve ölçülü vida önizlemesi
  js/screw-shapes.js  Vida başı ve tahrik izi geometrisi (3B ve çizim ortak)
  rules/              Süreç × malzeme kural dosyaları
  rules/toolbox/      Standart bağlantı elemanı kütüphanesi (ISO vidalar, dişli burçlar)
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
