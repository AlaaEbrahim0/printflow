import { validateDocument, type EditorDocument } from '../components/manual-editor/document'
import type { Adjustments } from '../components/manual-editor/adjustments'

export interface DraftSnapshot {
  /** Row-major selection mask, one byte per pixel, or null. */
  selection: Uint8Array | null
  /** Row-major layer mask, one byte per pixel, or null. */
  mask: Uint8Array | null
  adjustments: Adjustments
  label: string
}

export interface EditorDraft {
  key: string
  batchId: string
  designId: string
  document: EditorDocument
  snapshot: DraftSnapshot
  updatedAt: number
}

export interface DraftStore {
  load(key: string): Promise<EditorDraft | null>
  save(key: string, draft: Omit<EditorDraft, 'key' | 'updatedAt'>): Promise<EditorDraft>
  clear(key: string): Promise<void>
}

const DB_NAME = 'printsheet-editor-drafts'
const STORE = 'drafts'
const VERSION = 1
export const draftKey = (batchId: string, designId: string): string => `${batchId}:${designId}`

/** ponytail: full undo history is not persisted — 50 snapshots x ~36 MB masks
 * would exceed practical IndexedDB budgets. Restore covers the visible session
 * (document + current snapshot); upgrade path: persist deltas only. */
const encode = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item instanceof Uint8Array) return { __u8: btoa(String.fromCharCode(...item)) }
  return item
})
const decode = <T>(value: string): T => JSON.parse(value, (_key, item) => {
  if (item && typeof item === 'object' && typeof item.__u8 === 'string') {
    return Uint8Array.from(atob(item.__u8), char => char.charCodeAt(0))
  }
  return item
}) as T

function restore(value: string): EditorDraft {
  const draft = decode<EditorDraft>(value)
  if (draft.document.schemaVersion !== 1) throw new Error('unsupported draft schema')
  if (!draft.snapshot || typeof draft.snapshot.label !== 'string' || !draft.snapshot.adjustments) throw new Error('corrupt draft snapshot')
  validateDocument(draft.document)
  return draft
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'))
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function runRequest<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = action(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export class IndexedDbDraftStore implements DraftStore {
  async load(key: string): Promise<EditorDraft | null> {
    const db = await openDb()
    try {
      const raw = await runRequest<string | undefined>(db, 'readonly', store => store.get(key))
      return raw ? restore(raw) : null
    } finally { db.close() }
  }

  async save(key: string, draft: Omit<EditorDraft, 'key' | 'updatedAt'>): Promise<EditorDraft> {
    const value = { ...draft, key, updatedAt: Date.now() }
    const encoded = encode(value)
    const db = await openDb()
    try {
      await runRequest(db, 'readwrite', store => store.put(encoded, key))
      return restore(encoded)
    } finally { db.close() }
  }

  async clear(key: string): Promise<void> {
    const db = await openDb()
    try { await runRequest(db, 'readwrite', store => store.delete(key)) } finally { db.close() }
  }
}

export class MemoryDraftStore implements DraftStore {
  private readonly values = new Map<string, string>()
  private readonly failSave: boolean
  constructor(failSave = false) { this.failSave = failSave }

  async load(key: string): Promise<EditorDraft | null> {
    const raw = this.values.get(key)
    return raw ? restore(raw) : null
  }

  async save(key: string, draft: Omit<EditorDraft, 'key' | 'updatedAt'>): Promise<EditorDraft> {
    if (this.failSave) throw new Error('draft quota exceeded')
    const value = { ...draft, key, updatedAt: Date.now() }
    const encoded = encode(value)
    this.values.set(key, encoded)
    return restore(encoded)
  }

  async clear(key: string): Promise<void> { this.values.delete(key) }
}

export const editorDrafts: DraftStore = new IndexedDbDraftStore()

/** The immutable document the draft validates and restores. The layer mask is
 * derived from the live byte-per-pixel mask at the editor's threshold, so a
 * restored draft recomposes identically. */
export function buildDraftDocument(width: number, height: number, mask: Uint8Array | null, threshold: number, fileUrl: string): EditorDocument {
  return {
    schemaVersion: 1, id: 'manual-editor', designId: fileUrl, sourceVersionId: fileUrl,
    width, height, activeLayerId: 'base', selection: null,
    layers: [{ id: 'base', kind: 'base-raster', name: 'Original', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: mask ? { encoding: 'bitpack-v1', width, height, feather: 0, bytes: Uint8Array.from(mask, value => value >= threshold ? 255 : 0) } : null }],
  }
}

export const loadEditorDraft = (batchId: string, designId: string): Promise<EditorDraft | null> => editorDrafts.load(draftKey(batchId, designId))
export const saveEditorDraft = (draft: Omit<EditorDraft, 'key' | 'updatedAt'>): Promise<EditorDraft> => editorDrafts.save(draftKey(draft.batchId, draft.designId), draft)
export const clearEditorDraft = (batchId: string, designId: string): Promise<void> => editorDrafts.clear(draftKey(batchId, designId))
