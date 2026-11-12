/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Structural (text/AST-style) test, not a behavioural test.
 *
 * Claim under test: preview and commit take the *same* composite path. The
 * editor never forks pixel math. Every visible-pixel render — the on-canvas
 * preview and the pixels that end up in the saved/exported PNG — is produced by
 * `compositeDocument` from `./composite`, whether it runs inline in
 * `ManualEditor.tsx` or inside the compositor worker. This file therefore reads
 * the real sources and asserts on their shape; it executes no editor code.
 *
 * Assertions are deliberately whitespace-tolerant (they normalize all runs of
 * whitespace before matching) so formatting churn cannot break them, while the
 * structural guarantees they encode stay explicit and reviewable.
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

const compositeSource = read('./composite.ts')
const editorSource = read('./ManualEditor.tsx')
const workerSource = read('./compositor.worker.ts')
const clientSource = read('./compositorClient.ts')

/** Collapse all whitespace runs (incl. newlines and tabs) to a single space. */
const flat = (source: string): string => source.replace(/\s+/g, ' ').trim()

/** Extract the balanced `{ ... }` block that starts at the first `{` at/after `from`. */
function balancedBlock(source: string, from: number): string {
  const start = source.indexOf('{', from)
  expect(start, 'no opening brace found at/after anchor').toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces while slicing source block')
}

/** Extract `export function name(...) ... { ... }` by balanced-brace slice. */
function functionBody(source: string, signatureAnchor: string): string {
  const at = source.indexOf(signatureAnchor)
  expect(at, `missing function signature: ${signatureAnchor}`).toBeGreaterThanOrEqual(0)
  // Skip the parameter list so a default like `options = {}` cannot be mistaken
  // for the function body; the real body is the next `{` after the closing `)`.
  const parenAt = source.indexOf('(', at)
  expect(parenAt, `missing parameter list for: ${signatureAnchor}`).toBeGreaterThanOrEqual(0)
  const parenEnd = matchingParen(source, parenAt)
  return balancedBlock(source, parenEnd)
}

/** Index of the `)` that balances the `(` at `openAt`. */
function matchingParen(source: string, openAt: number): number {
  let depth = 0
  for (let i = openAt; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced parentheses while locating a function body')
}

/** Extract an `export interface Name { ... }` body plus its header. */
function interfaceBlock(source: string, name: string): string {
  const at = source.indexOf(`export interface ${name}`)
  expect(at, `missing interface ${name}`).toBeGreaterThanOrEqual(0)
  return balancedBlock(source, at)
}

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Bounded-window search over flattened source; avoids brittle whole-file regexes. */
function hasNearby(source: string, anchor: string, pattern: RegExp, window = 400): boolean {
  const flatSource = flat(source)
  const index = flatSource.indexOf(anchor)
  if (index < 0) return false
  return pattern.test(flatSource.slice(index, index + anchor.length + window))
}

const countCalls = (source: string, callee: string): number =>
  (flat(source).match(new RegExp(`(?<![\\w$.])${escapeRegExp(callee)}\\s*\\(`, 'g')) ?? []).length

/** Count call sites only, including method calls like `x.postMessage(`, excluding declarations. */
const countInvocations = (source: string, callee: string): number =>
  (flat(source).match(new RegExp(`${escapeRegExp(callee)}\\s*\\(`, 'g')) ?? []).length

describe('shared composite contract (composite.ts)', () => {
  it('declares the verbatim compositeDocument signature', () => {
    const signature = 'export function compositeDocument(document: EditorDocument, resolver: PixelResolver, options: CompositeOptions = {}): ImageData'
    expect(compositeSource).toContain(signature)
    // Exactly one definition: the contract has a single entry point.
    expect(flat(compositeSource).match(/export function compositeDocument\s*\(/g)).toHaveLength(1)
    // Everything renderable is built here and exported; not re-exported elsewhere.
    expect(compositeSource).not.toMatch(/export\s*\{[^}]*compositeDocument/)
  })

  it('declares the verbatim CompositeOptions shape', () => {
    expect(compositeSource).toContain(
      'export interface CompositeOptions { region?: CompositeRegion; scale?: number; colorKeyCache?: ColorKeyCache; inputRevision?: string }',
    )
    const block = interfaceBlock(compositeSource, 'CompositeOptions')
    for (const field of ['region?: CompositeRegion', 'scale?: number', 'colorKeyCache?: ColorKeyCache', 'inputRevision?: string']) {
      expect(flat(block)).toContain(field)
    }
  })

  it('keeps region/scale as output sampling knobs only (no fork of pixel math)', () => {
    const body = flat(functionBody(compositeSource, 'export function compositeDocument'))
    // The body composites the full document exactly once, then re-samples.
    expect(body).toMatch(/const full = compositeFull\(document, resolver, options\)/)
    expect(body).toMatch(/const region = options\.region \?\? \{[^}]*x: 0, y: 0, width: document\.width, height: document\.height[^}]*\}/)
    expect(body).toMatch(/const scale = options\.scale \?\? 1/)
    // Sampling reads from the single `full` buffer — never a second composite.
    expect(body).toMatch(/full\.data\.subarray\(/)
    // Exactly one full-document composite in the body, and no recursion.
    expect(countCalls(body, 'compositeFull')).toBe(1)
    expect(countCalls(body, 'compositeDocument')).toBe(0)
  })
})

describe('preview path in ManualEditor.tsx', () => {
  it('imports compositeDocument from the shared module', () => {
    expect(flat(editorSource)).toContain("import { compositeDocument } from './composite'")
  })

  it('renders the base canvas from compositeDocument(document, resolver)', () => {
    // The editor's pixel render effect calls the shared entry point with a
    // document plus an inline resolver, exactly like the worker does.
    expect(flat(editorSource)).toMatch(
      /const rendered = compositeDocument\(document, \{ resolve: \(\) => pixels \}\)/,
    )
    // The composite output is what reaches the preview canvas.
    expect(flat(editorSource)).toMatch(/canvas\.width = rendered\.width; canvas\.height = rendered\.height/)
    expect(flat(editorSource)).toMatch(/canvas\.getContext\('2d'\)\?\.putImageData\(rendered, 0, 0\)/)
    // The resolver hands the composer source pixels directly (same inputs the
    // worker gives its resolver), rather than a pre-processed buffer.
    expect(hasNearby(editorSource, 'compositeDocument(document,', /resolve: \(\) => pixels/)).toBe(true)
  })

  it('does not bypass the shared composer with its own pixel loops', () => {
    // Preview is per-frame; any local compositing loop would be a second path.
    expect(flat(editorSource)).not.toMatch(/putImageData\((?!rendered)/)
    expect(flat(editorSource)).not.toMatch(/new Uint8ClampedArray\([^)]*\)\s*\)\s*;?\s*for\s*\([^)]*\+\+\)\s*\{\s*[^}]*\[3\]\s*=/)
  })
})

