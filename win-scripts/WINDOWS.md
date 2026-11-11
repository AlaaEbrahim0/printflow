# Running PrintFlow / PrintSheet Workbench on Windows

Run everything **natively** on Windows. Docker cannot use the GPU, and bind mounts from
NTFS into Linux containers are slow for large PNGs. Compose still works for the CPU-only
stack (`.\dev.ps1 up`); the native GPU worker (port 8001) can run alongside it.

## One-time setup

```powershell
winget install Microsoft.DotNet.SDK.10 OpenJS.NodeJS Python.Python.3.12 Git.Git
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned     # allow local scripts
.\dev.ps1 doctor            # toolchain, Vulkan devices, GPU clocks, power plan
.\dev.ps1 setup
.\dev.ps1 worker-gpu-setup  # checksum-pinned Real-ESRGAN v0.2.5.0 -> .tools\
.\dev.ps1 gpu-prefer        # hybrid laptops: force the NVIDIA GPU for the engine
```

## Run

```powershell
.\dev.ps1 stack      # api :8080, GPU worker :8001, packer, web :5173 (4 windows)
.\dev.ps1 e2e        # optional fixture flow
```

Overrides go in `.env.windows` (git-ignored), e.g.:

```ini
PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX=1   # only if auto-detection picks wrong
PRINTSHEET_REALESRGAN_TILE_SIZE=256
PRINTSHEET_REALESRGAN_GPU_THREADS=2:2:2    # ncnn load:proc:save
```

## Windows-specific fixes in this change

- `worker/app/storage.py`: `_sync_file` opened the temp file read-only before `os.fsync`.
  Windows rejects that (EBADF), so every atomic write — i.e. every job — would fail.
  Now opens `r+b`; behaviour on Linux is unchanged.
- `dev.ps1` sets `Storage__Root` for the API to the repo's `storage\` (absolute). The API's
  default is the relative path `storage`, which resolves against its working directory and
  can differ from the workers' directory.
- The packer runner refuses an empty worker key; `dev.ps1 packer` supplies `dev-worker-key`.
- New optional worker setting `PRINTSHEET_REALESRGAN_GPU_THREADS` (`-j` for the GPU path;
  previously only the CPU path passed `-j`). Empty = unchanged behaviour. 2 new tests.

## Not verified

Nothing in `*.ps1` has been executed on Windows (no PowerShell where this was written);
run `doctor` first and report anything that fails. Worker tests (197) pass on Linux; some
fixtures use `chmod`-based fake executables and may need adjusting to run natively on Windows.
