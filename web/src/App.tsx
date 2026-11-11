import { NavLink, Route, Routes, Outlet, BrowserRouter, Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import BatchDetailPage from './routes/BatchDetailPage'
import BatchListPage from './routes/BatchListPage'
import DesignReviewPage from './routes/DesignReviewPage'
import JobsPage from './routes/JobsPage'
import PhotopeaEditorPage from './routes/PhotopeaEditorPage'
import SettingsPage from './routes/SettingsPage'
import SheetPage from './routes/SheetPage'
import { SettingsProvider } from './state/SettingsContext'
import { HealthDot } from './components/ui/HealthDot'
import { ContractBadge } from './components/ui/ContractBadge'
import { api } from './api/client'
import './styles/shell.css'
import './styles/ui.css'

function WorkbenchLayout() {
  return (
    <div className="workbench">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            PS
          </span>
          <span className="brand-name">
            PrintSheet <em>Workbench</em>
          </span>
        </div>
        <nav className="mainnav" aria-label="Primary">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Batches
          </NavLink>
          <NavLink to="/jobs" className={({ isActive }) => (isActive ? 'active' : '')}>
            Jobs
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Settings
          </NavLink>
        </nav>
        <div className="topbar-meta">
          <HealthDot />
          <ContractBadge />
          <LiveJobsBadge />
        </div>
      </header>

      <main className="workspace">
        <Outlet />
      </main>

      <footer className="statusbar">
        <span>The machine proposes, the human approves, nothing is lost.</span>
        <span className="muted">sRGB only · no staff authentication (trusted LAN MVP)</span>
      </footer>
    </div>
  )
}

function LiveJobsBadge() {
  const [liveCount, setLiveCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const list = await api.jobs.list({ limit: 200 }, { signal: AbortSignal.timeout(5000) })
        if (!cancelled) {
          setLiveCount(
            list.items.filter((job) => job.status === 'queued' || job.status === 'running').length,
          )
        }
      } catch {
        // Transient network/read errors are retried on the next tick.
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (liveCount === 0) return null
  return (
    <Link className="topbar-live" to="/jobs">
      <span className="dot ok" aria-hidden="true" />
      {liveCount} live
    </Link>
  )
}

export function WorkbenchRoutes() {
  return (
    <Routes>
      <Route path="/batches/:batchId/designs/:designId/photopea" element={<PhotopeaEditorPage />} />
      <Route element={<WorkbenchLayout />}>
        <Route path="/" element={<BatchListPage />} />
        <Route path="/batches/:batchId" element={<BatchDetailPage />} />
        <Route path="/batches/:batchId/designs/:designId" element={<DesignReviewPage />} />
        <Route path="/batches/:batchId/sheet" element={<SheetPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/batches/:batchId/jobs" element={<JobsPage />} />
        <Route
          path="*"
          element={
            <section className="card">
              <h1 className="card-title">Page not found</h1>
              <p className="muted">
                The workbench has no screen at this address. Use Batches to get back to your
                intake queue.
              </p>
            </section>
          }
        />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <SettingsProvider>
        <WorkbenchRoutes />
      </SettingsProvider>
    </BrowserRouter>
  )
}