describe('commit path in ManualEditor.tsx', () => {
  it('serializes the already-composited base canvas (no second composite)', () => {
    expect(flat(editorSource)).toMatch(/const canvas = base\.current[\s\S]{0,160}canvas\.toBlob\(resolve, 'image\/png'\)/)
    // `renderPng` reads `base.current`; it must not recompose from the source.
    const png = flat(functionBody(editorSource, 'async function renderPng'))
    expect(png).toContain('base.current')
    expect(png).not.toContain('compositeDocument')
    expect(png).not.toContain('source.current')
  })

  it('routes both export and save through the same renderPng helper', () => {
    const exportBody = flat(functionBody(editorSource, 'async function exportPng'))
    const saveBody = flat(functionBody(editorSource, 'async function save'))
    expect(exportBody).toContain('await renderPng()')
    expect(saveBody).toContain('await renderPng()')
    // Saving hands the exported PNG bytes to the caller unchanged.
    expect(saveBody).toMatch(/await onSave\(new File\(\[blob\], 'manual-cleanup\.png', \{ type: 'image\/png' \}\)\)/)
    // Both commit doors converge on renderPng; neither invents its own pixels.
    // Three mentions: the declaration plus the two call sites counted below.
    expect(countInvocations(editorSource, 'renderPng')).toBe(3)
    expect(exportBody).toContain('renderPng()')
    expect(saveBody).toContain('renderPng()')
    expect(exportBody).not.toContain('compositeDocument')
    expect(saveBody).not.toContain('compositeDocument')
  })

  it('has exactly one compositeDocument call site — the preview render', () => {
    // If preview and commit diverged, a second call (or a second composer)
    // would show up here. One call site proves a single pixel pipeline.
    expect(countCalls(editorSource, 'compositeDocument')).toBe(1)
    expect(flat(editorSource)).not.toMatch(/from '\.\/compositor\.worker'/)
    expect(flat(editorSource)).not.toMatch(/from '\.\/compositorClient'/)
  })
})

