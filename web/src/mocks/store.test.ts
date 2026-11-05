import { beforeEach, describe, expect, it } from 'vitest'
import { MockProblem, resetStore, store } from './store'
import type { MockBatchRecord, MockDesignRecord } from './store'

function batchByName(name: string): MockBatchRecord {
  const found = [...store().batches.values()].find((batch) => batch.name === name)
  if (!found) throw new Error(`no seeded batch called ${name}`)
  return found
}

function designByName(batchId: string, name: string): MockDesignRecord {
  const found = [...store().designs.values()].find(
    (design) => design.batchId === batchId && design.name === name,
  )
  if (!found) throw new Error(`no seeded design called ${name}`)
  return found
}

function problem(run: () => unknown): MockProblem {
  try {
    run()
  } catch (error) {
    return error as MockProblem
  }
  throw new Error('expected a MockProblem to be thrown')
}

describe('mock store seeding', () => {
  beforeEach(() => {
    resetStore()
    store().jobDelayMs = 0
  })

  it('derives a batch status per design for every listed batch', () => {
    const statuses = [...store().batches.values()].map((batch) => [batch.name, batch.status])
    expect(statuses).toEqual([
      ['ACME summer drop 01', 'collecting'],
      ['Riverside run club', 'ready-to-pack'],
      ['Northgate cafe merch', 'exported'],
      ['Marathon expo back print', 'ready-to-pack'],
      ['Empty intake queue', 'collecting'],
    ])
  })

  it('seeds varied design statuses, a pending proposal and an exclusion', () => {
    const acme = batchByName('ACME summer drop 01')
    const statuses = Object.fromEntries(
      acme.designIds.map((id) => {
        const design = store().designs.get(id)!
        return [design.name, design.status]
      }),
    )
    expect(statuses).toMatchObject({
      'Round sticker (fringe)': 'in-progress',
      'Full-bleed collage': 'received',
      'Side-seam banner': 'ready',
      'Signature at 80 DPI': 'needs-better-source',
      'Supplier proof (excluded)': 'excluded',
      'APEX logo': 'received',
      'Mist ridge': 'ready',
    })
    const sticker = designByName(acme.id, 'Round sticker (fringe)')
    expect(sticker.pendingVersionId).not.toBeNull()
  })

  it('serves honest alpha variants: the background-removal version carries transparency and a mask', () => {
    const acme = batchByName('ACME summer drop 01')
    const sticker = designByName(acme.id, 'Round sticker (fringe)')
    const current = store().versions.get(sticker.currentVersionId)!
    expect(current.stepType).toBe('background-removal')
    expect(current.hasAlpha).toBe(true)
    expect(current.variant).toBe('transparent')
    const detail = store().designDetail(sticker.id)
    const maskUrl = detail.versions.find((item) => item.id === current.id)?.artifacts?.maskUrl
    expect(maskUrl).toContain('/mask')
  })
})

