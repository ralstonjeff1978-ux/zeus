/** Terminal styling. Honours NO_COLOR and non-TTY output. */

const enabled = !process.env.NO_COLOR && process.stdout.isTTY !== false

const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s)

export const C = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  grey: wrap('90'),
}

export function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows
  if (!all.length) return ''
  const widths = all[0]!.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length)))
  const fmt = (r: string[]) =>
    r
      .map((cell, i) => {
        const visible = cell.replace(/\x1b\[[0-9;]*m/g, '').length
        return cell + ' '.repeat(Math.max(0, widths[i]! - visible))
      })
      .join('  ')
      .trimEnd()
  const out: string[] = []
  if (headers) {
    out.push(C.dim(fmt(headers)))
    out.push(C.dim(widths.map(w => '─'.repeat(w)).join('  ')))
  }
  for (const r of rows) out.push(fmt(r))
  return out.join('\n')
}
