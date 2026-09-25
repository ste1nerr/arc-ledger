/**
 * localStorage access for private, per-browser data only (labels, categories, settings).
 * Every access is wrapped: storage can be missing, full or blocked (private mode, previews).
 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
