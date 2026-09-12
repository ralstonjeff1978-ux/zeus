import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * Development tooling: version control, project recognition, tests.
 *
 * These exist because an agent that shells out for everything gets version
 * control subtly wrong and cannot reliably find a project's test command. Both
 * are worth encoding once, properly.
 */

const GIT_TIMEOUT = 60_000

async function exec(argv: string[], cwd: string, timeoutMs = GIT_TIMEOUT): Promise<{ code: number; out: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', signal: ctl.signal })
    const [o, e, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, out: [o, e].filter(Boolean).join('\n').trimEnd() }
  } catch (err) {
    return { code: -1, out: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

function contain(pathArg: string, ctx: ToolContext): string {
  const abs = resolve(ctx.cwd, pathArg)
  const inside = ctx.allowedRoots.some(r => {
    const root = resolve(r)
    return abs === root || abs.startsWith(root + sep)
  })
  if (!inside) throw new Error(`"${pathArg}" is outside the allowed roots.`)
  return abs
}

/** Read-only git verbs need no confirmation; the rest do. */
const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'branch', 'remote', 'describe',
  'rev-parse', 'ls-files', 'shortlog', 'stash', 'tag', 'config',
])

/** Git operations that discard work. Refused outright — too easy to lose data. */
const GIT_FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /^reset\b.*--hard/, why: 'discards uncommitted work irreversibly' },
  { re: /^clean\b.*-[a-z]*[fd]/, why: 'deletes untracked files irreversibly' },
  { re: /^push\b.*--force(?!-with-lease)/, why: 'can destroy a remote branch; use --force-with-lease' },
  { re: /^filter-branch\b|^filter-repo\b/, why: 'rewrites history irreversibly' },
]

export const gitTool: Tool = {
  name: 'git',
  description:
    'Run a git command in the project. Read-only verbs (status, log, diff, show, blame, branch) run without confirmation; anything that changes state asks first. Pass arguments as a list, not a shell string.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Git arguments, e.g. ["status","--short"] or ["commit","-m","message"]',
      },
      path: { type: 'string', description: 'Repository directory. Defaults to cwd.' },
    },
    required: ['args'],
  },
  async run(input: { args: string[]; path?: string }, ctx): Promise<ToolResult> {
    const args = (input.args ?? []).map(String)
    if (!args.length) return fail('No git arguments given.')
    const cwd = contain(input.path ?? '.', ctx)
    const joined = args.join(' ')

    for (const f of GIT_FORBIDDEN) {
      if (f.re.test(joined)) {
        return fail(
          `Refusing "git ${joined}" — it ${f.why}. If you genuinely need this, the user should run it themselves.`,
        )
      }
    }

    if (!GIT_READONLY.has(args[0]!)) {
      if (!(await ctx.confirm('git', joined))) return fail('Denied by user.')
    }

    const res = await exec(['git', ...args], cwd)
    if (res.code === -1) return fail(`git could not run: ${res.out}`)
    const body = res.out || '(no output)'
    return res.code === 0
      ? ok(body.slice(0, 40_000))
      : { content: `git exited ${res.code}\n${body.slice(0, 20_000)}`, isError: true }
  },
}

type ProjectInfo = {
  stack: string
  root: string
  install?: string
  build?: string
  test?: string
  lint?: string
  run?: string
}

