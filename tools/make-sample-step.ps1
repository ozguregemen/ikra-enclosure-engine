<#
.SYNOPSIS
  Ikra icin ornek PCB montajlari uretir (STEP AP214): kart + kutu geometrili bilesenler.
  Kartlar: ornek-kart (60 x 40), arduino-uno-r3, raspberry-pi-4b, esp32-devkitc, nucleo-64.
  Kart dis olculeri, montaj delikleri ve konnektor konumlari ureticilerin mekanik cizimlerinden alinmistir
  (her kartin aciklamasinda kaynak); bilesenler kutu olarak basitlestirilmistir, yuksekliklerin bir kismi yaklasiktir.
  Gercek bir ECAD ciktisi yerine gecmez; analiz ve demo icindir.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-sample-step.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-sample-step.ps1 -Board arduino-uno-r3
#>
param(
    [string]$Board = 'all',
    [string]$OutDir = (Join-Path $PSScriptRoot '..\web\samples')
)

$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
$script:nextId = 0
$script:lines = New-Object 'System.Collections.Generic.List[string]'
$script:styled = New-Object 'System.Collections.Generic.List[int]'

function F([double]$v) { return $v.ToString('0.0#####', $inv) }

function Add-Entity([string]$text) {
    $script:nextId++
    $script:lines.Add("#$($script:nextId) = $text;")
    return $script:nextId
}

function Add-Point([double[]]$p) { return Add-Entity "CARTESIAN_POINT('',($(F $p[0]),$(F $p[1]),$(F $p[2])))" }
function Add-Direction([double[]]$d) { return Add-Entity "DIRECTION('',($(F $d[0]),$(F $d[1]),$(F $d[2])))" }

# Dik silindirik delik: ust/alt yuz icin ic sinirlar + silindirik yan yuz.
# Yonler: ust yuzde delik saat yonunde (malzeme solda), alt yuzde tersi; silindir yuzunun
# normali eksene bakar (same_sense .F.), dikis (seam) kenari dongude iki kez, iki yonde kullanilir.
function Add-Hole([double]$hx, [double]$hy, [double]$r, [double]$z0, [double]$z1) {
    $zDir = Add-Direction @(0, 0, 1)
    $xDir = Add-Direction @(1, 0, 0)
    $vTop = Add-Entity "VERTEX_POINT('',#$(Add-Point @(($hx + $r), $hy, $z1)))"
    $vBot = Add-Entity "VERTEX_POINT('',#$(Add-Point @(($hx + $r), $hy, $z0)))"
    $axTop = Add-Entity "AXIS2_PLACEMENT_3D('',#$(Add-Point @($hx, $hy, $z1)),#$zDir,#$xDir)"
    $axBot = Add-Entity "AXIS2_PLACEMENT_3D('',#$(Add-Point @($hx, $hy, $z0)),#$zDir,#$xDir)"
    $circTop = Add-Entity "CIRCLE('',#$axTop,$(F $r))"
    $circBot = Add-Entity "CIRCLE('',#$axBot,$(F $r))"
    $eTop = Add-Entity "EDGE_CURVE('',#$vTop,#$vTop,#$circTop,.T.)"
    $eBot = Add-Entity "EDGE_CURVE('',#$vBot,#$vBot,#$circBot,.T.)"
    $seamVec = Add-Entity "VECTOR('',#$zDir,1.)"
    $seamLine = Add-Entity "LINE('',#$(Add-Point @(($hx + $r), $hy, $z0)),#$seamVec)"
    $eSeam = Add-Entity "EDGE_CURVE('',#$vBot,#$vTop,#$seamLine,.T.)"
    $cyl = Add-Entity "CYLINDRICAL_SURFACE('',#$axBot,$(F $r))"

    $o1 = Add-Entity "ORIENTED_EDGE('',*,*,#$eTop,.T.)"
    $o2 = Add-Entity "ORIENTED_EDGE('',*,*,#$eSeam,.F.)"
    $o3 = Add-Entity "ORIENTED_EDGE('',*,*,#$eBot,.F.)"
    $o4 = Add-Entity "ORIENTED_EDGE('',*,*,#$eSeam,.T.)"
    $cylLoop = Add-Entity "EDGE_LOOP('',(#$o1,#$o2,#$o3,#$o4))"
    $cylBound = Add-Entity "FACE_OUTER_BOUND('',#$cylLoop,.T.)"
    $cylFace = Add-Entity "ADVANCED_FACE('',(#$cylBound),#$cyl,.F.)"

    $oTop = Add-Entity "ORIENTED_EDGE('',*,*,#$eTop,.F.)"
    $topLoop = Add-Entity "EDGE_LOOP('',(#$oTop))"
    $topBound = Add-Entity "FACE_BOUND('',#$topLoop,.T.)"
    $oBot = Add-Entity "ORIENTED_EDGE('',*,*,#$eBot,.T.)"
    $botLoop = Add-Entity "EDGE_LOOP('',(#$oBot))"
    $botBound = Add-Entity "FACE_BOUND('',#$botLoop,.T.)"
    return @{ face = $cylFace; top = $topBound; bottom = $botBound }
}

