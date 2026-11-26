# Kaynaklar

[TASARIM-ALGORITMASI.md](TASARIM-ALGORITMASI.md) ve kural kataloğunda (`web/js/dfm/catalog.js`, 128 kural) atıf yapılan kaynaklar. Her girdi: anahtar, yayıncı, başlık, bağlantı, Ikra'da ne için kullanıldığı ve doğrulama durumu. Katalogdaki kaynak adlarının bu anahtarlarla eşlemesi sondaki "Katalog anahtarları" tablosundadır; uygulamada her bulgunun "Neden?" bölümü ve DFM rapor paftasının kaynak listesi aynı başlık ve bağlantıları gösterir.

**Doğrulama durumu.** Kurallar kaynaklardan çıkarıldıktan sonra ayrı bir doğrulama adımında kaynağın kendisiyle karşılaştırıldı.

| Durum | Anlamı |
|---|---|
| Doğrulandı | Kaynaktan alınan en az bir kural kaynağın metniyle birebir karşılaştırıldı ve onaylandı. |
| Düzeltildi | Doğrulamada değer ya da atıf düzeltildi; belgede düzeltilmiş hâli kullanılır. |
| Kontrol edilmedi | Kaynaktan alınan kurallar ayrıca doğrulanmadı. Bu kaynağa dayanan sayılar belgede ○ ile işaretlidir. Böyle bir kaynak hata seviyesindeki bir kuralda yalnızca bağlam verir: hata seviyesi doğrulanmış bir eşikten, modelden ölçülen geometrik çakışmadan (ör. GEN-STANDOFF-BELOW, FAS-COLLIDE, PORT-CROSS-CLOSED), eksik veriden ya da kullanıcının açık gereksiniminden (REQ-TEMP) gelir; düşük güvenli hiçbir kural hata seviyesinde tanımlı değildir. |
| Açılamadı / okunmadı | Doğrulayıcı kaynağa erişemedi ya da kaynağı okumadı. |

Bir kaynağın bazı maddeleri doğrulanıp bazıları doğrulanmamışsa ayrıntı "Durum" alanında belirtilmiştir. Bu sürümde eklenen [F23], [C25], [M26]–[M30] ve [N1]–[N8] için araştırma notlarında doğrulama kaydı yoktur; hepsi "kontrol edilmedi" durumundadır.

## FDM (3B baskı)

- **[F1]** UltiMaker — *How to design for FFF 3D printing* (kılavuz v2.00, 2019). <https://ultimaker.com/wp-content/uploads/2024/06/How-to-design-for-FFF-1.pdf>
  Kullanım: nozul çapı et alt sınırı; tabla kenarında radyüs yerine pah; taban köşelerini yuvarlatma; 45° sarkma; baskı yönü. Durum: doğrulandı (baskı yönü maddesi kontrol edilmedi).
- **[F2]** Prusa Research — *Modeling with 3D printing in mind*. <https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135>
  Kullanım: çevre genişliği katları; tablaya bakan kenarda pah; sarkma açısı; desteksiz baskı ve parçalama; giriş pahı. Durum: doğrulandı (giriş pahı ve hareketli geçme maddeleri kontrol edilmedi).
- **[F3]** Prusa Research — *Elephant foot compensation*. <https://help.prusa3d.com/article/elephant-foot-compensation_114487>
  Kullanım: 0,4 mm nozulda ~0,2 mm fil ayağı; tabla pahının alt sınırı. Durum: doğrulandı.
- **[F4]** Prusa Research — *Warping*. <https://help.prusa3d.com/en/article/warping_2011>
  Kullanım: ABS, ASA, PC çarpılma önlemleri (sonraki çarpılma kuralı için). Durum: kontrol edilmedi.
- **[F5]** Formlabs — *Minimum Wall Thickness for 3D Printing*. <https://formlabs.com/blog/minimum-wall-thickness-3d-printing/>
  Kullanım: FDM'de 1,0 mm alt sınır; 0,4 mm katları (1,2 mm). Durum: doğrulandı (yazı derinliği maddesi kontrol edilmedi).
- **[F6]** Formlabs — *How to Design and 3D Print Snap-Fit Joints for Enclosures, Boxes, Lids, and More*. <https://formlabs.com/blog/designing-3d-printed-snap-fit-enclosures>
  Kullanım: kart yalnız duvarla konumlanıyorsa 1,5–2,0 mm boşluk; Z yönünde zayıflık. Durum: kontrol edilmedi.
- **[F7]** Stratasys Direct — *FDM Design Guide* (DG_SDM_FDM_0725). <https://www.stratasys.com/siteassets/sdm/content---website-storage/design-guides/dg_sdm_fdm_0725a.pdf>
  Kullanım: ≈ 4 × katman et tablosu; insert çevresinde 2,03 mm et; radyüsün gerilme yığılmasını azaltması. Durum: doğrulandı; r_o = r_i + t bağıntısının bu kaynağa atfı düzeltildi (bağıntı enjeksiyon kaynaklarındandır, bkz. [K7], [K9]).
- **[F8]** Hubs (Protolabs Network) — *How to design parts for FDM 3D printing*. <https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/>
  Kullanım: tablaya değen kenarda 45° pah ya da radyüs; köşe ≈ nozul çapı; 45° sarkma; 5 mm köprü. Durum: doğrulandı; yatay delik maddesi düzeltildi (damla biçimli tavan bu kaynakta yok); ince pim maddesi kontrol edilmedi.
- **[F9]** Hubs — *Selecting the optimal shell and infill parameters for FDM 3D printing*. <https://www.hubs.com/knowledge-base/selecting-optimal-shell-and-infill-parameters-fdm-3d-printing/>
  Kullanım: kabuk 2 × nozul (0,8 mm). Durum: doğrulandı (bağlantı bölgesinde %50 dolgu maddesi kontrol edilmedi).
- **[F10]** Hubs — *Enclosure design for 3D printing: a step-by-step guide*. <https://www.hubs.com/knowledge-base/enclosure-design-3d-printing-step-step-guide/>
  Kullanım: ≥ 2 mm muhafaza duvarı; boşluk deliği d + 0,25, diş açılacak delik d − 0,25. Durum: doğrulandı (iç boşluk 0,5 mm, port 1 mm/yan, nervür oranı, tırnak genişliği maddeleri kontrol edilmedi).
- **[F11]** Hubs — *How to assemble 3D printed parts with threaded fasteners*. <https://www.hubs.com/knowledge-base/how-assemble-3d-printed-parts-threaded-fasteners/>
  Kullanım: M5 altında basılı diş yok; somun yuvası; diş açan vida çevresinde et. Durum: kontrol edilmedi.
- **[F12]** Hubs — *How to design interlocking joints for 3D printed parts*. <https://www.hubs.com/knowledge-base/how-design-interlocking-joints-fastening-3d-printed-parts>
  Kullanım: kapak geçmesi toplam 0,5 mm. Durum: kontrol edilmedi.
- **[F13]** Hubs — *What is the dimensional accuracy of 3D printed parts?* <https://www.hubs.com/knowledge-base/dimensional-accuracy-3d-printed-parts/>
  Kullanım: masaüstü ve endüstriyel FDM tolerans bantları (sonraki tolerans zinciri için). Durum: kontrol edilmedi.
- **[F14]** Xometry — *Fused Deposition Modeling (FDM) Mini-Guide*. <https://www.xometry.com/blog/fdm-mini-guide>
  Kullanım: taşıyıcı duvar 1,2–1,5 mm. Durum: doğrulandı (nervür alt sınırı kontrol edilmedi).
- **[F15]** University of Zurich, Additive Manufacturing Facility — *Design Guideline FDM*. <https://www.amf.uzh.ch/dam/jcr:fd1ee024-1a98-488b-89ec-ffd85befa786/Design-Guideline-FDM.pdf>
  Kullanım: en küçük delik 2,0 mm, özellik 2,0 mm, pim 3,0 mm; 1,0 mm duvar. Durum: doğrulandı.
- **[F16]** He, Zhu, Zhang, Yang — *Investigation on Bridging Defects in 3D-Printed Polylactic Acid Beams Using Fused Filament Fabrication*, Polymers 2026, 18(2):261. <https://pmc.ncbi.nlm.nih.gov/articles/PMC12845589>
  Kullanım: ~10 mm pratik köprü sınırı; ISO/ASTM 52910'da açık sınır olmaması. Durum: doğrulandı (PMC sayfası CAPTCHA korumalı olduğundan tam metin Europe PMC üzerinden okundu).
- **[F17]** CNC Kitchen — *Tips & Tricks for Heat-Set Inserts used in 3D printing*. <https://www.cnckitchen.com/blog/tipps-amp-tricks-fr-gewindeeinstze-im-3d-druck-3awey>
  Kullanım: düz (konik olmayan) delik; kenar pahının gereksizliği; kör delik insert boyu + ~1 mm; takma sıcaklığı. Durum: doğrulandı; delik kalibrasyon adımı düzeltildi (0,1 mm adım yalnız reçine bölümünde).
- **[F18]** CNC Kitchen (3DJake satış sayfası) — *Threaded Inserts Set - Standard*, ölçü tablosu. <https://3djake.com/cnc-kitchen/threaded-inserts-set-standard>
  Kullanım: M2–M6 insert boyu, dış çapı, delik çapı ve en az et. Durum: doğrulandı (sayfada birim yok; mm varsayıldı).
- **[F19]** ruthex (3DJake satış sayfası) — *Threaded Insert M3 (M3x5.7)*. <https://3djake.com/ruthex/threaded-insert-m3-100-pieces>
  Kullanım: M3 insert ölçüleri. Durum: doğrulandı (yalnız M3 karşılaştırıldı).
