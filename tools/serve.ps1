<#
.SYNOPSIS
  Ikra web arayuzunu yerelde sunan kucuk statik sunucu (Node/Python gerektirmez).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/serve.ps1
  # Ardindan tarayicida: http://localhost:8080/
#>
param(
    [int]$Port = 8080,
    [string]$Root = (Join-Path $PSScriptRoot '..\web')
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path.TrimEnd('\') + '\'

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.wasm' = 'application/wasm'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.step' = 'application/octet-stream'
    '.stp'  = 'application/octet-stream'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Ikra yerel sunucu calisiyor: http://localhost:$Port/  (kok: $Root)"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/')).Replace('/', '\')
            $path = [IO.Path]::GetFullPath((Join-Path $Root $rel))
            if (Test-Path -LiteralPath $path -PathType Container) {
                $path = Join-Path $path 'index.html'
            }

            $inside = $path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)
            if ($inside -and (Test-Path -LiteralPath $path -PathType Leaf)) {
                $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
                $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
                $bytes = [IO.File]::ReadAllBytes($path)
            }
            else {
                $res.StatusCode = 404
                $res.ContentType = 'text/plain; charset=utf-8'
                $bytes = [Text.Encoding]::UTF8.GetBytes('404 - bulunamadi')
            }

            $res.Headers.Add('Cache-Control', 'no-store')
            $res.ContentLength64 = $bytes.Length
            if ($req.HttpMethod -ne 'HEAD') {
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            Write-Host ('{0} {1} {2}' -f $res.StatusCode, $req.HttpMethod, $req.Url.AbsolutePath)
        }
        catch {
            Write-Host "Hata: $($_.Exception.Message)"
            try { $res.StatusCode = 500 } catch { }
        }
        finally {
            $res.Close()
        }
    }
}
finally {
    $listener.Stop()
}