describe('version approval transitions', () => {
  beforeEach(() => {
    resetStore()
    store().jobDelayMs = 0
  })

  it('approving a proposal moves the current pointer and clears the pending one', () => {
    const acme = batchByName('ACME summer drop 01')
    const sticker = designByName(acme.id, 'Round sticker (fringe)')
    const pendingId = sticker.pendingVersionId!
    const detail = store().approveVersion(sticker.id, pendingId)
    expect(detail.currentVersionId).toBe(pendingId)
    expect(detail.pendingVersion).toBeNull()
    expect(detail.status).toBe('in-progress')
    expect(store().versions.get(pendingId)!.status).toBe('approved')
  })

  it('rejecting keeps the current version and offers the three next actions', () => {
    const acme = batchByName('ACME summer drop 01')
    const sticker = designByName(acme.id, 'Round sticker (fringe)')
    const before = sticker.currentVersionId
    const pendingId = sticker.pendingVersionId!
    const result = store().rejectVersion(sticker.id, pendingId, 'halo too strong')
    expect(result.nextActions).toEqual(['adjust-parameters', 'manual-tool', 'skip'])
    expect(result.design.currentVersionId).toBe(before)
    expect(store().versions.get(pendingId)!.rejectionReason).toBe('halo too strong')
    expect(store().designs.get(sticker.id)!.pendingVersionId).toBeNull()
  })

  it('only a proposed version can be approved or rejected', () => {
    const acme = batchByName('ACME summer drop 01')
    const banner = designByName(acme.id, 'Side-seam banner')
    expect(problem(() => store().approveVersion(banner.id, banner.currentVersionId)).code).toBe(
      'invalid-transition',
    )
    expect(problem(() => store().rejectVersion(banner.id, banner.originalVersionId)).code).toBe(
      'invalid-transition',
    )
  })

  it('a proposal whose parent is no longer current is rejected, never rebased', () => {
    const acme = batchByName('ACME summer drop 01')
    const mist = designByName(acme.id, 'Mist ridge')
    const proposal = store().proposeStep(mist.id, 'upscale', { model: 'realesrgan-x4plus', scale: 2 })
    store().settleJob(proposal.jobId)
    const pendingId = store().designs.get(mist.id)!.pendingVersionId!

    // Move the current pointer away by reverting to the original upload.
    store().revert(mist.id, mist.originalVersionId)

    expect(store().versions.get(pendingId)!.status).toBe('rejected')
    expect(store().versions.get(pendingId)!.rejectionReason).toBe('stale-parent')
    expect(store().designs.get(mist.id)!.pendingVersionId).toBeNull()

    const conflict = problem(() => store().approveVersion(mist.id, pendingId))
    expect(conflict.status).toBe(409)
    expect(conflict.code).toBe('stale-proposal')
  })

  it('revert refuses a rejected target and undo steps back to the parent', () => {
    const acme = batchByName('ACME summer drop 01')
    const sticker = designByName(acme.id, 'Round sticker (fringe)')
    store().rejectVersion(sticker.id, sticker.pendingVersionId!, 'not sharp enough')
    const rejected = store().newestFirst(sticker.id).find((v) => v.status === 'rejected')!
    expect(rejected.stepType).toBe('upscale')
    expect(problem(() => store().revert(sticker.id, rejected.id)).code).toBe('version-not-approved')

    const currentBefore = sticker.currentVersionId
    const parent = store().versions.get(currentBefore)!.parentId!
    const after = store().undo(sticker.id)
    expect(after.currentVersionId).toBe(parent)
    expect(after.status).not.toBe('ready')
  })

  it('reverting away from a matching resize drops the design out of ready', () => {
    const acme = batchByName('ACME summer drop 01')
    const banner = designByName(acme.id, 'Side-seam banner')
    expect(banner.status).toBe('ready')
    const after = store().revert(banner.id, banner.originalVersionId)
    expect(after.status).toBe('received')
    expect(batchByName('ACME summer drop 01').sheet?.stale ?? false).toBe(false)
  })
})