# Eksene hizali kutu katisi: 8 kose, 12 kenar, 6 duzlemsel yuz (normaller disari bakar).
# $holes: @(@{x; y; r}, ...) verilirse Z yonunde boydan boya delikler acilir.
function Add-BoxSolid([double[]]$a, [double[]]$b, [string]$name, [object[]]$holes = @()) {
    $holeParts = @(foreach ($hole in $holes) { Add-Hole $hole.x $hole.y $hole.r $a[2] $b[2] })
    # Not: PowerShell degisken adlari buyuk/kucuk harf duyarsizdir; dongu degiskenleri farkli adlandirildi.
    $verts = @(
        @($a[0], $a[1], $a[2]), @($b[0], $a[1], $a[2]), @($b[0], $b[1], $a[2]), @($a[0], $b[1], $a[2]),
        @($a[0], $a[1], $b[2]), @($b[0], $a[1], $b[2]), @($b[0], $b[1], $b[2]), @($a[0], $b[1], $b[2])
    )
    $vp = foreach ($vert in $verts) { $p = Add-Point $vert; Add-Entity "VERTEX_POINT('',#$p)" }

    $edgeDefs = @(@(0, 1), @(1, 2), @(2, 3), @(3, 0), @(4, 5), @(5, 6), @(6, 7), @(7, 4), @(0, 4), @(1, 5), @(2, 6), @(3, 7))
    $ec = foreach ($edge in $edgeDefs) {
        $s = $verts[$edge[0]]; $t = $verts[$edge[1]]
        $d = @(($t[0] - $s[0]), ($t[1] - $s[1]), ($t[2] - $s[2]))
        $len = [Math]::Sqrt($d[0] * $d[0] + $d[1] * $d[1] + $d[2] * $d[2])
        $dir = Add-Direction @(($d[0] / $len), ($d[1] / $len), ($d[2] / $len))
        $vec = Add-Entity "VECTOR('',#$dir,1.)"
        $pt = Add-Point $s
        $line = Add-Entity "LINE('',#$pt,#$vec)"
        Add-Entity "EDGE_CURVE('',#$($vp[$edge[0]]),#$($vp[$edge[1]]),#$line,.T.)"
    }

    $faceDefs = @(
        @{ n = @(0, 0, -1); r = @(1, 0, 0); p = $verts[0]; loop = @(@(3, '.F.'), @(2, '.F.'), @(1, '.F.'), @(0, '.F.')) },
        @{ n = @(0, 0, 1);  r = @(1, 0, 0); p = $verts[4]; loop = @(@(4, '.T.'), @(5, '.T.'), @(6, '.T.'), @(7, '.T.')) },
        @{ n = @(0, -1, 0); r = @(1, 0, 0); p = $verts[0]; loop = @(@(0, '.T.'), @(9, '.T.'), @(4, '.F.'), @(8, '.F.')) },
        @{ n = @(0, 1, 0);  r = @(1, 0, 0); p = $verts[2]; loop = @(@(2, '.T.'), @(11, '.T.'), @(6, '.F.'), @(10, '.F.')) },
        @{ n = @(1, 0, 0);  r = @(0, 1, 0); p = $verts[1]; loop = @(@(1, '.T.'), @(10, '.T.'), @(5, '.F.'), @(9, '.F.')) },
        @{ n = @(-1, 0, 0); r = @(0, 1, 0); p = $verts[0]; loop = @(@(3, '.T.'), @(8, '.T.'), @(7, '.F.'), @(11, '.F.')) }
    )
    $faceIds = for ($fi = 0; $fi -lt $faceDefs.Count; $fi++) {
        $f = $faceDefs[$fi]
        $pt = Add-Point $f.p
        $nd = Add-Direction $f.n
        $rd = Add-Direction $f.r
        $ax = Add-Entity "AXIS2_PLACEMENT_3D('',#$pt,#$nd,#$rd)"
        $pl = Add-Entity "PLANE('',#$ax)"
        $oe = foreach ($le in $f.loop) { Add-Entity "ORIENTED_EDGE('',*,*,#$($ec[$le[0]]),$($le[1]))" }
        $loopRefs = ($oe | ForEach-Object { "#$_" }) -join ','
        $el = Add-Entity "EDGE_LOOP('',($loopRefs))"
        $fb = Add-Entity "FACE_OUTER_BOUND('',#$el,.T.)"
        $bounds = @("#$fb")
        if ($fi -eq 0) { $bounds += @($holeParts | ForEach-Object { "#$($_.bottom)" }) }
        if ($fi -eq 1) { $bounds += @($holeParts | ForEach-Object { "#$($_.top)" }) }
        Add-Entity "ADVANCED_FACE('',($($bounds -join ',')),#$pl,.T.)"
    }
    $faceIds = @($faceIds) + @($holeParts | ForEach-Object { $_.face })
    $faceRefs = ($faceIds | ForEach-Object { "#$_" }) -join ','
    $shell = Add-Entity "CLOSED_SHELL('',($faceRefs))"
    return Add-Entity "MANIFOLD_SOLID_BREP('$name',#$shell)"
}

