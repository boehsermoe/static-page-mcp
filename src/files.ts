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

/** Binary files the agent may upload (images, icons, PDFs, fonts), by extension, with the bytes they must start with */
const ASSET_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  avif: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1')),
  ico: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  woff: (b) => b.subarray(0, 4).toString('latin1') === 'wOFF',
  woff2: (b) => b.subarray(0, 4).toString('latin1') === 'wOF2',
}
ASSET_SIGNATURES.jpeg = ASSET_SIGNATURES.jpg
export const ASSET_EXTENSIONS = Object.keys(ASSET_SIGNATURES)
export const MAX_ASSET_BYTES = 15 * 1024 * 1024

const assetExtension = (rel: string) => {
  const ext = path.posix.extname(rel).slice(1).toLowerCase()
  return ext in ASSET_SIGNATURES ? ext : null
}

/**
 * Uploads a binary file (image, icon, PDF, font) as base64. Never replaces an existing file: a new image gets a new
 * name and the page refers to it, so an undo is simply deleting it again.
 */
export async function uploadAsset(config: SiteConfig, rel: string, base64: string): Promise<{ path: string; size: number }> {
  const ext = assetExtension(rel)
  if (!ext) throw new FenceError(`Only these file types can be uploaded: ${ASSET_EXTENSIONS.join(', ')} (text files go through write_file)`)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new FenceError('data must be base64')
  const data = Buffer.from(base64, 'base64')
  if (data.length === 0) throw new FenceError('The file is empty')
  if (data.length > MAX_ASSET_BYTES) throw new FenceError(`The file is too large (max ${MAX_ASSET_BYTES / 1024 / 1024} MB)`)
  if (!ASSET_SIGNATURES[ext](data)) throw new FenceError(`The content is no .${ext} file`)
  const { abs, rel: clean } = await resolveInside(config, rel)
  if (!clean) throw new FenceError('A file path is required')
  if (await stat(abs).catch(() => null)) throw new FenceError(`A file already exists at ${clean}: upload under a new name`)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, data, { flag: 'wx' })
  return { path: clean, size: data.length }
}

/** Deletes a file. Text files return their previous content (for undo); uploaded binaries return null and their size */
export async function deleteFile(config: SiteConfig, rel: string): Promise<{ path: string; previous: string | null; size: number }> {
  if (assetExtension(rel)) {
    const { abs, rel: clean } = await resolveInside(config, rel)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isFile()) throw new FenceError(`File not found: ${rel}`)
    await rm(abs)
    return { path: clean, previous: null, size: s.size }
  }
  const { path: clean, content } = await readText(config, rel)
  await rm((await resolveInside(config, clean)).abs)
  return { path: clean, previous: content, size: Buffer.byteLength(content) }
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
