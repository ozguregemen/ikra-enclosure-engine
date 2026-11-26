# Ikra Enclosure Engine

PCB'nin STEP montajından, seçilen üretim yöntemine ve malzemeye uygun muhafaza (enclosure) tasarımı üreten motor.
Tamamen tarayıcıda çalışır: STEP dosyası hiçbir sunucuya gönderilmez, sunucu maliyeti yoktur.
GitHub Pages gibi statik bir barındırmada link ile paylaşılabilir.

## Tasarım akışı: tasarla → incele → düzelt → sun

Muhafaza doğrudan çizilip gösterilmez. Her tasarım kaynaklı bir DFM kural setinden geçer, bir inceleme
kod bloğu tarafından değerlendirilir, güvenli düzeltmeler küçük bir döngüde otomatik uygulanır ve ancak bundan sonra
katı model olarak sunulur. Algoritmanın ayrıntısı [docs/TASARIM-ALGORITMASI.md](docs/TASARIM-ALGORITMASI.md),
kuralların dayandığı kaynaklar [docs/KAYNAKLAR.md](docs/KAYNAKLAR.md) belgesindedir.

Sol aşama çubuğu akışı yedi adımda gösterir; her aşamanın simgesi durumunu verir (✓ tamam, ! uyarı, × hata, numara: henüz çalışmadı):

