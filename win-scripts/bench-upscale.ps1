#Requires -Version 5.1
<#
.SYNOPSIS
  Times realesrgan-ncnn-vulkan across tile sizes and load:proc:save thread layouts on THIS
  GPU/driver, using the same models directory the worker uses.
.EXAMPLE
  .\dev.ps1 bench -Image fixtures\generated\images\<file>.png -Gpu 1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Image,
    [int] $Gpu = 0,
    [string] $Model = 'realesrgan-x4plus',
    [int] $Scale = 4,
    [int[]] $Tiles = @(0, 128, 192, 256, 384, 512),
    [string[]] $Threads = @('1:2:2', '2:2:2', '2:4:4'),
    [int] $Repeats = 2
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Engine = Join-Path $Root '.tools\realesrgan-v0.2.5.0'
$Exe    = Join-Path $Engine 'realesrgan-ncnn-vulkan.exe'
if (-not (Test-Path $Exe))   { throw 'Real-ESRGAN missing. Run .\dev.ps1 worker-gpu-setup' }
if (-not (Test-Path $Image)) { throw "Image not found: $Image" }
$Image = (Resolve-Path $Image).Path
$out = Join-Path ([IO.Path]::GetTempPath()) 'ps-bench-out.png'
$ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns native stderr into errors otherwise

function Invoke-Engine([int] $Tile, [string] $J) {
    Remove-Item $out -ErrorAction SilentlyContinue
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $Exe -i $Image -o $out -s $Scale -n $Model -m (Join-Path $Engine 'models') -t $Tile -g $Gpu -j $J -f png *> $null
    $sw.Stop()
    [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0 -and (Test-Path $out)); Seconds = $sw.Elapsed.TotalSeconds }
}

Write-Host 'Warm-up (shader/driver caches)...'
$null = Invoke-Engine 256 '1:2:2'

$results = foreach ($j in $Threads) { foreach ($t in $Tiles) {
    $runs = 1..$Repeats | ForEach-Object { Invoke-Engine $t $j }
    $ok = -not ($runs | Where-Object { -not $_.Ok })
    [pscustomobject]@{
        Model = $Model; Scale = $Scale; Tile = $t; Threads = $j
        Seconds = $(if ($ok) { [math]::Round(($runs.Seconds | Measure-Object -Minimum).Minimum, 2) } else { $null })
        Status  = $(if ($ok) { 'ok' } else { 'FAILED (VRAM/driver?)' })
    }
} }
$results | Sort-Object { if ($null -eq $_.Seconds) { [double]::MaxValue } else { $_.Seconds } } | Format-Table -AutoSize
$best = $results | Where-Object { $null -ne $_.Seconds } | Sort-Object Seconds | Select-Object -First 1
if ($best) {
    Write-Host "Fastest: tile=$($best.Tile) threads=$($best.Threads) -> $($best.Seconds)s (best of $Repeats)"
    Write-Host "To use it, add to .env.windows:`n  PRINTSHEET_REALESRGAN_TILE_SIZE=$($best.Tile)`n  PRINTSHEET_REALESRGAN_GPU_THREADS=$($best.Threads)"
}
Write-Host 'Benchmark on AC power, one image per run set. Compare outputs visually if you change model or scale.'
Remove-Item $out -ErrorAction SilentlyContinue
