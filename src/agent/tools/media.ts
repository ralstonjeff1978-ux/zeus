import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname, sep, join, basename } from 'node:path'
import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'
import { loadRegistry, findBrain } from '../../registry/registry.ts'
import { generateImage, synthesizeSpeech, transcribeAudio } from '../../adapters/media.ts'
import { recordCall } from '../../core/ledger.ts'

/**
 * Media tools.
 *
 * Pictures, speech, transcription and video assembly. The brain doing the
 * generating is chosen from the registry exactly like any other, so pointing
 * Zeus at a different image model is a registry edit, not a code change.
 */

function contain(pathArg: string, ctx: ToolContext): string {
  const abs = resolve(ctx.cwd, pathArg)
  const inside = ctx.allowedRoots.some(r => {
    const root = resolve(r)
    return abs === root || abs.startsWith(root + sep)
  })
  if (!inside) throw new Error(`"${pathArg}" is outside the allowed roots.`)
  return abs
}

/** Resolve a brain of the required kind, by id or by taking the first that fits. */
async function brainOfKind(kind: string, id?: string) {
  const reg = await loadRegistry()
  if (id) {
    const b = findBrain(reg, id)
    if (b.kind !== kind) throw new Error(`Brain "${id}" is kind "${b.kind}", not "${kind}".`)
    return b
  }
  const b = reg.brains.find(x => x.kind === kind)
  if (!b) {
    throw new Error(
      `No brain of kind "${kind}" is registered. Add one to brains.yaml — for example a local ComfyUI or ` +
        `Automatic1111 server for images, or a hosted endpoint. Zeus has no built-in generator.`,
    )
  }
  return b
}

export const generateImageTool: Tool = {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt using an image brain from the registry, and save it. Describe the subject, composition, lighting and style concretely — vague prompts produce vague images.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      path: { type: 'string', description: 'Where to save, e.g. renders/concept.png' },
      brain: { type: 'string', description: 'Image brain id. Defaults to the first registered.' },
      negative: { type: 'string', description: 'What to avoid' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      count: { type: 'integer', description: 'How many to generate. Defaults to 1.' },
      seed: { type: 'integer', description: 'For reproducibility' },
    },
    required: ['prompt', 'path'],
  },
  async run(
    input: { prompt: string; path: string; brain?: string; negative?: string; width?: number; height?: number; count?: number; seed?: number },
    ctx,
  ): Promise<ToolResult> {
    let brain
    try {
      brain = await brainOfKind('image', input.brain)
    } catch (e) {
      return fail((e as Error).message)
    }

    const abs = contain(input.path, ctx)
    if (!(await ctx.confirm(`Generate image via ${brain.label}`, `${input.prompt.slice(0, 200)}\n  → ${input.path}`))) {
      return fail('Denied by user.')
    }

    const started = performance.now()
    try {
      const res = await generateImage(brain, {
        prompt: input.prompt,
        negative: input.negative,
        width: input.width,
        height: input.height,
        count: input.count,
        seed: input.seed,
      })
      await mkdir(dirname(abs), { recursive: true })

      const written: string[] = []
      for (let i = 0; i < res.images.length; i++) {
        const target = res.images.length === 1 ? abs : abs.replace(/(\.\w+)?$/, `-${i + 1}$1`)
        await Bun.write(target, Buffer.from(res.images[i]!, 'base64'))
        written.push(target)
      }

      recordCall(brain, {
        bytesSent: Buffer.byteLength(input.prompt),
        usage: { costUsd: 0 },
        durationMs: Math.round(performance.now() - started),
        ok: true,
        context: 'generate_image',
      })

      return ok(
        `Generated ${written.length} image${written.length > 1 ? 's' : ''} with ${brain.label}` +
          `${res.seed !== undefined ? ` (seed ${res.seed})` : ''}:\n${written.join('\n')}`,
      )
    } catch (e) {
      recordCall(brain, {
        bytesSent: Buffer.byteLength(input.prompt),
        usage: {},
        durationMs: Math.round(performance.now() - started),
        ok: false,
        error: (e as Error).message,
        context: 'generate_image',
      })
      return fail(`Image generation failed: ${(e as Error).message}`)
    }
  },
}

export const speakTool: Tool = {
  name: 'speak',
  description: 'Turn text into spoken audio using an audio brain from the registry, saved to a file.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      path: { type: 'string', description: 'Output file, e.g. narration.mp3' },
      brain: { type: 'string' },
      voice: { type: 'string' },
    },
    required: ['text', 'path'],
  },
  async run(input: { text: string; path: string; brain?: string; voice?: string }, ctx): Promise<ToolResult> {
    let brain
    try {
      brain = await brainOfKind('audio', input.brain)
    } catch (e) {
      return fail((e as Error).message)
    }
    const abs = contain(input.path, ctx)
    if (!(await ctx.confirm('Synthesize speech', `${input.text.slice(0, 120)}… → ${input.path}`))) {
      return fail('Denied by user.')
    }
    try {
      const res = await synthesizeSpeech(brain, { text: input.text, voice: input.voice })
      await mkdir(dirname(abs), { recursive: true })
      await Bun.write(abs, res.audio)
      return ok(`Wrote ${(res.audio.byteLength / 1024).toFixed(0)}KB of audio to ${input.path}`)
    } catch (e) {
      return fail(`Speech synthesis failed: ${(e as Error).message}`)
    }
  },
}

