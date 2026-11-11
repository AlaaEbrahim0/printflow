import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, type DesignDetail, type DesignVersion } from '../api/client'
import { toDisplayMessage } from '../api/problem'
import { ManualEditor } from '../components/manual-editor/ManualEditor'
import { useAsync } from '../hooks/useAsync'

function pick(design: DesignDetail, id: string | null): DesignVersion | undefined {
  return design.versions.find(v => v.id === id) ?? design.versions.find(v => v.id === design.currentVersionId)
}

export default function ManualEditorPage() {
  const { batchId = '', designId = '' } = useParams()
  const [query] = useSearchParams()
  const navigate = useNavigate()
  const { state, reload } = useAsync(signal => api.designs.get(designId, { signal }), [designId])
  const design = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
  const version = design && pick(design, query.get('versionId'))
  const back = () => navigate(`/batches/${batchId}/designs/${designId}`)

  if (!design || !version) {
    return (
      <div className="card">
        {state.kind === 'error' ? (
          <>
            <h2>Could not open the manual editor</h2>
            <p>{toDisplayMessage(state.error)}</p>
            <div className="row">
              <button className="btn primary" onClick={reload}>
                Retry
              </button>
              <button className="btn" onClick={back}>
                Back to design
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Loading editor…</p>
        )}
      </div>
    )
  }

  return (
    <ManualEditor
      title={design.name}
      fileUrl={version.fileUrl}
      onBack={back}
      onSave={async file => {
        await api.designs.manualEdit(designId, version.id, file)
      }}
    />
  )
}
