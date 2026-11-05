import { NavLink, Route, Routes, BrowserRouter } from 'react-router-dom'
import BatchDetailPage from './routes/BatchDetailPage'
import BatchListPage from './routes/BatchListPage'
import DesignReviewPage from './routes/DesignReviewPage'
import SettingsPage from './routes/SettingsPage'
import SheetPage from './routes/SheetPage'
import { SettingsProvider } from './state/SettingsContext'
import { HealthDot } from './components/ui/HealthDot'
import './styles/shell.css'

export function WorkbenchRoutes() {
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
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Settings
          </NavLink>
        </nav>
        <div className="topbar-meta">
          <HealthDot />
          <span className="pill">contract 1.0.0</span>
        </div>
      </header>

      <main className="workspace">
        <Routes>
          <Route path="/" element={<BatchListPage />} />
          <Route path="/batches/:batchId" element={<BatchDetailPage />} />
          <Route path="/batches/:batchId/designs/:designId" element={<DesignReviewPage />} />
          <Route path="/batches/:batchId/sheet" element={<SheetPage />} />
          <Route path="/settings" element={<SettingsPage />} />
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
        </Routes>
      </main>

      <footer className="statusbar">
        <span>The machine proposes, the human approves, nothing is lost.</span>
        <span className="muted">sRGB only · no staff authentication (trusted LAN MVP)</span>
      </footer>
    </div>
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
