import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SiteConfig } from './config.js'
import type { SiteIdentity } from './identity.js'

/**
 * Builds and publishing run as background jobs: a build can take minutes, and
 * clients (MAIA on serverless) cannot hold a request open that long. The tools
 * return a job id at once and the agent polls get_build_status.
 * Commands come only from the config; the agent cannot pass any.
 */
export type JobKind = 'build' | 'publish'
export type JobStatus = 'running' | 'succeeded' | 'failed'

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  startedAt: string
  finishedAt: string | null
  /** The last lines of output */
  log: string[]
  error: string | null
  /** Settles when the job is finished (tests, CLI); not part of the tool output */
  done?: Promise<void>
}

const LOG_LINES = 200
const KEPT_JOBS = 20

export type CommandRunner = (command: string, args: string[] | null, opts: { cwd: string; timeoutMs: number; onLine: (line: string) => void }) => Promise<void>

/** Runs a command; `args === null` runs `command` through the shell (trusted config only) */
export const runCommand: CommandRunner = (command, args, { cwd, timeoutMs, onLine }) =>
  new Promise((resolve, reject) => {
    const child = args === null ? spawn(command, { cwd, shell: true, env: buildEnv() }) : spawn(command, args, { cwd, env: buildEnv() })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    const pipe = (chunk: Buffer) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach(onLine)
    child.stdout.on('data', pipe)
    child.stderr.on('data', pipe)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Exited with code ${code}`))
    })
  })

/** The child sees PATH and locale, not the server's secrets */
function buildEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_ENV', 'CI', 'HUGO_ENV', 'JEKYLL_ENV']
  const env: NodeJS.ProcessEnv = { CI: '1' }
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

export class BuildRunner {
  private readonly jobs = new Map<string, Job>()
  private running: Job | null = null

  constructor(
    private readonly config: SiteConfig,
    private readonly identity: SiteIdentity,
    private readonly run: CommandRunner = runCommand,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null
  }

  latest(): Job | null {
    return [...this.jobs.values()].at(-1) ?? null
  }

  /** Starts a job unless one is running; resolves when it has started (not finished) */
  start(kind: JobKind): Job {
    if (this.running) throw new Error(`A ${this.running.kind} job is still running (${this.running.id})`)
    if (kind === 'build' && !this.config.build.command) throw new Error('This site has no build step; use publish')
    const job: Job = { id: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, log: [], error: null }
    this.jobs.set(job.id, job)
    while (this.jobs.size > KEPT_JOBS) this.jobs.delete(this.jobs.keys().next().value!)
    this.running = job
    const work = kind === 'build' ? this.build(job) : this.publish(job)
    // Settles the job; never rejects
    job.done = work.then(
      () => {
        job.status = 'succeeded'
      },
      (err: Error) => {
        job.status = 'failed'
        job.error = err.message
        this.line(job, `ERROR: ${err.message}`)
      }
    ).finally(() => {
      job.finishedAt = new Date().toISOString()
      this.running = null
    })
    return job
  }

  private line(job: Job, text: string) {
    job.log.push(text)
    if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES)
  }

  private async build(job: Job) {
    const { command, outputDir, timeoutSeconds } = this.config.build
    this.line(job, `$ ${command}`)
    await this.run(command!, null, { cwd: this.config.root, timeoutMs: timeoutSeconds * 1000, onLine: (l) => this.line(job, l) })
    // The output must always carry the domain key, or the website no longer proves its MCP
    if (outputDir) {
      await this.identity.publishTo(path.resolve(this.config.root, outputDir))
      this.line(job, 'Wrote the site identity into the build output')
    }
  }

  private async publish(job: Job) {
    const p = this.config.publish
    const opts = { cwd: this.config.root, timeoutMs: this.config.build.timeoutSeconds * 1000, onLine: (l: string) => this.line(job, l) }
    switch (p.type) {
      case 'none':
        throw new Error('Publishing is not configured for this site')
      case 'copy': {
        const from = this.config.build.outputDir ? path.resolve(this.config.root, this.config.build.outputDir) : this.config.root
        if (from === this.config.root) throw new Error('Plain sites are served from their root; nothing to copy')
        await mkdir(p.targetDir, { recursive: true })
        await cp(from, p.targetDir, { recursive: true, force: true })
        this.line(job, `Copied ${from} to ${p.targetDir}`)
        return
      }
      case 'git': {
        await this.run('git', ['add', '-A'], opts)
        // Nothing to commit is fine: push whatever is not on the remote yet
        await this.run('git', ['commit', '-m', 'Update site via static-site-mcp'], opts).catch((err: Error) => this.line(job, `commit skipped: ${err.message}`))
        await this.run('git', ['push', p.remote, `HEAD:${p.branch}`], opts)
        return
      }
      case 'hook': {
        const res = await this.fetchImpl(p.url, { method: 'POST' })
        this.line(job, `Deploy hook answered ${res.status}`)
        if (!res.ok) throw new Error(`Deploy hook failed with ${res.status}`)
        return
      }
    }
  }
}
