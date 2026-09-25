import { useMemo, useState } from 'react'
import type { Asset } from '../config/arc'
import type { AnnotationsApi } from '../state/annotations'
import { CATEGORIES, rowKey, type CanonicalReport, type CanonicalRow, type Category, type Direction } from '../report/types'
import { addrUrl, displayAmount, shortAddr, txUrl, utcDateTime } from './format'

function Totals({ report }: { report: CanonicalReport }) {
  return (
    <div className="totals">
      {report.assets.map((a) => {
        const t = report.totals[a]!
        const r = report.reconciliation[a]
        const unexplained = r && r.unexplained !== '0'
        return (
          <section className="card" key={a} aria-label={`${a} totals`}>
            <h2>{a}</h2>
            <dl className="kv">
              <dt>In</dt>
              <dd className="pos" title={t.in}>
                {displayAmount(t.in, 18)}
              </dd>
              <dt>Out</dt>
              <dd className="neg" title={t.out}>
                {displayAmount(t.out, 18)}
              </dd>
              <dt>Network fees</dt>
              <dd title={t.fees}>{a === 'USDC' ? displayAmount(t.fees, 18) : '—'}</dd>
              <dt>Net</dt>
              <dd title={t.net}>
                <strong>{displayAmount(t.net, 18)}</strong>
              </dd>
              {r && (
                <>
                  <dt>Opening balance</dt>
                  <dd title={r.opening}>{displayAmount(r.opening, 18)}</dd>
                  <dt>Closing balance</dt>
                  <dd title={r.closing}>{displayAmount(r.closing, 18)}</dd>
                  <dt>Unexplained</dt>
                  <dd className={unexplained ? 'neg' : 'pos'} title={r.unexplained}>
                    {unexplained ? displayAmount(r.unexplained, 18) : '0 ✓'}
                  </dd>
                </>
              )}
            </dl>
          </section>
        )
      })}
    </div>
  )
}

function Reconciliation({ report }: { report: CanonicalReport }) {
  const { sentTxCount, itemizedSentTxCount } = report.reconciliation
  const gaps = report.assets.filter((a) => report.reconciliation[a]?.unexplained !== '0')
  if (gaps.length === 0 && sentTxCount === itemizedSentTxCount) {
    return <p className="success small">Reconciled: opening balance + movements − fees equals the on-chain closing balance exactly, for every asset.</p>
  }
  return (
    <div className="notice small">
      <strong>Not everything is itemized.</strong>{' '}
      {sentTxCount > itemizedSentTxCount && (
        <>
          This address sent {sentTxCount} transactions in the period, {sentTxCount - itemizedSentTxCount} of them moved no USDC/EURC to or from it (approvals, contract
          calls…). Their gas fees are real but no Transfer log lists them, so they appear only in the <em>Unexplained</em> line.{' '}
        </>
      )}
      {gaps.length > 0 && <>The unexplained amount is exact and included in every export, so imported statements still end at the true on-chain balance.</>}
    </div>
  )
}

export function LedgerView({ report, api }: { report: CanonicalReport; api: AnnotationsApi }) {
  const [dir, setDir] = useState<'' | Direction>('')
  const [asset, setAsset] = useState<'' | Asset>('')
  const [cat, setCat] = useState<'' | Category>('')
  const { annotations } = api

  const rows = useMemo(
    () =>
      report.rows.filter(
        (r) => (!dir || r.direction === dir) && (!asset || r.asset === asset) && (!cat || (annotations.categories[rowKey(r)] ?? 'uncategorized') === cat),
      ),
    [report.rows, dir, asset, cat, annotations.categories],
  )

  return (
    <>
      <Totals report={report} />
      <Reconciliation report={report} />

      <section className="card">
        <div className="filters">
          <select aria-label="Direction" value={dir} onChange={(e) => setDir(e.target.value as '' | Direction)}>
            <option value="">All directions</option>
            <option value="in">In</option>
            <option value="out">Out</option>
            <option value="self">Self</option>
          </select>
          <select aria-label="Asset" value={asset} onChange={(e) => setAsset(e.target.value as '' | Asset)}>
            <option value="">All assets</option>
            {report.assets.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value as '' | Category)}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span className="muted small" style={{ alignSelf: 'center' }}>
            {rows.length} of {report.rows.length} movements · times in UTC
          </span>
        </div>
        <p className="muted small">
          🔒 Labels and categories are private: saved only in this browser, never hashed and never put on chain.
          {!api.saved && <strong> This browser blocks local storage, so edits will be lost on reload.</strong>}
        </p>

        {report.rows.length === 0 ? (
          <p className="muted">No USDC or EURC movements for this address in this period.</p>
        ) : rows.length === 0 ? (
          <p className="muted">No movements match these filters.</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date (UTC)</th>
                  <th>Dir</th>
                  <th>Asset</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Counterparty</th>
                  <th>Memo</th>
                  <th style={{ textAlign: 'right' }}>Fee (USDC)</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={rowKey(r)} row={r} api={api} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

/** Memos are often "A|B|C" tokens without spaces: allow line breaks after separators. */
function Memo({ text }: { text: string }) {
  const parts = text.split(/(?<=[|/,;_])/)
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </>
  )
}

function Row({ row: r, api }: { row: CanonicalRow; api: AnnotationsApi }) {
  const label = api.annotations.counterpartyLabels[r.counterparty] ?? ''
  const category = api.annotations.categories[rowKey(r)] ?? 'uncategorized'
  const sign = r.direction === 'out' ? '-' : r.direction === 'in' ? '+' : ''
  return (
    <tr>
      <td data-label="Date (UTC)" className="date">
        <a href={txUrl(r.txHash)} target="_blank" rel="noreferrer" title={`${r.txHash} · log ${r.logIndex}`}>
          {utcDateTime(r.timestamp)}
        </a>
      </td>
      <td data-label="Direction">
        <span className={`badge ${r.direction}`}>{r.direction}</span>
      </td>
      <td data-label="Asset">{r.asset}</td>
      <td data-label="Amount" className={`num ${r.direction === 'in' ? 'pos' : r.direction === 'out' ? 'neg' : ''}`} title={`${sign}${r.amount} ${r.asset}`}>
        {sign}
        {displayAmount(r.amount)}
      </td>
      <td data-label="Counterparty">
        <div>
          <a className="mono" href={addrUrl(r.counterparty)} target="_blank" rel="noreferrer" title={r.counterparty}>
            {r.counterparty === '0x0000000000000000000000000000000000000000' ? 'mint / burn (0x0)' : shortAddr(r.counterparty)}
          </a>
          <input
            type="text"
            aria-label={`Label for ${r.counterparty}`}
            placeholder="Add label"
            defaultValue={label}
            key={label}
            onBlur={(e) => e.target.value !== label && api.setLabel(r.counterparty, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            style={{ marginTop: 4 }}
          />
        </div>
      </td>
      <td data-label="Memo" className="small" style={{ overflowWrap: 'break-word', minWidth: '8em' }}>
        {r.memo === null ? <span className="muted">—</span> : <Memo text={r.memo} />}
      </td>
      <td data-label="Fee (USDC)" className="num" title={r.feeUSDC ?? 'Paid by someone else or already counted on another row of this tx'}>
        {r.feeUSDC ? displayAmount(r.feeUSDC, 9) : <span className="muted">—</span>}
      </td>
      <td data-label="Category">
        <select aria-label="Category" value={category} onChange={(e) => api.setCategory(r, e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </td>
    </tr>
  )
}
