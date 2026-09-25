/** Guard (REPORT_SPEC §1.1): money code never converts to JS floats. Mirrors the ESLint rule. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../src')
const MONEY_DIRS = ['money', 'report', 'export', 'chain']
const FORBIDDEN: [RegExp, string][] = [
  [/\bparseFloat\s*\(/, 'parseFloat('],
  [/(?<![\w.])Number\s*\(/, 'Number('],
  [/\.toFixed\s*\(/, '.toFixed('],
  [/(?<![\w.'"`/])\d*\.\d+(?![\w.])/, 'float literal'],
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('no JS floats in money code', () => {
  for (const d of MONEY_DIRS) {
    for (const file of files(join(ROOT, d))) {
      it(file.slice(ROOT.length + 1), () => {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""') // drop string literals
        const hits = FORBIDDEN.filter(([re]) => re.test(code)).map(([, name]) => name)
        expect(hits, `forbidden in ${file}`).toEqual([])
      })
    }
  }
})
