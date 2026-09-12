import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { summary, recentRemote, totalSpend } from '../core/ledger.ts'
import { C, table } from './style.ts'

/** Audit commands: what left the machine, and document rendering. */

export async function cmdLedger(opts: { remote?: boolean; since?: string }): Promise<number> {
  if (opts.remote) {
    const rows = recentRemote(60)
    if (!rows.length) {
      console.log(C.green('Nothing has left this machine.'))
      return 0
    }
    console.log(C.bold('Recent calls that left this machine\n'))
    for (const r of rows) {
      const mark = r.ok ? C.dim('·') : C.red('✗')
      console.log(
        `${mark} ${r.ts.slice(0, 19).replace('T', ' ')}  ${C.yellow(r.host.padEnd(28))} ${r.brainId.padEnd(28)}` +
          C.dim(` ${(r.bytesSent / 1024).toFixed(1)}KB sent  ${r.inputTokens}/${r.outputTokens} tok` +
            (r.costUsd ? `  $${r.costUsd.toFixed(4)}` : '') +
            (r.context ? `  ${r.context}` : '')),
      )
    }
    return 0
  }

  const rows = summary(opts.since)
  if (!rows.length) {
    console.log('No calls recorded yet.')
    return 0
  }

  const body = rows.map(r => [
    r.locality === 'remote' ? C.yellow('CLOUD') : C.green('LOCAL'),
    r.host,
    String(r.calls),
    `${(r.bytesSent / 1024 / 1024).toFixed(2)} MB`,
    `${r.inputTokens.toLocaleString()}/${r.outputTokens.toLocaleString()}`,
    r.costUsd ? `$${r.costUsd.toFixed(4)}` : '—',
    r.lastAt.slice(0, 16).replace('T', ' '),
  ])

  console.log(table(body, ['WHERE', 'HOST', 'CALLS', 'SENT', 'TOKENS in/out', 'COST', 'LAST']))

  const remote = rows.filter(r => r.locality === 'remote')
  const sent = remote.reduce((n, r) => n + r.bytesSent, 0)
  console.log(
    `\n${C.dim('Total spend')} $${totalSpend(opts.since).toFixed(4)}   ` +
      `${C.dim('Left this machine')} ${(sent / 1024 / 1024).toFixed(2)} MB to ${remote.length} host(s)`,
  )
  console.log(C.dim('\nThis ledger is local. Zeus never transmits it, and never blocks a call — it only records.'))
  return 0
}

export async function cmdPdf(file: string): Promise<number> {
  const abs = resolve(file)
  if (!existsSync(abs)) {
    console.error(C.red(`No such file: ${file}`))
    return 1
  }

  const candidates = [
    process.env.ZEUS_CHROME,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]

  const chrome = candidates.find(c => existsSync(c))
  if (!chrome) {
    console.error(
      C.red('No headless Chrome or Edge found.') +
        '\nInstall Edge or Chrome, or set $ZEUS_CHROME to the executable.',
    )
    return 1
  }

  const out = abs.replace(/\.html?$/i, '') + '.pdf'
  const proc = Bun.spawn(
    [chrome, '--headless', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${out}`, '--print-to-pdf-no-header', `file:///${abs.replace(/\\/g, '/')}`],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const code = await proc.exited
  if (code !== 0 || !existsSync(out)) {
    console.error(C.red(`Rendering failed (exit ${code}).`))
    console.error(C.dim((await new Response(proc.stderr).text()).slice(0, 500)))
    return 1
  }
  console.log(`${C.green('Wrote')} ${out}`)
  return 0
}
