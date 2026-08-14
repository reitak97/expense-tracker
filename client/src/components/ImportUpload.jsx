import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useImportProgress } from '../hooks/useImportProgress'

// Upload a bank statement CSV and watch it import.
//
// The request returns as soon as the work is queued — categorizing thousands of
// rows can't finish inside an HTTP request — so what the user watches after
// that is progress pushed from the server, not this component waiting.

const API_URL = import.meta.env.VITE_API_URL

// Matches the server's multer limit. Checked here too so an oversized file
// fails instantly instead of after a long upload.
const MAX_FILE_BYTES = 10 * 1024 * 1024

export default function ImportUpload({ onImported }) {
  const { getToken } = useAuth()
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [importId, setImportId] = useState(null)
  const fileInput = useRef(null)

  // Generated once per selected file and reused if the upload is retried, so a
  // retry after a flaky connection returns the existing import instead of
  // creating a second copy of every row.
  const idempotencyKey = useRef(null)

  const { progress, transport, error: progressError } = useImportProgress(importId)
  const settled = progress?.status === 'COMPLETED' || progress?.status === 'FAILED'

  // The imported rows are ordinary expenses once they land, so the list above
  // has to refetch. Runs on the transition into a settled state, not on
  // every progress frame.
  useEffect(() => {
    if (settled) onImported?.()
  }, [settled, onImported])

  function selectFile(event) {
    const selected = event.target.files?.[0] ?? null
    setUploadError(null)

    if (selected && selected.size > MAX_FILE_BYTES) {
      setUploadError('That file is larger than 10MB.')
      setFile(null)
      return
    }

    setFile(selected)
    idempotencyKey.current = selected ? crypto.randomUUID() : null
  }

  function reset() {
    setFile(null)
    setImportId(null)
    setUploadError(null)
    idempotencyKey.current = null
    if (fileInput.current) fileInput.current.value = ''
  }

  async function upload() {
    if (!file || uploading) return

    setUploading(true)
    setUploadError(null)

    try {
      const token = await getToken()
      const body = new FormData()
      body.append('file', file)

      const response = await fetch(`${API_URL}/imports`, {
        method: 'POST',
        // No Content-Type: the browser sets the multipart boundary itself.
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey.current,
        },
        body,
      })

      const payload = await response.json()

      if (!response.ok) {
        // The server explains exactly what was wrong with the file — a missing
        // column, an unparseable line — so show that rather than a generic error.
        setUploadError(payload.error || 'Upload failed.')
        return
      }

      // 200 means this key was already used and the existing import came back;
      // either way there is now an import to watch.
      setImportId(payload.id)
    } catch (error) {
      setUploadError(error.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">Import a statement</h2>
      <p className="text-sm text-gray-500 mb-4">
        A CSV with <span className="font-medium">date</span>,{' '}
        <span className="font-medium">description</span>, and{' '}
        <span className="font-medium">amount</span> columns. Categories are filled in for you.
      </p>

      {!importId && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            onChange={selectFile}
            className="flex-1 min-w-0 text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
          />
          <button
            type="button"
            onClick={upload}
            disabled={!file || uploading}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {uploading ? 'Uploading…' : 'Import'}
          </button>
        </div>
      )}

      {uploadError && <p className="mt-3 text-sm text-red-600">{uploadError}</p>}

      {importId && (
        <ImportStatus
          progress={progress}
          transport={transport}
          error={progressError}
          settled={settled}
          onDone={reset}
        />
      )}
    </div>
  )
}

// The live half: a bar while the worker chews through batches, a summary once
// it stops.
function ImportStatus({ progress, transport, error, settled, onDone }) {
  // Between the upload returning and the first frame arriving there is nothing
  // to render a bar from yet.
  if (!progress) {
    return <p className="mt-2 text-sm text-gray-500">Queued. Waiting for the first update…</p>
  }

  // Both come from the server. Rows rejected individually carry a reason;
  // rows lost with a whole failed batch do not, and counting them as imported
  // is how "1000 of 1000" gets reported when 900 landed.
  const failedRows = progress.failedRows ?? 0
  const unprocessedRows = progress.unprocessedRows ?? 0
  const importedRows = progress.importedRows ?? progress.totalRows - failedRows

  return (
    <div className="mt-2">
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-sm font-medium text-gray-700">{progress.filename}</span>
        <span className="text-sm text-gray-500">{progress.percentComplete}%</span>
      </div>

      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            progress.status === 'FAILED' ? 'bg-red-500' : 'bg-indigo-600'
          }`}
          style={{ width: `${progress.percentComplete}%` }}
        />
      </div>

      <p className="mt-2 text-sm text-gray-500">
        {progress.batches.settled} of {progress.batches.total} batches
        {progress.batches.failed > 0 && (
          <span className="text-amber-600"> · {progress.batches.failed} failed</span>
        )}
        {/* Worth surfacing: it explains why updates feel slower than usual. */}
        {transport === 'polling' && <span className="text-gray-400"> · reconnecting</span>}
      </p>

      {settled && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          {progress.status === 'COMPLETED' ? (
            <p className="text-sm text-gray-700">
              Imported <span className="font-medium">{importedRows}</span> of {progress.totalRows}{' '}
              rows.
              {failedRows > 0 && (
                <span className="text-amber-600"> {failedRows} rows couldn&apos;t be read.</span>
              )}
              {unprocessedRows > 0 && (
                <span className="text-amber-600">
                  {' '}
                  {unprocessedRows} rows were in a batch that failed and can be re-uploaded.
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-red-600">
              This import failed. Nothing was double-counted — re-uploading the same file is safe.
            </p>
          )}

          <button
            type="button"
            onClick={onDone}
            className="mt-3 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            Import another
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