- **[F20]** SPIROL — *How to select a threaded insert for your 3D printed assembly*. <https://www.spirol.com/resources/white-papers/how-to-select-a-threaded-insert-for-your-3d-printed-assembly/>
  Kullanım: boss ≥ 1,5 × (en iyi 2 ×) tırtıl çapı. Durum: doğrulandı.
- **[F21]** Fictiv — *Solving Common Problems with 3D Printed Inserts*. <https://www.fictiv.com/articles/solving-common-problems-with-3d-printed-inserts>
  Kullanım: insertin serbest kenardan en az yarım insert çapı uzakta olması. Durum: doğrulandı.
- **[F22]** Hubs — *How to design snap-fit joints for 3D printing*. <https://hubs.com/knowledge-base/how-design-snap-fit-joints-3d-printing>
  Kullanım: DIN kilit dili kök radyüsü ≥ 0,5 t. Durum: kontrol edilmedi.
- **[F23]** Fictiv — *How to Design Snap Fit Components*. <https://www.fictiv.com/articles/how-to-design-snap-fit-components>
  Kullanım: FDM'de izin verilen geçme gerinimleri ve Z yönünde basılan dilde azaltma (MNT-DIN-SNAP). Durum: kontrol edilmedi.

## CNC talaşlı imalat

- **[C1]** Hubs (Protolabs Network) — *How to design parts for CNC machining*. <https://www.hubs.com/knowledge-base/how-design-parts-cnc-machining/>
  Kullanım: iç köşe ≥ derinlik/3; taban radyüsü 0 / 0,5 / 1 mm; cep 3–4 × D; et (metal 0,8/0,5, plastik 1,5/1,0 mm); delik derinliği; 2,5 mm takım; diş ≥ M2. Durum: doğrulandı.
- **[C2]** Hubs — *Reducing CNC machining costs: 13 design tips*. <https://www.hubs.com/knowledge-base/reducing-cnc-machining-costs-13-design-tips/>
  Kullanım: 12 mm cepte R5 örneği; serbest çıkıntıda 4:1. Durum: doğrulandı (ham malzeme maddesi kontrol edilmedi).
- **[C3]** Hubs — *Sharp corners in CNC machining*. <https://www.hubs.com/knowledge-base/sharp-corners-in-cnc-machining/>
  Kullanım: cep derinliği 2–3 × takım çapı. Durum: doğrulandı (dog-bone maddesi kontrol edilmedi).
- **[C4]** Xometry — *CNC Machining Design Guide* (PDF). <https://xometry.pro/wp-content/uploads/2023/07/TR-EN-CNC-Machining-Design-Guide.pdf>
  Kullanım: iç köşe 1,3 × takım yarıçapı; 1:4 ideal, 1:8 mümkün; cep ≤ 4 × genişlik; taban radyüsü; standart matkap; kör delik + %25; kenar mesafesi; kılavuz altında ≥ 0,5 d. Durum: doğrulandı.
- **[C5]** Xometry — *CNC Machining: Optimizing Internal Corner Radii*. <https://www.xometry.com/resources/machining/cnc-machining-optimizing-internal-corner-radii/>
  Kullanım: köşe radyüsünü takım yarıçapından biraz büyük seçme. Durum: doğrulandı.
- **[C6]** Xometry — *CNC Machining Thin Walls*. <https://www.xometry.com/resources/machining/cnc-machining-thin-walls/>
  Kullanım: duvar yükseklik/kalınlık ≤ 10:1. Durum: doğrulandı.
- **[C7]** Xometry — *The machining costs you should consider when designing with chamfers and fillets*. <https://www.xometry.com/blog/the-machining-costs-you-should-consider-when-designing-with-chamfers-and-fillets>
  Kullanım: dış kenarda 45° pahın varsayılan olması. Durum: kontrol edilmedi.
- **[C8]** Ensinger — *Design for manufacturing for plastic machined parts*. <https://www.ensingerplastics.com/en-us/injection-molding/blog/design-for-manufacturing-for-plastic-machined-parts>
  Kullanım: iç köşe 1,3 × takım yarıçapı; plastikte 1,5 mm et. Durum: doğrulandı.
- **[C9]** Protocase — *CNC Milling Constraints*. <https://www.protocase.com/products/cnc-machining/cnc-milling/constraints.php>
  Kullanım: derinliğe göre en az ve önerilen iç köşe radyüsü tablosu. Durum: doğrulandı (aynı firmanın blogunda en derin satır farklıdır).
- **[C10]** Protocase — *How corner radius affects CNC machining*. <https://www.protocase.com/blog/2020/03/6/how-corner-radius-affects-cnc-machining/>
  Kullanım: takım yarıçapının %200'ü en iyi, %120'si ideal değil. Durum: doğrulandı.
- **[C11]** Protolabs — *Design Guidelines: CNC Milling*. <https://www.protolabs.com/services/cnc-machining/cnc-milling/design-guidelines/>
  Kullanım: tek taraftan en çok 50,8 mm; 0,51 mm ince eleman, 1,02 mm nominal; M2–M12. Durum: doğrulandı.
- **[C12]** Protolabs — *Mastering complex features on machined parts*. <https://www.protolabs.com/resources/design-tips/mastering-complex-features-on-machined-parts/>
  Kullanım: Ø1 mm takım ve 9,52 mm cep derinliği (CNC-POCKET-DEPTH hata sınırı; CNC-CUTOUT-TOOL dar açıklıkta en küçük freze). Durum: doğrulandı.
- **[C13]** Protolabs — *6 mistakes to avoid when designing machined parts*. <https://www.protolabs.com/en-gb/resources/design-tips/6-mistakes-to-avoid-when-designing-machined-parts/>
  Kullanım: 0,51 mm ve altındaki duvarların kırılması. Durum: doğrulandı.
- **[C14]** Protolabs — *Threading: Standard holes*. <https://protolabs.com/services/cnc-machining/threaded-holes-guidelines/standard-holes>
  Kullanım: en çok diş derinlikleri; modellenecek ön delik çapları. Durum: doğrulandı.
- **[C15]** Protolabs — *Threading: Coil inserts*. <https://protolabs.com/services/cnc-machining/threaded-holes-guidelines/coil-inserts>
  Kullanım: Helicoil delik çapı ve derinliği. Durum: doğrulandı.
- **[C16]** Protolabs — *Fillets vs. chamfers: how to handle edges and corners in CNC machining design*. <https://www.protolabs.com/resources/blog/fillets-and-chamfers/>
  Kullanım: vida deliğinde 60° giriş pahı; metalde 0,25 × 45° kenar kırma. Durum: 60° maddesi doğrulandı, kenar kırma maddesi kontrol edilmedi.
- **[C17]** Protolabs — *The Definitive Guide to CNC Machining* (PDF). <https://www.protolabs.com/media/yswj4qnm/cnc-definitive-guide.pdf>
  Kullanım: eloksalda temas yüzeylerinin maskelenmesi. Durum: kontrol edilmedi.
- **[C18]** Fictiv — *Optimizing part design for CNC machining*. <https://www.fictiv.com/?p=20227>
  Kullanım: 5 × D standart, 10 × D uzun takım. Durum: doğrulandı.
- **[C19]** Fictiv — *DFM Feedback Glossary*. <https://www.fictiv.com/articles/dfm-action-steps>
  Kullanım: 10 × D üstü cep (CNC-POCKET-DEPTH hata sınırı); 0,25 mm metal alt sınırının muhafaza için kullanılmaması. Durum: doğrulandı.
- **[C20]** NASA — *JSC-67701 JSC Fabrication Tolerances and Practices* (Basic DCN001). <https://standards.nasa.gov/system/files/tmp/JSC-67701_JSC_Fabrication_Tolerances_and_Practices_Basic_DCN001_Final.pdf>
  Kullanım: kılavuz ek derinliği 5 P … 5 P + 1,52 mm; kılavuzdan önce 80–120° havşa; derin delik tanımı; belirtilmemiş kenar kırma 0,13–0,51 mm. Durum: ilk üç madde doğrulandı, kenar kırma ve iç köşe maddeleri kontrol edilmedi.
- **[C21]** Bossard — *Length of engaged thread* (teknik bilgi, 01-2025). <https://assets.eu.ctfassets.net/0vp0u5uh75zd/3wPlDC2XQOYT3XOdwCk6lz/9a9282ffd29746a7a7f6b0149509f1cf/052_Length_engaged_thread_Fastening_EN_01_2025.pdf>
  Kullanım: alüminyumda vida tutunma boyu. Durum: düzeltildi (10.9 sütunu bir satır kaymıştı; değerler M6–M16 denemelerine dayanır, küçük vidalara dış değer biçilmiştir).
- **[C22]** Mitsubishi Chemical Group — *Machinist's Toolkit* (EU metric, PDF). <https://www.mcam.com/mam/41701/MCG-Machinist-Toolkit-A4-EU-metric.pdf>
  Kullanım: plastikte delmede ısı birikimi ve deliğin daralması; insert gereksinimi. Durum: düzeltildi (insert her plastikte gerekmez; titreşim ve sık sökme durumunda önerilir).
- **[C23]** Boedeker Plastics — *Plastic Machining Guidelines*. <https://www.boedeker.com/Technical-Resources/Plastic-Machining-Guidelines>
  Kullanım: işlenmiş plastikte tolerans ve ısıl genleşme (sonraki tolerans kuralları için). Durum: kontrol edilmedi.
- **[C24]** ISO 13715:2017 *Technical product documentation — Edges of undefined shape* (önizleme kopyası, Zeiss Quality Forum). <https://qualityforum.zeiss.com/migration/images/1125_cad718ab03258942de4de01b28242c05.pdf>
  Kullanım: teknik resimde genel kenar notu (GEO-EDGE-BREAK). Durum: kontrol edilmedi.