function Add-Color([int]$solid, [double[]]$rgb) {
    $col = Add-Entity "COLOUR_RGB('',$(F $rgb[0]),$(F $rgb[1]),$(F $rgb[2]))"
    $fasc = Add-Entity "FILL_AREA_STYLE_COLOUR('',#$col)"
    $fas = Add-Entity "FILL_AREA_STYLE('',(#$fasc))"
    $ssfa = Add-Entity "SURFACE_STYLE_FILL_AREA(#$fas)"
    $sss = Add-Entity "SURFACE_SIDE_STYLE('',(#$ssfa))"
    $ssu = Add-Entity "SURFACE_STYLE_USAGE(.BOTH.,#$sss)"
    $psa = Add-Entity "PRESENTATION_STYLE_ASSIGNMENT((#$ssu))"
    $si = Add-Entity "STYLED_ITEM('color',(#$psa),#$solid)"
    $script:styled.Add($si)
}


# Her parca ayri bir urun (serbest sekil) olarak yazilir
function Add-Part([string]$name, [object[]]$boxes) {
    $solids = foreach ($bx in $boxes) {
        $boxHoles = if ($bx.ContainsKey('holes')) { $bx.holes } else { @() }
        $s = Add-BoxSolid $bx.min $bx.max $name $boxHoles
        Add-Color $s $bx.rgb
        $s
    }
    $o = Add-Point @(0, 0, 0)
    $dz = Add-Direction @(0, 0, 1)
    $dx = Add-Direction @(1, 0, 0)
    $ax = Add-Entity "AXIS2_PLACEMENT_3D('',#$o,#$dz,#$dx)"
    $items = (@("#$ax") + @($solids | ForEach-Object { "#$_" })) -join ','
    $absr = Add-Entity "ADVANCED_BREP_SHAPE_REPRESENTATION('',($items),#$($script:ctx))"
    $p = Add-Entity "PRODUCT('$name','$name','',(#$($script:prodCtx)))"
    $null = Add-Entity "PRODUCT_RELATED_PRODUCT_CATEGORY('part',`$,(#$p))"
    $pdf = Add-Entity "PRODUCT_DEFINITION_FORMATION('','',#$p)"
    $pd = Add-Entity "PRODUCT_DEFINITION('design','',#$pdf,#$($script:pdCtx))"
    $pds = Add-Entity "PRODUCT_DEFINITION_SHAPE('','',#$pd)"
    $null = Add-Entity "SHAPE_DEFINITION_REPRESENTATION(#$pds,#$absr)"
}

