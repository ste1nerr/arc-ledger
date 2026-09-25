/**
 * Close period: commit the report hash to PeriodCloseRegistry from the account that owns the books.
 * Loaded lazily so wagmi/WalletConnect only ship with this screen.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { BaseError, getAddress, type Hex } from 'viem'
import { createConfig, http, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain, useWaitForTransactionReceipt, useWriteContract, WagmiProvider } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { ARC_CHAIN_ID, arcMainnet, PERIOD_CLOSE_REGISTRY } from '../config/arc'
import { readCloses, registryAbi, type CloseRecord } from '../chain/registry'
import { exportJson } from '../export/formats'
import { formatUnitsExact } from '../money/decimal'
import type { Annotations, CanonicalReport } from '../report/types'
import { publicRpc } from '../state/settings'
import { download, errorMessage, shortHash, txUrl, unixToUtc } from './format'
import { describePeriod } from './periods'

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined

const wagmiConfig = createConfig({
  chains: [arcMainnet],
  transports: { [arcMainnet.id]: http('https://rpc.mainnet.arc.io') },
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            metadata: { name: 'Arc Ledger', description: 'Bookkeeping and tax exports for Arc', url: globalThis.location?.origin ?? 'https://arc-ledger.vercel.app', icons: [] },
          }),
        ]
      : []),
  ],
})
const queryClient = new QueryClient()

export interface CloseProps {
  report: CanonicalReport
  hash: Hex
  headTimestamp: number
  annotations: Annotations
}

export default function CloseView(props: CloseProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Close {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  )
}

function Close({ report, hash, headTimestamp, annotations }: CloseProps) {
  const account = getAddress(report.address)
  const [history, setHistory] = useState<CloseRecord[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [uri, setUri] = useState('')

  const [refresh, setRefresh] = useState(0)
  const loadHistory = useCallback(() => setRefresh((n) => n + 1), [])
  useEffect(() => {
    if (!PERIOD_CLOSE_REGISTRY) return
    let live = true
    readCloses(publicRpc(), PERIOD_CLOSE_REGISTRY, account).then(
      (h) => live && (setHistory(h), setHistoryError(null)),
      (e) => live && setHistoryError(errorMessage(e)),
    )
    return () => {
      live = false
    }
  }, [account, refresh])

  const periodOver = report.periodEnd <= headTimestamp
  const alreadyClosed = history?.find((c) => c.reportHash.toLowerCase() === hash.toLowerCase())
  const jsonFile = exportJson(report, annotations)

  return (
    <>
      <section className="card">
        <h2>Close the period on Arc</h2>
        <p className="muted small">
          Closing writes this report’s hash to the PeriodCloseRegistry contract, signed by the account itself. Anyone holding the JSON file can later prove it was not
          edited. Only the hash goes on chain, never the rows, labels or categories.
        </p>
        <dl className="kv">
          <dt>Account</dt>
          <dd>{account}</dd>
          <dt>Period</dt>
          <dd>{describePeriod({ start: report.periodStart, end: report.periodEnd })}</dd>
          <dt>Rows</dt>
          <dd>{report.rows.length}</dd>
          {report.assets.map((a) => (
            <FragmentTotals key={a} label={a} net={report.totals[a]!.net} fees={a === 'USDC' ? report.totals.USDC!.fees : null} />
          ))}
          <dt>reportHash</dt>
          <dd>{hash}</dd>
        </dl>
        <div className="notice small" style={{ marginTop: 12 }}>
          <strong>Download the JSON report first.</strong> The chain stores only the hash; you (or your accountant) need this exact file to verify later.
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn secondary" onClick={() => download(jsonFile.name, jsonFile.mime, jsonFile.content)}>
              Download {jsonFile.name}
            </button>
          </div>
        </div>
      </section>

      {!PERIOD_CLOSE_REGISTRY ? (
        <p className="notice">The PeriodCloseRegistry contract has not been deployed/configured in this build yet. Closing will be enabled once it is.</p>
      ) : !periodOver ? (
        <p className="notice">This period has not ended yet (the latest block is at {unixToUtc(headTimestamp)} UTC). Close it after it ends, so the report is complete.</p>
      ) : alreadyClosed ? (
        <p className="success">
          ✅ This exact report is already closed (close #{alreadyClosed.index + 1}, {unixToUtc(alreadyClosed.closedAt)} UTC).
        </p>
      ) : (
        <Sender report={report} hash={hash} account={account} uri={uri} setUri={setUri} onClosed={loadHistory} />
      )}

      <section className="card">
        <h2>Close history for this account</h2>
        {!PERIOD_CLOSE_REGISTRY ? (
          <p className="muted">Available once the registry is deployed.</p>
        ) : historyError ? (
          <p className="error">Could not read the registry: {historyError}</p>
        ) : history === null ? (
          <p className="muted">Loading…</p>
        ) : history.length === 0 ? (
          <p className="muted">No closes yet.</p>
        ) : (
          <HistoryTable history={history} currentHash={hash} />
        )}
      </section>
    </>
  )
}

function FragmentTotals({ label, net, fees }: { label: string; net: string; fees: string | null }) {
  return (
    <>
      <dt>{label} net</dt>
      <dd>{net}</dd>
      {fees !== null && (
        <>
          <dt>USDC fees</dt>
          <dd>{fees}</dd>
        </>
      )}
    </>
  )
}

function HistoryTable({ history, currentHash }: { history: CloseRecord[]; currentHash: Hex }) {
  const latestByPeriod = new Map<string, number>()
  for (const c of history) latestByPeriod.set(`${c.periodStart}-${c.periodEnd}`, c.index)
  return (
    <div className="table-wrap">
      <table className="ledger">
        <thead>
          <tr>
            <th>#</th>
            <th>Closed (UTC)</th>
            <th>Period</th>
            <th>Rows</th>
            <th>Hash</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((c) => {
            const latest = latestByPeriod.get(`${c.periodStart}-${c.periodEnd}`) === c.index
            return (
              <tr key={c.index}>
                <td data-label="#">{c.index + 1}</td>
                <td data-label="Closed (UTC)">{unixToUtc(c.closedAt)}</td>
                <td data-label="Period">{describePeriod({ start: c.periodStart, end: c.periodEnd })}</td>
                <td data-label="Rows">{c.rowCount}</td>
                <td data-label="Hash" className="mono" title={c.reportHash}>
                  {shortHash(c.reportHash)}
                  {c.reportHash.toLowerCase() === currentHash.toLowerCase() && ' (this report)'}
                </td>
                <td data-label="Status">{latest ? <span className="badge in">current</span> : <span className="badge">amended later</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Sender({ report, hash, account, uri, setUri, onClosed }: { report: CanonicalReport; hash: Hex; account: `0x${string}`; uri: string; setUri: (s: string) => void; onClosed: () => void }) {
  const connection = useConnection()
  const connectors = useConnectors()
  const { connect, isPending: connecting, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain()
  const { writeContract, data: txHash, isPending: signing, error: writeError, reset } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId: ARC_CHAIN_ID })

  useEffect(() => {
    if (receipt.isSuccess) onClosed()
  }, [receipt.isSuccess, onClosed])

  const uriOk = uri === '' || /^(https:\/\/|ipfs:\/\/)\S+$/.test(uri)
  const connected = connection.status === 'connected' ? connection : null
  const sameAccount = connected?.address?.toLowerCase() === account.toLowerCase()
  const onArc = connected?.chainId === ARC_CHAIN_ID

  const send = () => {
    reset()
    writeContract({
      address: PERIOD_CLOSE_REGISTRY!,
      abi: registryAbi,
      functionName: 'closePeriod',
      args: [hash, BigInt(report.periodStart), BigInt(report.periodEnd), report.rows.length, uri],
      chainId: ARC_CHAIN_ID,
    })
  }

  const err = (e: unknown) => (e instanceof BaseError ? e.shortMessage : errorMessage(e))

  if (receipt.isSuccess && receipt.data) {
    const r = receipt.data
    const fee = formatUnitsExact(r.gasUsed * r.effectiveGasPrice, 18)
    return (
      <section className="card">
        {r.status === 'success' ? <p className="success result">✅ Period closed.</p> : <p className="error result">❌ The transaction reverted.</p>}
        <dl className="kv">
          <dt>Transaction</dt>
          <dd>
            <a href={txUrl(r.transactionHash)} target="_blank" rel="noreferrer">
              {r.transactionHash}
            </a>
          </dd>
          <dt>Block</dt>
          <dd>{r.blockNumber.toString()}</dd>
          <dt>Fee paid</dt>
          <dd>{fee} USDC</dd>
        </dl>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>Sign with {account.slice(0, 6)}…{account.slice(-4)}</h2>
      {!connected ? (
        <>
          <p className="muted small">Connect the wallet that controls this address. Your wallet shows the exact fee before you confirm (about 0.004 USDC).</p>
          <div className="actions">
            {connectors.map((c) => (
              <button key={c.uid} type="button" className="btn" disabled={connecting} onClick={() => connect({ connector: c, chainId: ARC_CHAIN_ID })}>
                {c.name === 'Injected' ? 'Browser wallet' : c.name}
              </button>
            ))}
          </div>
          {!WC_PROJECT_ID && <p className="muted small">WalletConnect is not configured in this build; use a browser wallet.</p>}
          {connectError && <p className="error small">{err(connectError)}</p>}
        </>
      ) : !sameAccount ? (
        <>
          <p className="error">
            The connected wallet is <span className="mono">{connected.address}</span>, but this report belongs to <span className="mono">{account}</span>. The registry
            records closes under the sender’s address, so only that account can close its own books. Switch accounts in your wallet.
          </p>
          <button type="button" className="btn secondary" onClick={() => disconnect()}>
            Disconnect
          </button>
        </>
      ) : !onArc ? (
        <>
          <p className="notice">Your wallet is on another network. Switch to Arc mainnet (chain {ARC_CHAIN_ID}).</p>
          <button type="button" className="btn" disabled={switching} onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}>
            Switch to Arc
          </button>
          {switchError && <p className="error small">{err(switchError)}</p>}
        </>
      ) : (
        <>
          <label className="field">
            <span>Report location (optional)</span>
            <input type="url" className="mono" placeholder="https://… or ipfs://…" value={uri} onChange={(e) => setUri(e.target.value.trim())} aria-invalid={!uriOk} />
          </label>
          <p className="muted small">Stored publicly on chain. Leave empty if the file is private.</p>
          {!uriOk && <p className="error small">Use an https:// or ipfs:// link, or leave it empty.</p>}
          <div className="actions">
            <button type="button" className="btn" disabled={!uriOk || signing || receipt.isLoading} onClick={send}>
              {signing ? 'Confirm in your wallet…' : receipt.isLoading ? 'Waiting for the block…' : 'Close period'}
            </button>
            <button type="button" className="btn secondary" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
          {txHash && receipt.isLoading && (
            <p className="muted small">
              Sent:{' '}
              <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                {txHash}
              </a>
            </p>
          )}
          {writeError && <p className="error small">{err(writeError)}</p>}
          {receipt.error && <p className="error small">{err(receipt.error)}</p>}
        </>
      )}
    </section>
  )
}
