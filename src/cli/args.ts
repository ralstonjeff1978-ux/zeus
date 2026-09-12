/**
 * A small argument parser.
 *
 * Zeus takes no dependency for this: the surface is a handful of flags, and a
 * parser we own is one fewer thing that can change under us.
 */

export type Parsed = {
  _: string[]
  flags: Record<string, string | boolean | string[]>
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { _: [], flags: {} }

  /**
   * Repeating a flag accumulates rather than overwrites, so both
   * `--brains a,b` and `--brains a --brains b` work. PowerShell splits an
   * unquoted `a,b` into separate arguments, which would otherwise silently
   * drop every value but the first.
   */
  const set = (key: string, value: string | boolean) => {
    const prior = out.flags[key]
    if (prior === undefined) out.flags[key] = value
    else if (typeof value === 'boolean') out.flags[key] = value
    else if (Array.isArray(prior)) prior.push(value)
    else if (typeof prior === 'string') out.flags[key] = [prior, value]
    else out.flags[key] = value
  }

  let i = 0
  while (i < argv.length) {
    const a = argv[i]!
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        set(a.slice(2, eq), a.slice(eq + 1))
        i++
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        set(key, true)
        i++
      } else {
        set(key, next)
        i += 2
      }
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        set(key, true)
        i++
      } else {
        set(key, next)
        i += 2
      }
      continue
    }
    out._.push(a)
    i++
  }
  return out
}

export function str(p: Parsed, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = p.flags[n]
    if (typeof v === 'string') return v
  }
  return undefined
}

export function bool(p: Parsed, ...names: string[]): boolean {
  for (const n of names) if (p.flags[n] === true || p.flags[n] === 'true') return true
  return false
}

export function num(p: Parsed, ...names: string[]): number | undefined {
  const v = str(p, ...names)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function list(p: Parsed, ...names: string[]): string[] | undefined {
  const parts: string[] = []
  for (const n of names) {
    const v = p.flags[n]
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) parts.push(...v)
  }
  if (!parts.length) return undefined
  const out = parts.flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  return out.length ? out : undefined
}