function B([double[]]$min, [double[]]$max, [double[]]$rgb) { return @{ min = $min; max = $max; rgb = $rgb } }

$green = @(0.12, 0.48, 0.28)
$teal2 = @(0.05, 0.38, 0.42)
$black = @(0.10, 0.10, 0.11)
$metal = @(0.74, 0.75, 0.78)
$gold = @(0.83, 0.68, 0.30)
$blue = @(0.16, 0.24, 0.48)
$tan = @(0.72, 0.60, 0.42)
$teal = @(0.10, 0.55, 0.55)
$red = @(0.85, 0.15, 0.12)
$gray = @(0.35, 0.36, 0.38)
$white = @(0.90, 0.90, 0.88)

# Bir karti STEP dosyasina yazar: baglam ve birimler, parcalar ($parts betigi), stil ve dosya
function Write-Board([string]$file, [string]$title, [scriptblock]$parts) {
    $script:nextId = 0
    $script:lines = New-Object 'System.Collections.Generic.List[string]'
    $script:styled = New-Object 'System.Collections.Generic.List[int]'
    $appCtx = Add-Entity "APPLICATION_CONTEXT('core data for automotive mechanical design processes')"
    $null = Add-Entity "APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#$appCtx)"
    $script:prodCtx = Add-Entity "PRODUCT_CONTEXT('',#$appCtx,'mechanical')"
    $script:pdCtx = Add-Entity "PRODUCT_DEFINITION_CONTEXT('part definition',#$appCtx,'design')"
    $mm = Add-Entity "( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )"
    $rad = Add-Entity "( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT(`$,.RADIAN.) )"
    $sr = Add-Entity "( NAMED_UNIT(*) SI_UNIT(`$,.STERADIAN.) SOLID_ANGLE_UNIT() )"
    $unc = Add-Entity "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#$mm,'distance_accuracy_value','confusion accuracy')"
    $script:ctx = Add-Entity "( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#$unc)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#$mm,#$rad,#$sr)) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )"

    & $parts

    $styledRefs = ($script:styled | ForEach-Object { "#$_" }) -join ','
    $null = Add-Entity "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',($styledRefs),#$($script:ctx))"
    $name = Split-Path -Leaf $file
    $header = @(
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('Ikra Enclosure Engine - $title (basitlestirilmis ornek model)'),'2;1');",
        "FILE_NAME('$name','2026-11-25T00:00:00',('Ikra'),('Ikra'),'tools/make-sample-step.ps1','Ikra','');",
        "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
        'ENDSEC;',
        'DATA;'
    )
    $footer = @('ENDSEC;', 'END-ISO-10303-21;')
    $dir = Split-Path -Parent $file
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $all = $header + $script:lines.ToArray() + $footer
    [IO.File]::WriteAllLines([IO.Path]::GetFullPath($file), $all, (New-Object Text.UTF8Encoding $false))
    Write-Host "Yazildi: $file ($($script:nextId) varlik)"
}

