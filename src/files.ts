import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SiteConfig } from './config.js'
import { FenceError, MAX_FILE_BYTES, isVisible, resolveInside } from './fence.js'

/** Directories never walked (build output, dependencies, caches) */
const SKIP_DIRS = new Set(['node_modules', '.git', '.astro', '.next', '.cache', '.static-mcp'])
const MAX_LIST = 2000

export interface FileEntry {
  path: string
  size: number
}

/** Walks the site (or a sub directory), skipping denied and build directories */
export async function walk(config: SiteConfig, dir = '', filter?: (rel: string) => boolean): Promise<FileEntry[]> {
  const start = await resolveInside(config, dir)
  const out: FileEntry[] = []
  const output = config.build.outputDir ? config.build.outputDir.replace(/\/+$/, '') : null
  async function visit(abs: string, rel: string) {
    if (out.length >= MAX_LIST) return
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (!isVisible(config, childRel)) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || childRel === output) continue
        await visit(path.join(abs, e.name), childRel)
      } else if (e.isFile() && (!filter || filter(childRel))) {
        const s = await stat(path.join(abs, e.name))
        out.push({ path: childRel, size: s.size })
        if (out.length >= MAX_LIST) return
      }
    }
  }
  await visit(start.abs, start.rel)
  return out
}

export async function readText(config: SiteConfig, rel: string): Promise<{ path: string; content: string }> {
  const { abs, rel: clean } = await resolveInside(config, rel)
  const s = await stat(abs).catch(() => null)
  if (!s || !s.isFile()) throw new FenceError(`File not found: ${rel}`)
  if (s.size > MAX_FILE_BYTES) throw new FenceError(`File is too large to read (${s.size} bytes)`)
  const buf = await readFile(abs)
  if (buf.includes(0)) throw new FenceError('Binary files cannot be read as text')
  return { path: clean, content: buf.toString('utf8') }
}

/** Writes a text file and returns what was there before (null = new file), for undo */
export async function writeText(config: SiteConfig, rel: string, content: string): Promise<{ path: string; previous: string | null }> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new FenceError('Content is too large')
  const { abs, rel: clean } = await resolveInside(config, rel)
  if (!clean) throw new FenceError('A file path is required')
  const previous = await readFile(abs, 'utf8').catch(() => null)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content)
  return { path: clean, previous }
}

export async function deleteFile(config: SiteConfig, rel: string): Promise<{ path: string; previous: string }> {
  const { path: clean, content } = await readText(config, rel)
  await rm((await resolveInside(config, clean)).abs)
  return { path: clean, previous: content }
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

/** Plain-text search (case-insensitive) over text files */
export async function searchFiles(config: SiteConfig, query: string, dir = '', limit = 50): Promise<SearchHit[]> {
  const needle = query.toLowerCase()
  const hits: SearchHit[] = []
  for (const f of await walk(config, dir)) {
    if (f.size > MAX_FILE_BYTES || !/\.(html?|md|mdx|markdown|astro|njk|liquid|tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|json|ya?ml|toml|txt|xml)$/i.test(f.path)) continue
    const text = await readFile((await resolveInside(config, f.path)).abs, 'utf8').catch(() => '')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 240) })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}
