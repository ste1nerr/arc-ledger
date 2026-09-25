import { useState } from 'react'
import { getAddress, type Hex } from 'viem'
import { ARC_CHAIN_ID, PERIOD_CLOSE_REGISTRY } from '../config/arc'
import { findCloseTx, readCloses, verifyAgainst, type CloseRecord, type VerifyOutcome } from '../chain/registry'
import { reportHash } from '../report/canonical'
import { checkReportConsistency, parseReportFile } from '../report/file'
import type { ReportFile } from '../report/types'
import { publicRpc } from '../state/settings'
import { addrUrl, errorMessage, txUrl, unixToUtc } from './format'
import { describePeriod } from './periods'

type State =
  | { status: 'idle' }
  | { status: 'checking'; fileName: string }
  | { status: 'error'; message: string; fileName?: string }
  | { status: 'done'; fileName: string; file: ReportFile; hash: Hex; problems: string[]; outcome: VerifyOutcome | null; closeTx: Hex | null; newerTx: Hex | null }

export function VerifyView() {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [over, setOver] = useState(false)

  async function check(f: File) {
    setState({ status: 'checking', fileName: f.name })
    try {
      if (f.size > 20 * 1024 * 1024) throw new Error('This file is larger than 20 MB, which is not an Arc Ledger report.')
      const file = parseReportFile(await f.text())
      const hash = reportHash(file.report)
      const problems = checkReportConsistency(file.report)
      if (file.report.chainId !== ARC_CHAIN_ID) problems.unshift(`This report is for chain ${file.report.chainId}, not Arc mainnet (${ARC_CHAIN_ID}).`)
      let outcome: VerifyOutcome | null = null
      let closeTx: Hex | null = null
      let newerTx: Hex | null = null
      if (PERIOD_CLOSE_REGISTRY) {
        const rpc = publicRpc()
        const account = getAddress(file.report.address)
        const closes = await readCloses(rpc, PERIOD_CLOSE_REGISTRY, account)
        outcome = verifyAgainst(closes, hash, file.report.periodStart, file.report.periodEnd)
        const lookup = (c: CloseRecord) => findCloseTx(rpc, PERIOD_CLOSE_REGISTRY!, account, c).catch(() => null)
        if (outcome.kind !== 'no-match') closeTx = await lookup(outcome.close)
        if (outcome.kind === 'amended') newerTx = await lookup(outcome.newer)
      }
      setState({ status: 'done', fileName: f.name, file, hash, problems, outcome, closeTx, newerTx })
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e), fileName: f.name })
    }
  }

  const onFiles = (files: FileList | null) => {
    const f = files?.[0]
    if (f) void check(f)
  }

  return (
    <>
      <h1>Verify a closed report</h1>
      <p className="lead">
        Drop an Arc Ledger <span className="mono">.report.json</span> file. Its hash is recomputed in your browser and compared with the <em>PeriodCloseRegistry</em>{' '}
        contract on Arc mainnet. No wallet needed, and the file never leaves your device.
      </p>

      <label
        className={`dropzone card ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          onFiles(e.dataTransfer.files)
        }}
      >
        <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => onFiles(e.target.files)} />
        <strong>Drop the report file here</strong>
        <br />
        <span className="muted small">or click to choose a file</span>
      </label>

      {state.status === 'checking' && <p className="muted">Checking {state.fileName}…</p>}
      {state.status === 'error' && (
        <div className="error">
          <strong>Could not verify {state.fileName ?? 'the file'}.</strong> {state.message}
        </div>
      )}
      {state.status === 'done' && <Result state={state} />}
    </>
  )
}

function Result({ state }: { state: Extract<State, { status: 'done' }> }) {
  const { file, hash, outcome, problems } = state
  const r = file.report
  return (
    <section className="card" aria-live="polite">
      {!PERIOD_CLOSE_REGISTRY ? (
        <p className="notice">The PeriodCloseRegistry contract is not configured in this build yet, so only the hash is shown.</p>
      ) : outcome?.kind === 'match' ? (
        <p className="success result">
          ✅ Matches close #{outcome.close.index + 1} at {unixToUtc(outcome.close.closedAt)} UTC
        </p>
      ) : outcome?.kind === 'amended' ? (
        <p className="notice result">
          ⚠️ This file matches close #{outcome.close.index + 1} ({unixToUtc(outcome.close.closedAt)} UTC), but an amended version exists: close #{outcome.newer.index + 1} at{' '}
          {unixToUtc(outcome.newer.closedAt)} UTC with a newer hash.
        </p>
      ) : (
        <p className="error result">❌ No matching close. {outcome && outcome.samePeriod.length > 0 ? 'This period was closed with a different hash: this file was edited or is a different version.' : 'This account has not closed a report with this hash.'}</p>
      )}

      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Account</dt>
        <dd>
          <a href={addrUrl(r.address)} target="_blank" rel="noreferrer">
            {getAddress(r.address)}
          </a>
        </dd>
        <dt>Period</dt>
        <dd>{describePeriod({ start: r.periodStart, end: r.periodEnd })}</dd>
        <dt>Rows</dt>
        <dd>{r.rows.length}</dd>
        <dt>Recomputed hash</dt>
        <dd>{hash}</dd>
        {file.reportHash !== hash && (
          <>
            <dt>Hash written in the file</dt>
            <dd className="neg">{file.reportHash} (differs: the report was changed after export)</dd>
          </>
        )}
        {state.closeTx && (
          <>
            <dt>Close transaction</dt>
            <dd>
              <a href={txUrl(state.closeTx)} target="_blank" rel="noreferrer">
                {state.closeTx}
              </a>
            </dd>
          </>
        )}
        {state.newerTx && (
          <>
            <dt>Amendment transaction</dt>
            <dd>
              <a href={txUrl(state.newerTx)} target="_blank" rel="noreferrer">
                {state.newerTx}
              </a>
            </dd>
          </>
        )}
        {outcome && (
          <>
            <dt>Closes by this account</dt>
            <dd>{outcome.total}</dd>
          </>
        )}
      </dl>

      {problems.length > 0 && (
        <div className="notice small" style={{ marginTop: 12 }}>
          <strong>Internal inconsistencies found in the file:</strong>
          <ul>
            {problems.slice(0, 10).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted small">
        Only the <span className="mono">report</span> part of the file is hashed. Private labels and categories can differ without affecting the result.
      </p>
    </section>
  )
}
