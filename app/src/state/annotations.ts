/**
 * Private annotations: counterparty labels and row categories. Stored in this browser only,
 * never hashed and never sent on chain (REPORT_SPEC §3.3).
 */
import { useCallback, useState } from 'react'
import { CATEGORIES, rowKey, type Annotations, type CanonicalRow, type Category } from '../report/types'
import { readJson, writeJson } from './storage'

const KEY = 'arc-ledger:annotations:v1'

function load(): Annotations {
  const raw = readJson<Partial<Annotations>>(KEY, {})
  const labels: Record<string, string> = {}
  const categories: Record<string, Category> = {}
  for (const [k, v] of Object.entries(raw.counterpartyLabels ?? {})) if (typeof v === 'string' && v) labels[k.toLowerCase()] = v.slice(0, 200)
  for (const [k, v] of Object.entries(raw.categories ?? {})) if (CATEGORIES.includes(v as Category)) categories[k.toLowerCase()] = v as Category
  return { counterpartyLabels: labels, categories }
}

export interface AnnotationsApi {
  annotations: Annotations
  saved: boolean
  setLabel(address: string, label: string): void
  setCategory(row: CanonicalRow, category: Category): void
  /** Only the annotations that touch the given rows (what goes into an export). */
  forRows(rows: CanonicalRow[]): Annotations
}

export function useAnnotations(): AnnotationsApi {
  const [annotations, setAnnotations] = useState<Annotations>(load)
  const [saved, setSaved] = useState(true)

  const update = useCallback((fn: (a: Annotations) => Annotations) => {
    setAnnotations((prev) => {
      const next = fn(prev)
      setSaved(writeJson(KEY, next))
      return next
    })
  }, [])

  const setLabel = useCallback(
    (address: string, label: string) =>
      update((a) => {
        const labels = { ...a.counterpartyLabels }
        const clean = label.trim().slice(0, 200)
        if (clean) labels[address.toLowerCase()] = clean
        else delete labels[address.toLowerCase()]
        return { ...a, counterpartyLabels: labels }
      }),
    [update],
  )

  const setCategory = useCallback(
    (row: CanonicalRow, category: Category) =>
      update((a) => {
        const categories = { ...a.categories }
        if (category === 'uncategorized') delete categories[rowKey(row)]
        else categories[rowKey(row)] = category
        return { ...a, categories }
      }),
    [update],
  )

  const forRows = useCallback(
    (rows: CanonicalRow[]): Annotations => {
      const labels: Record<string, string> = {}
      const categories: Record<string, Category> = {}
      for (const r of rows) {
        const l = annotations.counterpartyLabels[r.counterparty]
        if (l) labels[r.counterparty] = l
        const c = annotations.categories[rowKey(r)]
        if (c) categories[rowKey(r)] = c
      }
      return { counterpartyLabels: labels, categories }
    },
    [annotations],
  )

  return { annotations, saved, setLabel, setCategory, forRows }
}