/** Recognise a project from its manifest, and read the real script names out of it. */
async function detect(root: string): Promise<ProjectInfo[]> {
  const found: ProjectInfo[] = []
  const has = (f: string) => existsSync(join(root, f))

  if (has('package.json')) {
    let scripts: Record<string, string> = {}
    let pm = 'npm'
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      scripts = pkg.scripts ?? {}
    } catch {
      /* malformed manifest is itself worth reporting via the empty script list */
    }
    if (has('bun.lock') || has('bun.lockb')) pm = 'bun'
    else if (has('pnpm-lock.yaml')) pm = 'pnpm'
    else if (has('yarn.lock')) pm = 'yarn'

    const s = (name: string) => (scripts[name] ? `${pm} run ${name}` : undefined)
    found.push({
      stack: `node (${pm})`,
      root,
      install: pm === 'npm' ? 'npm install' : `${pm} install`,
      build: s('build'),
      test: s('test') ?? (pm === 'bun' ? 'bun test' : undefined),
      lint: s('lint'),
      run: s('start') ?? s('dev'),
    })
  }

  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    found.push({
      stack: 'python',
      root,
      install: has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .',
      test: has('pytest.ini') || has('pyproject.toml') ? 'pytest' : 'python -m unittest',
      lint: 'ruff check .',
    })
  }
  if (has('Cargo.toml')) {
    found.push({ stack: 'rust', root, build: 'cargo build', test: 'cargo test', lint: 'cargo clippy', run: 'cargo run' })
  }
  if (has('go.mod')) {
    found.push({ stack: 'go', root, build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' })
  }
  if (has('pom.xml')) found.push({ stack: 'java (maven)', root, build: 'mvn package', test: 'mvn test' })
  if (has('build.gradle') || has('build.gradle.kts')) {
    found.push({ stack: 'java (gradle)', root, build: 'gradle build', test: 'gradle test' })
  }
  if (has('CMakeLists.txt')) found.push({ stack: 'c/c++ (cmake)', root, build: 'cmake --build build' })
  if (has('Makefile')) found.push({ stack: 'make', root, build: 'make', test: 'make test' })
  if (has('*.csproj') || has('*.sln')) found.push({ stack: 'dotnet', root, build: 'dotnet build', test: 'dotnet test' })

  return found
}

export const projectTool: Tool = {
  name: 'detect_project',
  description:
    'Identify what kind of project this is and report its real install, build, test, lint and run commands, read from its manifest. Call this before guessing how to build or test something.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Project directory. Defaults to cwd.' } },
  },
  async run(input: { path?: string }, ctx): Promise<ToolResult> {
    const root = contain(input.path ?? '.', ctx)
    const infos = await detect(root)
    if (!infos.length) {
      return ok(
        `No recognised project manifest in ${input.path ?? '.'}.\n` +
          `Looked for: package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod, pom.xml, build.gradle, CMakeLists.txt, Makefile.`,
      )
    }

    const lines: string[] = []
    for (const i of infos) {
      lines.push(`## ${i.stack}`)
      for (const [k, v] of Object.entries(i)) {
        if (k === 'stack' || k === 'root' || !v) continue
        lines.push(`  ${k.padEnd(8)} ${v}`)
      }
    }

    const vcs = existsSync(join(root, '.git')) ? 'git repository' : 'not a git repository'
    lines.push(`\n${vcs}`)
    return ok(lines.join('\n'))
  },
}

export const testTool: Tool = {
  name: 'run_tests',
  description:
    'Run the project test suite and report the result. Detects the command automatically when not given one. Use this after changing code — not to prove it works, but to find out.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Override the detected test command' },
      path: { type: 'string' },
      timeout_ms: { type: 'integer', description: 'Defaults to 300000' },
    },
  },
  async run(input: { command?: string; path?: string; timeout_ms?: number }, ctx): Promise<ToolResult> {
    const root = contain(input.path ?? '.', ctx)
    let command = input.command
    if (!command) {
      const infos = await detect(root)
      command = infos.find(i => i.test)?.test
      if (!command) {
        return fail(
          'No test command could be detected and none was given. Run detect_project to see what this project is.',
        )
      }
    }

    if (!(await ctx.confirm('Run tests', command))) return fail('Denied by user.')

    const shell = process.platform === 'win32' ? ['pwsh', '-NoProfile', '-Command', command] : ['bash', '-lc', command]
    const res = await exec(shell, root, Math.min(input.timeout_ms ?? 300_000, 900_000))

    const out = res.out.length > 30_000 ? res.out.slice(0, 10_000) + '\n...\n' + res.out.slice(-18_000) : res.out
    if (res.code === 0) return ok(`PASS — ${command}\n\n${out}`)
    return { content: `FAIL (exit ${res.code}) — ${command}\n\n${out}`, isError: true }
  },
}

export const patchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply a unified diff to the working tree. Use when you have a patch; use edit_file for a single targeted change.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'Unified diff text' },
      path: { type: 'string', description: 'Directory to apply in. Defaults to cwd.' },
    },
    required: ['diff'],
  },
  async run(input: { diff: string; path?: string }, ctx): Promise<ToolResult> {
    const root = contain(input.path ?? '.', ctx)
    const files = [...input.diff.matchAll(/^\+\+\+ [ab]\/(.+)$/gm)].map(m => m[1]).join(', ')
    if (!(await ctx.confirm('Apply patch', files || '(unknown files)'))) return fail('Denied by user.')

    const tmp = join(root, `.zeus-patch-${process.pid}.diff`)
    await Bun.write(tmp, input.diff.endsWith('\n') ? input.diff : input.diff + '\n')
    try {
      const check = await exec(['git', 'apply', '--check', tmp], root)
      if (check.code !== 0) {
        return { content: `Patch does not apply cleanly:\n${check.out}`, isError: true }
      }
      const res = await exec(['git', 'apply', tmp], root)
      return res.code === 0
        ? ok(`Applied patch to: ${files || 'working tree'}`)
        : { content: `git apply failed:\n${res.out}`, isError: true }
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  },
}

export const devTools: Tool[] = [gitTool, projectTool, testTool, patchTool]
