<#
.SYNOPSIS
  Ikra icin ornek PCB montaji uretir (STEP AP214): 60 x 40 x 1.6 mm kart + kutu
  geometrili bilesenler. Gercek bir ECAD ciktisi yerine gecmez; analiz ve demo icindir.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-sample-step.ps1
#>
param(
    [string]$OutFile = (Join-Path $PSScriptRoot '..\web\samples\ornek-kart.step')
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

# Ortak baglam ve birimler
$appCtx = Add-Entity "APPLICATION_CONTEXT('core data for automotive mechanical design processes')"
$null = Add-Entity "APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#$appCtx)"
$prodCtx = Add-Entity "PRODUCT_CONTEXT('',#$appCtx,'mechanical')"
$pdCtx = Add-Entity "PRODUCT_DEFINITION_CONTEXT('part definition',#$appCtx,'design')"
$mm = Add-Entity "( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )"
$rad = Add-Entity "( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT(`$,.RADIAN.) )"
$sr = Add-Entity "( NAMED_UNIT(*) SI_UNIT(`$,.STERADIAN.) SOLID_ANGLE_UNIT() )"
$unc = Add-Entity "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#$mm,'distance_accuracy_value','confusion accuracy')"
$ctx = Add-Entity "( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#$unc)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#$mm,#$rad,#$sr)) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )"

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
    $absr = Add-Entity "ADVANCED_BREP_SHAPE_REPRESENTATION('',($items),#$ctx)"
    $p = Add-Entity "PRODUCT('$name','$name','',(#$prodCtx))"
    $null = Add-Entity "PRODUCT_RELATED_PRODUCT_CATEGORY('part',`$,(#$p))"
    $pdf = Add-Entity "PRODUCT_DEFINITION_FORMATION('','',#$p)"
    $pd = Add-Entity "PRODUCT_DEFINITION('design','',#$pdf,#$pdCtx)"
    $pds = Add-Entity "PRODUCT_DEFINITION_SHAPE('','',#$pd)"
    $null = Add-Entity "SHAPE_DEFINITION_REPRESENTATION(#$pds,#$absr)"
}

function B([double[]]$min, [double[]]$max, [double[]]$rgb) { return @{ min = $min; max = $max; rgb = $rgb } }

$green = @(0.12, 0.48, 0.28)
$black = @(0.10, 0.10, 0.11)
$metal = @(0.74, 0.75, 0.78)
$gold = @(0.83, 0.68, 0.30)
$blue = @(0.16, 0.24, 0.48)
$tan = @(0.72, 0.60, 0.42)
$teal = @(0.10, 0.55, 0.55)
$red = @(0.85, 0.15, 0.12)
$gray = @(0.35, 0.36, 0.38)

# Kart: X 0..60, Y 0..40, Z 0..1.6 (ust yuzey Z = 1.6), koselerde 4 x M3 montaj deligi (O3,2)
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

$styledRefs = ($script:styled | ForEach-Object { "#$_" }) -join ','
$null = Add-Entity "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',($styledRefs),#$ctx)"

$header = @(
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('Ikra Enclosure Engine - ornek PCB montaji'),'2;1');",
    "FILE_NAME('ornek-kart.step','2026-11-25T00:00:00',('Ikra'),('Ikra'),'tools/make-sample-step.ps1','Ikra','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;'
)
$footer = @('ENDSEC;', 'END-ISO-10303-21;')

$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$all = $header + $script:lines.ToArray() + $footer
[IO.File]::WriteAllLines([IO.Path]::GetFullPath($OutFile), $all, (New-Object Text.UTF8Encoding $false))
Write-Host "Yazildi: $OutFile ($($script:nextId) varlik)"
