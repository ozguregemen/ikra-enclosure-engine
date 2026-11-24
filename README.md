# Ikra Enclosure Engine

PCB'nin STEP montajından, seçilen üretim yöntemine ve malzemeye uygun muhafaza (enclosure) tasarımı üreten motor.
Tamamen tarayıcıda çalışır: STEP dosyası hiçbir sunucuya gönderilmez, sunucu maliyeti yoktur.
GitHub Pages gibi statik bir barındırmada link ile paylaşılabilir.

## Şu anki durum: M0

- STEP (.step / .stp) yükleme: dosya seçme ya da sürükle-bırak
- OpenCascade (WebAssembly) ile okuma, three.js ile 3B önizleme
- PCB tespiti (ince ve geniş plaka + isim ipucu), kart ölçüsü ve kalınlığı
- Üst yüzeyden en yüksek bileşen, alt yüzeyden taşan bileşen/pin
- Bileşen zarfı (taşan konnektörler dahil)
- Kart kenarına yakın veya taşan bileşenler (konnektör adayları)
- Analiz raporunu JSON olarak indirme

## Yol haritası (V1)

| Aşama | İçerik |
|---|---|
| **M0** | STEP yükle, 3B göster, PCB ve bileşen analizi |
| M1 | Kural dosyaları (süreç × malzeme), parametrik alt gövde + kapak, STEP/STL indir |
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
  js/analysis.js      PCB / bileşen analizi (saf fonksiyonlar)
  js/viewer.js        3B önizleme (three.js)
  samples/            Örnek STEP dosyası
tools/
  serve.ps1           Yerel statik sunucu
  make-sample-step.ps1  Örnek kart STEP üreteci
```

## Kullanılan açık kaynak bileşenler

- [OpenCascade Technology](https://dev.opencascade.org) (LGPL 2.1 + istisna), [occt-import-js](https://github.com/kovacsv/occt-import-js) üzerinden WebAssembly olarak
- [three.js](https://threejs.org) (MIT)

Her ikisi de jsDelivr CDN'den sabit sürümle yüklenir.
