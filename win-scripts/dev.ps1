#Requires -Version 5.1
<#
.SYNOPSIS
  Windows task runner for PrintSheet Workbench (the Makefile and scripts/*.sh need bash).
  Run `.\dev.ps1 help`. Optional overrides go in `.env.windows` (git-ignored KEY=VALUE lines).
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)] [string] $Task = 'help',
    [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root      = $PSScriptRoot
$EngineDir = Join-Path $Root '.tools\realesrgan-v0.2.5.0'
$EngineExe = Join-Path $EngineDir 'realesrgan-ncnn-vulkan.exe'

# ----------------------------------------------------------------- helpers --

function Exec {
    param([string] $File, [string[]] $ArgList = @(), [string] $Dir = $Root)
    Push-Location $Dir
    try {
        & $File @ArgList
        if ($LASTEXITCODE -ne 0) { throw "'$File $($ArgList -join ' ')' exited with code $LASTEXITCODE" }
    } finally { Pop-Location }
}

function Test-Tool([string] $Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Invoke-ChildScript([string] $Script, [string[]] $ScriptArgs) {
    # A child process keeps `-Name value` pairs as real named parameters (array splatting would not).
    $shell = if (Test-Tool 'pwsh') { 'pwsh' } else { 'powershell' }
    & $shell -NoProfile -ExecutionPolicy Bypass -File $Script @ScriptArgs
    if ($LASTEXITCODE -ne 0) { throw "$Script failed with exit code $LASTEXITCODE" }
}

function Get-Python312 {
    # 3.12 matches the worker image; VTracer segfaults on 3.14 (AGENTS.md).
    if (Test-Tool 'py') {
        $exe = & py -3.12 -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
    }
    throw 'Python 3.12 not found. Install it: winget install Python.Python.3.12'
}

function Initialize-Venv {
    param([string] $Dir, [string[]] $PipArgs, [string] $DepFile)
    $venv = Join-Path $Dir '.venv'; $stamp = Join-Path $venv '.installed'
    $dep  = Join-Path $Dir $DepFile
    if ((Test-Path $stamp) -and ((Get-Item $stamp).LastWriteTime -gt (Get-Item $dep).LastWriteTime)) { return }
    if (-not (Test-Path $venv)) { Exec (Get-Python312) @('-m', 'venv', '.venv') $Dir }
    $vpy = Join-Path $venv 'Scripts\python.exe'
    Exec $vpy @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip') $Dir
    Exec $vpy (@('-m', 'pip', 'install', '--quiet') + $PipArgs) $Dir
    New-Item -ItemType File -Force $stamp | Out-Null
    (Get-Item $stamp).LastWriteTime = Get-Date
}

function Initialize-ContractsVenv {
    $venv = Join-Path $Root '.venv-contracts'; $stamp = Join-Path $venv '.installed'
    $dep  = Join-Path $Root 'scripts\requirements-dev.txt'
    if ((Test-Path $stamp) -and ((Get-Item $stamp).LastWriteTime -gt (Get-Item $dep).LastWriteTime)) { return }
    if (-not (Test-Path $venv)) { Exec (Get-Python312) @('-m', 'venv', '.venv-contracts') }
    $vpy = Join-Path $venv 'Scripts\python.exe'
    Exec $vpy @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip')
    Exec $vpy @('-m', 'pip', 'install', '--quiet', '-r', 'scripts/requirements-dev.txt')
    New-Item -ItemType File -Force $stamp | Out-Null
    (Get-Item $stamp).LastWriteTime = Get-Date
}

function Import-DotEnv {
    $file = Join-Path $Root '.env.windows'
    if (-not (Test-Path $file)) { return }
    foreach ($line in Get-Content $file) {
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { Set-Item "Env:$($Matches[1])" $Matches[2].Trim('"', "'") }
    }
}

function Set-DefaultEnv([string] $Name, [string] $Value) {
    if (-not [Environment]::GetEnvironmentVariable($Name)) { Set-Item "Env:$Name" $Value }
}

function Get-VulkanDevices {
    # Best effort: ncnn prints "[index name] ..." for each Vulkan device at start-up.
    if (-not (Test-Path $EngineExe)) { return @() }
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $tmp = [IO.Path]::GetTempPath()
        $text = (& $EngineExe -i (Join-Path $tmp 'ps-no-such-input.png') -o (Join-Path $tmp 'ps-no-such-output.png') 2>&1 | Out-String)
    } finally { $ErrorActionPreference = $old }
    @([regex]::Matches($text, '(?m)^\[(\d+)\s+([^\]]+)\]') | ForEach-Object {
        [pscustomobject]@{ Index = [int]$_.Groups[1].Value; Name = $_.Groups[2].Value.Trim() }
    })
}

function Show-GpuState {
    if (Test-Tool 'nvidia-smi') {
        & nvidia-smi --query-gpu=index,name,pstate,clocks.sm,clocks.max.sm,power.draw,memory.used,memory.total --format=csv
    } else { Write-Warning 'nvidia-smi not found (install/update the NVIDIA driver).' }
    Write-Host "`nVulkan devices (use the NVIDIA index for PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX):"
    $d = Get-VulkanDevices
    if ($d.Count) { $d | Format-Table -AutoSize } else { Write-Host '  (unavailable - run worker-gpu-setup first, or use vulkaninfo)' }
    Write-Host 'Active power scheme:'; & powercfg /getactivescheme
    $onBattery = (Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Where-Object { $_.BatteryStatus -eq 1 })
    if ($onBattery) { Write-Warning 'Running on BATTERY: your own measurements show a 2.6x slowdown. Plug in AC.' }
}

function Start-Worker {
    param([switch] $Gpu)
    Initialize-Venv (Join-Path $Root 'worker') @('-e', '.[dev]') 'pyproject.toml'
    Import-DotEnv
    Set-DefaultEnv 'PRINTSHEET_API_BASE_URL' 'http://localhost:8080'
    Set-DefaultEnv 'PRINTSHEET_STORAGE_ROOT' (Join-Path $Root 'storage')
    Set-DefaultEnv 'PRINTSHEET_WORKER_KEY'   'dev-worker-key'
    Set-DefaultEnv 'PRINTSHEET_RUN_JOBS'     'true'
    if ($Gpu) {
        if (-not (Test-Path $EngineExe)) { throw 'Real-ESRGAN not installed. Run: .\dev.ps1 worker-gpu-setup' }
        $env:PRINTSHEET_GPU_ENABLED = 'true'
        Set-DefaultEnv 'PRINTSHEET_WORKER_ID'    'worker-native-gpu'
        Set-DefaultEnv 'PRINTSHEET_CAPABILITIES' 'gpu'
        Set-DefaultEnv 'PRINTSHEET_LOG_JSON'     'true'
        Set-DefaultEnv 'PRINTSHEET_REALESRGAN_BINARY'    $EngineExe
        Set-DefaultEnv 'PRINTSHEET_REALESRGAN_MODEL_DIR' (Join-Path $EngineDir 'models')
        Set-DefaultEnv 'WORKER_PORT' '8001'
        if (-not $env:PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX) {
            $nv = Get-VulkanDevices | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
            if ($nv) { $env:PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX = "$($nv.Index)"; Write-Host "Using Vulkan device $($nv.Index): $($nv.Name)" }
            else { Write-Warning 'Could not detect an NVIDIA Vulkan device; defaulting to 0 (may be the slow Intel iGPU). Set PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX in .env.windows.' }
        }
    } else {
        Set-DefaultEnv 'PRINTSHEET_WORKER_ID'   'worker-native'
        Set-DefaultEnv 'PRINTSHEET_GPU_ENABLED' 'false'
    }
    Set-DefaultEnv 'WORKER_PORT' '8000'
    New-Item -ItemType Directory -Force $env:PRINTSHEET_STORAGE_ROOT | Out-Null
    $vpy = Join-Path $Root 'worker\.venv\Scripts\python.exe'
    Exec $vpy @('-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', $env:WORKER_PORT) (Join-Path $Root 'worker')
}

function Set-GpuPreference {
    # Same effect as Settings > System > Display > Graphics > High performance, for the engine exe.
    $key = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
    if (-not (Test-Path $EngineExe)) { throw 'Install the engine first: .\dev.ps1 worker-gpu-setup' }
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name (Resolve-Path $EngineExe).Path -Value 'GpuPreference=2;' -Type String
    Write-Host "High-performance GPU preference set for $EngineExe"
}

function Invoke-Doctor {
    function Row($n, $ok, $d) { [pscustomobject]@{ Check = $n; Status = $(if ($ok) { 'OK' } else { 'MISSING' }); Detail = $d } }
    $rows = @()
    $rows += Row 'git' (Test-Tool 'git') ''
    $dn = if (Test-Tool 'dotnet') { (& dotnet --version) } else { 'winget install Microsoft.DotNet.SDK.10' }
    $rows += Row '.NET SDK 10' ((Test-Tool 'dotnet') -and $dn -match '^10\.') $dn
    $nd = if (Test-Tool 'node') { (& node --version) } else { 'winget install OpenJS.NodeJS' }
    $rows += Row 'Node 24+' ((Test-Tool 'node') -and $nd -match '^v(2[4-9]|[3-9]\d)') $nd
    $py = $null; try { $py = Get-Python312 } catch { }
    $rows += Row 'Python 3.12' ([bool]$py) $(if ($py) { $py } else { 'winget install Python.Python.3.12' })
    $rows += Row 'docker (optional)' (Test-Tool 'docker') 'Only for the Compose CPU stack'
    $rows += Row 'Real-ESRGAN' (Test-Path $EngineExe) $(if (Test-Path $EngineExe) { $EngineExe } else { '.\dev.ps1 worker-gpu-setup' })
    $rows | Format-Table -AutoSize
    Show-GpuState
}

$Tasks = [ordered]@{
    'doctor'           = 'Check toolchain, GPU/Vulkan state, power plan'
    'setup'            = 'Restore NuGet, create venvs, npm ci'
    'worker-gpu-setup' = 'Install the pinned Real-ESRGAN Windows build into .tools'
    'stack'            = 'Native: open api + worker-gpu + packer + web in separate windows'
    'api'              = 'Run API natively on :8080 (SQLite)'
    'worker'           = 'Run CPU worker natively on :8000'
    'worker-gpu'       = 'Run GPU worker natively on :8001'
    'packer'           = 'Run the packer job runner'
    'web'              = 'Run the Vite dev server on :5173'
    'gpu-info'         = 'Vulkan devices, GPU clocks, power scheme'
    'gpu-prefer'       = 'Force high-performance GPU for the engine (hybrid-graphics laptops)'
    'bench'            = 'Benchmark tile/thread settings: .\dev.ps1 bench -Image x.png'
    'up'               = 'Docker Compose build/start/wait + smoke test (CPU worker only)'
    'down'             = 'Compose down (keep volumes)'
    'reset'            = 'Compose down -v (DELETES database volume)'
    'logs'             = 'Follow Compose logs'
    'smoke'            = 'Smoke-test a running stack'
    'test'             = 'All gates'
    'test-api'         = 'dotnet test'
    'test-worker'      = 'worker pytest'
    'test-packer'      = 'packer pytest'
    'test-web'         = 'web build + lint'
    'test-contracts'   = 'Validate schemas/examples/OpenAPI'
    'fixtures'         = 'Regenerate fixtures'
    'e2e'              = 'Fixture flow against a running stack'
    'clean'            = 'Remove build artefacts and generated fixtures'
}

# ------------------------------------------------------------------- tasks --

switch ($Task) {
    'help' { "PrintSheet Workbench (Windows)`n`nUsage: .\dev.ps1 <task>`n"; $Tasks.GetEnumerator() | ForEach-Object { '  {0,-17} {1}' -f $_.Key, $_.Value } }
    'doctor' { Invoke-Doctor }
    'setup' {
        Exec 'dotnet' @('restore', 'PrintSheet.slnx') (Join-Path $Root 'api')
        Initialize-Venv (Join-Path $Root 'worker') @('-e', '.[dev]') 'pyproject.toml'
        Initialize-Venv (Join-Path $Root 'packer') @('-e', '.[dev]') 'pyproject.toml'
        Initialize-ContractsVenv
        if (-not (Test-Path (Join-Path $Root 'web\node_modules'))) { Exec 'npm' @('ci') (Join-Path $Root 'web') }
    }
    'worker-gpu-setup' { Invoke-ChildScript (Join-Path $Root 'scripts\windows\install-realesrgan-windows.ps1') $Rest }
    'api' {
        Import-DotEnv
        # Absolute so the API and the workers always share ONE storage directory.
        Set-DefaultEnv 'Storage__Root' (Join-Path $Root 'storage')
        Set-DefaultEnv 'Worker__Key' 'dev-worker-key'
        New-Item -ItemType Directory -Force $env:Storage__Root | Out-Null
        Exec 'dotnet' @('run', '--project', 'src/PrintSheet.Api', '--launch-profile', 'http') (Join-Path $Root 'api')
    }
    'worker'     { Start-Worker }
    'worker-gpu' { Start-Worker -Gpu }
    'packer' {
        Initialize-Venv (Join-Path $Root 'packer') @('-e', '.[dev]') 'pyproject.toml'
        Import-DotEnv
        Set-DefaultEnv 'PRINTSHEET_PACKER_API_BASE_URL' 'http://localhost:8080'
        Set-DefaultEnv 'PRINTSHEET_PACKER_WORKER_KEY'   'dev-worker-key'   # runner refuses an empty key
        Set-DefaultEnv 'PRINTSHEET_STORAGE_ROOT'        (Join-Path $Root 'storage')
        Exec (Join-Path $Root 'packer\.venv\Scripts\printsheet-packer-runner.exe') @() (Join-Path $Root 'packer')
    }
    'web' {
        Import-DotEnv
        Set-DefaultEnv 'VITE_API_PROXY_TARGET' 'http://localhost:8080'
        Set-DefaultEnv 'WEB_PORT' '5173'
        if (-not (Test-Path (Join-Path $Root 'web\node_modules'))) { Exec 'npm' @('ci') (Join-Path $Root 'web') }
        Exec 'npm' @('run', 'dev', '--', '--host', '0.0.0.0', '--port', $env:WEB_PORT) (Join-Path $Root 'web')
    }
    'stack' {
        $shell = if (Test-Tool 'pwsh') { 'pwsh' } else { 'powershell' }
        foreach ($t in 'api', 'worker-gpu', 'packer', 'web') {
            Start-Process $shell -ArgumentList '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", $t
            Start-Sleep -Seconds 3
        }
        Write-Host 'Started. Web: http://localhost:5173  (allow the Windows Firewall prompts for private networks)'
    }
    'gpu-info'   { Show-GpuState }
    'gpu-prefer' { Set-GpuPreference; Write-Host 'Restart the GPU worker for it to take effect.' }
    'bench'      { Invoke-ChildScript (Join-Path $Root 'scripts\windows\bench-upscale.ps1') $Rest }
    'up'     { Exec 'docker' @('compose', 'up', '--build', '-d', '--wait', '--wait-timeout', '240'); Exec (Get-Python312) @('scripts/smoke_test.py') }
    'down'   { Exec 'docker' @('compose', 'down') }
    'reset'  { if ((Read-Host 'Deletes the Compose database/storage volumes. Type YES to continue') -eq 'YES') { Exec 'docker' @('compose', 'down', '-v') } }
    'logs'   { Exec 'docker' @('compose', 'logs', '-f', '--tail=100') }
    'smoke'  { Exec (Get-Python312) @('scripts/smoke_test.py') }
    'test-api'       { Exec 'dotnet' @('test', 'PrintSheet.slnx') (Join-Path $Root 'api') }
    'test-worker'    { Initialize-Venv (Join-Path $Root 'worker') @('-e', '.[dev]') 'pyproject.toml'; Exec (Join-Path $Root 'worker\.venv\Scripts\python.exe') @('-m', 'pytest') (Join-Path $Root 'worker') }
    'test-packer'    { Initialize-Venv (Join-Path $Root 'packer') @('-e', '.[dev]') 'pyproject.toml'; Exec (Join-Path $Root 'packer\.venv\Scripts\python.exe') @('-m', 'pytest') (Join-Path $Root 'packer') }
    'test-web'       { if (-not (Test-Path (Join-Path $Root 'web\node_modules'))) { Exec 'npm' @('ci') (Join-Path $Root 'web') }; Exec 'npm' @('run', 'build') (Join-Path $Root 'web'); Exec 'npm' @('run', 'lint') (Join-Path $Root 'web') }
    'test-contracts' { Initialize-ContractsVenv; Exec (Join-Path $Root '.venv-contracts\Scripts\python.exe') @('scripts/validate_contracts.py') }
    'test'           { foreach ($t in 'test-contracts', 'test-api', 'test-worker', 'test-packer', 'test-web') { & $PSCommandPath $t; if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "$t failed" } } }
    'fixtures' {
        Initialize-Venv (Join-Path $Root 'packer') @('-e', '.[dev]') 'pyproject.toml'
        Exec (Join-Path $Root 'packer\.venv\Scripts\python.exe') @('scripts/generate_fixtures.py', '--clean')
    }
    'e2e'   { & $PSCommandPath fixtures; Exec (Get-Python312) @('scripts/e2e_fixture_flow.py') }
    'clean' {
        Exec 'dotnet' @('clean', 'PrintSheet.slnx') (Join-Path $Root 'api')
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Root 'web\dist'), (Join-Path $Root 'fixtures\generated')
    }
    default { throw "Unknown task '$Task'. Run .\dev.ps1 help" }
}
