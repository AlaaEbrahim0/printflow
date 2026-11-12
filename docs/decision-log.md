# Decision log

Append-only autonomous decisions.

## 2026-11-12

- Adopted reversible withoutbg spike setup only: use local open weights in Compose worker, mounted under `/data/storage/models/withoutbg`; no cloud API. Revert: remove spike files/memo and delete only spike model directory after explicit data confirmation.
- Kept Phase 1 editor work as main line while spike runs. Revert: none needed; separate files and commits.
