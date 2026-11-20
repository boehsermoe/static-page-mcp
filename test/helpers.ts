import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveSite, type SiteConfig } from '../src/config.js'

/** Creates a temporary project: { root/<files> } plus a state dir next to it */
export async function makeSite(files: Record<string, string>, raw: Record<string, unknown> = {}): Promise<{ dir: string; config: SiteConfig }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssm-'))
  const root = path.join(dir, 'site')
  await mkdir(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  const config = await resolveSite('example', { siteUrl: 'https://www.example.com/', root: 'site', ...raw }, dir, path.join(dir, 'state'))
  return { dir, config }
}

export const PLAIN_SITE = {
  'index.html': '<html><head><title>Home &amp; Garden</title></head><body><h1>Welcome</h1><p>Opening hours: 9-17</p></body></html>',
  'about/index.html': '<html><body><h1>About us</h1><p>We are a team.</p></body></html>',
  'contact.html': '<html><body><h1>Contact</h1></body></html>',
  'css/site.css': 'body { color: black }',
  '.env': 'SECRET=1',
}

export const ASTRO_SITE = {
  'astro.config.mjs': 'export default {}',
  'package.json': '{"name":"astro-fixture"}',
  'src/pages/index.astro': '---\nconst title = "Start"\n---\n<h1>{title}</h1>',
  'src/pages/blog/[slug].astro': '---\n---\n<slot />',
  'src/pages/_partial.astro': '<p>partial</p>',
  'src/content/blog/first-post.md': '---\ntitle: First post\ndraft: false\n---\nHello world.\n',
  'src/components/Header.astro': '<header>Header</header>',
}
