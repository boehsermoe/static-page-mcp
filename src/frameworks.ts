import { access, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * What the server knows about each static site generator: where pages and
 * content live, how a source file maps to a URL, and the default build.
 * Routes are best effort (frameworks allow custom routing); `routeFor` returns
 * null when a file is not a page by itself (layouts, partials, components).
 */
export interface FrameworkProfile {
  id: FrameworkId
  label: string
  buildCommand: string | null
  outputDir: string | null
  /** Copied 1:1 into the output (Astro public/, Hugo static/): the well-known file goes here for hosted builds */
  publicDir: string | null
  contentDirs: string[]
  /** Source files that render pages: [directory, extensions] */
  pageDirs: Array<{ dir: string; ext: string[] }>
  routeFor(rel: string): string | null
}

export type FrameworkId = 'astro' | 'hugo' | 'eleventy' | 'jekyll' | 'vitepress' | 'next-export' | 'plain'

const MARKDOWN = ['.md', '.mdx', '.markdown']

const stripExt = (p: string) => p.replace(/\.[^/.]+$/, '')
/** "blog/post.md" -> "/blog/post/", "index.md" -> "/", "about/index.html" -> "/about/" */
export function pathRoute(rel: string, { keepHtml = false } = {}): string {
  let p = keepHtml && rel.endsWith('.html') ? rel : stripExt(rel)
  if (keepHtml && p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length)
  else if (keepHtml && p === 'index.html') p = ''
  p = p.replace(/(^|\/)index$/, '$1')
  if (p === '' || p.endsWith('/')) return '/' + p
  return keepHtml && p.endsWith('.html') ? '/' + p : '/' + p + '/'
}

const under = (rel: string, dir: string) => (dir === '' || dir === '.' ? rel : rel.startsWith(dir + '/') ? rel.slice(dir.length + 1) : null)
const isPartial = (rel: string) => rel.split('/').some((part) => part.startsWith('_'))

export const FRAMEWORKS: Record<FrameworkId, FrameworkProfile> = {
  astro: {
    id: 'astro',
    label: 'Astro',
    buildCommand: 'npx astro build',
    outputDir: 'dist',
    publicDir: 'public',
    contentDirs: ['src/content'],
    pageDirs: [{ dir: 'src/pages', ext: ['.astro', ...MARKDOWN, '.html'] }],
    routeFor(rel) {
      const page = under(rel, 'src/pages')
      if (page !== null) return isPartial(page) || page.includes('[') ? null : pathRoute(page)
      // A collection entry is usually rendered under its collection name (src/content/blog/x.md -> /blog/x/)
      const entry = under(rel, 'src/content')
      return entry !== null && MARKDOWN.some((e) => entry.endsWith(e)) ? pathRoute(entry) : null
    },
  },
  hugo: {
    id: 'hugo',
    label: 'Hugo',
    buildCommand: 'hugo --minify',
    outputDir: 'public',
    publicDir: 'static',
    contentDirs: ['content'],
    pageDirs: [],
    routeFor(rel) {
      const entry = under(rel, 'content')
      if (entry === null || !MARKDOWN.some((e) => entry.endsWith(e))) return null
      return pathRoute(entry.replace(/(^|\/)_index(\.[^.]+)$/, '$1index$2'))
    },
  },
  eleventy: {
    id: 'eleventy',
    label: 'Eleventy',
    buildCommand: 'npx @11ty/eleventy',
    outputDir: '_site',
    publicDir: null,
    contentDirs: ['.'],
    pageDirs: [{ dir: '.', ext: [...MARKDOWN, '.njk', '.liquid', '.html'] }],
    routeFor(rel) {
      if (isPartial(rel) || rel.startsWith('_site/')) return null
      return pathRoute(rel)
    },
  },
  jekyll: {
    id: 'jekyll',
    label: 'Jekyll',
    buildCommand: 'bundle exec jekyll build',
    outputDir: '_site',
    publicDir: null,
    contentDirs: ['_posts', '.'],
    pageDirs: [{ dir: '.', ext: [...MARKDOWN, '.html'] }],
    routeFor(rel) {
      const post = under(rel, '_posts')
      // _posts/2026-01-31-title.md -> /2026/01/31/title.html (Jekyll's default permalink)
      if (post !== null) {
        const m = /^(\d{4})-(\d{2})-(\d{2})-(.+)\.[^.]+$/.exec(path.posix.basename(post))
        return m ? `/${m[1]}/${m[2]}/${m[3]}/${m[4]}.html` : null
      }
      if (isPartial(rel)) return null
      return pathRoute(rel)
    },
  },
  vitepress: {
    id: 'vitepress',
    label: 'VitePress',
    buildCommand: 'npx vitepress build docs',
    outputDir: 'docs/.vitepress/dist',
    publicDir: 'docs/public',
    contentDirs: ['docs'],
    pageDirs: [],
    routeFor(rel) {
      const doc = under(rel, 'docs')
      if (doc === null || doc.startsWith('.vitepress/') || !MARKDOWN.some((e) => doc.endsWith(e))) return null
      return pathRoute(doc)
    },
  },
  'next-export': {
    id: 'next-export',
    label: 'Next.js (static export)',
    buildCommand: 'npx next build',
    outputDir: 'out',
    publicDir: 'public',
    contentDirs: ['content'],
    pageDirs: [
      { dir: 'app', ext: ['.tsx', '.jsx', '.mdx'] },
      { dir: 'pages', ext: ['.tsx', '.jsx', '.mdx'] },
    ],
    routeFor(rel) {
      const app = under(rel, 'app')
      if (app !== null) {
        if (!/(^|\/)page\.(tsx|jsx|mdx)$/.test(app) || app.includes('[')) return null
        const dir = path.posix.dirname(app).split('/').filter((s) => s !== '.' && !/^\(.*\)$/.test(s)).join('/')
        return dir ? `/${dir}/` : '/'
      }
      const page = under(rel, 'pages')
      if (page === null || page.startsWith('api/') || isPartial(page) || page.includes('[')) return null
      return pathRoute(page)
    },
  },
  plain: {
    id: 'plain',
    label: 'Static HTML',
    buildCommand: null,
    outputDir: null,
    publicDir: null,
    contentDirs: [],
    pageDirs: [{ dir: '.', ext: ['.html', '.htm'] }],
    routeFor: (rel) => (/\.html?$/.test(rel) ? pathRoute(rel, { keepHtml: true }) : null),
  },
}

const exists = async (p: string) => access(p).then(() => true, () => false)

/** Detects the generator from the files in the project root */
export async function detectFramework(root: string): Promise<FrameworkId> {
  const names = new Set(await readdir(root).catch(() => [] as string[]))
  const any = (...candidates: string[]) => candidates.some((n) => names.has(n))
  if ([...names].some((n) => /^astro\.config\.(m?js|ts|mjs|cjs)$/.test(n))) return 'astro'
  if (any('hugo.toml', 'hugo.yaml', 'hugo.json') || ((any('config.toml') || any('config.yaml')) && names.has('content') && names.has('layouts'))) return 'hugo'
  if ([...names].some((n) => /^(\.eleventy\.(c?js)|eleventy\.config\.(c|m)?js)$/.test(n))) return 'eleventy'
  if (any('_config.yml', '_config.yaml')) return 'jekyll'
  if (await exists(path.join(root, 'docs', '.vitepress'))) return 'vitepress'
  if ([...names].some((n) => /^next\.config\.(m?js|ts)$/.test(n))) return 'next-export'
  return 'plain'
}
