# PrintSheet Web — Phase 1 workbench (Track D)

React 19 + TypeScript + Vite workbench for the review-driven DTF sheet tool.
Phase 1 D builds the whole operator flow — batch intake, honest alpha review,
crop and brush tools, packing preview and export — **against a mock server
derived from the frozen OpenAPI contract**, not the real API. The client
boundary is deliberately thin so Phase 2 can delete the mocks and keep the app.

> The machine proposes, the human approves, nothing is lost. Every screen here
> enforces that: no auto-approval, no silent pointer change, no destructive
> pixel edit, no integrity claim the server did not make.

## Scripts

```bash
npm ci              # install (no legacy-peer-deps flag needed)
npm run dev         # real API: Vite proxies /api and /healthz to VITE_API_PROXY_TARGET
                    # (default http://localhost:8080 — Docker `api`, not a browser URL)
npm run dev:mock    # mock API: Vite in "mock" mode, loads .env.mock (VITE_USE_MOCKS=true)
npm test            # vitest run (jsdom + MSW node server, no network, no browser download)
npm run test:watch
npm run build       # tsc -b && vite build
npm run lint        # oxlint
npm run gen:api     # regenerate src/api/schema.d.ts from ../contracts/openapi/printsheet-api.yaml
```

`npm run dev` and `npm run dev:mock` are the only difference in how the app is
served: with mocks on, MSW's service worker intercepts `/api/v1/*` in the
browser and never touches the proxy. The plain `dev` script keeps the Phase 0
proxy behaviour so the same build can point at the real API.

`gen:api` runs `openapi-typescript` from the isolated tool package in
`tools/apigen/` (its own `package.json` + lockfile, TypeScript 5 pinned).
`openapi-typescript` declares `typescript@^5.x` as a peer and crashes on the
`ts.factory` API that TypeScript 7 removed, so the generator cannot live in the
app's own dependency tree. `src/api/schema.d.ts` is committed, so **builds,
tests and lints never need the contract file or the tool install** — only
regeneration does.

## Routes

| Path | Screen | What it does |
| --- | --- | --- |
| `/` | Batch list | Cards with name, design/ready counts, status, geometry, sheet height; create-batch dialog (name, roll width cm, margin mm, edge margin mm, working DPI) prefilled from settings. |
| `/batches/:batchId` | Batch detail | Design grid with checkerboard thumbnails, status chips, target size + px, effective-DPI warnings, include/exclude, upload with client-side validation and progress, and a `Pack sheet` action that is disabled until every non-excluded design is `ready`. |
| `/batches/:batchId/designs/:designId` | Design review | Honest alpha preview with checkerboard/white/black/garment-colour backgrounds, target cm↔px with DPI thresholds from settings, version history (newest first, parent links, select-to-preview), approve / reject (+reason and next actions) / revert / undo, and step dialogs for trim, crop, background removal, upscale, vectorize and resize with live job polling. |
| `/batches/:batchId/sheet` | Packing preview | Fitted sheet canvas with zoom, checkerboard/solid backgrounds, drag (0.1 cm snap) and 90° rotate, live sheet height + cost + collision highlighting, placements PUT that marks the sheet `unchecked`, integrity report with the four blocking check IDs, and the export dialog with format availability. |
| `/settings` | Settings | Working DPI, default roll width/margins, DPI warning thresholds, price per cm + currency, packer defaults. Batch geometry is snapshotted, so changing defaults never rewrites existing batches. |

## Architecture

```text
src/
  api/
    schema.d.ts        generated from the frozen OpenAPI contract (committed)
    client.ts          typed endpoints, base /api/v1, relative URLs only,
                       JSON + multipart(XHR with progress), abortable
    problem.ts         ProblemDetails → ApiError with a stable `code` and
                       operator-readable copy for all 18 documented codes
  lib/                 pure functions, no React, no DOM
    units.ts           the only cm↔px math (round-half-away-from-zero),
                       effective DPI, DPI warning levels, 0.1 cm snapping
    crop.ts            crop rectangle geometry (clamps, 8 handles, zoom-independent output)
    brush.ts           stroke capture → contract `brushOps`
    sheet.ts           rotation normalisation, footprint swap, clamping,
                       collisions, cost, export gating
    preview.ts         preview background model + checkerboard CSS
    upload.ts          client-side intake validation
    format.ts          dates, money, cm/px, step and status labels
    defaults.ts        settings defaults shared with the mock
  hooks/useAsync.ts    fetch/abort/reload and job polling (`useJobPoller`)
  state/               settings context (loaded once, refreshed on save)
  components/
    ui/                chip, banner, dialog, fields, states (plain CSS)
    preview/           AlphaPreview + BackgroundPicker (shared, honest alpha)
    crop/, brush/      the two canvas tools
    review/, batch/, sheet/  screen components
  routes/              one file per route
  mocks/               MSW handlers + in-memory state machine
```

Nothing in `src/lib`, `src/api` or `src/components` imports from `src/mocks`:
the app talks to `api.*` and `ApiError` only, so deleting the mock layer is a
one-line change in `main.tsx`.

## The mock API

`src/mocks/store.ts` is an in-memory implementation of the domain model, and
`src/mocks/handlers.ts` maps every OpenAPI path onto it. State is real, not
scripted: approving moves the current pointer, reverting expires a proposal,
packing needs every non-excluded design ready, a manual placement edit bumps the
revision and clears the integrity report, and export refuses a sheet that is
stale, unchecked or failed.

Seeded content (five batches, eight designs in the first one):