export const transcribeTool: Tool = {
  name: 'transcribe',
  description: 'Transcribe an audio or video file to text using a transcribe brain from the registry.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Audio or video file to transcribe' },
      brain: { type: 'string' },
    },
    required: ['path'],
  },
  async run(input: { path: string; brain?: string }, ctx): Promise<ToolResult> {
    let brain
    try {
      brain = await brainOfKind('transcribe', input.brain)
    } catch (e) {
      return fail((e as Error).message)
    }
    const abs = contain(input.path, ctx)
    if (!existsSync(abs)) return fail(`No such file: ${input.path}`)
    try {
      const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer())
      const res = await transcribeAudio(brain, bytes, basename(abs))
      return ok(res.text || '(no speech detected)')
    } catch (e) {
      return fail(`Transcription failed: ${(e as Error).message}`)
    }
  },
}

/** ffmpeg verbs Zeus will construct. Free-form ffmpeg is available via the shell tools. */
const FFMPEG_OPS: Record<string, (i: { input: string; input2?: string; output: string; extra?: string }) => string[]> = {
  convert: i => ['-y', '-i', i.input, i.output],
  extract_audio: i => ['-y', '-i', i.input, '-vn', '-acodec', 'libmp3lame', i.output],
  frames: i => ['-y', '-i', i.input, '-vf', i.extra ?? 'fps=1', i.output],
  images_to_video: i => ['-y', '-framerate', i.extra ?? '24', '-i', i.input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', i.output],
  add_audio: i => ['-y', '-i', i.input, '-i', i.input2 ?? '', '-c:v', 'copy', '-c:a', 'aac', '-shortest', i.output],
  trim: i => ['-y', '-i', i.input, '-ss', (i.extra ?? '0').split(',')[0]!, '-to', (i.extra ?? '0,10').split(',')[1] ?? '10', i.output],
  info: i => ['-i', i.input],
}

export const ffmpegTool: Tool = {
  name: 'ffmpeg',
  description:
    'Convert, trim, mux and inspect audio and video. Operations: convert, extract_audio, frames, images_to_video, add_audio, trim, info. Requires ffmpeg — check with check_capability first.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: Object.keys(FFMPEG_OPS) },
      input: { type: 'string' },
      input2: { type: 'string', description: 'Second input, for add_audio' },
      output: { type: 'string' },
      extra: {
        type: 'string',
        description: 'Operation parameter: fps filter for frames, framerate for images_to_video, "start,end" for trim',
      },
    },
    required: ['operation', 'input'],
  },
  async run(
    input: { operation: string; input: string; input2?: string; output?: string; extra?: string },
    ctx,
  ): Promise<ToolResult> {
    const build = FFMPEG_OPS[input.operation]
    if (!build) return fail(`Unknown operation "${input.operation}". Known: ${Object.keys(FFMPEG_OPS).join(', ')}`)

    const inAbs = contain(input.input, ctx)
    const outAbs = input.output ? contain(input.output, ctx) : ''
    if (input.operation !== 'info' && !outAbs) return fail('An output path is required for this operation.')
    const in2Abs = input.input2 ? contain(input.input2, ctx) : undefined

    if (!(await ctx.confirm('ffmpeg', `${input.operation}: ${input.input} → ${input.output ?? '(stdout)'}`))) {
      return fail('Denied by user.')
    }
    if (outAbs) await mkdir(dirname(outAbs), { recursive: true })

    const args = build({ input: inAbs, input2: in2Abs, output: outAbs, extra: input.extra })
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 900_000)
    try {
      const p = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe', signal: ctl.signal })
      const [o, e, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ])
      const out = [o, e].filter(Boolean).join('\n')
      // `ffmpeg -i` with no output is how you inspect a file; it exits nonzero by design.
      if (input.operation === 'info') return ok(out.slice(-6000))
      if (code !== 0) return { content: `ffmpeg exited ${code}\n${out.slice(-4000)}`, isError: true }
      return ok(`Wrote ${input.output}\n${out.slice(-1500)}`)
    } catch (err) {
      return fail(`ffmpeg could not run: ${(err as Error).message}. Check it is installed with check_capability.`)
    } finally {
      clearTimeout(timer)
    }
  },
}

export const diagramTool: Tool = {
  name: 'make_diagram',
  description:
    'Render a Mermaid or Graphviz diagram to SVG. Use for block diagrams, schematics-as-blocks, flowcharts and architecture. Falls back to writing the source when the renderer is not installed.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Mermaid or DOT source' },
      path: { type: 'string', description: 'Output .svg path' },
      language: { type: 'string', enum: ['mermaid', 'dot'] },
    },
    required: ['source', 'path', 'language'],
  },
  async run(input: { source: string; path: string; language: string }, ctx): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    if (!(await ctx.confirm('Render diagram', input.path))) return fail('Denied by user.')
    await mkdir(dirname(abs), { recursive: true })

    const srcPath = abs.replace(/\.svg$/i, '') + (input.language === 'dot' ? '.dot' : '.mmd')
    await Bun.write(srcPath, input.source)

    const argv =
      input.language === 'dot' ? ['dot', '-Tsvg', srcPath, '-o', abs] : ['mmdc', '-i', srcPath, '-o', abs, '-b', 'transparent']

    try {
      const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
      const code = await p.exited
      if (code === 0 && existsSync(abs)) return ok(`Rendered ${input.path}`)
      const err = await new Response(p.stderr).text()
      return ok(
        `Renderer failed (exit ${code}); the source was written to ${srcPath} instead.\n` +
          `${input.language === 'dot' ? 'Install Graphviz' : 'Install with: npm i -g @mermaid-js/mermaid-cli'}\n${err.slice(0, 300)}`,
      )
    } catch {
      return ok(
        `No renderer installed, so the diagram source was written to ${srcPath}.\n` +
          `${input.language === 'dot' ? 'Install Graphviz (winget install Graphviz.Graphviz)' : 'Install with: npm i -g @mermaid-js/mermaid-cli'}`,
      )
    }
  },
}

export const mediaTools: Tool[] = [generateImageTool, speakTool, transcribeTool, ffmpegTool, diagramTool]