- **[C25]** Boedeker Plastics — *Plastic Drilling Machining Guidelines*. <https://www.boedeker.com/Technical-Resources/Plastic-Machining-Guidelines/Plastic-Drilling-Machining-Guidelines>
  Kullanım: işlenmiş plastikte sac vidası yerine kılavuz ya da insert (FAS-SCREW-PROCESS). Durum: kontrol edilmedi.

## Enjeksiyon kalıplama

- **[K1]** Protolabs — *Injection Molding Wall Thickness Guidelines*. <https://www.protolabs.com/resources/design-tips/improving-part-design-with-uniform-wall-thickness/>
  Kullanım: malzemeye göre nominal et aralığı; ince etin komşunun %40–60'ı olması. Durum: doğrulandı; istisna listesi ve ±%10 düzgünlük hedefi düzeltildi (bu kaynakta yok).
- **[K2]** Protolabs — *Design Stronger Molded Parts with Ribs, Gussets, and Durable Materials*. <https://www.protolabs.com/resources/design-tips/design-stronger-molded-parts/>
  Kullanım: boyuta göre nominal et; 1,5–2,5 mm kararlı aralık; ≥ 3,8 mm çöküntü; nervür ≤ 0,6 t. Durum: doğrulandı.
- **[K3]** Protolabs — *Injection Molding Basics*. <https://www.protolabs.com/resources/design-tips/injection-molding-basics/>
  Kullanım: nervür kalınlığı 0,4–0,6 t. Durum: doğrulandı.
- **[K4]** Protolabs — *Plastic Boss Design on Molded Parts*. <https://www.protolabs.com/resources/design-tips/plastic-boss-design-on-molded-parts/>
  Kullanım: boss eti nominal etin %40–60'ı (INJ-BOSS-WALL). Durum: doğrulandı.
- **[K5]** Protolabs — *Draft Angle Guidelines for Injection Molding*. <https://protolabs.com/resources/design-tips/improving-part-moldability-with-draft/>
  Kullanım: en az 0,5°, 1–2° iyi, 25,4 mm başına ~1°; derinlik ve ete göre çıkma açısı tablosu (INJ-DRAFT, `treat.js injectionDraft`). Durum: doğrulandı.
- **[K6]** Protolabs — *Designing for Mouldability, Volume 1* (PDF). <https://www.protolabs.com/media/949709/dfm1-english.pdf>
  Kullanım: derin duvarda çıkma açısı (50–101 mm'de 3° ya da 3 mm et; `injectionDraft`'ta 50,8 mm üstü 3°), çekirdek–kavitede ≥ 2°; sürgülü kapamada 3°; yan maça (INJ-SIDE-ACTION, MNT-DIN-PROCESS). Durum: doğrulandı (kapama 3° maddesi dahil; yan maça, tolerans ve yolluk maddeleri kontrol edilmedi).
- **[K7]** Protolabs — *Cutting corners on injection molded parts*. <https://www.protolabs.com/resources/design-tips/cutting-corners-on-injection-molded-parts/>
  Kullanım: r_i ≥ 0,5 t, r_o = 1,5 t bağıntısının eşleşen kaynağı (INJ-CORNER-RADIUS). Durum: kontrol edilmedi (doğrulayıcının atıf düzeltmesinde önerdiği kaynak).
- **[K8]** DuPont — *General Design Principles for DuPont Engineering Polymers*, Module I (Stellenbosch Üniv. kopyası). <https://academic.sun.ac.za/mad/catalogs/dfmguidelines/dupontgeneraldesignprinciples.pdf>
  Kullanım: iç radyüs 0,5 t; yarı kristal malzemelerde düşük draft; boss dış çapı 2–3 × delik; sac vidası seçimi. Durum: doğrulandı.
- **[K9]** Ticona (Celanese) — *Designing With Plastic: The Fundamentals* (TDM-1). <https://res.cloudinary.com/engineering-com/image/upload/v1639229518/tips/Designing_With_Plastics_-_Ticona_Brochure_vghwzt.pdf>
  Kullanım: dış radyüs = iç radyüs + t; 0,5 mm / 0,13 mm radyüs alt sınırları; gerilme yığılma katsayıları; kapama yüzeyinde 5°; nervür yüksekliği; paralel draft. Durum: doğrulandı; nervür draftı ve kökü düzeltildi; paralel draft, UL 94 kalınlığı ve delik L/d maddeleri kontrol edilmedi.
- **[K10]** Avient — *Best Practices for Reducing Stress Cracking in Molded Plastic Parts* (ESCR Design Guide). <https://avient.com/sites/default/files/2022-08/Environmental%20Stress%20Cracking%20Resistance%20_ESCR_%20Design%20Guide%20%281%29.pdf>
  Kullanım: boss ayrıntısı (dış draft 1°, iç 0,5°, kök 0,25 t, 45° giriş pahı); gusset oranları; nervür aralığı ≥ 3 t. Durum: doğrulandı; nervür aralığı düzeltildi.
- **[K11]** Böllhoff — *Self-tapping fasteners* katalogu (EJOT PT, DELTA PT, AMTEC tasarım önerileri). <https://media.boellhoff.com/files/pdf13/8705-self-tapping-fasteners-en.pdf>
  Kullanım: malzemeye göre sac vidası ön deliği, boss çapı, dalma boyu. Durum: doğrulandı.
- **[K12]** P. R. Bonenberger — *The First Snap-Fit Handbook*, 2. baskı (Hanser), bölüm 4. <https://s3.amazonaws.com/gc-p/files/128686/The%20First%20Snap-Fit%20Handbook%202E_Bonenberger.pdf>
  Kullanım: çıkıntıların (kapak dili) draft ve kök radyüsü; çıkıntı tabanında %120 hacim kuralı. Durum: doğrulandı.
- **[K13]** Stratasys Direct — *Injection Molding Design Guidelines* (2017). <https://stratasys.com/siteassets/sdm/resources/design-guidelines/injection-molding/injection_molding_design_guidelines_2017.pdf>
  Kullanım: doku derinliğine göre ek draft (0,025 mm başına 1,5°). Durum: doğrulandı; nervür yüksekliği maddesi düzeltildi (sınır nervürün kendi kalınlığına göredir).
- **[K14]** Fathom — *Design Guide for Injection Molding*. <https://fathommfg.com/app/uploads/2025/12/Design-Guidelines-for-Injection-Molding.pdf>
  Kullanım: kalın bölgelerin oyulması; boss deliğinin taban seviyesine inmesi. Durum: doğrulandı.
- **[K15]** Xometry — *An Overview of Injection Molded Surface Finishes*. <https://www.xometry.com/resources/injection-molding/choosing-the-right-finish-for-your-injection-molded/>
  Kullanım: adlandırılmış dokular için en az draft (sonraki doku girdisi için). Durum: doğrulandı.
- **[K16]** Hubs — *How to design parts for injection molding*. <https://www.hubs.com/knowledge-base/how-design-parts-injection-molding/>
  Kullanım: kalınlık geçişinde 3:1. Durum: doğrulandı.
- **[K17]** Fictiv — *Enclosure Design for Injection Molding*. <https://www.fictiv.com/articles/enclosure-design-for-injection-molding>
  Kullanım: ayırma çizgisinin keskin kenarda ve açık kutuda ağızda olması; kozmetik kenarın ayırma çizgisinden uzakta radyüslenmesi (GEO-FILLET-OUTER). Durum: kontrol edilmedi.
- **[K18]** Fictiv — *Injection Molding Specifications*. <https://www.fictiv.com/specifications/injection-molding>
  Kullanım: malzemelere göre çekme payları (sonraki tolerans kuralları için). Durum: kontrol edilmedi.
- **[K19]** Bayer MaterialScience (Covestro) — *Snap-Fit Joints for Plastics: A Design Guide* (MIT ders kopyası). <https://fab.cba.mit.edu/classes/S62.12/people/vernelle.noel/Plastic_Snap_fit_design.pdf>
  Kullanım: DIN kilit dili kök radyüsü (R/h ≈ 0,6, ≥ 0,38 mm); konsol gerinim bağıntıları. Durum: kontrol edilmedi.
- **[K20]** Covestro — *Engineering Polymers Part and Mold Design: Thermoplastics, A Design Guide*. <https://solutions.covestro.com/-/media/covestro/solution-center/brands/downloads/imported/1557214249.pdf>
  Kullanım: kullanılmadı. Durum: açılamadı (HTTP 403); kural kaynağı yapılmadı.

## Elektronik muhafaza, IP ve güvenlik

- **[M1]** Parker Hannifin O-Ring Division — *Parker O-Ring Handbook ORD 5700* (Arizona Üniv. kopyası). <https://nfc.arizona.edu/sites/default/files/2022-02/parker_o-ring_handbook.pdf>
  Kullanım: sıkıştırma penceresi; en az 0,2 mm; kanal doluluğu; uzama; yüz contası kanal tablosu; kanal köşe radyüsü ≥ 3 W (IP-GROOVE-RADIUS); yüzey pürüzlülüğü. Durum: doğrulandı; %30 sıkıştırmanın mutlak sınır değil "en çok önerilen" olduğu düzeltildi.
- **[M2]** Element Materials Technology — *Electrotechnology Enclosure Testing: IEC 60529 and NEMA 250*. <https://www.element.com/resources/articles/electrotechnology-enclosure-testing-iec-60529-and-nema-250>
  Kullanım: IP prob ölçüleri; toz ve su test parametreleri. Durum: doğrulandı; IPX3 süresi IEC 60529 parametrelerine göre düzeltildi.
