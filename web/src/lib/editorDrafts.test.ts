import { describe, expect, it } from 'vitest'
import { DEFAULT_ADJUSTMENTS } from '../components/manual-editor/adjustments'
import { validateDocument, type EditorDocument } from '../components/manual-editor/document'
import { draftKey, MemoryDraftStore, type DraftStore } from './editorDrafts'

const document = (): EditorDocument => ({
  schemaVersion: 1, id: 'doc', designId: 'design', sourceVersionId: 'source', width: 2, height: 1,
  activeLayerId: 'base', selection: null,
  layers: [{ id: 'base', kind: 'base-raster', name: 'base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: { encoding: 'bitpack-v1', width: 2, height: 1, feather: 0, bytes: new Uint8Array([3]) } }],
})
const draft = () => ({
  batchId: 'batch', designId: 'design', document: document(),
  snapshot: { selection: new Uint8Array([0, 255]), mask: new Uint8Array([255, 0]), adjustments: { ...DEFAULT_ADJUSTMENTS }, label: 'Wand' },
})

describe('editor drafts', () => {
  it('round-trips document and snapshot, restoring Uint8Arrays and passing validateDocument', async () => {
    const store = new MemoryDraftStore()
    const saved = await store.save(draftKey('batch', 'design'), draft())
    expect(saved.key).toBe('batch:design')
    const loaded = await store.load(draftKey('batch', 'design'))
    expect(loaded?.document).toEqual(document())
    expect(loaded?.snapshot.selection).toEqual(new Uint8Array([0, 255]))
    expect(loaded?.snapshot.mask).toEqual(new Uint8Array([255, 0]))
    expect(loaded?.snapshot.label).toBe('Wand')
    validateDocument(loaded!.document)
  })

  it('isolates batch:design keys', async () => {
    const store = new MemoryDraftStore()
    await store.save(draftKey('batch', 'one'), draft())
    await store.save(draftKey('other', 'one'), { ...draft(), batchId: 'other' })
    expect((await store.load(draftKey('batch', 'one')))?.batchId).toBe('batch')
    expect((await store.load(draftKey('other', 'one')))?.batchId).toBe('other')
    expect(await store.load(draftKey('batch', 'two'))).toBeNull()
  })

  it('keeps an existing draft when a save fails (quota or write error)', async () => {
    const good = new MemoryDraftStore()
    await good.save('key', draft())
    const failing = new MemoryDraftStore(true)
    await expect(failing.save('key', draft())).rejects.toThrow('quota')
    expect(await good.load('key')).not.toBeNull()
  })

  it('soft-fails when storage is unavailable', async () => {
    const store: DraftStore = {
      load: async () => null,
      save: async () => { throw new Error('IndexedDB unavailable') },
      clear: async () => undefined,
    }
    expect(await store.load('key')).toBeNull()
    await expect(store.save('key', draft())).rejects.toThrow('unavailable')
  })

  it('clears only when the caller confirms a successful save', async () => {
    const store = new MemoryDraftStore()
    await store.save('key', draft())
    expect(await store.load('key')).not.toBeNull()
    await store.clear('key')
    expect(await store.load('key')).toBeNull()
  })

  it('rejects invalid drafts instead of restoring them', async () => {
    const store = new MemoryDraftStore()
    await expect(store.save('key', { ...draft(), document: { ...document(), schemaVersion: 2 as 1 } })).rejects.toThrow('unsupported draft schema')
    await expect(store.save('key', { ...draft(), document: { ...document(), activeLayerId: 'missing' } })).rejects.toThrow('active layer does not exist')
  })
})
