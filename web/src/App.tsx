import { useEffect, useState } from 'react'
import './App.css'

type Health = {
  status: string
  checks?: Array<{ name: string; status: string; durationMs: number }>
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; health: Health }
  | { kind: 'error'; message: string }

const tracks = [
  { id: 'A', title: 'API', body: 'Aggregates, state machine, immutable versions, jobs against a fake worker.' },
  { id: 'B', title: 'Worker', body: 'Trim, upscale, size, background-removal modes, vectorize, classifier.' },
  { id: 'C', title: 'Packer', body: 'Mask nesting, integrity checks, exports and adversarial tests.' },
  { id: 'D', title: 'Web', body: 'Wizard, cropper, brush editor, batch grid and packing preview.' },
]

const guardrails = [
  'Originals are never overwritten.',
  'Only approved versions become current.',
  'The packer translates and rotates by 90° — never resamples.',
  'Export is blocked when the integrity report fails.',
  'Previews are composited over checkerboard and garment colors.',
]

function useHealth(): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    fetch('/healthz', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`)
        return (await response.json()) as Health
      })
      .then((health) => setState({ kind: 'ready', health }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown health error',
        })
      })
    return () => controller.abort()
  }, [])

  return state
}

function App() {
  const health = useHealth()

  return (
    <main className="shell">
      <header className="hero">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            PS
          </span>
          <span className="eyebrow">Internal tool · Phase 0</span>
        </div>
        <h1>
          PrintSheet
          <span>Workbench</span>
        </h1>
        <p className="lede">
          A review-driven DTF sheet workbench. The machine proposes, a human approves,
          and every pixel keeps its receipts.
        </p>
        <div className="hero-meta">
          <span className="pill">58 cm roll</span>
          <span className="pill">300 DPI</span>
          <span className="pill">Immutable versions</span>
          <span className="pill">58 × up to 500 cm</span>
        </div>
      </header>

      <section className="status-grid" aria-label="Phase 0 status">
        <article className="card status-card">
          <div className="card-heading">
            <h2>Stack status</h2>
            <span className={`dot ${health.kind}`} />
          </div>
          {health.kind === 'loading' && <p className="muted">Checking API and database…</p>}
          {health.kind === 'error' && (
            <>
              <p className="status-line bad">API unreachable</p>
              <p className="muted">{health.message}</p>
            </>
          )}
          {health.kind === 'ready' && (
            <>
              <p className="status-line good">API {health.health.status.toLowerCase()}</p>
              <ul className="checks">
                {(health.health.checks ?? []).map((check) => (
                  <li key={check.name}>
                    <span>{check.name}</span>
                    <span className={check.status === 'Healthy' ? 'good' : 'bad'}>
                      {check.status} · {check.durationMs} ms
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="footnote">
            Contract v1.0.0 · OpenAPI + worker/packer JSON Schemas frozen.
          </p>
        </article>

        <article className="card">
          <div className="card-heading">
            <h2>What Phase 0 delivered</h2>
            <span className="tag">blocking</span>
          </div>
          <ul className="checklist">
            <li>Clean Architecture skeleton and SQLite/Postgres switch</li>
            <li>File-based worker, packer and storage contracts</li>
            <li>Domain model and state transitions</li>
            <li>Realistic fixtures for every known input failure mode</li>
            <li>Measured PSD/PSB spike and export fallback decision</li>
          </ul>
        </article>
      </section>

      <section className="card preview-card">
        <div className="preview-copy">
          <span className="tag">Preview honesty</span>
          <h2>Halos only appear when the background is real.</h2>
          <p>
            Transparency is never previewed on a single flat color. Checkerboard and
            garment colors reveal soft smoke, fringes and dark edges before print.
          </p>
        </div>
        <div className="swatches" aria-label="Preview background modes">
          <div className="swatch checker">
            <span>Checkerboard</span>
          </div>
          <div className="swatch white">
            <span>White garment</span>
          </div>
          <div className="swatch black">
            <span>Black garment</span>
          </div>
          <div className="swatch custom">
            <span>Custom</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="tracks-title">
        <div className="section-heading">
          <h2 id="tracks-title">Phase 1 tracks</h2>
          <p>Parallel, directory-owned, contract-first.</p>
        </div>
        <div className="track-grid">
          {tracks.map((track) => (
            <article className="card track" key={track.id}>
              <span className="track-id">{track.id}</span>
              <h3>{track.title}</h3>
              <p>{track.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card guardrails">
        <div>
          <span className="tag">Non-negotiables</span>
          <h2>The rules survive the demo.</h2>
        </div>
        <ul>
          {guardrails.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>

      <footer>
        <span>PrintSheet Workbench</span>
        <span>Phase 0 · contracts frozen 2026-11-05</span>
      </footer>
    </main>
  )
}

export default App
