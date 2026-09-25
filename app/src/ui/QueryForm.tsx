import { useMemo, useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import type { Asset } from '../config/arc'
import { loadCustomRpc, saveCustomRpc, validRpcUrl } from '../state/settings'
import { customPeriod, describePeriod, estimateScan, isoDay, presetPeriod, PRESETS, type Period, type PresetId } from './periods'

export interface Query {
  address: Address
  period: Period
  assets: Asset[]
  customRpc: string
}

/** A real, moderately active mainnet EOA with memos, EURC swaps and relayed payments (test/fixtures/business.json). */
export const SAMPLE = {
  address: '0x01dE545e8fEA5ecAAb78Ec2C09e6D98117F7687d' as Address,
  first: '2026-09-24',
  last: '2026-09-24',
}

export function addressError(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return 'An Arc address is 0x followed by 40 hex characters.'
  // Mixed case means EIP-55 checksum: reject typos. All-lower/all-upper carry no checksum.
  const hasChecksum = v.slice(2) !== v.slice(2).toLowerCase() && v.slice(2) !== v.slice(2).toUpperCase()
  if (hasChecksum && !isAddress(v, { strict: true })) return 'Checksum mismatch: check the address for a typo.'
  return null
}

export function QueryForm({ onSubmit, busy }: { onSubmit: (q: Query) => void; busy: boolean }) {
  const [address, setAddress] = useState('')
  const [preset, setPreset] = useState<PresetId>('last-month')
  const [first, setFirst] = useState(() => isoDay(presetPeriod('this-month').start))
  const [last, setLast] = useState(() => isoDay(Math.floor(Date.now() / 1000)))
  const [assets, setAssets] = useState<Asset[]>(['USDC', 'EURC'])
  const [rpc, setRpc] = useState(loadCustomRpc)
  const [touched, setTouched] = useState(false)

  const period = useMemo(() => (preset === 'custom' ? customPeriod(first, last) : presetPeriod(preset)), [preset, first, last])
  const addrErr = addressError(address)
  const rpcErr = rpc && !validRpcUrl(rpc) ? 'Enter an https:// URL.' : null
  const valid = !!address.trim() && !addrErr && !!period && assets.length > 0 && !rpcErr
  const estimate = period ? estimateScan(period) : null

  const toggle = (a: Asset) => setAssets((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!valid || !period) return
    saveCustomRpc(rpc)
    onSubmit({ address: getAddress(address.trim().toLowerCase()), period, assets, customRpc: rpc })
  }

  const useSample = () => {
    setAddress(SAMPLE.address)
    setPreset('custom')
    setFirst(SAMPLE.first)
    setLast(SAMPLE.last)
    setAssets(['USDC', 'EURC'])
    const p = customPeriod(SAMPLE.first, SAMPLE.last)!
    onSubmit({ address: SAMPLE.address, period: p, assets: ['USDC', 'EURC'], customRpc: rpc && validRpcUrl(rpc) ? rpc : '' })
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <label className="field">
        <span>Arc address</span>
        <input
          type="text"
          className="mono"
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && !!addrErr}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      {touched && addrErr && <p className="error small">{addrErr}</p>}

      <div className="field">
        <span style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>Period (UTC)</span>
        <div className="seg" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="row">
            <label className="field">
              <span>First day</span>
              <input type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
            </label>
            <label className="field">
              <span>Last day (included)</span>
              <input type="date" value={last} onChange={(e) => setLast(e.target.value)} />
            </label>
          </div>
        )}
        {period ? <p className="muted small">{describePeriod(period)}</p> : <p className="error small">The last day must not be before the first day.</p>}
      </div>

      <div className="checks" role="group" aria-label="Assets">
        {(['USDC', 'EURC'] as Asset[]).map((a) => (
          <label key={a}>
            <input type="checkbox" checked={assets.includes(a)} onChange={() => toggle(a)} /> {a}
          </label>
        ))}
      </div>
      {assets.length === 0 && <p className="error small">Pick at least one asset.</p>}

      <details>
        <summary>Advanced: use your own RPC</summary>
        <p className="small muted">
          The public Arc RPC allows about 1–2 log queries per second, so a month takes roughly 10–15 minutes. Paste your own archive RPC URL (for example a free
          Alchemy or QuickNode key) to go faster. It is stored only in this browser.
        </p>
        <label className="field">
          <span className="sr-only">RPC URL</span>
          <input type="url" className="mono" placeholder="https://…" value={rpc} onChange={(e) => setRpc(e.target.value)} aria-invalid={!!rpcErr} />
        </label>
        {rpcErr && <p className="error small">{rpcErr}</p>}
      </details>

      <div className="actions" style={{ marginTop: 16 }}>
        <button className="btn" type="submit" disabled={busy || (touched && !valid)}>
          Build ledger
        </button>
        <button className="btn secondary" type="button" onClick={useSample} disabled={busy}>
          Try with a sample address
        </button>
        {estimate && !rpc && (
          <span className="muted small">
            ≈ {estimate.calls} log queries, about {estimate.minutes} min on the public RPC
          </span>
        )}
      </div>
    </form>
  )
}
