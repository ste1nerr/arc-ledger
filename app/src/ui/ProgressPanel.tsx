import { useEffect, useState } from 'react'
import type { Progress } from '../chain/ledger'
import { formatDuration } from './format'

const PHASES: Progress['phase'][] = ['range', 'logs', 'receipts', 'blocks', 'balances']
// Rough share of total work per phase, for one overall bar.
const WEIGHT: Record<string, number> = { range: 0.03, logs: 0.72, receipts: 0.15, blocks: 0.07, balances: 0.03 }

export function overallFraction(p: Progress): number {
  if (p.phase === 'done') return 1
  let f = 0
  for (const ph of PHASES) {
    if (ph === p.phase) {
      const inner = p.phase === 'logs' && p.blocksTotal ? Number(((p.blocksScanned ?? 0n) * 1000n) / p.blocksTotal) / 1000 : p.total ? p.done / p.total : 0
      return f + WEIGHT[ph]! * inner
    }
    f += WEIGHT[ph]!
  }
  return f
}

export function ProgressPanel({ progress, startedAt, onCancel }: { progress: Progress | null; startedAt: number; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const frac = progress ? overallFraction(progress) : 0
  const elapsed = now - startedAt
  const eta = frac > 0.05 ? (elapsed / frac) * (1 - frac) : null
  return (
    <div className="card" aria-live="polite">
      <h2>Reading Arc mainnet…</h2>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
        <div style={{ width: `${Math.max(2, frac * 100)}%` }} />
      </div>
      <p className="small">
        {progress?.message ?? 'Starting…'} <span className="muted">· {Math.round(frac * 100)}% · {formatDuration(elapsed)} elapsed</span>
        {eta !== null && <span className="muted"> · about {formatDuration(eta)} left</span>}
      </p>
      {progress?.phase === 'logs' && progress.blocksTotal ? (
        <p className="muted small">
          Blocks scanned: {progress.blocksScanned?.toLocaleString('en-US')} / {progress.blocksTotal.toLocaleString('en-US')} (the public RPC returns at most 10,000
          blocks per query)
        </p>
      ) : null}
      <button className="btn secondary" type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}
