import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { fetchLedgerCached, type LedgerResult, type Progress } from './chain/ledger'
import { isAbort } from './chain/rpc'
import { PERIOD_CLOSE_REGISTRY } from './config/arc'
import { reportHash } from './report/canonical'
import { useAnnotations } from './state/annotations'
import { getRpc } from './state/settings'
import { ExportView } from './ui/ExportView'
import { addrUrl, errorMessage, formatDuration } from './ui/format'
import { LedgerView } from './ui/LedgerView'
import { describePeriod } from './ui/periods'
import { ProgressPanel } from './ui/ProgressPanel'
import { QueryForm, type Query } from './ui/QueryForm'
import { VerifyView } from './ui/VerifyView'

const CloseView = lazy(() => import('./ui/CloseView'))

type Page = 'ledger' | 'verify'
type Tab = 'ledger' | 'export' | 'close'
type Job =
  | { status: 'idle' }
  | { status: 'running'; query: Query; progress: Progress | null; startedAt: number; ctrl: AbortController }
  | { status: 'error'; query: Query; message: string }
  | { status: 'done'; query: Query; result: LedgerResult }

const pageFromHash = (): Page => (globalThis.location?.hash === '#/verify' ? 'verify' : 'ledger')

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash)
  const [job, setJob] = useState<Job>({ status: 'idle' })
  const [tab, setTab] = useState<Tab>('ledger')
  const api = useAnnotations()
  const jobRef = useRef(job)
  jobRef.current = job

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (p: Page) => {
    window.location.hash = p === 'verify' ? '#/verify' : ''
    setPage(p)
  }

  async function run(query: Query) {
    if (jobRef.current.status === 'running') jobRef.current.ctrl.abort()
    const ctrl = new AbortController()
    setTab('ledger')
    setJob({ status: 'running', query, progress: null, startedAt: Date.now(), ctrl })
    try {
      const result = await fetchLedgerCached(query.address, query.period.start, query.period.end, {
        rpc: getRpc(query.customRpc),
        assets: query.assets,
        signal: ctrl.signal,
        onProgress: (progress) => setJob((j) => (j.status === 'running' && j.ctrl === ctrl ? { ...j, progress } : j)),
      })
      setJob((j) => (j.status === 'running' && j.ctrl === ctrl ? { status: 'done', query, result } : j))
    } catch (e) {
      if (isAbort(e)) setJob((j) => (j.status === 'running' && j.ctrl === ctrl ? { status: 'idle' } : j))
      else setJob((j) => (j.status === 'running' && j.ctrl === ctrl ? { status: 'error', query, message: errorMessage(e) } : j))
    }
  }

  const done = job.status === 'done' ? job : null
  const hash = useMemo(() => (done ? reportHash(done.result.report) : null), [done])

  return (
    <div className="app">
      <header className="top">
        <a
          className="brand"
          href="#/"
          onClick={(e) => {
            e.preventDefault()
            go('ledger')
          }}
        >
          <Logo /> Arc Ledger <small>books for Arc mainnet</small>
        </a>
        <nav className="tabs" aria-label="Main">
          <button type="button" aria-current={page === 'ledger' ? 'page' : undefined} onClick={() => go('ledger')}>
            Ledger
          </button>
          <button type="button" aria-current={page === 'verify' ? 'page' : undefined} onClick={() => go('verify')}>
            Verify
          </button>
        </nav>
      </header>

      <main>
        {page === 'verify' ? (
          <VerifyView />
        ) : (
          <>
            {job.status !== 'done' && (
              <>
                <h1>Exact books for your Arc address</h1>
                <p className="lead">
                  Every USDC and EURC movement in a period, with memos and network fees in exact dollars (gas on Arc is paid in USDC). Export to Xero, QuickBooks or CSV,
                  then close the period on chain so an auditor can verify the file later. Runs entirely in your browser from public chain data.
                </p>
              </>
            )}

            {job.status !== 'running' && (job.status !== 'done' ? <QueryForm onSubmit={run} busy={false} /> : null)}

            {job.status === 'running' && <ProgressPanel progress={job.progress} startedAt={job.startedAt} onCancel={() => job.ctrl.abort()} />}

            {job.status === 'error' && (
              <div className="error" role="alert">
                <strong>Could not build the ledger.</strong> {job.message}
                <div className="actions" style={{ marginTop: 8 }}>
                  <button type="button" className="btn secondary" onClick={() => run(job.query)}>
                    Retry
                  </button>
                </div>
              </div>
            )}

            {done && hash && (
              <>
                <section className="card">
                  <div className="actions" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <h2 style={{ margin: 0 }}>
                        <a className="mono" href={addrUrl(done.query.address)} target="_blank" rel="noreferrer">
                          {done.query.address}
                        </a>
                      </h2>
                      <p className="muted small" style={{ margin: '4px 0 0' }}>
                        {describePeriod(done.query.period)} · blocks {done.result.report.blockRange.from}–{done.result.report.blockRange.to} ·{' '}
                        {done.result.report.rows.length} movements · read in {formatDuration(done.result.stats.ms)} ({done.result.stats.rpcCalls} RPC calls)
                      </p>
                    </div>
                    <button type="button" className="btn secondary" onClick={() => setJob({ status: 'idle' })}>
                      New query
                    </button>
                  </div>
                  {done.result.partial && (
                    <p className="notice small">This period is still in progress: the ledger covers blocks up to the latest one and will change. It cannot be closed yet.</p>
                  )}
                </section>

                <nav className="tabs" aria-label="Report" style={{ marginBottom: 16 }}>
                  {(['ledger', 'export', 'close'] as Tab[]).map((t) => (
                    <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
                      {t === 'ledger' ? 'Ledger' : t === 'export' ? 'Export' : 'Close period'}
                    </button>
                  ))}
                </nav>

                {tab === 'ledger' && <LedgerView report={done.result.report} api={api} />}
                {tab === 'export' && <ExportView report={done.result.report} annotations={api.forRows(done.result.report.rows)} />}
                {tab === 'close' && (
                  <Suspense fallback={<p className="muted">Loading wallet tools…</p>}>
                    <CloseView report={done.result.report} hash={hash} headTimestamp={done.result.head.timestamp} annotations={api.forRows(done.result.report.rows)} />
                  </Suspense>
                )}
              </>
            )}
          </>
        )}
      </main>

      <footer>
        <p>
          All dates and periods are UTC. Amounts are exact (USDC at 18 decimals, EURC at 6); exports to Xero and QuickBooks round to cents with an explicit rounding line.
        </p>
        <p>
          Data: public Arc mainnet RPC · no server, no accounts, no tracking ·{' '}
          <a href="https://github.com/ste1nerr/arc-ledger" target="_blank" rel="noreferrer">
            source
          </a>
          {PERIOD_CLOSE_REGISTRY && (
            <>
              {' '}
              ·{' '}
              <a href={addrUrl(PERIOD_CLOSE_REGISTRY)} target="_blank" rel="noreferrer">
                PeriodCloseRegistry
              </a>
            </>
          )}
        </p>
      </footer>
    </div>
  )
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path d="M8 22 L16 8 L24 22" stroke="var(--bg)" strokeWidth="3" fill="none" strokeLinejoin="round" />
      <path d="M11 17 H21" stroke="var(--bg)" strokeWidth="3" />
    </svg>
  )
}
