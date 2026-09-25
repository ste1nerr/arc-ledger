import { useMemo, useState } from 'react'
import { exportFiles, type ExportFormat } from '../export/formats'
import type { Annotations, CanonicalReport } from '../report/types'
import { download } from './format'

const FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: 'generic', label: 'Generic CSV', note: 'Every field at full precision; fees are separate rows. Opens in Google Sheets and Excel.' },
  { id: 'xero', label: 'Xero', note: 'Bank statement CSV, one file per asset (map USDC to a USD account, EURC to a EUR account). Amounts rounded to cents with an exact rounding line.' },
  { id: 'qbo', label: 'QuickBooks', note: '4-column CSV (Date, Description, Credit, Debit), one file per asset, split at 1,000 lines. Map Credit to money received.' },
  { id: 'json', label: 'JSON report', note: 'The canonical report plus your private labels. Keep this file: it is what an auditor drops into Verify.' },
]

export function ExportView({ report, annotations }: { report: CanonicalReport; annotations: Annotations }) {
  const [format, setFormat] = useState<ExportFormat>('generic')
  const files = useMemo(() => exportFiles(format, report, annotations), [format, report, annotations])
  const [fileIdx, setFileIdx] = useState(0)
  const file = files[Math.min(fileIdx, files.length - 1)]!
  const preview = useMemo(() => {
    const lines = file.content.replace(/^\ufeff/, '').split(/\r?\n/)
    return format === 'json' ? lines.slice(0, 40).join('\n') + (lines.length > 40 ? '\n…' : '') : lines.slice(0, 6).join('\n')
  }, [file, format])
  const meta = FORMATS.find((f) => f.id === format)!

  return (
    <section className="card">
      <h2>Export</h2>
      <div className="seg" role="group" aria-label="Format">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={format === f.id}
            onClick={() => {
              setFormat(f.id)
              setFileIdx(0)
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="muted small">{meta.note} All dates are UTC. Decimal separator is “.”, with no thousands separators.</p>

      {files.length > 1 && (
        <div className="seg" role="group" aria-label="File">
          {files.map((f, i) => (
            <button key={f.name} type="button" aria-pressed={i === fileIdx} onClick={() => setFileIdx(i)} className="small">
              {f.name.replace(/^arc-ledger_[^_]+_[^_]+_[^_]+_/, '')}
            </button>
          ))}
        </div>
      )}

      <p className="small mono">{file.name}</p>
      <pre className="preview" aria-label="Preview">
        {preview}
      </pre>
      <p className="muted small">{format === 'json' ? 'Preview of the first lines.' : 'Header and first 5 rows.'}</p>

      <div className="actions">
        {files.map((f) => (
          <button key={f.name} className="btn" type="button" onClick={() => download(f.name, f.mime, f.content)}>
            Download {files.length > 1 ? f.name.replace(/^.*_(xero|qbo)_/, '') : meta.label}
          </button>
        ))}
      </div>
    </section>
  )
}