describe('worker + client composite path', () => {
  it('worker imports and calls the shared composer with request options', () => {
    expect(flat(workerSource)).toMatch(
      /import \{ compositeDocument, type CompositeRegion, type PixelResolver \} from '\.\/composite'/,
    )
    expect(countCalls(workerSource, 'compositeDocument')).toBe(1)
    expect(flat(workerSource)).toMatch(
      /const output = compositeDocument\(request\.document, resolver, \{ region: request\.region, scale: request\.scale, inputRevision: request\.inputRevision \}\)/,
    )
  })

  it('worker never forks pixel math for one request type', () => {
    // `preview` and `commit` share a single request union branch and one
    // composite call; a `commit`-specific branch would indicate a second path.
    expect(flat(workerSource)).toMatch(/type: 'preview' \| 'commit'; requestId: string; document: EditorDocument; region: CompositeRegion; scale: number; inputRevision: string/)
    expect(flat(workerSource)).not.toMatch(/request\.type === 'commit'/)
    expect(flat(workerSource)).not.toMatch(/request\.type === 'preview'/)
    // The composite runs before the staleness check, so preview and commit
    // results are byte-identical for identical inputs.
    const flatWorker = flat(workerSource)
    const compositeAt = flatWorker.indexOf('const output = compositeDocument(')
    const staleAt = flatWorker.indexOf('request.requestId !== latestRequest')
    expect(compositeAt).toBeGreaterThanOrEqual(0)
    expect(staleAt).toBeGreaterThan(compositeAt)
    // Transferred result buffer is exactly the composer's own pixels.
    expect(flat(workerSource)).toMatch(/const pixels = output\.data\.buffer/)
    expect(flat(workerSource)).toMatch(/pixels \} satisfies CompositorWorkerResponse, \{ transfer: \[pixels\] \}\)/)
  })

  it('client is transport only — it never composites or post-processes pixels', () => {
    expect(flat(clientSource)).toMatch(/import type \{ CompositeRegion \} from '\.\/composite'/)
    expect(flat(clientSource)).toMatch(/import type \{ CompositorWorkerRequest, CompositorWorkerResponse \} from '\.\/compositor\.worker'/)
    expect(clientSource).not.toContain('compositeDocument')
    // The only thing it takes from the composite module is a *type*.
    expect(flat(clientSource).match(/from '\.\/composite'/g)).toHaveLength(1)
    expect(flat(clientSource)).toMatch(/import type \{ CompositeRegion \} from '\.\/composite'/)
    // Result pixels are wrapped verbatim; nothing is recomputed client-side.
    expect(flat(clientSource)).toMatch(
      /resolve\(new ImageData\(new Uint8ClampedArray\(event\.data\.pixels\), event\.data\.width, event\.data\.height\)\)/,
    )
    // Requests carry the document + sampling options, not pre-composited bytes.
    expect(countInvocations(clientSource, 'postMessage')).toBe(2)
    expect(flat(clientSource)).toMatch(
      /\{ type: 'preview', requestId, document, region, scale, inputRevision \} satisfies CompositorWorkerRequest/,
    )
  })

  it('client instantiates the compositor worker module (no parallel renderer)', () => {
    expect(flat(clientSource)).toContain("new URL('./compositor.worker.ts', import.meta.url)")
    expect(flat(clientSource)).toMatch(/new Worker\(new URL\('\.\/compositor\.worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/)
  })
})

describe('preview and commit share one pipeline', () => {
  it('every consumer of compositeDocument passes a document and a resolver', () => {
    const consumers: Array<[string, number]> = [
      ['ManualEditor.tsx', countCalls(editorSource, 'compositeDocument')],
      ['compositor.worker.ts', countCalls(workerSource, 'compositeDocument')],
      ['compositorClient.ts', countCalls(clientSource, 'compositeDocument')],
    ]
    // Single call in each place that renders; none in transport-only client.
    expect(consumers).toEqual([
      ['ManualEditor.tsx', 1],
      ['compositor.worker.ts', 1],
      ['compositorClient.ts', 0],
    ])
    expect(flat(editorSource)).toMatch(/compositeDocument\(document, \{ resolve: \(\) => pixels \}\)/)
    expect(flat(workerSource)).toMatch(
      /const resolver: PixelResolver = \{ resolve: sourceId => sources\.get\(sourceId\)/,
    )
  })

  it('commit pixels are the exact preview pixels (canvas serialization only)', () => {
    // Preview puts `rendered` (compositeDocument output) onto `base`; commit
    // serializes that same `base` canvas. Nothing between them re-derives pixels.
    expect(flat(editorSource)).toMatch(
      /canvas\.getContext\('2d'\)\?\.putImageData\(rendered, 0, 0\)[\s\S]*?const canvas = base\.current[\s\S]*?canvas\.toBlob\(resolve, 'image\/png'\)/,
    )
    expect(flat(editorSource)).toMatch(/const base = useRef<HTMLCanvasElement>\(null\)/)
  })
})
