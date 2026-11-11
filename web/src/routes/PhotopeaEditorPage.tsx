import { useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, type DesignDetail, type DesignVersion } from '../api/client'
import { PhotopeaEditor, type PhotopeaEditorHandle } from '../components/photopea/PhotopeaEditor'
import { PhotopeaIcon } from '../components/photopea/PhotopeaIcon'
import { Dialog } from '../components/ui/Dialog'
import { ErrorBanner } from '../components/ui/Banner'
import { ErrorState, Loading } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'
import {
  arrayBufferToPngFile,
  downloadArrayBuffer,
  photopeaExportFileName,
} from '../lib/photopea'
import { formatPixels, shortId, stepLabel } from '../lib/format'
import '../components/photopea/photopea.css'

function versionFor(design: DesignDetail, versionId: string | null): DesignVersion | undefined {
  if (versionId) {
    return design.versions.find((version) => version.id === versionId)
  }
  return design.versions.find((version) => version.id === design.currentVersionId)
}

export default function PhotopeaEditorPage() {
  const { batchId = '', designId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const versionId = searchParams.get('versionId')
  const navigate = useNavigate()
  const editorRef = useRef<PhotopeaEditorHandle>(null)

  const { state, reload } = useAsync(
    (signal) => api.designs.get(designId, { signal }),
    [designId],
  )
  const design = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
  const loadError = state.kind === 'error' ? state.error : null

  const [editorError, setEditorError] = useState<Error | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmSave, setConfirmSave] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<Error | null>(null)

  if (state.kind === 'loading' || (state.kind === 'reloading' && !design)) {
    return (
      <div className="photopea-page">
        <div className="photopea-toolbar">
          <Link className="btn" to={`/batches/${batchId}/designs/${designId}`}>
            Back to design
          </Link>
        </div>
        <div className="photopea-stage">
          <div className="photopea-overlay">
            <Loading label="Loading design…" />
          </div>
        </div>
      </div>
    )
  }

  if (loadError || !design) {
    return (
      <div className="photopea-page">
        <div className="photopea-toolbar">
          <Link className="btn" to={`/batches/${batchId}`}>
            Back to batch
          </Link>
        </div>
        <div className="photopea-stage">
          <div className="photopea-overlay">
            <ErrorState
              error={loadError ?? new Error('Design not found')}
              onRetry={() => void reload()}
              title="Could not open this design in Photopea"
            />
          </div>
        </div>
      </div>
    )
  }

  const version = versionFor(design, versionId)
  if (!version) {
    return (
      <div className="photopea-page">
        <div className="photopea-toolbar">
          <Link className="btn" to={`/batches/${batchId}/designs/${designId}`}>
            Back to design
          </Link>
        </div>
        <div className="photopea-stage">
          <div className="photopea-overlay">
            <div className="photopea-overlay-card">
              <strong>Version not found</strong>
              <p>
                This design has no version matching{' '}
                <span className="mono">{versionId ?? 'current'}</span>.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const exportName = photopeaExportFileName(design.name, version)
  const backTo = `/batches/${batchId}/designs/${designId}`

  const exportBuffer = async (): Promise<ArrayBuffer | null> => {
    setSaveError(null)
    setSaveMessage(null)
    setBusy(true)
    try {
      const buffer = await editorRef.current?.exportPng()
      if (!buffer) {
        throw new Error('Photopea is still starting. Wait until the editor is ready.')
      }
      return buffer
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause : new Error('Export failed.'))
      return null
    } finally {
      setBusy(false)
    }
  }

  const downloadEdited = async () => {
    const buffer = await exportBuffer()
    if (!buffer) return
    downloadArrayBuffer(buffer, exportName)
    setSaveMessage(`Downloaded ${exportName}. The original version is unchanged.`)
  }

  const saveAsReadyToPack = async () => {
    const buffer = await exportBuffer()
    if (!buffer) return
    setConfirmSave(false)
    setBusy(true)
    setSaveMessage('Saving edited PNG as a new ready-to-pack design…')
    try {
      const file = arrayBufferToPngFile(buffer, exportName)
      const created = await api.designs.upload(batchId, {
        file,
        name: `${design.name} (Photopea)`,
        readyToPack: true,
      })
      setSaveMessage('Saved as a new ready-to-pack design. Opening it…')
      navigate(`/batches/${batchId}/designs/${created.id}`)
    } catch (cause) {
      setSaveMessage(null)
      setSaveError(cause instanceof Error ? cause : new Error('Could not save the edited PNG.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="photopea-page" data-testid="photopea-editor-page">
      <header className="photopea-toolbar">
        <Link className="btn" to={backTo} data-testid="photopea-back">
          Back to design
        </Link>
        <div className="photopea-toolbar-title">
          <strong>
            <PhotopeaIcon /> {design.name}
          </strong>
          <span className="mono">
            {stepLabel(version.stepType)} · {formatPixels(version.widthPx)} ×{' '}
            {formatPixels(version.heightPx)} · {shortId(version.id)}
          </span>
        </div>
        <div className="photopea-toolbar-actions">
          <button
            type="button"
            className="btn"
            disabled={!editorReady || busy}
            onClick={() => void downloadEdited()}
            data-testid="photopea-download"
          >
            Download PNG
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!editorReady || busy}
            onClick={() => setConfirmSave(true)}
            data-testid="photopea-save"
            title="Creates a new ready-to-pack design. The source version stays unchanged."
          >
            Save as ready-to-pack
          </button>
        </div>
      </header>

      {(saveError || editorError || saveMessage) && (
        <div style={{ padding: '8px 14px' }}>
          {saveError ? <ErrorBanner error={saveError} title="Could not return the edit" /> : null}
          {editorError && !saveError ? (
            <ErrorBanner error={editorError} title="Photopea reported a problem" />
          ) : null}
          {saveMessage ? (
            <p className="hint" role="status" data-testid="photopea-save-status">
              {saveMessage}
            </p>
          ) : null}
        </div>
      )}

      <PhotopeaEditor
        ref={editorRef}
        fileUrl={version.fileUrl}
        documentName={exportName}
        onStatusChange={(status, nextError) => {
          setEditorReady(status === 'ready')
          setEditorError(
            status === 'error'
              ? new Error(nextError ?? 'Photopea could not open. Check that www.photopea.com is reachable.')
              : null,
          )
        }}
      />

      {confirmSave ? (
        <Dialog
          title="Save edited artwork?"
          onClose={() => {
            if (!busy) setConfirmSave(false)
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmSave(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void saveAsReadyToPack()}
                data-testid="photopea-confirm-save"
              >
                Save as new design
              </button>
            </>
          }
        >
          <p>
            PrintSheet will export a PNG from Photopea and upload it as a{' '}
            <strong>new ready-to-pack design</strong> in this batch. The version you opened (
            {stepLabel(version.stepType)}, {shortId(version.id)}) is not overwritten.
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}
