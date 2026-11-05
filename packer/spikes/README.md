# Packer spikes

Throwaway measurements that inform packer/export ADRs. These are not imported
by the package and are not run in CI.

| Spike | Question | Result |
| --- | --- | --- |
| [`psd-spike/`](psd-spike/) | Can we write layered PSD/PSB sheets at realistic sizes with psd-tools? | PSD ≤ 30,000 px works; PSB is write-only above that limit, so layered export is a flat file + manifest + `.jsx` rebuild bundle. See [ADR 0003](../../docs/adr/0003-layered-export-format.md). |

Artifacts are written to an `out/` directory (git-ignored) because a single
tall PSB is over 600 MB. The measured JSON lives in `docs/spikes/psd-spike/`.

```bash
cd packer/spikes/psd-spike
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PSD_SPIKE_OUT=/tmp/psd-spike-out .venv/bin/python spike.py
PSD_SPIKE_OUT=/tmp/psd-spike-out .venv/bin/python tall_and_dpi.py
```
