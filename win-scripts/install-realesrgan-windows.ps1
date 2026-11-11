#Requires -Version 5.1
<#
.SYNOPSIS
  Windows counterpart of scripts/install-realesrgan-linux.sh: checksum-verified install of
  Real-ESRGAN ncnn-Vulkan v0.2.5.0 into .tools\realesrgan-v0.2.5.0 (same layout as Linux).
#>
[CmdletBinding()]
param(
    [string] $ArchivePath   # optional: use an already-downloaded archive instead of downloading
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root       = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Version    = 'v0.2.5.0'
$Archive    = 'realesrgan-ncnn-vulkan-20220424-windows.zip'
$Url        = "https://github.com/xinntao/Real-ESRGAN/releases/download/$Version/$Archive"
$Sha256     = 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d'
$LicenseUrl = 'https://raw.githubusercontent.com/xinntao/Real-ESRGAN-ncnn-vulkan/v0.2.0/LICENSE'
$LicenseSha = '5abb941454de437b0e90d78dcb72e3688f74e14bcd4e24393273cb5cd0e9c937'  # same pin as the Linux installer
$Install    = Join-Path $Root ".tools\realesrgan-$Version"

if ((Test-Path (Join-Path $Install 'realesrgan-ncnn-vulkan.exe')) -and
    (Test-Path (Join-Path $Install 'models\realesrgan-x4plus.bin')) -and
    (Test-Path (Join-Path $Install 'models\realesrgan-x4plus-anime.bin'))) {
    Write-Host "Real-ESRGAN $Version is already installed at $Install"; return
}
if (Test-Path $Install) { throw "Refusing to overwrite an incomplete install at $Install (delete it and retry)." }

function Assert-Hash([string] $Path, [string] $Expected) {
    $actual = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) { throw "Checksum mismatch for $(Split-Path $Path -Leaf): expected $Expected, got $actual" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) "ps-realesrgan-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $zip = Join-Path $work $Archive
    $ProgressPreference = 'SilentlyContinue'
    if ($ArchivePath) { Copy-Item $ArchivePath $zip } else { Write-Host "Downloading $Url"; Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing }
    Assert-Hash $zip $Sha256
    $license = Join-Path $work 'LICENSE'
    Invoke-WebRequest -Uri $LicenseUrl -OutFile $license -UseBasicParsing
    Assert-Hash $license $LicenseSha
    $x = Join-Path $work 'x'
    Expand-Archive -Path $zip -DestinationPath $x
    $stage = Join-Path $Root '.tools\.realesrgan-install'
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory -Force $stage | Out-Null
    # The VC++ OpenMP runtimes ship in the archive and must sit next to the exe.
    Copy-Item (Join-Path $x 'realesrgan-ncnn-vulkan.exe'), (Join-Path $x 'vcomp140.dll') $stage
    Copy-Item $license (Join-Path $stage 'LICENSE')
    Copy-Item -Recurse (Join-Path $x 'models') (Join-Path $stage 'models')
    Move-Item $stage $Install
    Write-Host "Installed Real-ESRGAN $Version at $Install"
    Write-Host 'Next: .\dev.ps1 gpu-info ; .\dev.ps1 gpu-prefer ; .\dev.ps1 bench -Image <file>'
} finally { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
