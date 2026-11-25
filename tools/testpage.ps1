<#
.SYNOPSIS
  web/test/ altındaki bir test sayfasını görünmez (headless) Edge'de çalıştırır ve sonucunu JSON olarak verir.
  Node/Python gerektirmez. Sayfa sonucu konsola "IKRA-TEST-RESULT <json>" ve "IKRA-TEST-DONE" olarak yazar.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/testpage.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/testpage.ps1 -Page test/catalog.html -OutFile sonuc.json
  # Çıkış kodu: 0 = tüm testler geçti, 1 = başarısız test var, 2 = zaman aşımı / sonuç yok
#>
param(
    [string]$Page = 'test/catalog.html',
    [int]$Port = 0,
    [int]$TimeoutSec = 120,
    [string]$Root = (Join-Path $PSScriptRoot '..'),
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
if ($Port -eq 0) { $Port = Get-Random -Minimum 8200 -Maximum 8900 }
$edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge bulunamadi.' }

$server = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'tools\serve.ps1'), '-Port', "$Port", '-Root', $Root -PassThru -WindowStyle Hidden
$tmp = Join-Path $env:TEMP ('ikra-testpage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
$errFile = Join-Path $tmp 'edge.err.txt'
$outFileEdge = Join-Path $tmp 'edge.out.txt'
$browser = $null
try {
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        try { $r = Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/web/index.html" -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ok) { throw "Yerel sunucu $Port portunda acilmadi." }

    $url = "http://localhost:$Port/web/$Page"
    $browser = Start-Process -FilePath $edge -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', "--user-data-dir=$tmp\prof", '--enable-logging=stderr', '--v=0', '--window-size=1280,900', $url -RedirectStandardError $errFile -RedirectStandardOutput $outFileEdge -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $done = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $errFile) {
            $txt = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
            if ($txt -and $txt.Contains('IKRA-TEST-DONE')) { $done = $true; break }
        }
    }
    $txt = if (Test-Path $errFile) { Get-Content $errFile -Raw -Encoding UTF8 } else { '' }
    $errors = [regex]::Matches($txt, 'IKRA-TEST-ERROR[^\r\n]*') | ForEach-Object { $_.Value }
    $m = [regex]::Match($txt, 'IKRA-TEST-RESULT (\{.*\})", source:')
    if (-not $done -or -not $m.Success) {
        Write-Output "TEST ZAMAN ASIMI ya da sonuc yok (done=$done)."
        $errors | ForEach-Object { Write-Output $_ }
        ([regex]::Matches($txt, 'CONSOLE[^\r\n]*') | Select-Object -Last 15) | ForEach-Object { Write-Output $_.Value }
        exit 2
    }
    $json = $m.Groups[1].Value
    if ($errors) { $errors | ForEach-Object { Write-Output $_ } }
    if ($OutFile) { [System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutFile), $json, (New-Object System.Text.UTF8Encoding $false)); Write-Output "Sonuc yazildi: $OutFile" }
    $res = $json | ConvertFrom-Json
    Write-Output ("Test: {0}, basarisiz: {1}, kural: {2}" -f $res.total, $res.failed, $res.rules)
    foreach ($f in $res.failures) { Write-Output ("  KALDI: {0} - {1}" -f $f.name, $f.detail) }
    if ($res.failed -gt 0) { exit 1 }
}
finally {
    if ($browser -and -not $browser.HasExited) { try { Stop-Process -Id $browser.Id -Force } catch {} }
    Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$tmp*" } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    try { Stop-Process -Id $server.Id -Force } catch {}
    Start-Sleep -Milliseconds 300
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