describe('jobs, proposals and step semantics', () => {
  beforeEach(() => {
    resetStore()
    store().jobDelayMs = 0
  })

  it('refuses a second proposal while one is in flight', () => {
    const acme = batchByName('ACME summer drop 01')
    const logo = designByName(acme.id, 'APEX logo')
    store().proposeStep(logo.id, 'trim', { mode: 'auto' })
    store().settleAllJobs()
    const second = problem(() => store().proposeStep(logo.id, 'trim', { mode: 'auto' }))
    expect(second.status).toBe(409)
    expect(second.code).toBe('proposal-in-flight')
  })

  it('auto-trim refuses a full-bleed input instead of cropping artwork', () => {
    const acme = batchByName('ACME summer drop 01')
    const collage = designByName(acme.id, 'Full-bleed collage')
    const job = store().proposeStep(collage.id, 'trim', { mode: 'auto' })
    const settled = store().settleJob(job.jobId)!
    expect(settled.status).toBe('failed')
    expect(settled.error?.code).toBe('nothing-to-trim')
  })

  it('a manual crop through the trim endpoint records a crop version', () => {
    const acme = batchByName('ACME summer drop 01')
    const logo = designByName(acme.id, 'APEX logo')
    const job = store().proposeStep(logo.id, 'trim', {
      mode: 'manual',
      cropRect: { x: 10, y: 20, width: 300, height: 240 },
    })
    store().settleJob(job.jobId)
    const pending = store().designs.get(logo.id)!.pendingVersionId!
    expect(store().versions.get(pending)!.stepType).toBe('crop')
    expect(store().versions.get(pending)!.widthPx).toBe(300)
  })

  it('a worker result whose parent is no longer current is discarded as stale-source', () => {
    // Keep jobs queued so the pointer can move while a job is in flight.
    store().jobDelayMs = 60_000
    const acme = batchByName('ACME summer drop 01')
    const logo = designByName(acme.id, 'APEX logo')
    const first = store().proposeStep(logo.id, 'trim', { mode: 'auto' })
    store().settleJob(first.jobId)
    const trimmed = store().designs.get(logo.id)!.pendingVersionId!
    store().approveVersion(logo.id, trimmed)

    const second = store().proposeStep(logo.id, 'upscale', { model: 'realesrgan-x4plus', scale: 2 })
    // The operator reverts while the upscale job is still in flight.
    store().revert(logo.id, logo.originalVersionId)
    const before = store().designs.get(logo.id)!.versionIds.length

    expect(store().jobs.get(second.jobId)!.status).toBe('queued')
    const settled = store().settleJob(second.jobId)!
    expect(settled.status).toBe('failed')
    expect(settled.error?.code).toBe('stale-source')
    expect(store().designs.get(logo.id)!.versionIds).toHaveLength(before)
    expect(store().designs.get(logo.id)!.pendingVersionId).toBeNull()
  })

  it('resizing to the target and approving it makes the design ready', () => {
    const acme = batchByName('ACME summer drop 01')
    const logo = designByName(acme.id, 'APEX logo')
    store().updateDesign(logo.id, { targetWidthCm: 14, targetHeightCm: 14 })
    const resize = store().proposeStep(logo.id, 'resize', { targetWidthCm: 14, targetHeightCm: 14 })
    store().settleJob(resize.jobId)
    const pendingId = store().designs.get(logo.id)!.pendingVersionId!
    const version = store().versions.get(pendingId)!
    expect(version.widthPx).toBe(1654)
    expect(version.heightPx).toBe(1654)
    const after = store().approveVersion(logo.id, pendingId)
    expect(after.status).toBe('ready')
  })

  it('requires a target size before proposing the final resize', () => {
    const acme = batchByName('ACME summer drop 01')
    const collage = designByName(acme.id, 'Full-bleed collage')
    store().updateDesign(collage.id, { targetWidthCm: null, targetHeightCm: null })
    const error = problem(() => store().proposeStep(collage.id, 'resize', {}))
    expect(error.status).toBe(422)
    expect(error.code).toBe('invalid-target-size')
  })

  it('brush operations ride along in the version parameters', () => {
    const acme = batchByName('ACME summer drop 01')
    const logo = designByName(acme.id, 'APEX logo')
    const ops = [{ tool: 'erase' as const, radiusPx: 18, points: [[40, 60], [44, 66]] }]
    const job = store().proposeStep(logo.id, 'background-removal', {
      mode: 'color-to-alpha',
      keyColor: '#0b0b0b',
      brushOps: ops,
    })
    store().settleJob(job.jobId)
    const pendingId = store().designs.get(logo.id)!.pendingVersionId!
    expect(store().versions.get(pendingId)!.hasMask).toBe(true)
    expect(store().versions.get(pendingId)!.parameters.brushOps).toEqual(ops)
  })

  it('excluded and better-source designs cannot be processed', () => {
    const acme = batchByName('ACME summer drop 01')
    const proof = designByName(acme.id, 'Supplier proof (excluded)')
    expect(problem(() => store().proposeStep(proof.id, 'trim', { mode: 'auto' })).code).toBe(
      'invalid-transition',
    )
    const signature = designByName(acme.id, 'Signature at 80 DPI')
    expect(problem(() => store().proposeStep(signature.id, 'upscale', { model: 'realesrgan-x4plus', scale: 2 })).code).toBe(
      'invalid-transition',
    )
    const resumed = store().resumeDesign(signature.id)
    expect(resumed.status).toBe('received')
  })

  it('include restores the flag-driven status and exclude never deletes anything', () => {
    const acme = batchByName('ACME summer drop 01')
    const banner = designByName(acme.id, 'Side-seam banner')
    const versionCountBefore = banner.versionIds.length
    store().setExcluded(banner.id, true)
    expect(store().designs.get(banner.id)!.status).toBe('excluded')
    const included = store().setExcluded(banner.id, false)
    expect(included.status).toBe('ready')
    expect(store().designs.get(banner.id)!.versionIds).toHaveLength(versionCountBefore)
  })

  it('uploading creates an immutable original plus a queued classify job', () => {
    const empty = batchByName('Empty intake queue')
    const detail = store().uploadDesign(empty.id, { name: 'new-badge.png', assetKey: 'sticker-fringe' })
    expect(detail.status).toBe('received')
    expect(detail.versions).toHaveLength(1)
    expect(detail.versions[0]!.stepType).toBe('original')
    expect(detail.versions[0]!.status).toBe('approved')
    const jobs = store().listJobs(empty.id, { type: 'classify' })
    expect(jobs.items.length).toBeGreaterThan(0)
    store().settleAllJobs()
    expect(store().suggestions(detail.id).status).toBe('ready')
  })
})

