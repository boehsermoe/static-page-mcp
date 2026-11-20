import matter from 'gray-matter'
import { access } from 'node:fs/promises'
import type { SiteConfig } from './config.js'
import { FenceError, resolveInside } from './fence.js'
import { deleteFile, readText, walk, writeText } from './files.js'

/**
 * A page = one source file that renders a URL (or a content entry). Its id is
 * its path relative to the site root, which stays stable across calls.
 *  - "content": Markdown/MDX with frontmatter, edited as frontmatter fields + body
 *  - "html": a plain HTML file, edited as source or by text replacements
 *  - "template": a framework component (.astro, .tsx, .njk, …), edited as source
 */
export type PageKind = 'content' | 'html' | 'template'

export interface PageSummary {
  id: string
  route: string | null
  url: string | null
  title: string | null
  kind: PageKind
}

export interface Page extends PageSummary {
  frontmatter?: Record<string, unknown>
  body?: string
  source: string
}

export interface PageUpdate {
  /** Merged into the frontmatter; a null value removes the field (content pages only) */
  frontmatter?: Record<string, unknown | null>
  /** Replaces the body below the frontmatter (content pages only) */
  body?: string
  /** Replaces the whole file */
  source?: string
  /** Exact text replacements; each `find` must occur exactly once in the file */
  replacements?: Array<{ find: string; replace: string }>
}

const MARKDOWN = /\.(md|mdx|markdown)$/i
const HTML = /\.html?$/i

const kindOf = (rel: string): PageKind => (MARKDOWN.test(rel) ? 'content' : HTML.test(rel) ? 'html' : 'template')

function isPage(config: SiteConfig, rel: string): boolean {
  if (config.framework.routeFor(rel) !== null) return true
  // Markdown in a configured content directory is content even without a known route
  return MARKDOWN.test(rel) && config.contentDirs.some((dir) => dir === '.' || rel.startsWith(dir.replace(/\/+$/, '') + '/'))
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

function titleOf(rel: string, source: string, frontmatter?: Record<string, unknown>): string | null {
  const fm = frontmatter?.title
  if (typeof fm === 'string' && fm.trim()) return fm.trim()
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)
  if (tag) return decode(tag[1].replace(/<[^>]+>/g, '').trim()) || null
  const heading = /^#\s+(.+)$/m.exec(source)
  return heading ? heading[1].trim() : null
}

function summary(config: SiteConfig, rel: string, source: string, frontmatter?: Record<string, unknown>): PageSummary {
  const route = config.framework.routeFor(rel)
  return { id: rel, route, url: route ? new URL(route, config.siteUrl).toString() : null, title: titleOf(rel, source, frontmatter), kind: kindOf(rel) }
}

function parse(config: SiteConfig, rel: string, source: string): Page {
  if (kindOf(rel) === 'content') {
    const parsed = matter(source)
    return { ...summary(config, rel, source, parsed.data), frontmatter: parsed.data, body: parsed.content, source }
  }
  return { ...summary(config, rel, source), source }
}

export async function listPages(config: SiteConfig, opts: { query?: string; offset?: number; limit?: number } = {}): Promise<{ total: number; pages: PageSummary[] }> {
  const files = await walk(config, '', (rel) => isPage(config, rel))
  const needle = opts.query?.toLowerCase().trim()
  const pages: PageSummary[] = []
  for (const f of files) {
    const { content } = await readText(config, f.path).catch(() => ({ content: '' }))
    const fm = kindOf(f.path) === 'content' ? safeFrontmatter(content) : undefined
    const s = summary(config, f.path, content, fm)
    if (needle && ![s.id, s.route ?? '', s.title ?? ''].some((v) => v.toLowerCase().includes(needle))) continue
    pages.push(s)
  }
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  return { total: pages.length, pages: pages.slice(offset, offset + limit) }
}

function safeFrontmatter(source: string): Record<string, unknown> | undefined {
  try {
    return matter(source).data
  } catch {
    return undefined
  }
}

async function requirePage(config: SiteConfig, id: string) {
  const { rel } = await resolveInside(config, id)
  if (!isPage(config, rel)) throw new FenceError(`Not a page: ${id} (use read_file for other files)`)
  return rel
}

export async function getPage(config: SiteConfig, id: string): Promise<Page> {
  const rel = await requirePage(config, id)
  const { content } = await readText(config, rel)
  return parse(config, rel, content)
}

/** Applies exact replacements; each find must match exactly once so a change never lands in the wrong place */
export function applyReplacements(source: string, replacements: NonNullable<PageUpdate['replacements']>): string {
  let out = source
  for (const { find, replace } of replacements) {
    if (!find) throw new FenceError('A replacement needs a non-empty "find"')
    const first = out.indexOf(find)
    if (first === -1) throw new FenceError(`Text not found: ${JSON.stringify(find.slice(0, 80))}`)
    if (out.indexOf(find, first + 1) !== -1) throw new FenceError(`Text occurs more than once, add more context: ${JSON.stringify(find.slice(0, 80))}`)
    out = out.slice(0, first) + replace + out.slice(first + find.length)
  }
  return out
}

function render(page: Page, update: PageUpdate): string {
  if (update.source !== undefined) {
    if (update.frontmatter || update.body !== undefined || update.replacements) throw new FenceError('"source" replaces the whole file and cannot be combined with other changes')
    return update.source
  }
  let source = page.source
  if (update.frontmatter || update.body !== undefined) {
    if (page.kind !== 'content') throw new FenceError('frontmatter/body changes are only possible on Markdown pages; use replacements or source')
    const data: Record<string, unknown> = { ...(page.frontmatter ?? {}) }
    for (const [key, value] of Object.entries(update.frontmatter ?? {})) {
      if (value === null) delete data[key]
      else data[key] = value
    }
    source = matter.stringify(update.body ?? page.body ?? '', data)
  }
  if (update.replacements?.length) source = applyReplacements(source, update.replacements)
  return source
}

export async function updatePage(config: SiteConfig, id: string, update: PageUpdate): Promise<{ page: Page; previous: string }> {
  const page = await getPage(config, id)
  const next = render(page, update)
  if (next === page.source) throw new FenceError('The change does not alter the page')
  const { previous } = await writeText(config, page.id, next)
  return { page: parse(config, page.id, next), previous: previous ?? page.source }
}

export async function createPage(config: SiteConfig, id: string, init: { frontmatter?: Record<string, unknown>; body?: string; source?: string }): Promise<Page> {
  const { abs, rel } = await resolveInside(config, id)
  if (!isPage(config, rel)) throw new FenceError(`${id} would not be a page of this ${config.framework.label} site; check the directory and extension`)
  if (await access(abs).then(() => true, () => false)) throw new FenceError(`A file already exists at ${id}`)
  const source = init.source ?? (kindOf(rel) === 'content' ? matter.stringify(init.body ?? '', init.frontmatter ?? {}) : null)
  if (source === null) throw new FenceError('"source" is required for this kind of page')
  await writeText(config, rel, source)
  return parse(config, rel, source)
}

export async function deletePage(config: SiteConfig, id: string): Promise<{ id: string; previous: string }> {
  const rel = await requirePage(config, id)
  const { previous } = await deleteFile(config, rel)
  return { id: rel, previous }
}