# Yardimci: pin baslik govdesi (pin merkezleri x0..x1 / y0..y1, yarim adim 1.27 pay)
function Header([string]$name, [double]$x0, [double]$x1, [double]$y0, [double]$y1, [double]$zTop, [double]$zBot, [double[]]$rgb) {
    return (B @(($x0 - 1.27), ($y0 - 1.27), $zBot) @(($x1 + 1.27), ($y1 + 1.27), $zTop) $rgb)
}

$boards = [ordered]@{}

# ---------------------------------------------------------------------------
# Ikra ornek kart: X 0..60, Y 0..40, Z 0..1.6 (ust yuzey Z = 1.6), koselerde 4 x M3 montaj deligi (O3,2)
$boards['ornek-kart'] = @{ title = 'ornek PCB montaji'; parts = {
    $pcb = B @(0, 0, 0) @(60, 40, 1.6) $green
    $pcb.holes = @(
        @{ x = 3.5; y = 3.5; r = 1.6 }, @{ x = 56.5; y = 3.5; r = 1.6 },
        @{ x = 3.5; y = 36.5; r = 1.6 }, @{ x = 56.5; y = 36.5; r = 1.6 }
    )
    Add-Part 'ORNEK_KART_PCB' @($pcb)
    Add-Part 'USB_C_Receptacle' @(B @(-1.2, 15.5, 1.6) @(6.3, 24.5, 4.86) $metal)
    Add-Part 'SMA_Edge_Mount' @(B @(55, 16.8, 1.6) @(66, 23.2, 7.95) $gold)
    Add-Part 'CP_Elec_8x10' @(B @(30, 26, 1.6) @(38, 34, 11.6) $blue)
    Add-Part 'TO-252_Regulator' @(B @(15, 4, 1.6) @(21.5, 14, 3.9) $black)
    Add-Part 'QFN-48_7x7_MCU' @(B @(26, 10, 1.6) @(33, 17, 2.5) $black)
    Add-Part 'PinHeader_1x04' @(
        (B @(47, 28, 1.6) @(49.54, 38.16, 10.1) $black),
        (B @(47.95, 28.6, -3.0) @(48.59, 37.6, 1.6) $gold)
    )
    Add-Part 'TerminalBlock_2P_5.08' @(B @(8, 34, 1.6) @(18.16, 41.5, 10.6) $teal)
    Add-Part 'Crystal_HC49' @(B @(36, 4, 1.6) @(47, 8.6, 5.1) $metal)
    Add-Part 'L_Power_6x6' @(B @(15, 20, 1.6) @(21, 26, 6.1) $gray)
    Add-Part 'LED_0603' @(B @(50, 0.3, 1.6) @(51.6, 1.1, 2.2) $red)
    Add-Part 'R_0805_alt' @(B @(10, 30, -0.6) @(12, 31.25, 0) $tan)
} }