describe('packing, integrity and export', () => {
  beforeEach(() => {
    resetStore()
    store().jobDelayMs = 0
  })

  it('blocks packing until every non-excluded design is ready', () => {
    const acme = batchByName('ACME summer drop 01')
    const error = problem(() => store().pack(acme.id, {}))
    expect(error.status).toBe(409)
    expect(error.code).toBe('design-not-ready')
    expect(error.detail).toContain('Full-bleed collage')
  })

  it('rejects a ready design that is wider than the usable roll', () => {
    const marathon = batchByName('Marathon expo back print')
    const error = problem(() => store().pack(marathon.id, {}))
    expect(error.status).toBe(422)
    expect(error.code).toBe('design-exceeds-roll')
  })

  it('packs into an unchecked sheet, then valid after a passing integrity check', () => {
    const riverside = batchByName('Riverside run club')
    const pack = store().pack(riverside.id, {})
    store().settleJob(pack.jobId)
    const sheet = store().sheet(riverside.id)
    expect(sheet.state).toBe('unchecked')
    expect(sheet.integrityReport).toBeNull()
    expect(sheet.placements).toHaveLength(3)
    expect(sheet.widthPx).toBe(6850)
    expect(riverside.status).toBe('ready-to-pack')

    const check = store().runIntegrityCheck(riverside.id)
    store().settleJob(check.jobId)
    const checked = store().sheet(riverside.id)
    expect(checked.state).toBe('valid')
    expect(checked.integrityReport?.passed).toBe(true)
    expect(checked.integrityReport?.checks.map((item) => item.id)).toEqual([
      'visible-pixels-inside-sheet',
      'dilated-masks-no-overlap',
      'minimum-gap',
      'pixel-equality',
    ])
    expect(store().batches.get(riverside.id)!.status).toBe('packed')
  })

  it('a failed check marks the sheet invalid and leaves the batch unpackable', () => {
    const riverside = batchByName('Riverside run club')
    const pack = store().pack(riverside.id, {})
    store().settleJob(pack.jobId)
    store().forceIntegrityFailure(riverside.id)
    const check = store().runIntegrityCheck(riverside.id)
    store().settleJob(check.jobId)
    const sheet = store().sheet(riverside.id)
    expect(sheet.state).toBe('invalid')
    expect(sheet.integrityReport?.passed).toBe(false)
    expect(store().batches.get(riverside.id)!.status).toBe('ready-to-pack')
    expect(problem(() => store().createExport(riverside.id, 'flat-png')).code).toBe(
      'sheet-integrity-failed',
    )
  })

  it('manual placement edits bump the revision and clear the report', () => {
    const riverside = batchByName('Riverside run club')
    const pack = store().pack(riverside.id, {})
    store().settleJob(pack.jobId)
    const check = store().runIntegrityCheck(riverside.id)
    store().settleJob(check.jobId)
    const before = store().sheet(riverside.id)

    const moved = before.placements.map((placement, index) => ({
      designId: placement.designId,
      versionId: placement.versionId,
      xCm: index === 0 ? placement.xCm + 2 : placement.xCm,
      yCm: placement.yCm,
      rotationDeg: placement.rotationDeg,
    }))
    const updated = store().updatePlacements(riverside.id, before.revision, moved)
    expect(updated.revision).toBe(before.revision + 1)
    expect(updated.state).toBe('unchecked')
    expect(updated.integrityReport).toBeNull()
    expect(store().batches.get(riverside.id)!.status).toBe('ready-to-pack')

    expect(
      problem(() => store().updatePlacements(riverside.id, before.revision, moved)).code,
    ).toBe('stale-revision')
  })

  it('keeps overlapping placements accepted but reported as failing', () => {
    const riverside = batchByName('Riverside run club')
    const pack = store().pack(riverside.id, {})
    store().settleJob(pack.jobId)
    const sheet = store().sheet(riverside.id)
    const [first, second] = sheet.placements
    const stacked = sheet.placements.map((placement) =>
      placement.designId === second.designId
        ? { ...placement, xCm: first.xCm, yCm: first.yCm, rotationDeg: placement.rotationDeg }
        : { ...placement, rotationDeg: placement.rotationDeg },
    )
    const updated = store().updatePlacements(riverside.id, sheet.revision, stacked)
    const check = store().runIntegrityCheck(riverside.id)
    store().settleJob(check.jobId)
    const report = store().sheet(riverside.id).integrityReport!
    expect(updated.state).toBe('unchecked')
    expect(report.passed).toBe(false)
    expect(report.checks.find((item) => item.id === 'dilated-masks-no-overlap')!.status).toBe('failed')
  })

  it('90-degree rotation swaps the printed footprint without resampling', () => {
    const riverside = batchByName('Riverside run club')
    const pack = store().pack(riverside.id, {})
    store().settleJob(pack.jobId)
    const sheet = store().sheet(riverside.id)
    const target = sheet.placements[0]!
    const rotated = sheet.placements.map((placement) => ({
      designId: placement.designId,
      versionId: placement.versionId,
      xCm: placement.xCm,
      yCm: placement.yCm,
      rotationDeg: placement.designId === target.designId ? 90 : placement.rotationDeg,
    }))
    const updated = store().updatePlacements(riverside.id, sheet.revision, rotated)
    const placement = updated.placements.find((item) => item.designId === target.designId)!
    expect(placement.widthCm).toBeCloseTo(target.heightCm, 4)
    expect(placement.heightCm).toBeCloseTo(target.widthCm, 4)
    expect(placement.widthPx).toBe(target.heightPx)
  })

  it('blocks export on a stale or unchecked sheet and succeeds on a valid one', () => {
    const riverside = batchByName('Riverside run club')
    expect(problem(() => store().createExport(riverside.id, 'flat-png')).code).toBe('sheet-not-found')
    const pack = store().pack(riverside.id, {})
    store().settleJob(pack.jobId)
    expect(problem(() => store().createExport(riverside.id, 'flat-png')).code).toBe(
      'sheet-integrity-failed',
    )
    const check = store().runIntegrityCheck(riverside.id)
    store().settleJob(check.jobId)
    const accepted = store().createExport(riverside.id, 'psd-bundle', true)
    store().settleJob(accepted.jobId)
    const list = store().listExports(riverside.id)
    expect(list.items[0]!.status).toBe('succeeded')
    expect(list.items[0]!.artifacts.map((item) => item.name)).toContain('jsx')
    expect(store().batches.get(riverside.id)!.status).toBe('exported')

    // Editing afterwards makes the sheet stale and export ineligible again.
    const sheet = store().sheet(riverside.id)
    store().updatePlacements(
      riverside.id,
      sheet.revision,
      sheet.placements.map((placement) => ({
        designId: placement.designId,
        versionId: placement.versionId,
        xCm: placement.xCm,
        yCm: placement.yCm + 1,
        rotationDeg: placement.rotationDeg,
      })),
    )
    expect(problem(() => store().createExport(riverside.id, 'flat-png')).code).toBe(
      'sheet-integrity-failed',
    )
  })

  it('refuses the layered formats that ADR 0003 leaves unvalidated', () => {
    const northgate = batchByName('Northgate cafe merch')
    expect(problem(() => store().createExport(northgate.id, 'layered-psb')).code).toBe(
      'export-format-unavailable',
    )
  })

  it('a target-size change invalidates a packed sheet and leaves the export as history', () => {
    const northgate = batchByName('Northgate cafe merch')
    const sheetBefore = store().sheet(northgate.id)
    const exportsBefore = store().listExports(northgate.id).items.length
    const cup = designByName(northgate.id, 'Steam cup')
    store().updateDesign(cup.id, { targetWidthCm: 13, targetHeightCm: 13 })
    expect(store().sheet(northgate.id).stale).toBe(true)
    expect(store().designs.get(cup.id)!.status).toBe('in-progress')
    expect(store().batches.get(northgate.id)!.status).toBe('collecting')
    expect(store().listExports(northgate.id).items).toHaveLength(exportsBefore)
    expect(sheetBefore.revision).toBe(1)
  })
})