| Batch | Status | Purpose |
| --- | --- | --- |
| ACME summer drop 01 | `collecting` | 8 designs covering every state: a transparent sticker with a real white fringe and one **pending proposal**, a full-bleed collage (auto-trim must refuse), a tall banner (`ready`), a 62 cm over-wide lockup, an 80-DPI signature (`needs-better-source`), an `excluded` proof, an untouched logo and a `ready` misty art piece. |
| Riverside run club | `ready-to-pack` | packs successfully → `unchecked` sheet → integrity → `packed` → export → `exported` |
| Northgate cafe merch | `exported` | sheet + passing report + a succeeded export with downloadable artifacts |
| Marathon expo back print | `ready-to-pack` | all ready but over-wide, so packing returns 422 `design-exceeds-roll` |
| Empty intake queue | `collecting` | the zero-design empty state |

Images are self-contained inline SVGs split into a background layer and an
artwork layer, so the mock can serve three honest variants of the same design:
`with-bg` (what the customer sent), `transparent` (after background removal,
with the semi-transparent halo intact so fringes show against dark garments) and
`mask` (white-on-black coverage). A crop or trim result is the same artwork
served with a `viewBox` window, which is why the crop preview really shows the
cropped region.

Intentionally mocked, and what the real services will do instead:

| Behaviour | Mock | Real system |
| --- | --- | --- |
| Job execution | `setTimeout` (~0.9 s in `dev:mock`, synchronous in tests) | worker claims jobs over the internal queue |
| Trim/upscale/vectorize output | geometry metadata changes; pixels are representative | worker image pipeline (Real-ESRGAN, potrace…) |
| Background removal | mode/brush ops recorded on the version, mask artifact served | rembg/BiRefNet + colour-to-alpha + mask reuse |
| Packing | deterministic shelf packing, never rotates, honours margin and edge margin | packer mask nesting with randomized orderings |
| Integrity `pixel-equality` | always passes with an explanatory message | packer renders strips and compares bytes |
| Layered PSB | always refused (422), matching ADR 0003 | refused until a strip writer is validated |
| Export artifacts | small SVG/JSON/JSX bodies, real downloads | strip-rendered PNG/TIFF/PSD bundle |
| Classifier | deterministic per-asset suggestions with reasons | worker classifier |

## Contract gaps found while building (nothing here was edited)

1. `VersionArtifacts.maskUrl` / `svgUrl` exist in the schema but the frozen API
   has **no endpoint** that serves them. The mock adds
   `GET /api/v1/designs/{id}/versions/{v}/mask` and `/svg`; real APIs must add
   them or drop the fields.
2. `DesignVersion` has no `rejectionReason` or `jobId` (the domain model has
   both), so a rejected proposal's reason is not visible to the UI through the
   contract.
3. There is no **undo** endpoint. Undo is sugar for reverting to the current
   version's `parentId`, which the UI derives locally.
4. `PackSheetRequest.noInterlocking`, `UpscaleStepRequest.gpu`,
   `VectorizeStepRequest.mode` and `ExportRequest.includePreview` have schema
   defaults, which `openapi-typescript` renders as **required**; the client
   fills them so callers never send partial bodies.
5. `Export` records a `sheetRevision` but no `sheetId`, and the enum has no
   `preview` format even though `ARCHITECTURE.md` §10 lists one.
6. `ManualPlacement` omits width/height (good: no resampling fields), which
   means the UI must know the rotated footprint from the version geometry.
7. Nothing in the API marks *why* a sheet is stale, so the UI can only report
   the flag, not the cause.

## Testing

```bash
npm test               # unit + component + mock-state tests
```

Coverage: cm↔px conversion and DPI thresholds; `ProblemDetails` → `ApiError`
mapping (all 18 codes plus unknown codes and non-JSON bodies); the full version
state machine in the mock store (approve, reject, revert, undo, stale proposal,
proposal-in-flight, readiness); pack/integrity/export gating including
`design-exceeds-roll` and `stale-revision`; preview background switching that
proves the image source never changes; crop geometry (clamps, all eight handles,
zoom-independent integer output); brush stroke → `brushOps` conversion and undo;
rotation normalisation and placement clamping; the shell routes; and each
screen's own interactions.

Two documented environment limits, handled in `src/test/setup.ts` rather than
worked around in production code:

- jsdom's `fetch`/XHR cannot carry a `multipart/form-data` body built from
  jsdom `File` objects through Node's undici, so upload tests assert the
  **client-side** rejections (type, size) that fire before any byte leaves the
  browser; the multipart handler itself is exercised through the store and in
  `npm run dev:mock`.
- jsdom has no canvas backend, so `getContext('2d')` is stubbed with a no-op
  context. Crop and brush geometry are pure functions tested directly; the
  components are tested through inputs, keyboard and DOM state.

## UX rules this app must not break

- Checkerboard is the default preview background; a solid colour is always an
  explicit choice, and switching backgrounds never rewrites a file.
- No action is reported as successful unless the API returned it; `ApiError.code`
  is shown alongside the human sentence.
- Rotations are only ever 0/90/180/270. Nothing in this app resamples, recolours
  or crops a design; the packer preview scales by CSS only.
- The sheet never claims integrity passed while `unchecked` or `stale`, and a
  `skipped` check counts as not passed.
- Batch status, design status and sheet state always come from the latest API
  response, never from local cache.

## Phase 2 handover

Delete `src/mocks` and the `VITE_USE_MOCKS` branch in `main.tsx`, set
`VITE_API_PROXY_TARGET` (or serve the built app behind the API), and add the
missing mask/SVG download endpoints. No component, hook or lib module imports the
mock layer.