# ---------------------------------------------------------------------------
# Arduino UNO R3. Kart, delikler ve bilesen ayak izleri: Arduino resmi CAD (UNO-TH_Rev3e.brd) ve veri sayfasi
# A000066 kart cizimi. Kart 68,58 x 53,34 (sagdaki basamakli kenar dikdortgenlestirildi), kalinlik 1,6 (varsayim).
# Yukseklikler: disi basliklar 8,5 (parca degeri "H8.5"); USB-B 10,9, DC jak 11, soketli DIP-28 7, kristal 3,5,
# (alt yuzdeki lehim uclari pin siralari boyunca 1 mm genis serit olarak modellendi)
# kondansator 5,5, buton 4,3 ve alt yuzde lehim uclari 1,5 YAKLASIK tipik degerlerdir (resmi cizimde yok).
$boards['arduino-uno-r3'] = @{ title = 'Arduino UNO R3'; parts = {
    $t = 1.6
    $pcb = B @(0, 0, 0) @(68.58, 53.34, $t) $teal2
    $pcb.holes = @(
        @{ x = 13.97; y = 2.54; r = 1.6 }, @{ x = 15.24; y = 50.80; r = 1.6 },
        @{ x = 66.04; y = 7.62; r = 1.6 }, @{ x = 66.04; y = 35.56; r = 1.6 }
    )
    Add-Part 'ARDUINO_UNO_R3_PCB' @($pcb)
    Add-Part 'USB_B_Receptacle' @(B @(-6.34, 32.20, $t) @(9.41, 44.00, ($t + 10.9)) $metal)
    Add-Part 'DC_Barrel_Jack_2.1x5.5' @(B @(-1.80, 3.30, $t) @(11.68, 12.29, ($t + 11.0)) $black)
    Add-Part 'PinSocket_1x10_D8-SCL' @((B @(17.53, 49.53, $t) @(42.93, 52.07, ($t + 8.5)) $black), (B @(18.30, 50.30, -1.5) @(42.16, 51.30, 0) $gold))
    Add-Part 'PinSocket_1x08_D0-D7' @((B @(44.45, 49.53, $t) @(64.77, 52.07, ($t + 8.5)) $black), (B @(45.22, 50.30, -1.5) @(64.00, 51.30, 0) $gold))
    Add-Part 'PinSocket_1x08_Power' @((B @(26.67, 1.27, $t) @(46.99, 3.81, ($t + 8.5)) $black), (B @(27.44, 2.04, -1.5) @(46.22, 3.04, 0) $gold))
    Add-Part 'PinSocket_1x06_A0-A5' @((B @(49.53, 1.27, $t) @(64.77, 3.81, ($t + 8.5)) $black), (B @(50.30, 2.04, -1.5) @(64.00, 3.04, 0) $gold))
    Add-Part 'PinHeader_2x03_ICSP' @(B @(62.36, 24.13, $t) @(67.44, 31.75, ($t + 8.5)) $black)
    Add-Part 'ATmega328P_DIP-28_Socket' @(B @(27.81, 13.59, $t) @(64.90, 19.18, ($t + 7.0)) $black)
    Add-Part 'Button_Reset' @(B @(3.25, 47.20, $t) @(9.20, 51.60, ($t + 4.3)) $gray)
    Add-Part 'Crystal_16MHz' @(B @(15.49, 23.88, $t) @(22.35, 28.45, ($t + 3.5)) $metal)
    Add-Part 'CP_Elec_47uF_1' @(B @(15.17, 5.89, $t) @(21.67, 12.39, ($t + 5.5)) $metal)
    Add-Part 'CP_Elec_47uF_2' @(B @(22.28, 5.89, $t) @(28.78, 12.39, ($t + 5.5)) $metal)
} }

