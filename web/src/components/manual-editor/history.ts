/**
 * Undo/redo for the manual cleanup editor.
 *
 * The editor has several kinds of state an operator would expect Ctrl+Z to
 * walk back through — the selection, the layer mask, and the adjustment
 * sliders. A history that only covered one of them is worse than none, because
 * Ctrl+Z would silently do the wrong thing depending on which tool was last
 * used. So history stores *snapshots of everything*, and every state change
 * that a person would want to undo goes through one `commit`.
 *
 * Two rules make it trustworthy:
 *   1. `entries[cursor]` is always the current state. Undo moves the cursor
 *      back, redo moves it forward; neither pops, so redo survives an undo.
 *   2. A new commit truncates everything after the cursor. That is the
 *      standard linear history, and it is what stops the old bug where redo
 *      replayed a branch the operator had already abandoned.
 *
 * Entries are treated as immutable snapshots. `Uint8Array` payloads are copied
 * on the way in and on the way out: two history entries that alias the same
 * buffer means undoing a mask stroke also rewrites the redo state.
 */

export interface EditorSnapshot {
  /** Row-major selection mask, one byte per pixel, or `null` for none. */
  selection: Uint8Array | null
  /** Row-major layer mask, one byte per pixel, or `null` for none. */
  mask: Uint8Array | null
  /** Human label for the entry, e.g. "Lasso" or "Feather mask". */
  label: string
}

export interface HistoryEntry {
  snapshot: EditorSnapshot
  /** Monotonic sequence number; lets the UI show "step 3 of 7". */
  sequence: number
}

export interface HistoryState {
  entries: HistoryEntry[]
  /** Index of the current entry. `-1` only for a history with no entries. */
  cursor: number
  /** Sequence number to assign to the next commit. */
  nextSequence: number
  /** Bumped on every commit so React sees a new object even if the label repeats. */
  version: number
}

export const MAX_HISTORY = 50

export function emptyHistory(initial?: EditorSnapshot): HistoryState {
  if (!initial) return { entries: [], cursor: -1, nextSequence: 0, version: 0 }
  return {
    entries: [{ snapshot: cloneSnapshot(initial), sequence: 0 }],
    cursor: 0,
    nextSequence: 1,
    version: 0,
  }
}

export function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    selection: snapshot.selection ? snapshot.selection.slice() : null,
    mask: snapshot.mask ? snapshot.mask.slice() : null,
    label: snapshot.label,
  }
}

/**
 * Snapshots are compared by content, not by identity, because the selection
 * buffer is rebuilt on every gesture. Committing an identical state would give
 * the operator an Undo that appears to do nothing.
 */
export function snapshotsEqual(a: EditorSnapshot, b: EditorSnapshot): boolean {
  return bytesEqual(a.selection, b.selection) && bytesEqual(a.mask, b.mask)
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Record a new state.
 *
 * Returns the state unchanged when the snapshot matches the current entry, so
 * callers can commit freely (a slider `onChange` fires many times) without
 * polluting history with duplicates.
 */
export function commitHistory(state: HistoryState, snapshot: EditorSnapshot, limit = MAX_HISTORY): HistoryState {
  const current = state.cursor >= 0 ? state.entries[state.cursor] : null
  if (current && snapshotsEqual(current.snapshot, snapshot)) return state
  const kept = state.entries.slice(0, state.cursor + 1)
  const entry: HistoryEntry = { snapshot: cloneSnapshot(snapshot), sequence: state.nextSequence }
  kept.push(entry)
  // Drop the oldest entries once the cap is hit. The cap exists so a long
  // session over a 6000 px artwork cannot exhaust memory — a mask alone is
  // 36 MB per entry.
  const overflow = Math.max(0, kept.length - limit)
  const entries = overflow > 0 ? kept.slice(overflow) : kept
  return {
    entries,
    cursor: entries.length - 1,
    nextSequence: state.nextSequence + 1,
    version: state.version + 1,
  }
}

export function canUndo(state: HistoryState): boolean {
  return state.cursor > 0
}

export function canRedo(state: HistoryState): boolean {
  return state.cursor >= 0 && state.cursor < state.entries.length - 1
}

export function undoHistory(state: HistoryState): HistoryState {
  if (!canUndo(state)) return state
  return { ...state, cursor: state.cursor - 1, version: state.version + 1 }
}

export function redoHistory(state: HistoryState): HistoryState {
  if (!canRedo(state)) return state
  return { ...state, cursor: state.cursor + 1, version: state.version + 1 }
}

/** The snapshot the editor should currently display. Copies, never aliases. */
export function currentSnapshot(state: HistoryState): EditorSnapshot | null {
  if (state.cursor < 0 || state.cursor >= state.entries.length) return null
  return cloneSnapshot(state.entries[state.cursor].snapshot)
}

/** Label of the entry that Undo would return *to*, for a tooltip. */
export function undoLabel(state: HistoryState): string | null {
  if (!canUndo(state)) return null
  return state.entries[state.cursor - 1].snapshot.label
}

export function redoLabel(state: HistoryState): string | null {
  if (!canRedo(state)) return null
  return state.entries[state.cursor + 1].snapshot.label
}
