import { loadRegistry } from '../registry/registry.ts'
import { createServer } from '../serve/server.ts'
import { C } from './style.ts'

/** Router mode: serve the registry behind an Anthropic-shaped endpoint. */

export async function cmdServe(opts: { port: number; host?: string; fallbacks?: string[] }): Promise<number> {
  const reg = await loadRegistry()
  if (!reg.brains.length) {
    console.error(C.red('No brains registered. Run "zeus discover --save" first.'))
    return 1
  }

  const host = opts.host ?? '127.0.0.1'
  const server = createServer({
    registry: reg,
    port: opts.port,
    host,
    fallbacks: opts.fallbacks,
    onLog: line => console.error(C.dim(`  ${line}`)),
  })

  const base = `http://${host}:${opts.port}`
  const chat = reg.brains.filter(b => b.kind === 'chat')

  console.log(`${C.bold('Zeus router')} listening on ${C.cyan(base)}\n`)
  console.log(`  ${chat.length} chat brains served. Ask for one by id as the model name:\n`)
  for (const b of chat.slice(0, 12)) {
    const tag = b.locality === 'remote' ? C.yellow('CLOUD') : C.green('LOCAL')
    console.log(`    ${tag}  ${b.id}`)
  }
  if (chat.length > 12) console.log(C.dim(`    … and ${chat.length - 12} more`))

  console.log(`\n${C.dim('Point any Anthropic-compatible client at it:')}`)
  console.log(`  $env:ANTHROPIC_BASE_URL = "${base}"`)
  console.log(`  $env:ANTHROPIC_API_KEY  = "zeus"   ${C.dim('# unused, but clients expect one')}`)
  console.log(`\n${C.dim('Failover, the tool-call shim and cost accounting all apply. Ctrl-C to stop.')}`)

  await new Promise<void>(resolve => {
    const stop = () => {
      console.log(C.dim('\nStopping.'))
      server.stop()
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  return 0
}