# ---------------------------------------------------------------------------
# Raspberry Pi 4 Model B. Resmi mekanik cizim (raspberry-pi-4-mechanical-drawing.pdf): kart 85 x 56 (kose R3
# dikdortgenlestirildi), 4 x O2,7 delik, bilesen merkezleri ve yukseklikler (Z) cizimden; ayak izleri cizimden olcekle
# (yaklasik +-0,3). PCB kalinligi 1,5 YAKLASIK (Pi 5 yan gorunusunden olcek). PoE basligi 8,5, kablosuz kalkan 1,5 ve
# alt yuzde GPIO lehim uclari 1,5 YAKLASIK; alt yuzdeki microSD yuvasi modellenmedi.
$boards['raspberry-pi-4b'] = @{ title = 'Raspberry Pi 4 Model B'; parts = {
    $t = 1.5
    $pcb = B @(0, 0, 0) @(85, 56, $t) $green
    $pcb.holes = @(
        @{ x = 3.5; y = 3.5; r = 1.35 }, @{ x = 61.5; y = 3.5; r = 1.35 },
        @{ x = 3.5; y = 52.5; r = 1.35 }, @{ x = 61.5; y = 52.5; r = 1.35 }
    )
    Add-Part 'RASPBERRY_PI_4B_PCB' @($pcb)
    Add-Part 'PinHeader_2x20_GPIO' @((B @(7.1, 50.0, $t) @(57.9, 55.0, ($t + 8.5)) $black), (B @(7.87, 50.73, -1.5) @(57.13, 54.27, 0) $gold))
    Add-Part 'RJ45_Ethernet' @(B @(66.6, 38.0, $t) @(87.9, 53.5, ($t + 13.5)) $metal)
    Add-Part 'USB_A_Dual_Stack_1' @(B @(70.4, 20.4, $t) @(87.9, 33.6, ($t + 16.0)) $metal)
    Add-Part 'USB_A_Dual_Stack_2' @(B @(70.2, 2.4, $t) @(87.9, 15.5, ($t + 16.0)) $metal)
    Add-Part 'USB_C_Power' @(B @(6.8, -1.3, $t) @(15.4, 6.1, ($t + 3.2)) $metal)
    Add-Part 'Micro_HDMI_0' @(B @(22.35, -1.4, $t) @(29.65, 6.5, ($t + 3.0)) $metal)
    Add-Part 'Micro_HDMI_1' @(B @(35.85, -1.4, $t) @(43.15, 6.5, ($t + 3.0)) $metal)
    Add-Part 'Audio_Jack_3.5mm' @(B @(50.4, -2.5, $t) @(57.4, 12.4, ($t + 6.0)) $black)
    Add-Part 'FFC_CSI_Camera' @(B @(44.75, 0.5, $t) @(48.25, 22.5, ($t + 5.5)) $white)
    Add-Part 'FFC_DSI_Display' @(B @(2.5, 17.0, $t) @(5.5, 39.0, ($t + 5.5)) $white)
    Add-Part 'SoC_BCM2711' @(B @(21.75, 25.0, $t) @(36.75, 40.0, ($t + 2.4)) $metal)
    Add-Part 'PinHeader_2x02_PoE' @(B @(59.1, 43.96, $t) @(63.9, 48.76, ($t + 8.5)) $black)
    Add-Part 'WiFi_Bluetooth_Shield' @(B @(6.6, 36.0, $t) @(17.3, 49.1, ($t + 1.5)) $metal)
} }

# ---------------------------------------------------------------------------
# ESP32-DevKitC V4. Espressif boyut cizimi (esp32_devkitc_v4_dimensions.pdf): kart 48,26 x 27,94, montaj deligi YOK,
# 2 x 19 pin (2,54), sira merkezleri y = 1,30 ve 26,70, pin x 1,29..47,01. Modul ESP32-WROOM-32E 18 x 25,5 x 3,1
# (veri sayfasi), sagdan 6,04 tasar; anten bolgesi modulun son 6,19 mm'si. Mikro-USB ve butonlar cizimden olcekle.
# Kalinlik 1,6, mikro-USB 2,8, butonlar 2,0 ve alttaki baslik govdesi 2,5 + pinler 6 YAKLASIK (pinler asagi bakar).
$boards['esp32-devkitc'] = @{ title = 'ESP32-DevKitC V4'; parts = {
    $t = 1.6
    Add-Part 'ESP32_DEVKITC_V4_PCB' @(B @(0, 0, 0) @(48.26, 27.94, $t) $black)
    Add-Part 'ESP32-WROOM-32E_Shield' @(B @(28.80, 5.0, $t) @(48.11, 23.0, ($t + 3.1)) $metal)
    Add-Part 'ESP32_WiFi_PCB_Antenna' @(B @(48.11, 5.0, $t) @(54.30, 23.0, ($t + 0.8)) $teal2)
    Add-Part 'Micro_USB_B' @(B @(-1.1, 10.1, $t) @(5.7, 18.1, ($t + 2.8)) $metal)
    Add-Part 'Button_EN' @(B @(1.7, 20.4, $t) @(5.9, 23.5, ($t + 2.0)) $gray)
    Add-Part 'Button_BOOT' @(B @(1.7, 4.4, $t) @(5.9, 7.6, ($t + 2.0)) $gray)
    Add-Part 'PinHeader_1x19_J2' @((Header 'J2' 1.29 47.01 1.30 1.30 0 -2.5 $black), (B @(1.0, 1.0, -8.5) @(47.3, 1.6, -2.5) $gold))
    Add-Part 'PinHeader_1x19_J3' @((Header 'J3' 1.29 47.01 26.70 26.70 0 -2.5 $black), (B @(1.0, 26.4, -8.5) @(47.3, 27.0, -2.5) $gold))
} }