- **[M3]** Rogers Corporation — *The Mechanics of Enclosure Seal Design: Gap, Spacing, CFD and Compressibility*. <https://rogerscorp.com/blog/2025/the-mechanics-of-enclosure-seal-design-gap-spacing-cfd-and-compressibility>
  Kullanım: köpük contada %25–35 sıkıştırma; plastik gövdede düşük sıkıştırma kuvveti. Durum: doğrulandı; vida aralığı ve kapak sehim yöntemi bu kaynakta yok (doğrulanamadı).
- **[M4]** RST — *Expertise: Pressure equalisation*. <https://www.rst.eu/en/products/pressure-equalisation/expertise-pbe.html>
  Kullanım: membran elemanının yeri; IP65 ve üstünde önerilmesi, IP68 ile birlikte kullanılmaması (IP-VENT, PNL-VENT); tahliye yeri ve IPx5 sınırı; yoğuşma ilkeleri. Durum: doğrulandı; çiy noktası örnek değerleri psikrometrik olarak hatalı olduğundan Magnus formülüyle düzeltildi.
- **[M5]** W. L. Gore & Associates — *FAQ GORE Protective Vents*. <https://www.gore.com/resources/faq-gore-protective-vents>
  Kullanım: membran geçirgenliğinin 70 mbar'da tanımlanması. Durum: okunmadı.
- **[M6]** UL — *IEC 62368-1's Treatment of Enclosure Openings* (teknik not). <https://japan.ul.com/wp-content/uploads/sites/27/2014/06/1_techbrief_treatment_of_enclosure_openings.pdf>
  Kullanım: yangın muhafazasında üst, yan ve alt açıklık sınırları; Ek P yabancı cisim kuralı. Durum: doğrulandı (not 1. baskıya dayanır; 3. baskı farkları için [M8]).
- **[M7]** UL Solutions — *IEC 62368-1 Ask the Engineers Q&A*. <https://www.ul.com/vi/node/206146>
  Kullanım: PS1/PS2/PS3 sınıfları; yangın konisi mesafeleri; V-1 gereksinimi; küçük parça muafiyeti; tutuşma sıcaklığı sınırı. Durum: doğrulandı.
- **[M8]** TÜV Rheinland — *The evolution of IEC 62368-1, 3rd edition* (teknik ürün notu). <https://media.go.tuv.com/Web/TUVRheinlandAG/%7B73d23bd3-a64c-4168-b067-832362b95455%7D_62368-1_Technical_Product_Sheet_AV-IT_9.20.19.pdf>
  Kullanım: alt açıklıkta 5° / 15 mm kuralı; kafes seçeneğinin kaldırılması; 550 °C kızgın tel. Durum: doğrulandı.
- **[M9]** HUMMEL AG (Sealcon barındırıyor) — *UL94 vs. UL746C*. <https://www.sealconusa.com/pdf/ul94-versus-ul746c.pdf>
  Kullanım: UL 94 sınıf tanımları. Durum: doğrulandı (sınıfın kalınlığa bağlılığı bu belgede yok, ikincil kaynaklardandır).
- **[M10]** Texas Instruments — *Demystifying clearance and creepage distance for high-voltage end equipment* (SLUP421). <https://www.ti.com/lit/pdf/SLUP421>
  Kullanım: ES sınıfları; yüzey kaçak yolu (IEC 60664-1 F.4); darbe gerilimi ve hava aralığı (F.1, F.2); rakım katsayıları; kirlilik derecesi. Durum: doğrulandı.
- **[M11]** Texas Instruments — *Isolation in safety standards* (SLLA563). <https://ti.com/document-viewer/lit/html/SLLA563/GUID-A26A8BF1-0AA9-4DB6-9517-AC5574D7E3FF>
  Kullanım: güçlendirilmiş yalıtımda en az 0,4 mm katı yalıtım. Durum: doğrulandı.
- **[M12]** Power Integrations — *Minimum PCB spacing for spark gaps in adapter designs* (Apps Memo). <https://www.power.com/sites/default/files/knowledgebase/files/Apps%20Memo%20-%20ESD%20Spark%20gap%20spacing%20-%20Rev%20B.pdf>
  Kullanım: 250 V yüzey kaçak yolu satırı. Durum: okunmadı (değer başka bir IEC 60664-1 uygulamasıyla tutarlı bulundu).
- **[M13]** Rittal — *System Technology Handbook, Climate control*, s. 6. <https://www.rittal.de/downloads/eBook/TSH/EN/climate_control/pubData/SEO/Page_6.html>
  Kullanım: Q = k · A · ΔT, sac çelikte k = 5,5 W/m²K. Durum: doğrulandı.
- **[M14]** Rittal — *System Technology Handbook, Climate control*, s. 7. <https://www.rittal.de/downloads/eBook/TSH/EN/climate_control/pubData/SEO/Page_7.html>
  Kullanım: rakıma göre fan debisi katsayısı. Durum: doğrulandı.
- **[M15]** AutomationDirect — *Enclosure environment* (teknik destek notu). <https://support.automationdirect.com/notes/enclosure_environment.html>
  Kullanım: altı yüzü serbest kutuda ampirik sıcaklık artışı. Durum: doğrulandı.
- **[M16]** Würth Elektronik — *UG011 Thermal Gap Filler Pad WE-TGF* (kullanım kılavuzu). <https://www.we-online.com/components/products/media/489339>
  Kullanım: ısıl pedde %10–30 sıkışma, 6,9 N/cm² basınç, tek kullanım. Durum: doğrulandı.
- **[M17]** R. Brewer, G. Fenical — *Shielding: The Hole Problem* (Electronic Design). <https://www.electronicdesign.com/home/article/21200214/shielding-the-hole-problem>
  Kullanım: açıklık ekranlama etkinliği bağıntısı; 100 MHz'de 10 mm. Durum: doğrulandı (bal peteği havalandırma bağıntısı kontrol edilmedi).
- **[M18]** Parker Chomerics — *Theory of Shielding and Gasketing*. <https://discover.parker.com/chomerics-tech-info-emi-shielding-theory>
  Kullanım: metal gövdede dikiş ve vida aralığı (sonraki EMC kuralları için). Durum: kontrol edilmedi.
- **[M19]** Texas Instruments — *System-Level ESD Protection Guide* (SLAA530B), kutu açıklıkları. <https://ti.com/document-viewer/lit/html/SLAA530B/GUID-E3CFA29E-30BA-4095-B82E-8792304F5CF9>
  Kullanım: plastik gövdede ESD yolu (sonraki aşama). Durum: kontrol edilmedi.
- **[M20]** PCBWay — *PCB Enclosure Design Guide: Materials, IP Ratings and DFM Considerations*. <https://www.pcbway.com/blog/PCB_Design_Layout/PCB_Enclosure_Design_Guide_Materials_IP_Ratings_and_DFM_Considerations_3349fb77.html>
  Kullanım: PCB–duvar 0,5 mm; port açıklığı payları; inceleme kategorileri. Durum: kontrol edilmedi.
- **[M21]** OBO Bettermann — *Hat profile rail 35 × 7.5 mm, DIN EN 60715* (2069 T60 FS veri sayfası). <https://www.obo-bettermann.com/datasheet/en-xi/1115380/2069_T60_FS-1115380-en_GB.pdf>
  Kullanım: DIN klipsinin oturduğu TS35 ray ölçüleri. Durum: kontrol edilmedi.
- **[M22]** Lapp — *T21 Technical Tables* (kablo rakorları). <https://contentmedia.lappcdn.com/e/lapp/M54SitxM8Gk9LnRHkhruMw~~>
  Kullanım: rakor delik çapı, aralığı ve sıkma momenti (sonraki rakor kuralları için). Durum: kontrol edilmedi.
- **[M23]** Universidad de Sevilla — *Vibration analysis of PCBs*, bölüm 7 (Steinberg yaklaşımının özeti). <https://ereding.etsi.us.es/bibing/proyectos/abreproy/4124/fichero/Proyecto%252F7+-+SPECIFIC+SOLUTIONS.pdf>
  Kullanım: titreşimde kart destek aralığı (sonraki aşama). Durum: kontrol edilmedi.
- **[M24]** D. E. Whitney — *Design for Assembly*, MIT OpenCourseWare 2.875. <https://ocw.mit.edu/courses/2-875-mechanical-assembly-and-its-role-in-product-development-fall-2004/319a0f903d70a1a731d869d2a1c70c7c_class16_dfa04.pdf>
  Kullanım: tek yönden montaj, giriş pahları, parça ve vida çeşidi (sonraki DFA kuralları). Durum: kontrol edilmedi.
