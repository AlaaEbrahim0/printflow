import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryDraftStore, draftKey, type DraftStore } from '../../lib/editorDrafts'
import type { EditorDraft } from '../../lib/editorDrafts'

const mocks = vi.hoisted(() => ({ store: undefined as unknown as DraftStore }))

vi.mock('../../lib/editorDrafts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/editorDrafts')>()
  return {
    ...actual,
    get editorDrafts() { return mocks.store },
    loadEditorDraft: (batchId: string, designId: string) => mocks.store.load(draftKey(batchId, designId)),
    saveEditorDraft: (draft: Omit<EditorDraft, 'key' | 'updatedAt'>) => mocks.store.save(draftKey(draft.batchId, draft.designId), draft),
    clearEditorDraft: (batchId: string, designId: string) => mocks.store.clear(draftKey(batchId, designId)),
  }
})

class TestImage {
  naturalWidth = 2
  naturalHeight = 1
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

let testStore: DraftStore = new MemoryDraftStore()
const ManualEditor = (await import('./ManualEditor')).ManualEditor

const draft = (): Omit<EditorDraft, 'key' | 'updatedAt'> => ({
  batchId: 'b1', designId: 'd1',
  document: { schemaVersion: 1, id: 'manual-editor', designId: '/test.png', sourceVersionId: '/test.png', width: 2, height: 1, activeLayerId: 'base', selection: null, layers: [{ id: 'base', kind: 'base-raster', name: 'Original', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null }] },
  snapshot: { selection: null, mask: null, adjustments: { levels: { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }, hue: 0, saturation: 0, lightness: 0 }, label: 'Wand' },
})

beforeEach(() => {
  testStore = new MemoryDraftStore()
  mocks.store = testStore
  vi.stubGlobal('Image', TestImage)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
  HTMLCanvasElement.prototype.toBlob = (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function editor(onSave: (file: File) => Promise<void> = async () => {}) {
  return render(<ManualEditor title="Test" batchId="b1" designId="d1" fileUrl="/test.png" onSave={onSave} onBack={() => {}} />)
}

async function makeEdit() {
  await waitFor(() => expect(screen.queryByTestId('draft-restore')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
}

describe('editor draft lifecycle', () => {
  it('prompts to restore an existing draft and restores its mask', async () => {
    await testStore.save(draftKey('b1', 'd1'), { ...draft(), snapshot: { ...draft().snapshot, mask: new Uint8Array([255, 0]), label: 'Feather mask' } })
    editor()
    await screen.findByTestId('draft-restore')
    fireEvent.click(screen.getByTestId('draft-restore-accept'))
    await waitFor(() => expect(screen.queryByTestId('draft-restore')).toBeNull())
    expect(screen.getByTestId('mask-status')).not.toHaveTextContent('No mask')
  })

  it('discards the draft when the operator declines restore', async () => {
    await testStore.save(draftKey('b1', 'd1'), draft())
    editor()
    await screen.findByTestId('draft-restore')
    fireEvent.click(screen.getByTestId('draft-restore-decline'))
    await waitFor(async () => expect(await testStore.load(draftKey('b1', 'd1'))).toBeNull())
  })

  it('autosaves after changes with a debounce', async () => {
    const saveSpy = vi.spyOn(testStore, 'save')
    editor()
    await makeEdit()
    await waitFor(() => expect(saveSpy).toHaveBeenCalled(), { timeout: 4000 })
    expect(await testStore.load(draftKey('b1', 'd1'))).not.toBeNull()
  })

  it('clears the draft only after the save succeeds', async () => {
    await testStore.save(draftKey('b1', 'd1'), draft())
    editor(async () => { throw new Error('stale parent') })
    await makeEdit()
    fireEvent.click(screen.getByTestId('manual-save'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/stale parent/))
    expect(await testStore.load(draftKey('b1', 'd1'))).not.toBeNull()
  })

  it('shows a visible notice on save failure without losing edits', async () => {
    vi.spyOn(testStore, 'save').mockRejectedValue(new Error('draft quota exceeded'))
    editor()
    await makeEdit()
    await waitFor(() => expect(screen.getByTestId('draft-notice')).toHaveTextContent(/Draft save failed/), { timeout: 4000 })
    expect(screen.getByTestId('manual-save')).toBeEnabled()
  })

  it('keeps keys isolated between designs', async () => {
    await testStore.save(draftKey('b1', 'd1'), draft())
    await testStore.save(draftKey('b1', 'd2'), { ...draft(), designId: 'd2' })
    expect((await testStore.load(draftKey('b1', 'd1')))?.designId).toBe('d1')
    expect((await testStore.load(draftKey('b1', 'd2')))?.designId).toBe('d2')
  })

  it('discards an invalid draft without crashing', async () => {
    const invalid = { ...draft(), document: { ...draft().document, schemaVersion: 2 as 1 } } as EditorDraft
    await testStore.save(draftKey('b1', 'd1'), draft())
    vi.spyOn(testStore, 'load').mockResolvedValue(invalid)
    editor()
    await waitFor(() => expect(screen.queryByTestId('draft-restore')).toBeNull())
    expect(screen.getByTestId('manual-save')).toBeEnabled()
  })

  it('persists a mask edit and restores it after a reload', async () => {
    // Regression: the packed mask used to carry one byte per pixel, which
    // `validateDocument` rejects (it requires ceil(w*h/8)). Every draft with a
    // non-empty mask therefore failed to save and the restore prompt never
    // appeared — for the whole of Phase 1b, because the earlier tests only ever
    // used a null mask.
    const view = editor()
    await makeEdit()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(async () => {
      const stored = await testStore.load(draftKey('b1', 'd1'))
      const layer = stored?.document.layers[0]
      expect(layer?.kind).toBe('base-raster')
      expect((layer as { mask: { bytes: Uint8Array } | null }).mask).not.toBeNull()
    }, { timeout: 4000 })

    view.unmount()
    editor()
    await screen.findByTestId('draft-restore')
    fireEvent.click(screen.getByTestId('draft-restore-accept'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).not.toHaveTextContent('No mask'))
  })
})