# ---------------------------------------------------------------------------
# STM32 Nucleo-64 (MB1136, ornegin NUCLEO-F401RE). ST UM1724 Sekil 5 mekanik olculer: 70 x 82,5 (alttaki 33 mm
# cikinti dikdortgenlestirildi), 3 delik (10,87; 54,57), (59,13; 53,30), (43,89; 2,50) - delik capi verilmemis, O3,2
# YAKLASIK. Arduino disi basliklari ve morpho 2 x 19 erkek pin konumlari olcu zincirlerinden. Mini-USB, butonlar ve
# LQFP64 cizimden olcekle. Kalinlik 1,6, basliklar 8,5, morpho alt pinler 6, mini-USB 4, butonlar 5 YAKLASIK.
$boards['nucleo-64'] = @{ title = 'STM32 Nucleo-64 (MB1136)'; parts = {
    $t = 1.6
    $pcb = B @(0, 0, 0) @(70, 82.5, $t) $white
    $pcb.holes = @(
        @{ x = 10.87; y = 54.57; r = 1.6 }, @{ x = 59.13; y = 53.30; r = 1.6 }, @{ x = 43.89; y = 2.50; r = 1.6 }
    )
    Add-Part 'NUCLEO_64_MB1136_PCB' @($pcb)
    Add-Part 'PinSocket_1x06_CN8' @(Header 'CN8' 10.87 10.87 5.04 17.74 ($t + 8.5) $t $black)
    Add-Part 'PinSocket_1x08_CN6' @(Header 'CN6' 10.87 10.87 22.82 40.60 ($t + 8.5) $t $black)
    Add-Part 'PinSocket_1x08_CN9' @(Header 'CN9' 59.13 59.13 5.04 22.82 ($t + 8.5) $t $black)
    Add-Part 'PinSocket_1x10_CN5' @(Header 'CN5' 59.13 59.13 26.88 49.74 ($t + 8.5) $t $black)
    Add-Part 'PinHeader_2x19_CN7_Morpho' @((Header 'CN7' 3.25 5.79 5.04 50.76 ($t + 8.5) $t $black), (B @(2.9, 4.7, -6.0) @(6.1, 51.1, 0) $gold))
    Add-Part 'PinHeader_2x19_CN10_Morpho' @((Header 'CN10' 64.21 66.75 5.04 50.76 ($t + 8.5) $t $black), (B @(63.9, 4.7, -6.0) @(67.1, 51.1, 0) $gold))
    Add-Part 'Mini_USB_B_STLINK' @(B @(43.1, 73.5, $t) @(50.9, 83.9, ($t + 4.0)) $metal)
    Add-Part 'Button_USER_Blue' @(B @(23.5, 50.1, $t) @(30.0, 56.5, ($t + 5.0)) $blue)
    Add-Part 'Button_RESET_Black' @(B @(40.0, 50.1, $t) @(46.5, 56.5, ($t + 5.0)) $black)
    Add-Part 'STM32F401RE_LQFP64' @(B @(26.5, 18.4, $t) @(38.5, 30.4, ($t + 1.6)) $black)
} }

$targets = if ($Board -eq 'all') { @($boards.Keys) } else { @($Board) }
foreach ($id in $targets) {
    if (-not $boards.Contains($id)) { throw "Bilinmeyen kart: $id (secenekler: $($boards.Keys -join ', '))" }
    $out = Join-Path $OutDir "$id.step"
    Write-Board $out $boards[$id].title $boards[$id].parts
}