| Aşama | Ne olur |
|---|---|
| 1 Kart | STEP analiz edilir: PCB, bileşen yükseklikleri, montaj delikleri, kenardaki konnektörler |
| 2 Gereksinimler | Üretim yöntemi ve malzeme (FDM'de varsayılan PETG), isteğe bağlı en yüksek çalışma sıcaklığı, kapak malzemesi, IP seviyesi, kutunun sabitlenmesi |
| 3 Tasarım (otomatik) | Ölçüler kural setinden üretilir: kartın tutulması, kapak bağlantısı, port açıklıkları, panel elemanları; ayrıntılarda parametreler ve toleranslar |
| 4 İnceleme döngüsü | Kaynaklı kural kataloğuyla inceleme; yalnızca değeri artıran güvenli sayısal düzeltmeler uygulanıp yeniden incelenir; turlar, düzeltmeler, reddedilen denemeler ve durma nedeni zaman çizelgesinde |
| 5 Katı model | OpenCascade ile gövde, kapak ve (varsa) DIN klipsi; kenar işlemleri ve kalıp çıkma açısı dahil; düzenlemeden yarım saniye sonra kendiliğinden yeniden oluşturulur |
| 6 Son inceleme | Katı modelde gerçekten uygulanan radyüs, pah, çıkma açısı ve Boole işlemleri incelemeyle karşılaştırılır; "Kenar işlemleri" tablosu |
| 7 Final tasarım ve çıktılar | Özet ölçüler, STEP / STL / montaj STEP'i, PDF teknik resim (DFM inceleme raporu paftasıyla), BOM, analiz ve inceleme raporu (JSON) |

**Tasarım incelemesi paneli** (sağda; 1200 px altında çekmece):
- Karar bandı: **Hazır** (hata ve uyarı yok), **Uyarılarla hazır**, **Engelli** (en az bir hata); katı modelden önce "ön inceleme",
  sonra "son inceleme" (birleşik karar)
- Döngü günlüğü: tur sayısı, otomatik düzeltme sayısı ve durma nedeni (yakınsadı, kullanıcı kararı gerekiyor, tur sınırı, salınım, ilerleme yok)
- Otomatik düzeltmeler (eski → yeni değer, kural, gerekçe); **Geri al** parametreyi önceki değerinde kilitler.
  "Denendi, uygulanmadı" listesi döngünün geri aldığı denemeleri ve doğuracakları yeni bulguları gösterir
- Bulgu kartları düzeye ve kategoriye göre: kural kimliği, ölçülen değer–sınır (ör. `1,6 mm < 1,95 mm`), açıklama,
  **Neden?** altında kuralın gerekçesi ve kaynak bağlantıları; **Uygula** (önerilen düzeltme), **Göster** (3B'de vurgula),
  **Muaf tut** (en az 3 karakterlik gerekçe zorunlu; proje dosyasına, JSON rapora ve teknik resme yazılır), **Muafiyeti kaldır**;
  geçen kontroller "N kontrol geçti" altında toplanır; düzey ve kategori süzgeci

**Otomatik ve Kilitli parametreler:** otomatik alanları döngü belirler; alana yazılan değer kilitlenir ve döngü dokunmaz
(kilit düğmesiyle yeniden otomatiğe döner). Süreç ya da malzeme değişince kilitli değerler korunur. Alanlar satır içinde
doğrulanır; geçersiz ya da aralık dışı değer uygulanmaz.

**Güncellik ve çıktı kapısı:** durum makinesi `idle → designing → reviewing → building → built | build-error | invalid`.
Muaf tutulmamış hata varsa katı model kendiliğinden oluşturulmaz (bilerek "Hatalara rağmen oluştur" seçilebilir);
model tasarımla güncel değilse indirme düğmeleri gerekçesiyle kapalıdır, eski dosya sessizce sunulmaz. Engelli tasarımda
indirmeden önce açık hatalar listelenip onay istenir. Alttaki durum çubuğu akışı özetler:
`Tasarım ✓ · İnceleme: 2 tur, 1 otomatik düzeltme · Katı model ✓ 1,4 s · Son inceleme ✓`.

**Kullanım kolaylıkları:** 50 adımlı geri al / yinele (`Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`; yazı alanında değil),
"Geri al" düğmeli bildirimler, kaydedilmemiş tasarımda dosya değiştirmeden önce onay, açık / koyu / sistem teması,
WCAG 2.2 AA renk ve odak belirteçleri, zorlanmış renk modu, klavyeyle tam kullanım (aşama çubuğu ve seçim gruplarında ok tuşları).

## Şu anki durum: V1.14 (M0–M4 + Toolbox + malzeme kütüphanesi + proje dosyası + montaj + kapak malzemesi + kart kenarı tutucu + DIN ray klipsi)

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

**Pullar, malzeme ve sıkma torku (V1.4)**
- Pullar (Toolbox › ISO › Pullar): ISO 7089 normal, ISO 7092 küçük, ISO 7093-1 geniş seri; DIN 6798 A tırtıllı ve
  DIN 127 B yaylı (geri çekilmiş standartlar, uyarıyla). Pul kalınlığı vida boyu hesabına girer; havşa başta pul yok;
  PA66 yalıtım pulu seçeneği
- Vida malzemesi/kaplaması tipe göre: A2-70, A4-80, 4.8 / 8.8 / 10.9 galvaniz, 12.9 siyah oksit, pirinç, PA66;
  tanım, malzeme listesi ve 3B renk buna göre
- Sıkma torku önerisi (VDI 2230 yaklaşımı): vida dayanımı, kapakta/PCB'de baş-pul yüzey basıncı ve gövdede diş /
  insert / Helicoil sıyırma sınırlarının en küçüğü; sınırlayan etken ve ön yük gösterilir, geniş pul önerisi tek tıkla
- Kontroller: alüminyumda paslanmaz/pirinç vida (galvanik), metal gövdede şase bağlantısı, anten/GNSS yakınında
  manyetik vida, PA66 vidanın sınırları, yalnızca PCB vidasının baş/pulunun bileşene çarpması
- Kural dosyalarına `tensile_strength_mpa` ve `bearing_pressure_mpa`; malzeme verisi `rules/toolbox/fastener-materials.json`

**Somunlar ve hazır aralayıcılar (V1.5)**
- Somunlar (Toolbox › ISO › Somunlar): ISO 4032, ISO 4035 ince, ISO 10511 naylon kilitli, DIN 562 kare (fasten.it tabloları)
- Gövde tarafında "somun cebi": altıgen somun tabandan cebe (cep derinliği seçilen vida boyuna göre, uç somundan 1,5·P taşar,
  tabandan çıkmaz), kare somun standoff yanındaki yuvaya (kavite tarafına açık); boss köşeden köşeye ölçüye göre büyür;
  tork sınırı somunun gövdeye baskısı
- Hazır altıgen aralayıcı (Toolbox › DIN · üretici › Aralayıcılar): dişi-dişi (alttan vida, havşa başta tabana havşa) ve
  erkek-dişi (tabandan geçen erkek diş + ISO 4032 somun); M2.5 ve M3, pirinç Ni / çelik galvaniz / PA66; gövdede boss yok,
  aralayıcı boyu = PCB altı yükseklik (standart seri, uymazsa bir sonraki standart boy önerilir)
- 3B'de altıgen/kare/naylon kilitli somun, aralayıcı, alt vida ve alt somun; malzeme listesi ve teknik resim notları

**Köşe kapak vidaları ve gömme baş (V1.6)**
- Kapak bağlantısı: PCB vidalarıyla ortak (sandviç) / **köşe vidaları** / vidasız. Köşe modunda kapak 4 köşedeki,
  duvarlara yaslı boss'lara bağlanır (insert / Helicoil / kılavuz / sac vidası gövde tarafı seçimine göre); PCB vidaları
  yalnızca kartı tutar. Boss'lar PCB köşesine çarpmasın diye kavite bir eksende uzatılır: otomatik seçimde konnektör
  olmayan kenarlar tercih edilir, X/Y elle seçilebilir; kapak dilleri boss'lardan önce biter
- Köşe vidası için ayrı Toolbox seçimi (Vida grubu: PCB / köşe kapak); boy, kapak kalınlığına ve burç boyuna göre
- Gömme baş (oyuk): silindir/bombe başlar için kapakta Ø ≈ dk + 1 (M3 imbus 6,5; M4 8) oyuk; kapak inceyse altına
  boss'a oturan yastık eklenir, sandviç vidasında boru çapı büyür. Havşa başlı köşe vidasında da gerekirse yastık
- Tornavida/anahtar erişimi: yalnızca PCB vidasının başının üstünde bileşen varsa uyarı
- IP'de kapak sıkıştırma aralığı yetmezse köşe vidaları önerisi; teknik resimde C# köşe delikleri

**Panel elemanları (V1.7)** — Toolbox › Panel elemanları ve Tasarım › Panel elemanları kartı
- SMA / RP-SMA dişi panel konnektörü (arkadan somunlu, u.FL pigtail): Ø6,5 D-delik (6,1 düzlük üstte, dönmeyi önler),
  5/16" somun; otomatik yerleşimde karttaki RF bileşenine en yakın duvar seçilir, pigtail boyu (50/100/150… mm) önerilir
- Kablo rakoru M12/M16/M20/M25 ×1,5 (kablo sıkma aralığı Lapp SKINTOP ST-M), kontra somun için anahtar payı;
  basınç dengeleme elemanı M12×1,5 (IP67/68 dış ortam kutusunda önerilir, membran yönü uyarısı)
- Işık borusu Ø3/Ø5: kartta adında "LED" geçen her bileşenin üstüne kapakta delik, boru boyu hesaplanır;
  kart kenarındaki LED'de (boru duvar üstüne biniyorsa) delik açılmaz, uyarılır
- Lastik ayak (taban köşeleri): tabandan çıkan vida başı/somundan yüksek olmalı; yoksa ayak önerisi
- Özel delik: veri sayfasından delik Ø, düzlük, somun SW, en kalın panel, iç boy (N, BNC, TNC, M8/M12 sensör, buton…)
- Yerleşim: yüz ve konum boş bırakılırsa çakışmayan en uygun yere konur (bileşenler, PCB, kapak dili, standoff,
  köşe boss'u, port açıklıkları, diğer panel elemanları, conta kanalı, taban/köşe mesafesi); duvara sığmayan rakor
  kapağa alınır ve duvar için gereken üst boşluk önerilir. Elle konumda çakışma varsa "otomatik konuma al" önerisi
- Et kalınlığı parçanın en kalın panel sınırını aşarsa yerel lamba (FDM/enjeksiyon: içten, CNC: dıştan) açılır
- Katı modelde D/yuvarlak delikler ve lambalar; 3B'de SMA, rakor, basınç elemanı, ışık borusu, ayak modelleri;
  malzeme listesi ve teknik resimde "PANEL DELİKLERİ" tablosu (E#) ile kapakta E#/L# satırları
- Değerler tipik başlangıç değerleridir (SMA kesimi Würth/Amphenol yaygın değerleri; rakor anahtar ağzı ve en kalın
  panel yaklaşık): seçilen parçanın veri sayfasıyla doğrulanmalıdır

**Çıktılar ve şirket listesi (V1.8)**
- M5 ve M6: 11 metrik vida tipi, pullar, somunlar (fasten.it DIN EN ISO tabloları; havşa başlarda teorik dk ISO 2009
  tablosundan), ruthex RX-M5x9,5 / RX-M5Sx5,8 / RX-M6x12,7 insert, Helicoil M5/M6 (Böllhoff kataloğu),
  geçiş deliği ISO 273 orta (5,5 / 6,6). Boy serileri yaygın katalog boylarıdır
- Montaj STEP'i: gövde + kapak + vidalar, pullar, insert/Helicoil, somun, aralayıcı ve panel elemanları
  (basitleştirilmiş katı, her biri adlı ayrı gövde); istek üzerine ayrı üretilir, normal STEP'i yavaşlatmaz
- Teknik resimde 3. pafta "Montaj": patlatılmış izometrik görünüş, poz balonları ve parça listesi
- BOM (CSV): Excel için `;` ayraçlı, ondalık virgüllü, UTF-8; poz numaraları montaj paftasıyla aynı
  (1 gövde, 2 kapak, sonra elemanlar); stok kodu ve "tercihli" sütunları
- Tercihli parça listesi: şirket stok listesi CSV olarak yüklenir (Standart; Boyut; Boy; Malzeme; Stok kodu; Açıklama,
  boş alan "hepsi"); Toolbox'ta tercihli tip/boyut/boy ★ ile işaretlenir, Çıktılar'da listede olmayan kalemler gösterilir;
  "Şablon indir" bu tasarımın parçalarıyla doldurulmuş boş şablon verir. Liste yalnızca tarayıcıda (localStorage) saklanır
- Toolbox'ta arama: kod (7045), ad (imbus, rakor, cıvata) ya da boyut (M5); Türkçe karakter duyarsız, Enter ilk sonucu açar

**Malzeme kütüphanesi ve geçmeler (V1.9)**
- FDM (8): PLA, PETG, ABS, ASA, PC, naylon (PA11/PA12), PA-CF, PETG-CF — yoğunluk, HDT, çekme (katmanlar arası),
  su emme üretici veri sayfalarından (Bambu Lab, Prusament, Polymaker); insert havya sıcaklığı (CNC Kitchen: baskı +10–20 °C)
- CNC (15): POM-C, POM-H (Delrin), PA6, PA66, PET (Ertalyte), PEEK, PEI (Ultem), PTFE, UHMW-PE, PP, PC, PMMA, PVC, ABS,
  6061 alüminyum — Ensinger / Mitsubishi Chemical AM / Röchling / Perspex veri sayfaları (iki kaynak farklıysa muhafazakâr olan);
  ısıl genleşme, suda doygunluk, sürekli kullanım sıcaklığı, %2 basma gerilmesinden vida başı altı izin verilen basınç
- Her malzemenin tolerans bloğu: genel ±, 100 mm başına ek ± (çekme, ısıl genleşme, nem), FDM delik telafisi,
  sıkı / normal / bol çapsal geçme boşlukları, kapak dili ek payı (FDM: Bambu/CCI-UAL, Sovol, Hubs rehberleri;
  CNC: Protolabs ISO 2768-m, Boedeker %0,1–0,2 kuralı, Xometry PTFE/UHMW ±0,25, Ensinger nem etkisi)
- Tasarım › "Toleranslar ve geçmeler": kapak geçmesi (sıkı/normal/bol), vida geçiş deliği ISO 273 ince/orta/kaba,
  sonuç ölçüleri; değerler kendi yazıcı/atölye ölçümüyle düzeltilebilir (tarayıcıda malzemeye özel saklanır)
- Geçmenin uygulandığı yerler: kapak dili boşluğu (iki yüzey sapması + boy payı), geçiş/kılavuz/ön delikler (FDM telafisi),
  somun cebi, gömme baş oyuğu, ışık borusu (sıkı), panel kesimleri; vidasız kapakta sıkı geçme önerisi; teknik resim notları
- Değerler başlangıç değeridir: FDM'de yazıcı, nozul ve dilimleyici ayarına göre değişir; ilk parçada ölçüp düzeltin

**Proje dosyası (V1.10)**
- Üst çubukta **Kaydet** (Ctrl+S) / **Aç** (Ctrl+O); proje `.ikra.json` olarak indirilir, sürükle-bırak ile de açılır
- Kaydedilenler: süreç ve malzeme, parametreler, vida/burç/köşe vidası seçimleri, delik ve port seçimleri, IP seviyesi,
  panel elemanları, geçme sınıfları ve o malzeme için tolerans düzeltmeleri
- Kartın STEP'i isteğe bağlı olarak projeye gömülür (tek dosyada taşınır); gömülmezse proje açılınca aynı STEP istenir.
  Kart kimliği SHA-256 ile kontrol edilir, farklı STEP yüklenirse uyarılır. Açılan proje hatasızsa muhafaza hemen oluşturulur

**Kutunun sabitlenmesi (V1.11)** — Gereksinimler › Kutunun sabitlenmesi
- Montaj kulağı: taban hizasında (kutu yüzeye düz oturur), 2 ya da 4 kulak, M3–M6, yuvarlak ya da uzun (hizalama) delik;
  delik ISO 273 serisi + FDM telafisi, delik merkezi duvardan vida başı/pul + tornavida payı kadar uzakta, kalınlık
  ≥ max(3 mm; 1,5·et; 0,8·d). Otomatik duvar seçimi kulak üstünde port/panel elemanı çakışması olmayan çifti seçer
- Tabandan içten vida: kart takılmadan önce içeriden sıkılır; delikler standoff ve köşe boss'larından uzak konur,
  vida başı PCB altına sığmazsa PCB altı yükseklik kendiliğinden artar; IP'de sızdırmazlık pulu uyarısı
- Kontroller: kulak üstündeki fiş/panel elemanı, ayakla birlikte kullanım, tabandan çıkan vida başı, CNC stok boyu
- Teknik resimde M# delik satırları, delik aralığı notu ve kulaklı taban izi ölçüsü; malzeme listesinde montaj satırı

**DIN ray klipsi (V1.14)** — Gereksinimler › Kutunun sabitlenmesi › DIN ray (TS35)
- EN 60715 TS35×7,5 ray için ayrı parça klips (45 mm ray boyunca): +v tarafında boydan boya sabit kanca, −v tarafında
  plaka düzleminde esneyen iki kilit dili ve rampalı dudak (flanşın 1 mm altına biner, kancalar flanş kenarından 0,2 mm
  boşluklu). Takma: sabit kancayı flanşa geçirip kutuyu bastır; sökme: tornavidayı plaka ucundan dil yarığına sokup çevir
- Ray yönü otomatik (kısa kenar raya paralel, kutu klipsten kısaysa uzun kenar) ya da X / Y
- Kutuya içeriden 2 × M3 (aralık 30 mm, standoff ve boss'lardan uzak konur): FDM'de klipste ısıyla gömülen insert,
  CNC'de kılavuz, kalıpta diş açan vida; delikler ray kanalına inen boss'larda. Vida boyu taban + diş boyuna göre
  standart seriden; vida başı PCB altına sığmazsa PCB altı yükseklik artar
- Kilit dili genişliği malzemenin yaklaşık izin verilen geçme uzamasına göre (ε ≈ 1,5·t·δ/L², 1,6–2,5 mm); aşılırsa
  uyarı, alüminyumda ticari yaylı klips önerisi; düşük HDT'li malzemede pano sıcaklığı uyarısı. İzin değerleri başlangıç
  değeridir (test baskısıyla doğrulayın)
- Klips STL'si ayrı indirilir (üst yüzü tablaya, kancalar yukarı, desteksiz), STEP'te ve montaj STEP'inde ayrı gövde;
  3B görünümde ve montaj paftasında patlatılmış olarak altta; kütle ve BOM'da (klips, vidalar, insertler) yer alır
- Kontroller: IP'de sızdırmazlık pulu, ayakla birlikte kullanım, tabandan çıkan vida başı, rayda kapladığı yer (18 mm modül)

**Kapak malzemesi ve örnek kartlar (V1.12)**
- Üretim kartında "Kapak malzemesi: Gövdeyle aynı / Farklı malzeme": kapak ayrı süreç ve malzemeden seçilebilir
  (ör. CNC alüminyum gövde + akrilik kapak, FDM gövde + CNC PMMA kapak). Kapak kalınlığı en az kapak malzemesinin et
  kalınlığı; kapak dili, kapak boruları, kapaktaki geçiş delikleri, havşa/oyuk, ışık borusu ve kapak panel delikleri
  kapak malzemesinin toleransıyla; kapak dili boşluğu iki malzemenin ortalaması + ısıl genleşme farkı payı (ΔT 40 K);
  vida başı altı basınç sınırı kapak malzemesinden; kütle iki yoğunlukla; teknik resimde kapak paftası, BOM ve proje
  dosyası kapak malzemesiyle. Metal gövde + plastik kapakta RF notu kapağı işaret eder
- Örnek kartlar: Arduino UNO R3, Raspberry Pi 4 B, ESP32-DevKitC, STM32 Nucleo-64 (basitleştirilmiş, kutu biçimli
  bileşenler; kart ölçüsü, montaj delikleri ve konnektör konumları üretici mekanik çizimlerinden: Arduino A000066 CAD ve
  veri sayfası, Raspberry Pi 4 mekanik çizimi, Espressif DevKitC V4 boyut çizimi ve WROOM-32E veri sayfası, ST UM1724).
  Modeller tools/make-sample-step.ps1 ile üretilir, üretici CAD dosyası dağıtılmaz. Resmi çizimde olmayan bileşen
  yükseklikleri ve PCB kalınlıkları yaklaşıktır (üreteçte işaretli). Standoff bir bileşene çarparsa hata, o noktaya
  sığacak en büyük boss çapını ve "Bu deliği kullanma" düzeltmesini gösterir

**Kart kenarı tutucu (V1.13)** — Tasarım › Kartın tutulması › Kart kenarı tutucu (Otomatik / Açık / Kapalı)
- Montaj deliği olmayan kartlarda kendiliğinden: tabana ve duvara bağlı alt destekler kartı kenar bandından (2 mm, gerekirse
  1,5 / 1,2 mm) taşır, kapaktan inen baskı dilleri kapak kapanınca üstten sıkıştırır; yerler kenar bandında altında / üstünde
  bileşen, standoff, boss, kapak borusu, ışık borusu ve kapak panel elemanı olmayan noktalardan köşelere yayılarak seçilir
- En az 3 destek bulunamazsa hata; baskı yeri yoksa köpük bant önerisi; yanal konum kavite duvarlarıyla
- Kartın dışına taşan PCB anteni (ad içinde anten/antenna/ant) duvardan açıklık açmak yerine kutunun içine alınır;
  diğer taşan parçalar port listesinde "İçeri al" ile, geri almak için "Duvardan çıkar"

**Arayüz**
- Yön küpü (ViewCube): yüz, kenar veya köşeye tıklayarak 26 yönden bakış; tutup sürükleyince model eşzamanlı döner,
  eksen üçlüsü gösterir; ana görünüm ve sığdır düğmeleri, yumuşak kamera geçişleri
- Aşama çubuğu (Kart → Gereksinimler → Tasarım → İnceleme döngüsü → Katı model → Son inceleme → Çıktılar), katlanır ve
  durum noktalı kartlar, sağda tasarım incelemesi, altta işlem durum çubuğu; 768 px altında dikey yığın
- Gerçekçi bağlantı elemanları (yalnızca görsel): vidalarda helisel ISO dişi (metrikte pahlı, sac vidasında sivri uç),
  başa oyulmuş yıldız/yarık/imbus/torx izi, imbus başta tırtıl; pirinç insertte ters yönlü tırtıl bantları ve iç diş,
  Helicoil'de helisel tel; metal yüzeyler ortam yansımalı (PBR)
- Kısayollar (tek tuşlar yalnızca 3B görünüm odaktayken): `H` ana görünüm, `F` sığdır, `1…6` ön/arka/sol/sağ/üst/alt,
  `G` kılavuzlar, `T` Toolbox; her yerde `Ctrl+S` projeyi kaydet, `Ctrl+O` aç, `Ctrl+Z` / `Ctrl+Y` geri al / yinele (yardım: üst çubuktaki `?`)

## Kural dosyaları

`web/rules/<süreç>/<malzeme>.json` dosyaları süreç × malzeme kural setlerini tutar
(`min_wall`, `recommended_wall_min/max`, `pcb_clearance_xy`, `corner_radius_min`, `draft_angle_min`, `shrink_factor`,
`tolerance` { `general`, `per_100mm`, `hole_comp`, `lid_extra`, `fits` { `press`, `normal`, `loose` } } …).
Malzeme özellikleri (yoğunluk, HDT, ısıl genleşme, su emme, dayanım) veri sayfalarındandır, kaynak her dosyanın notlarında;
diğer değerler genel endüstri pratiğine dayanan başlangıç değerleridir;
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
| V1.3 | Dişli burçlar: ısıyla gömülen insert, Helicoil; CNC'ye PEEK ve PTFE |
| V1.4 | Pullar, vida malzemesi/kaplaması, sıkma torku önerisi |
| V1.5 | Somun cebi (altıgen/kare), hazır altıgen aralayıcılar |
| V1.6 | Köşe kapak vidaları, ayrı vida grupları, gömme baş, tornavida erişimi |
| V1.7 | Panel elemanları: SMA/RP-SMA (D-delik), kablo rakoru, basınç dengeleme, ışık borusu, lastik ayak, özel delik |
| V1.8 | M5–M6, montaj STEP'i, montaj paftası (balon + parça listesi), BOM CSV, tercihli parça listesi, Toolbox araması |
| V1.9 | Malzeme kütüphanesi (8 FDM filamenti, 15 CNC malzemesi), malzemeye özel tolerans ve sıkı/normal/bol geçme, ISO 273 delik serileri |
| V1.10 | Proje kaydet / aç (.ikra.json): tüm tasarım ayarları, STEP isteğe bağlı gömülü, kart kimliği (SHA-256) kontrolü |
| V1.11 | Montaj: taban hizasında montaj kulakları (2/4, yuvarlak ya da uzun delik, M3–M6) ya da tabandan içten vidalı delikler |
| V1.12 | Kapak için ayrı süreç/malzeme (ısıl genleşme farkı dahil), örnek kartlar: Arduino UNO R3, Raspberry Pi 4 B, ESP32-DevKitC, STM32 Nucleo-64 |
| V1.13 | Kart kenarı tutucu (alt destek + kapak baskısı), taşan anten/parçaları kutunun içine alma |
| **V1.14** | DIN ray klipsi (EN 60715 TS35): ayrı parça, esnek kilit dili, kutuya içeriden 2 × M3 |

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
  js/design-ui.js     Gereksinim ve tasarım panelleri, inceleme paneli, durum makinesi, katı model, çıktı kapısı, geri al
  js/dfm/             Kural kataloğu (catalog.js), inceleme (review.js), tasarım döngüsü (loop.js)
  js/treat.js         Kenar işlemi ve kalıp çıkma açısı politikası (saf fonksiyon)
  js/cad-worker.js    Katı model üretimi, STEP/STL çıktısı, teknik resim izdüşümleri (Web Worker, replicad)
  js/drawing.js       Teknik resim paftaları (SVG) ve PDF çıktısı
  js/viewer.js        3B önizleme (three.js)
  js/viewcube.js      Yön küpü
  js/toolbox.js       Toolbox penceresi ve ölçülü vida önizlemesi
  js/screw-shapes.js  Vida başı ve tahrik izi geometrisi (3B ve çizim ortak)
  js/fastener-meshes.js  Dişli vida, insert, Helicoil ve panel elemanı 3B modelleri (three.js)
  js/panel.js         Panel elemanları: yerleşim, çakışma/kenar kontrolleri, D-delik ve lamba (saf fonksiyonlar)
  js/assembly.js      Montaj: bağlantı/panel elemanlarının basit katı tanımları (montaj STEP ve paftası)
  js/bom.js           BOM CSV ve tercihli parça (stok kodu) listesi
  js/fits.js          Tolerans ve geçme modeli (malzeme + sıkı/normal/bol, ISO 273, FDM delik telafisi)
  js/mount.js         Montaj: taban hizasında kulaklar, tabandan içten vidalı delikler, DIN ray klipsi (saf fonksiyonlar)
  js/edgehold.js      Kart kenarı tutucu: alt destek ve kapak baskısı yerleşimi (saf fonksiyonlar)
  rules/              Süreç × malzeme kural dosyaları
  rules/toolbox/      Toolbox kütüphaneleri (ISO vidalar/pullar/somunlar, dişli burçlar/aralayıcılar, panel elemanları)
  samples/            Örnek STEP dosyaları (ornek-kart, arduino-uno-r3, raspberry-pi-4b, esp32-devkitc, nucleo-64)
tools/
  serve.ps1           Yerel statik sunucu
  selftest.ps1        Uygulamayı görünmez Edge'de çalıştırıp tasarım / inceleme / katı model sonucunu JSON verir
  testpage.ps1        Kural kataloğu ve döngü testleri (web/test/catalog.html)
  make-sample-step.ps1  Örnek kart STEP üreteci (-Board all / kart adı)
```

## Kullanılan açık kaynak bileşenler

- [OpenCascade Technology](https://dev.opencascade.org) (LGPL 2.1 + istisna), WebAssembly olarak:
  okuma için [occt-import-js](https://github.com/kovacsv/occt-import-js), modelleme için [replicad](https://replicad.xyz) (MIT) + replicad-opencascadejs
- [three.js](https://threejs.org) (MIT)

- [jsPDF](https://github.com/parallax/jsPDF) (MIT), [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) (MIT), [DejaVu fontları](https://dejavu-fonts.github.io) (serbest lisans)

Hepsi jsDelivr CDN'den sabit sürümle yüklenir. CAD modelleme çekirdeği (~6 MB) yalnızca muhafaza oluşturulurken,
PDF kütüphanesi ve font (~2 MB) yalnızca PDF indirilirken indirilir.