- **[M25]** Best Technology — *PCB standoffs* (blog). <https://www.bestpcbs.com/blog/2026/07/pcb-standoffs/>
  Kullanım: kart altında ≥ 1 mm hava payı (GEN-STANDOFF-GAP; GEN-STANDOFF-BELOW'da yalnızca bağlam). Durum: kontrol edilmedi (düşük güven).
- **[M26]** fasten.it — *DIN EN ISO 7089* düz pul ölçüleri. <https://fasten.it/Norms/Norm/DIN_EN_ISO_7089>
  Kullanım: pul dış çapları (FAS-HEAD-CLEAR, FAS-WASHER, MNT-EARS, MNT-HEAD-ROOM). Durum: kontrol edilmedi.
- **[M27]** RS DesignSpark — *Mounting holes: how to set copper pour clearance*. <https://www.rs-online.com/designspark/mounting-holes-how-to-set-copper-pour-clearance>
  Kullanım: montaj deliği çevresinde bakır ve bileşensiz halka (FAS-SCREW-FIT, FAS-COLLIDE, FAS-HEAD-CLEAR, FAS-CHASSIS). Durum: kontrol edilmedi.
- **[M28]** MacroFab — *PCB Mounting Holes and What to Watch Out For*. <https://www.macrofab.com/blog/attaching-your-project-to-things-mounting-holes-and-what-to-watch-out-for/>
  Kullanım: delik çevresindeki bileşenler, takım erişim silindiri, kart tutma (FAS-SCREW-FIT, FAS-COLLIDE, FAS-TOOL-ACCESS, FAS-STANDOFF, FAS-NO-HOLES). Durum: kontrol edilmedi.
- **[M29]** UL Solutions — *Thermal Aging Tests for Plastics* (UL 746B bağıl sıcaklık indeksi, RTI). <https://www.ul.com/services/thermal-aging-tests-plastics>
  Kullanım: sürekli kullanım sıcaklığı sınırı; RTI'nin özelliğe bağlı olması (REQ-TEMP). Durum: kontrol edilmedi (araştırma notlarında yok).
- **[M30]** Ensinger — *High temperature plastics* (sürekli kullanım sıcaklığı ve HDT). <https://ensingerplastics.com/en/plastic-material-selection/high-temperature-plastics>
  Kullanım: sürekli kullanım sıcaklığı ile HDT ayrımı (REQ-TEMP). Durum: kontrol edilmedi (araştırma notlarında yok).

## Anten ve RF

- **[R1]** Espressif Systems — *ESP Hardware Design Guidelines (ESP32): PCB Layout Design*. <https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/pcb-layout-design.html>
  Kullanım: kutu içinde anten çevresinde tüm yönlerde ≥ 15 mm (RF-KEEPOUT-METAL; `design.js`'teki sabit değer); taşan anteni kutuya alma (PORT-ENCLOSED); anten yerleşimi; son ürün testi (RF-DETUNE). Durum: 15 mm doğrulandı, yerleşim ve test maddeleri kontrol edilmedi.
- **[R2]** Espressif Systems — *ESP Hardware Design Guidelines (ESP32-S3): PCB Layout Design*. <https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/pcb-layout-design.html>
  Kullanım: kart kenarında anten yerleşimi. Durum: kontrol edilmedi.
- **[R3]** Microchip — *PIC32CX-BZ2 and WBZ45 Family Data Sheet: Module Placement Guidelines*. <https://onlinedocs.microchip.com/oxy/GUID-BF0CC5BA-1C78-4CCE-9C55-E847CB1F91C0-en-US-5/GUID-4DA5C0BD-495A-4865-8E33-07EA41067338.html>
  Kullanım: genel 10 mm, metal aralayıcılar için 31,75 mm. Durum: doğrulandı.
- **[R4]** Digi International — *Design notes for PCB antenna devices*. <https://docs.digi.com/resources/documentation/Digidocs/90002002/Reference/r_design_notes_pcb.htm>
  Kullanım: metal parçalarla antenin arasında 25,4 mm; anten kenarında engel olmaması (RF-METAL-BODY ve RF-MAGNETIC'te ikincil kaynak). Durum: kontrol edilmedi.
- **[R5]** Infineon (Cypress) — *AN91445 Antenna Design and RF Layout Guidelines*. <https://www.infineon.com/dgdl/Infineon-AN91445_Antenna_Design_and_RF_Layout_Guidelines-ApplicationNotes-v09_00-EN.pdf>
  Kullanım: plastik kasada 2,4 GHz'de 100–200 MHz kayma; eşleştirme devresi. Durum: kayma ve toprak boşluğu maddeleri doğrulandı, diğerleri kontrol edilmedi.
- **[R6]** Würth Elektronik — *ANP057 WE-MCA Multilayer Chip Antenna Placement & Matching*. <https://www.we-online.com/components/media/o139357v410%20ANP057a_WE-MCA%20Multilayer%20Chip%20Antenna%20Placement%20%26%20Matching_EN.pdf>
  Kullanım: çip antenin üstünde ya da altında metal için > 6 mm. Durum: doğrulandı.
- **[R7]** Texas Instruments — *Antenna Impedance Measurement and Matching* (SWRA726). <https://ti.com/lit/swra726>
  Kullanım: 868 MHz kayma örneği; kaymanın ölçülmesi gerekliliği (RF-DETUNE). Durum: doğrulandı (metal yüzeye yerleştirme maddesi kontrol edilmedi).
- **[R8]** Taoglas — *APN-11-8-004/C Flexible PCB Antenna with Cable*. <https://www.taoglas.com/wp-content/uploads/pdf/APN-11-8-004.C.pdf>
  Kullanım: metalden ≥ 20 mm (en az 4 mm); 2–3 mm ABS ayar koşulu; karbon siyahı ve naylon uyarısı (RF-LOSSY-MATERIAL'de not; denetim yalnızca karbon elyaf dolgulu malzemelerde); iletken gövdede dış anten (RF-METAL-BODY); kablo uzunluğu ve döngü (PNL-RF-CABLE). Durum: doğrulandı; bazı aralıklar başka Taoglas belgelerine ait olduğundan düzeltildi.
- **[R9]** Taoglas — *Guidelines for achieving highest RF performance and passing select regulatory approvals for cellular devices with internal antennas* (white paper). <https://www.taoglas.com/assets/whitepapers/Guidelines-for-achieving-highest-RF-performance-and-passing-select-regulatory-approvals-for-cellular-devices-with-internal-antennas-White-Paper.pdf>
  Kullanım: hücresel antende 20 mm metal mesafesi; TRP/TIS hedefleri. Durum: doğrulandı.
- **[R10]** Taoglas — *Antenna Integration Application Note* (nRF9160 ile Taoglas antenleri). <https://www.taoglas.com/datasheets/NordicApplicationNote.pdf>
  Kullanım: anten verimi ve geri dönüş kaybı hedefleri. Durum: doğrulandı.
- **[R11]** Taoglas — *APN-12-8-002/B GPS Patch Integration Application Note*. <https://www.taoglas.com/wp-content/uploads/pdf/TAOGLAS-GPS-Patch-Antenna-Integration-Application-NoteAPN-12-8-002.B.pdf>
  Kullanım: pasif GNSS yama çevresinde 4–10 mm; yama boyutuna göre bant genişliği. Durum: doğrulandı.
- **[R12]** u-blox — *GNSS antennas: RF design considerations for u-blox GNSS receivers* (UBX-15030289). <https://content.u-blox.com/sites/default/files/products/documents/GNSS-Antennas_AppNote_%28UBX-15030289%29.pdf>
  Kullanım: gerçekçi ekranlama 30–40 dB; GNSS ile hücresel verici arasında ≥ 40 dB yalıtım. Durum: doğrulandı (40 dB değeri doğrulama sırasında bu kaynaktan alındı).
- **[R13]** u-blox — *SAM-M10Q Integration manual* (UBX-22020019). <https://content.u-blox.com/sites/default/files/documents/SAM-M10Q_IntegrationManual_UBX-22020019.pdf>
  Kullanım: GNSS yama modülünde kapak ≥ 5 mm, yüksek bileşen ve modül kenarı ≥ 10 mm. Durum: doğrulandı.
- **[R14]** Antenova — *Techniques to integrate an antenna on a metal surface*. <https://www.antenova.com/techniques-to-integrate-an-antenna-on-a-metal-surface>
  Kullanım: metal yüzeye mesafe kademeleri ve 3–10 dB kayıp (RF-KEEPOUT-METAL); RF penceresi ≥ λ0/2 (RF-METAL-BODY). Durum: doğrulandı.
- **[R15]** K. Armstrong — *Design Techniques for EMC, Part 4: Shielding (Screening), part 1* (EMC Journal; KEK kopyası). <https://www-esys.kek.jp/r-and-d/emc/keitharmstrong/design-techniques-for-emc-part-4-shielding-screening-part-1/@@download/file/EMC%20Compliance%20Club4-1.pdf>
  Kullanım: açıklık boyutu ve ekranlama; vida aralığının açıklık sayılması; dalga kılavuzu kesim frekansı. Durum: doğrulandı (yazar bağıntıları kaba yaklaşım olarak niteler).
- **[R16]** Johanson Technology — *Understanding Chip Antennas Handbook*. <https://johansontechnology.com/docs/4565/johanson-antenna-handbook.pdf>
  Kullanım: anten üstünde iletken malzeme, metalik boya ve karbon elyaf yasağı (RF-LOSSY-MATERIAL); anten yakınında metal ve manyetik parça (RF-MAGNETIC). Durum: kontrol edilmedi.
- **[R17]** Texas Instruments — *AN058 Antenna Selection Guide* (SWRA161B). <https://ti.com/lit/swra161>
  Kullanım: bant boyunca S11 ≤ −10 dB; su şişesiyle el benzetimi. Durum: kontrol edilmedi.
- **[R18]** Pasternack — *PE4354 SMA Male Bulkhead Mount Connector* veri sayfası. <https://pasternack.com/images/ProductPDF/PE4354.pdf>
  Kullanım: önden takılan SMA için D delik ve panel kalınlığı. Durum: doğrulandı.
- **[R19]** Würth Elektronik — *WR-SMA PCB THT Jack Rear Mount Bulkhead 60312042641504* veri sayfası. <https://www.we-online.com/components/products/datasheet/60312042641504.pdf>
  Kullanım: arkadan takılan SMA için panel deliği ve kalınlığı. Durum: doğrulandı.
- **[R20]** Hirose Electric — *U.FL Series* katalogu (Digi-Key kopyası). <https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/8850/PdfFile_828479.pdf>
  Kullanım: takılı U.FL fiş yüksekliği. Durum: doğrulandı.
- **[R21]** TE Connectivity — *UMCC cable assemblies* veri sayfası (üçüncü taraf kopyası, DESY). <https://www.zeuthen.desy.de/~sulanke/Projects/ICECUBE/mDOM/PMT_base/datasheets/cable_assembly_UMCC_TE.pdf>
  Kullanım: 1,13 mm koaksiyelde bükme yarıçapı. Durum: doğrulandı.
- **[R22]** Professional Plastics — *Electrical Properties of Plastic Materials*. <https://www.professionalplastics.com/professionalplastics/content/downloads/ElectricalPropertiesofPlastics.pdf>
  Kullanım: 1 MHz dielektrik sabitleriyle malzeme sıralaması. Durum: kontrol edilmedi.
- **[R23]** Journal of Microwaves, Optoelectronics and Electromagnetic Applications (SciELO) — *Characterization of the Dielectric Properties of 3D Printing Filaments Using Cavity Perturbation Technique for 5G Applications*. <https://www.scielo.br/j/jmoea/a/LfyhQSc9nZZzpRwtYbKCTNs/?lang=en>
  Kullanım: FDM dolgu oranına göre dielektrik sabiti. Durum: kontrol edilmedi.

## Algoritma ve raporlama

Bu gruptaki kaynaklar sayısal eşik değil, yöntem ve sunum ilkesi için kullanılır. Doğrulayıcı bu gruptaki maddeleri ayrıca kontrol etmedi.

- **[A1]** KiCad projesi — *KiCad 8.0 PCB Editor* kılavuzu (Design Rule Checker, Violation Severity, Custom Design Rules, DRC report). <https://docs.kicad.org/8.0/en/pcbnew/pcbnew.html>
  Kullanım: kimlikli ve seviyeli kural kataloğu; özgül kuralın kazanması; tek bulgunun hariç tutulması; rapor.
- **[A2]** Altium — *Defining, Scoping & Managing PCB Design Rules*. <https://www.altium.com/documentation/altium-designer/pcb/defining-scoping-managing-design-rules>
  Kullanım: kural kapsamı ve önceliği; çevrimiçi (parametrik) ve toplu (katı model) denetim ayrımı.
- **[A3]** OpenJS Foundation — *ESLint: Custom Rules*. <https://eslint.org/docs/latest/extend/custom-rules>
  Kullanım: otomatik düzeltme ile öneri ayrımı; en çok 10 düzeltme turu; turda tek düzeltme.
- **[A4]** OpenJS Foundation — *ESLint: Circular fixes detected*. <https://eslint.org/docs/head/use/troubleshooting/circular-fixes>
  Kullanım: salınım algılama ve çatışan kural çiftinin raporlanması.
- **[A5]** Y. Gil, E. Melz — KAW96, propose-and-revise bilgi rolleri (Calgary Üniv. KSI). <https://ksi.cpsc.ucalgary.ca/KAW/KAW96/gil/node3.html>
  Kullanım: öner ve düzelt şeması; düzeltmelerin ihlale katkı veren parametrelerle sınırlanması.
- **[A6]** Z. Zdrahal, E. Motta — KAW96, *Improving competence by integrating case-based reasoning and heuristic search*. <https://ksi.cpsc.ucalgary.ca/KAW/KAW96/zdrahal/cbr.html>
  Kullanım: açgözlü onarımın sınırı (VT denemeleri); adayların maliyet sırasıyla denenmesi.
- **[A7]** S. Marcus, J. Stout, J. McDermott — *VT: An Expert Elevator Designer That Uses Knowledge-Based Backtracking* (AI Magazine; AITopics özeti). <https://aitopics.org/doc/journals:AA86382B>
  Kullanım: katalogun yakınsama açısından statik denetimi (sonraki aşama).
- **[A8]** B. Chandrasekaran — *Design Problem Solving: A Task Analysis* (AI Magazine 11(4), 1990; AITopics özeti). <https://aitopics.org/doc/journals:70DAAE67>
  Kullanım: her alt probleme uygun çözüm yöntemi.
- **[A9]** Wikipedia — *Design structure matrix*. <https://en.wikipedia.org/wiki/Design_structure_matrix>
  Kullanım: bağımlılık blokları (B1, B2, B3) ve yırtma.
- **[A10]** Wikipedia — *Data-flow analysis*. <https://en.wikipedia.org/wiki/Data-flow_analysis>
  Kullanım: tek yönlü adımlarla sabit noktaya ulaşma benzetmesi.
- **[A11]** Wikipedia — *Min-conflicts algorithm*. <https://en.wikipedia.org/wiki/Min-conflicts_algorithm>
  Kullanım: sözlük sıralı ihlal skoru.
- **[A12]** A. Borning, B. Freeman-Benson, M. Wilson — *Constraint Hierarchies* (1992; Washington Üniv.). <https://constraints.cs.washington.edu/theory/hierarchies-92.html>
  Kullanım: katı ve yumuşak kural ayrımı.
- **[A13]** OASIS SARIF TC — *SARIF 2.1.0 JSON schema* (SchemaStore kopyası). <https://www.schemastore.org/sarif-2.1.0.json>
  Kullanım: bulgu şeması; "geçti" türü; gerekçeli muafiyet.
- **[A14]** GitHub Docs — *SARIF support for code scanning*. <https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support>
  Kullanım: mesajın ilk cümlesinin tek başına anlaşılır olması; denetimin kesinlik derecesi.
- **[A15]** Protolabs — *Design Tip: Navigating Manufacturing Analysis*. <https://www.protolabs.com/resources/design-tips/navigating-manufacturing-analysis/>
  Kullanım: gerekli ve öneri niteliğindeki değişikliklerin sabit anlamı.
- **[A16]** Protolabs — *Help Center: Manufacturing Analysis*. <https://protolabs.com/help-center/manufacturing-analysis>
  Kullanım: öneriye üç yönlü yanıt.
- **[A17]** Protolabs — *Design Tip: Navigating ProtoQuote*. <https://www.protolabs.com/resources/design-tips/navigating-protoquote/>
  Kullanım: açık zorunlu değişiklik varken tasarıma "nihai" denmemesi.
- **[A18]** Fictiv — *DFM report help*. <https://www.fictiv.com/?p=20808>
  Kullanım: yeşil, turuncu, kırmızı sonuçlar; konuya göre gruplama.
- **[A19]** Fictiv — *Design validation that's disrupting injection molding*. <https://www.fictiv.com/articles/design-validation-thats-disrupting-injection-molding>
  Kullanım: otomatik incelemenin mühendis incelemesiyle tamamlanması.
- **[A20]** Siemens Digital Industries Software — *NX Tips & Tricks: DFM Advisor*. <https://blogs.sw.siemens.com/nx-design/nx-tips-tricks-dfm-advisor/>
  Kullanım: geçen denetimlerin de listelenmesi; denetim başına belge sayfası.
- **[A21]** Dassault Systèmes — *SOLIDWORKS Tech Tip: Using DFMXpress*. <http://blogs.solidworks.com/products/solidworks/solidworks-tech-tip-using-dfmxpress>
  Kullanım: süreç başına kural grupları.
- **[A22]** Autodesk — *DFM help: Wall thickness*. <https://help.autodesk.com/cloudhelp/2015/ENU/DFM/files/GUID-CFC1BEF6-FD8D-4A66-9D16-5A6BBFEA7BBA.htm>
  Kullanım: gerçekleşen geometrinin denetimi (GEO-TREAT, GEO-BUILD; katı model sonrası inceleme); et kalınlığı haritası (sonraki aşama).
- **[A23]** Altium Resources — *Design for Manufacturing and Assembly (DFM/A) or Predictive Engineering*. <https://resources.altium.com/p/design-manufacturing-and-assembly-dfma-or-predictive-engineering>
  Kullanım: maliyetin %75–85'inin tasarımda belirlenmesi; uygulanamayan kenar işleminin ve özelliğin raporlanması gerekçesi (GEO-TREAT, GEO-BUILD).
- **[A24]** Nielsen Norman Group — *Error-Message Guidelines*. <https://www.nngroup.com/articles/error-message-guidelines/>
  Kullanım: mesaj dili; rengin tek başına kullanılmaması; kalıcı pencerenin yalnızca engelleyici durumda kullanılması.
- **[A25]** Nielsen Norman Group — *10 Usability Heuristics for User Interface Design*. <https://www.nngroup.com/articles/ten-usability-heuristics/>
  Kullanım: döngü durumunun görünür olması; düzeltmelerin geri alınabilmesi.
- **[A26]** Nielsen Norman Group — *Progressive Disclosure*. <https://www.nngroup.com/articles/progressive-disclosure/>
  Kullanım: raporun en çok iki kademeli sunumu.
- **[A27]** Wikipedia — *Design rationale*. <https://en.wikipedia.org/wiki/Design_rationale>
  Kullanım: karar kaydı.
- **[A28]** Boothroyd Dewhurst, Inc. — *Part Consolidation*. <https://www.dfma.com/resources/part-consolidation.asp>
  Kullanım: DFA en az parça sayısı testi (sonraki aşama).

## Geometri çekirdeği

Bu kaynaklar katı model denetiminde (geometri incelemesi) kullanıldı; doğrulayıcı ayrıca kontrol etmedi. replicad 1.2.1 API'si ayrıca paketin dağıtım tiplerinden (replicad.d.ts) okundu.

- **[G1]** replicad — *Modifications* (fillet, chamfer, shell, bulucular) eğitimi. <https://replicad.xyz/docs/tutorial-overview/modifications>
  Kullanım: kenar işlemi çağrıları ve kenar seçimi.
- **[G2]** Open CASCADE forumu — *BRepFilletAPI_MakeFillet crash StdFail_NotDone*. <https://dev.opencascade.org/content/brepfilletapimakefillet-crash-stdfailnotdone-brepapi-command-not-done>
  Kullanım: boolean sonrası radyüs hataları; işlem sırası ve geri düşüş gerekçesi.
- **[G3]** Open CASCADE hata izleyicisi — kayıt 33877. <https://tracker.dev.opencascade.org/view.php?id=33877>
  Kullanım: radyüs işleminin yarıçapa duyarlılığı.

## Standartlar ve iç mühendislik notları

Katalogda bağlantısız anılan standartlar ve iç notlar. Standart metinleri bu çalışmada okunmadı; değerler kodda iç mühendislik modeli olarak kullanılır (tablolar `web/rules/` ve `fits.js` içindedir). Durum: hepsi kontrol edilmedi.

- **[N1]** VDI 2230 Blatt 1 — yüksek zorlanmalı cıvata bağlantılarının sistematik hesabı (ön yük, sıkma torku). Kullanım: sıkma torku sınırı, pul ve kilit pulu notları (FAS-TORQUE, FAS-WASHER, FAS-LOCK-WASHER, FAS-PLASTIC-SCREW).
- **[N2]** ISO 273 — cıvatalar için geçiş delikleri (ince / orta / kaba seri). Kullanım: geçiş deliği çapları ve vida geçme sınıfı (FAS-SCREW-FIT, MNT-DATA).
- **[N3]** EN 60715 — alçak gerilim şalt düzenlerinin montaj ölçüleri (TS35 rayı). Kullanım: DIN klipsi (MNT-DIN).
- **[N4]** ISO 7045 / ISO 7046 / ISO 7047 / ISO 7048 / ISO 7049 / ISO 7051 / ISO 14580 — vida baş ve boy serileri (Toolbox kütüphanesi). Kullanım: vida tipi ve boyut tanımı, havşa (FAS-TYPE-SIZE, FAS-CSK). V2.1'de eklenen tiplerin tabloları [T1]–[T14]'tedir.
- **[N5]** DIN 974-1 — silindir başlı vidalar için gömme baş oyukları. Kullanım: gömme oyuk (FAS-CBORE).
- **[N6]** IEC 60529 — muhafazaların koruma dereceleri (IP kodu). Kullanım: IP iddiasının testle doğrulanması (IP-TEST); test parametreleri [M2] üzerinden.
- **[N7]** Galvanik seri ve metal çiftleri (DIN EN ISO 8044 terimleri; iç mühendislik notu). Kullanım: alüminyum gövdede metal vida (FAS-GALVANIC).
- **[N8]** Malzeme teknik veri sayfaları (kural dosyası notlarındaki kaynak: HDT, sürekli kullanım sıcaklığı, yoğunluk, çekme dayanımı). Kullanım: `max_service_temp_c` (REQ-TEMP), pano içi sıcaklık (MNT-DIN-HDT), plastik vida (FAS-PLASTIC-SCREW).

## Bağlantı elemanı tabloları (Toolbox V2.1)

`web/rules/toolbox/iso-screws.json` içine V2.1'de eklenen tiplerin (ISO 7047, ISO 7048, DIN 7985, ISO 10644, ISO 7051), Pozidriv iz çaplarının (mZ) ve eski DIN karşılıklarının (din, din_note) kaynakları. ISO örnek sayfalarındaki (iTeh) taranmış tablolar okunarak alındı, 2011 baskıları için fasten.it tablolarıyla karşılaştırıldı. Durum: [T1]–[T6] ve [T14] ISO örnek sayfalarıdır, tablo değerleri okundu ve ikinci kaynakla karşılaştırıldı ([T14]'teki Aspen DIN 9021 sayfası tedarikçi verisidir); [T7]–[T13] ikinci kaynak ya da tedarikçi verisidir (Würth DIN-EN-ISO broşürünün Tabelle 2 ve Tabelle 8 değerleri PDF metninden okundu, bazı Würth sayfaları yalnızca arama özetinden görüldü).

- **[T1]** ISO 7047:1994 — yıldız bombeli havşa başlı vidalar (H/Z), örnek sayfa: https://cdn.standards.iteh.ai/samples/13614/380d3cd0adfe41a887be3ba971f0ccc4/ISO-7047-1994.pdf ; kapsam (M1,6–M10, 2011 baskısı): https://www.iso.org/standard/57375.html ; 2011 örnek sayfası (b = l − (k + a)): https://cdn.standards.iteh.ai/samples/57375/7d0f38c9922c413eb66bf84468fb777b/ISO-7047-2011.pdf . Kullanım: dk teorik/gerçek, k, f, rf, uç no., m (H/Z), boy tanımı (bombe boya dahil değil; FAS-CSK). M3 f için ISO değeri 0,7 alındı (fasten.it 0,75 = DIN 966).
- **[T2]** ISO 7048:1998 — yıldız silindir başlı vidalar, örnek sayfa: https://cdn.standards.iteh.ai/samples/13615/c02794ae754c49d79bf60d391ffa088e/ISO-7048-1998.pdf ; 2011 kapsamı (M2,5–M8, baş ISO 1207 ile aynı): https://cdn.standards.iteh.ai/samples/iso/iso-7048-2011/d050c7b8c070436bbaf04bcd25c6129e/iso-7048-2011.pdf . Kullanım: dk, k, uç no. (M3 PH2), m (H/Z), boylar (35 mm 2011 tablosundan).
- **[T3]** ISO 7051:2011 — yıldız bombeli havşa başlı sac vidaları, örnek sayfa: https://cdn.standards.iteh.ai/samples/54048/a93f31981df541ef9e32125db04fe444/ISO-7051-2011.pdf ; 1983 baskısı: https://cdn.standards.iteh.ai/samples/13618/44229a7394b5416c9a8875f87fd4f0db/ISO-7051-1983.pdf ; aynı havşa ISO 7050:2011: https://cdn.standards.iteh.ai/samples/54047/05c26c8a28aa4141812f5e6c5b314364/ISO-7050-2011.pdf . Kullanım: dk, k, f, rf, uç no., m (H/Z), Z izine izin.
- **[T4]** ISO 10644:2009 — vida ve düz pul takımları (kombi vida), örnek sayfa: https://cdn.standards.iteh.ai/samples/44116/23614ba4a8aa4d898a5a895e2e81cc62/ISO-10644-2009.pdf ; 1998 baskısı (tanım örnekleri S1 - N): https://cdn.standards.iteh.ai/samples/18739/521c1daeaaff425da0536d1f5684eb79/ISO-10644-1998.pdf . Kullanım: S3 = ISO 7045 başı, yalnız N/L pul, boy baş altından ölçülür ve pul kalınlığı boya eklenmez (pul boyun içindedir), kapsam yalnızca çelik vidalar (10.9'a kadar) ve 200 HV / 300 HV pullar (madde 1; 8.8'e kadar 200 HV ya da 300 HV), tanım öğeleri (madde 7: standart, vida özellikleri, vida sembolü, pul sembolü, pul sertlik sınıfı; FAS-WASHER). "- H - S3 - N - 200 HV" sırası 2009 madde 7 öğelerinden ve 1998 örneğinden çıkarıldı. A2 kombi vidalar standart dışıdır, katalogda yalnızca 4.8 galvaniz vardır.
- **[T5]** ISO 10673:1998 — vida ve pul takımları için düz pullar (S/N/L), örnek sayfa: https://cdn.standards.iteh.ai/samples/18763/16a1a118133a4b0aa5161e1c887b05bd/ISO-10673-1998.pdf ; fasten.it: https://www.fasten.it/norms/norm/din_en_iso_10673 . Kullanım: kombi vida pulu tip N d1, d2, s.
- **[T6]** ISO 7045:1994 ve ISO 7046-1:1994 örnek sayfaları (H ve Z iz çapı m): https://cdn.standards.iteh.ai/samples/13608/caed16a7f73145ffab7712aa5196142c/ISO-7045-1994.pdf , https://cdn.standards.iteh.ai/samples/13611/15b0d9158085481f8554d9b962dafc70/ISO-7046-1-1994.pdf ; ISO 7045:2011: https://cdn.standards.iteh.ai/samples/57372/fafe91d8504049fc8953281401736c79/ISO-7045-2011.pdf . Kullanım: mZ değerleri; uç no. H ve Z'de aynı.
- **[T7]** fasten.it DIN ve DIN EN ISO norm tabloları (ör. https://www.fasten.it/Norms/Norm/DIN_7985 , https://www.fasten.it/Norms/Norm/DIN_EN_ISO_7047 , https://www.fasten.it/Norms/Norm/DIN_EN_ISO_7048 , https://fasten.it/norms/norm/din_en_iso_7051 , https://www.fasten.it/norms/norm/din_en_iso_10644 ve DIN 965, 966, 84, 85, 963, 912, 7991, 7981, 7982, 7983, 125, 433, 9021, 934, 439-2, 985 sayfaları). Kullanım: 2011 karşılaştırması, DIN → ISO "yerine geçti" satırları, M2–M6 farkları (din_note). fasten.it'in DIN EN ISO 7045 sayfası M3/M5 baş ölçülerinde DIN 7985 değerlerini gösterir; ISO örnek sayfası esas alındı.
- **[T8]** Würth: DINO teknik bölüm 3 (DIN ↔ ISO eşlemesi, "baş ölçüleri değişti" notları): https://prueflabor.wuerth-industrie.com/web/media/en/pictures/wuerthindustrie/technikportal/dinokapitel/Kapitel_03_DINO_techn_Teil.pdf ; DIN-EN-ISO normalizasyon broşürü (DIN 7985 geri çekilmiş, değiştirilebilir): https://prueflabor.wuerth-industrie.com/web/media/de/pictures/wuerthindustrie/unternehmen/download_center/Broschuere_DIN-EN-ISO_Normung_DE.pdf . Kullanım: din alanı, DIN 7985 durumu.
- **[T9]** Westfield Fasteners standart sayfaları: DIN 7985 tablosu https://westfieldfasteners.co.uk/Standards/ScrewBolt-PhilRaPan-M.pdf ; ISO 7047 / DIN 966 boy tanımı https://www.westfieldfasteners.co.uk/Standards/ScrewBolt_PoziRaCsk_M.html ; DIN 912 = ISO 4762 https://westfieldfasteners.co.uk/Standards/ScrewBolt-SHCap-M.html . Kullanım: DIN 7985 k (anma ± tolerans → en büyük), rf, v; bombeli havşada boy tanımı.
- **[T10]** DIN Media: DIN 7985:1990-08 geri çekilmiş, yerine DIN EN ISO 7045:1994-10 https://www.dinmedia.de/de/norm/din-7985/3166488 ; DIN 6900-1 yerine DIN EN ISO 10644 https://www.dinmedia.de/en/standard/din-6900-1/1635208 ; ISO 7380-1'in DIN öncülü yok https://dinmedia.de/en/standard/din-en-iso-7380-1/141435645 . Kullanım: withdrawn alanı, din / din_note.
- **[T11]** boltport / ferrobend DIN 7985 tablosu (k anma/en büyük, rf, v, H ve Z m): https://www.boltport.com.ferrobend.com/standards/din-7985 .
- **[T12]** Kombi vida stokları: A.R.T. SEMS kataloğu https://artcomponents.com/media/static/pdf/Kombischrauben(MZ18-34).pdf ; Bossard BN 1719 https://www.bossard.com/eshop/ch-en/screws-and-bolts-with-internal-drive/phillips-pan-head-assembled-sems-screws-form-h-with-captive-flat-washer-din6902a/p/1719 . Kullanım: ISO 10644 boy serileri (M2,5–M6), malzeme (4.8 galvaniz; tedarikçilerin A2 kombi vidaları ISO 10644 kapsamı dışında kaldığı için katalogda yoktur). M2 boy serisi bulunamadı, M2 tanımlanmadı.
- **[T13]** Keller & Kalmbach veri sayfaları: ISO 7048 M3 (dk 5,5, k 2, H2) https://www.keller-kalmbach.de/p/I7048ADACAC312/pdf ; ISO 7049 / DIN 7981 baş farkı https://www.keller-kalmbach.de/p/I7049RAACT04213/pdf , https://www.keller-kalmbach.de/p/2079817428/pdf .
- **[T14]** ISO 10511 (1997) örnek sayfası (M3 h 3,9; DIN 985 karşılaştırması): https://cdn.standards.iteh.ai/samples/18580/3c6637cfdcd44b2d82aaa7e9dd0beecc/ISO-10511-1997.pdf ; Aspen DIN 9021 (M5 s 1,2): https://www.aspenfasteners.com/content/pdf/Metric_DIN_9021_spec.pdf .

Kaynaklarda bulunan, bu sürümde düzeltilmeyen veri notları: mevcut ISO 7045 M5 başı (dk 10, k 3,8) DIN 7985 değeridir (ISO 7045: 9,5 / 3,7); ISO 7049 satırları DIN 7981 değerlerini taşır (ISO 7049 ST2.2 dk 4,0 k 1,6 PH0 …); ISO 4032 M6 m 5,0 DIN 934 değeridir (ISO 4032: en büyük 5,2). Mevcut tasarımlar değişmesin diye bu değerler V2.1'de korunmuştur; bu satırlar katalogda `dim_src` alanıyla işaretlidir ve Toolbox'ta ölçünün yanında "(DIN 7985 ölçüsü)" gibi gösterilir, din_note metinleri de bunu yazar. ISO 7049 ST2,2'nin Pozidriv iz çapı (mZ 2,4) da satırın uç no.'su (PH1/PZ1) gibi DIN 7981'den alınmıştır (fasten.it DIN 7981: uç no. 1, m H 2,6, m Z 2,4).

V2.1 inceleme düzeltmeleri: DIN 7985 M2 uç no. PH1 (boltport [T11]: no. 1, m H 2,5, m Z 2,4), ISO 7045 M2 PH0 (ISO 7045:2011 Tablo 1: no. 0, m H 1,9) — ISO 7045 notu M2 farkını yazar. DIN 963 M6 k en büyük 3 (Würth broşürü Tabelle 2 [T8]: 0,96 / 1,2 / 1,5 / 1,65 / 1,93 / 2,2 / 2,5 / 3 / 4 / 5; fasten.it DIN 965 de 3 verir, fasten.it DIN 963 sayfasındaki 3,3 ISO değeridir) — ISO 2009 notu DIN 965/966 notlarıyla aynı "M6 dk/k 11/3→11,3/3,3" biçimindedir.

## Kullanılmayan ya da erişilemeyen kaynaklar

- Covestro *Part and Mold Design* kılavuzu HTTP 403 verdi; kural kaynağı yapılmadı ([K20]).
- aPriori, DFMPro ve Xometry'nin DFM özellik açıklamaları (403 ve DNS hataları), Silicon Labs AN1088 ve modül veri sayfaları ile Semtech sayfaları (403 ve yönlendirme) okunamadı; atıf yapılmadı.
- Enjeksiyonda et düzgünlüğü için anılan PT Online makalesi açılamadı; ±%10 düzgünlük hedefi bu yüzden kullanılmadı.
- FDM'de damla biçimli yatay delik ve 8 mm'ye kadar desteksiz yatay delik bilgisi doğrulayıcının andığı Makerverse FDM kılavuzundadır; bağlantısı kayıtlı olmadığından atıf yapılmadı.

## Katalog anahtarları

`catalog.js`'teki kaynak adları (`S.<ad>`) ile bu belgedeki anahtarlar. Tabloda olmayan anahtarlar yalnızca TASARIM-ALGORITMASI.md'de kullanılır.

| Grup | Eşleme |
|---|---|
| FDM | F1 `ultimaker`, F2 `prusaModel`, F3 `prusaElephant`, F4 `prusaWarp`, F5 `formlabsWall`, F7 `stratasysFdm`, F8 `hubsFdm`, F9 `hubsShell`, F10 `hubsEnclosure`, F11 `hubsThreaded`, F12 `hubsInterlock`, F13 `hubsAccuracy`, F16 `heBridge`, F17 `cncKitchen`, F18 `cncKitchenTable`, F20 `spirol`, F23 `fictivSnap` |
| CNC | C1 `hubsCnc`, C2 `hubsCncCost`, C4 `xometryCnc`, C5 `xometryCorner`, C7 `xometryChamfer`, C8 `ensinger`, C11 `protolabsMill`, C12 `protolabsComplex`, C16 `protolabsFillet`, C18 `fictivCnc`, C19 `fictivGlossary`, C20 `nasa`, C21 `bossard`, C22 `mcam`, C23 `boedeker`, C24 `iso13715`, C25 `boedekerDrill` |
| Enjeksiyon | K1 `protolabsWall`, K2 `protolabsStronger`, K3 `protolabsBasics`, K4 `protolabsBoss`, K5 `protolabsDraft`, K6 `protolabsDfm1`, K7 `protolabsCorners`, K8 `dupont`, K9 `ticona`, K10 `avient`, K11 `boellhoff`, K12 `bonenberger`, K14 `fathom`, K17 `fictivEnclosure`, K18 `fictivImSpec`, K19 `bayerSnap` |
| Muhafaza | M1 `parker`, M2 `element`, M3 `rogers`, M4 `rst`, M5 `gore`, M20 `pcbway`, M21 `obo`, M22 `lapp`, M23 `sevilla`, M24 `mitDfa`, M25 `standoffBlog`, M26 `iso7089`, M27 `rsMount`, M28 `macrofab`, M29 `ulRti`, M30 `ensingerTemp` |
| RF | R1 `espressif`, R3 `microchip`, R4 `digi`, R7 `tiMatch`, R8 `taoglasFlex`, R14 `antenova`, R16 `johanson`, R18 `pasternack` |
| Algoritma | A1 `kicad`, A22 `autodeskDfm`, A23 `altiumDfma` |
| Standartlar | N1 `vdi2230`, N2 `iso273`, N3 `en60715`, N4 `isoScrews`, N5 `din974`, N6 `iec60529`, N7 `galvanic`, N8 `materialTds` |
| Bağlantı elemanı (V2.1) | T1 `iso7047` (FAS-CSK), T4 `iso10644` (FAS-WASHER) |

## Sürüm geçmişi

- **V2.1 (Kasım 2026):** bağlantı elemanı tabloları bölümü ([T1]–[T14]): ISO 7047, ISO 7048, DIN 7985, ISO 10644 / ISO 10673, ISO 7051, Pozidriv iz çapları ve eski DIN karşılıkları; katalogda `iso7047` (FAS-CSK) ve `iso10644` (FAS-WASHER) kaynakları eklendi; [N4] başlığı yeni tiplerle güncellendi.

- **V2.0 (Kasım 2026):** katalogla eşleme tablosu (C12 `protolabsComplex` ve C19 `fictivGlossary` katalogda CNC-POCKET-DEPTH ve CNC-CUTOUT-TOOL kaynağı olarak eklendi); katalogda kullanılıp listede olmayan kaynaklar eklendi ([F23], [C25], [M26]–[M30], [N1]–[N8]); [K7] durumu ve "kontrol edilmedi" tanımı düzeltildi; kaynak kullanımları kural kimlikleriyle güncellendi.
