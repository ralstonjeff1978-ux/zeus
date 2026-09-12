import { loadRegistry, saveRegistry, findBrain, registryPath } from '../registry/registry.ts'
import { discoverLocal } from '../registry/discover.ts'
import { probeBrain } from '../registry/probe.ts'
import { chatAdapterFor } from '../adapters/index.ts'
import type { Brain } from '../registry/schema.ts'
import { C } from './style.ts'

/** Brain registry commands: list, discover, probe, one-shot ask. */

function healthMark(b: Brain): string {
  if (!b.probed) return C.dim('untested')
  if (!b.probed.reachable) return C.red('unreachable')
  const bits: string[] = [C.green('ok')]
  if (b.kind === 'chat') bits.push(b.probed.toolCalls ? 'tools' : C.yellow('no-tools'))
  if (b.probed.streaming) bits.push('stream')
  if (b.probed.firstTokenMs) bits.push(C.dim(`${b.probed.firstTokenMs}ms`))
  return bits.join(' ')
}

export async function cmdBrains(): Promise<number> {
  const reg = await loadRegistry()
  if (!reg.brains.length) {
    console.log(`No brains registered. Run ${C.cyan('zeus discover --save')} to find your local models.`)
    return 0
  }

  for (const locality of ['local', 'remote'] as const) {
    const group = reg.brains.filter(b => b.locality === locality)
    if (!group.length) continue
    console.log(`\n${C.bold(locality === 'local' ? 'LOCAL' : 'CLOUD')} ${C.dim(`(${group.length})`)}`)
    for (const b of group) {
      const def = reg.default === b.id ? C.cyan(' *') : '  '
      const size = b.sizeGb ? C.dim(` ${b.sizeGb}GB`) : ''
      const roles = b.roles.length ? C.dim(` [${b.roles.join(',')}]`) : ''
      const price = b.price.in || b.price.out ? C.dim(` $${b.price.in}/$${b.price.out} per 1M`) : ''
      console.log(`${def}${b.id.padEnd(40)} ${b.kind.padEnd(6)}${size}${roles}${price}`)
      console.log(`    ${C.dim(b.label)}  ${healthMark(b)}`)
    }
  }
  console.log(`\n${C.dim(`${reg.brains.length} brains — ${registryPath()}`)}`)
  return 0
}

export async function cmdDiscover(save: boolean): Promise<number> {
  const vram = process.env.ZEUS_VRAM_GB ? Number(process.env.ZEUS_VRAM_GB) : undefined
  console.log(C.dim('Scanning local inference servers...'))
  const found = await discoverLocal(vram)

  if (!found.length) {
    console.log(
      'Nothing found. Zeus checks Ollama (11434), LM Studio (1234), llama.cpp (8080) and vLLM (8000).\n' +
        'Start one, or add a cloud brain to brains.yaml by hand.',
    )
    return 1
  }

  const reg = await loadRegistry()
  const existing = new Set(reg.brains.map(b => b.id))
  let added = 0

  for (const d of found) {
    const isNew = !existing.has(d.brain.id)
    const fit = d.fitsVram === null ? '' : d.fitsVram ? C.green(' fits VRAM') : C.yellow(' exceeds VRAM — will offload')
    const tag = d.brain.locality === 'remote' ? C.yellow(' [CLOUD]') : C.green(' [LOCAL]')
    console.log(`${isNew ? C.cyan('+') : C.dim('=')} ${d.brain.id.padEnd(42)}${tag}${fit}`)
    if (isNew && save) {
      reg.brains.push(d.brain)
      existing.add(d.brain.id)
      added++
    }
  }

  if (save) {
    if (added) {
      reg.default ??= reg.brains.find(b => b.locality === 'local' && b.roles.includes('coder'))?.id
      await saveRegistry(reg)
      console.log(`\n${C.green(`Added ${added} brains`)} to ${registryPath()}`)
      console.log(C.dim(`Run "zeus test --all" to find out which can actually call tools.`))
    } else {
      console.log(`\n${C.dim('Nothing new to add.')}`)
    }
  } else {
    console.log(`\n${C.dim(`Run with --save to write these to ${registryPath()}`)}`)
  }
  return 0
}

export async function cmdTest(target: string): Promise<number> {
  const reg = await loadRegistry()
  const targets = target === '--all' || target === 'all' ? reg.brains : [findBrain(reg, target)]
  if (!targets.length) {
    console.log('No brains to test.')
    return 1
  }

  let failures = 0
  for (const brain of targets) {
    process.stdout.write(`${brain.id.padEnd(42)} `)
    const caps = await probeBrain(brain)
    const idx = reg.brains.findIndex(b => b.id === brain.id)
    if (idx >= 0) reg.brains[idx]!.probed = caps

    if (!caps.reachable) {
      failures++
      console.log(C.red(`FAIL  ${(caps.error ?? 'unreachable').slice(0, 110)}`))
      continue
    }
    const bits = [C.green('ok')]
    if (brain.kind === 'chat') bits.push(caps.toolCalls ? C.green('tools') : C.yellow('NO TOOL CALLS'))
    else bits.push(C.dim(brain.kind))
    if (caps.streaming) bits.push('stream')
    if (caps.firstTokenMs) bits.push(C.dim(`${caps.firstTokenMs}ms to first token`))
    console.log(bits.join('  '))
  }

  await saveRegistry(reg)
  const noTools = targets.filter(t => t.kind === 'chat' && t.probed?.reachable && !t.probed.toolCalls)
  if (noTools.length) {
    console.log(
      C.dim(
        `\n${noTools.length} brain(s) cannot call tools natively. Zeus will drive them through its ` +
          `prompt-based shim instead, which works but is less reliable.`,
      ),
    )
  }
  if (failures) console.log(`\n${C.yellow(`${failures} of ${targets.length} brains failed.`)}`)
  return failures === targets.length ? 1 : 0
}

export async function cmdAsk(id: string, prompt: string): Promise<number> {
  const reg = await loadRegistry()
  const brain = findBrain(reg, id || reg.default || '')
  const adapter = chatAdapterFor(brain)

  const tag = brain.locality === 'remote' ? C.yellow('[CLOUD]') : C.green('[LOCAL]')
  console.error(C.dim(`${tag} ${brain.label}\n`))

  for await (const ev of adapter.chat(brain, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 8192,
  })) {
    switch (ev.type) {
      case 'text':
        process.stdout.write(ev.text)
        break
      case 'tool_use':
        process.stdout.write(C.cyan(`\n[tool ${ev.name}] ${JSON.stringify(ev.input)}\n`))
        break
      case 'error':
        console.error(`\n${C.red(ev.message)}`)
        return 1
      case 'done': {
        const u = ev.usage
        const cost = u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : ''
        console.error(C.dim(`\n\n${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out${cost}`))
        break
      }
    }
  }
  return 0
}
