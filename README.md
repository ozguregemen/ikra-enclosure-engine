# Ikra Enclosure Engine

PCB'nin STEP montajından, seçilen üretim yöntemine ve malzemeye uygun muhafaza (enclosure) tasarımı üreten motor.
Tamamen tarayıcıda çalışır: STEP dosyası hiçbir sunucuya gönderilmez, sunucu maliyeti yoktur.
GitHub Pages gibi statik bir barındırmada link ile paylaşılabilir.

## Şu anki durum: M1

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

## Kural dosyaları

`web/rules/<süreç>/<malzeme>.json` dosyaları süreç × malzeme kural setlerini tutar
(`min_wall`, `recommended_wall_min/max`, `pcb_clearance_xy`, `lid_fit_clearance`, `corner_radius_min`,
`draft_angle_min`, `shrink_factor` …). Değerler genel endüstri pratiğine dayanan başlangıç değerleridir;
kurum standardına göre düzenlenmesi beklenir. Yeni malzeme eklemek için dosyayı oluşturup `web/rules/index.json`'a ekle.

## Yol haritası (V1)

| Aşama | İçerik |
|---|---|
| M0 | STEP yükle, 3B göster, PCB ve bileşen analizi |
| **M1** | Kural dosyaları (süreç × malzeme), parametrik alt gövde + kapak, STEP/STL indir |
| M2 | Montaj deliklerini tanıma, standoff/boss ve vida noktaları |
| M3 | Port açıklıkları (kenar bileşenlerinden), DFM uyarı paneli |
| M4 | IP65/66/67 conta kanalı, temel PDF teknik resim |

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
  js/design.js        Muhafaza ölçüleri ve DFM kontrolleri (saf fonksiyonlar)
  js/design-ui.js     Süreç/malzeme/parametre paneli, üretim ve indirme
  js/cad-worker.js    Katı model üretimi ve STEP/STL çıktısı (Web Worker, replicad)
  js/viewer.js        3B önizleme (three.js)
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

Hepsi jsDelivr CDN'den sabit sürümle yüklenir. CAD modelleme çekirdeği (~6 MB) yalnızca muhafaza oluşturulurken indirilir.
