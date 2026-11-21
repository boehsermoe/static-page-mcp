import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig, resolveSite } from '../src/config.js'
import { resolveInside } from '../src/fence.js'
import { detectFramework, FRAMEWORKS } from '../src/frameworks.js'
import { SiteIdentity, verifyIdentity } from '../src/identity.js'
import { createToken, matchToken, readTokens, revokeToken, tokenSite } from '../src/auth.js'
import { deleteFile, uploadAsset, walk } from '../src/files.js'
import { applyReplacements, createPage, deletePage, getPage, listPages, updatePage } from '../src/pages.js'
import { ASTRO_SITE, PLAIN_SITE, makeSite } from './helpers.js'

describe('path fence', () => {
  it('keeps the agent inside the site and away from secrets', async () => {
    const { config } = await makeSite(PLAIN_SITE)
    await expect(resolveInside(config, 'about/index.html')).resolves.toMatchObject({ rel: 'about/index.html' })
    for (const bad of ['../state/identity.pem', '/etc/passwd', 'a/../../x', '.env', '.env.local', '.git/config', 'node_modules/x/index.js', 'sub/.static-mcp/tokens.json', '.well-known/static-site-mcp.json', 'public/.well-known/static-site-mcp.json']) {
      await expect(resolveInside(config, bad), bad).rejects.toThrow()
    }
  })

  it('rejects a symlink that leads out of the site', async () => {
    const { dir, config } = await makeSite(PLAIN_SITE)
    await writeFile(path.join(dir, 'outside.txt'), 'secret')
    await symlink(path.join(dir, 'outside.txt'), path.join(config.root, 'link.txt'))
    await expect(resolveInside(config, 'link.txt')).rejects.toThrow(/outside/)
  })

  it('reaches only the folders of the allow list', async () => {
    const { config } = await makeSite({ ...ASTRO_SITE, 'secrets.json': '{}', 'src/content/notes.md': 'x' }, { allow: ['src/pages', 'public'] })
    await expect(resolveInside(config, 'src/pages/index.astro')).resolves.toMatchObject({ rel: 'src/pages/index.astro' })
    await expect(resolveInside(config, 'public/images/new.png')).resolves.toMatchObject({ rel: 'public/images/new.png' })
    for (const bad of ['secrets.json', 'package.json', 'src/content/notes.md', 'src/pagesX/a.astro', '']) {
      await expect(resolveInside(config, bad), bad).rejects.toThrow(/allowed folders/)
    }
    // Listing walks down to the allowed folders and shows nothing else
    expect((await walk(config)).map((f) => f.path)).toEqual(['src/pages/_partial.astro', 'src/pages/blog/[slug].astro', 'src/pages/index.astro'])
    // Still never .git or .env, even when the whole site is allowed
    const whole = (await makeSite(PLAIN_SITE)).config
    await expect(resolveInside(whole, '.env')).rejects.toThrow(/not accessible/)
  })

  it('needs an explicit allow list, and no longer takes deny', async () => {
    const { dir } = await makeSite({})
    await expect(resolveSite('a', { siteUrl: 'https://a.com', root: 'site' }, dir, dir)).rejects.toThrow(/allow/)
    await expect(resolveSite('a', { siteUrl: 'https://a.com', root: 'site', allow: [] }, dir, dir)).rejects.toThrow(/allow/)
    await expect(resolveSite('a', { siteUrl: 'https://a.com', root: 'site', allow: ['../x'] }, dir, dir)).rejects.toThrow(/inside the site/)
    await expect(resolveSite('a', { siteUrl: 'https://a.com', root: 'site', allow: ['.'], deny: ['x'] }, dir, dir)).rejects.toThrow(/replaced by "allow"/)
  })
})

describe('config', () => {
  const twoSites = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ssm-cfg-'))
    for (const d of ['a', 'b', 'a/inner']) await mkdir(path.join(dir, d), { recursive: true })
    return dir
  }

  it('reads several sites, each with its own key directory', async () => {
    const dir = await twoSites()
    const config = await resolveConfig({ stateDir: 'state', sites: { a: { siteUrl: 'https://a.com', root: 'a', allow: ['.'] }, b: { siteUrl: 'https://b.org', root: 'b', allow: ['.'] } } }, dir)
    expect([...config.sites.keys()]).toEqual(['a', 'b'])
    expect(config.sites.get('b')).toMatchObject({ id: 'b', host: 'b.org', root: path.join(dir, 'b'), stateDir: path.join(dir, 'state', 'sites', 'b') })
  })

  it('refuses anything that makes the site of a call unclear or lets one site reach another', async () => {
    const dir = await twoSites()
    const site = (url: string, root: string) => ({ siteUrl: url, root, allow: ['.'] })
    await expect(resolveConfig({ sites: {} }, dir)).rejects.toThrow(/At least one site/)
    await expect(resolveConfig({ sites: { a: { siteUrl: 'https://a.com' } } }, dir)).rejects.toThrow()
    await expect(resolveConfig({ sites: { 'Bad Id': site('https://a.com', 'a') } }, dir)).rejects.toThrow(/Site ids/)
    await expect(resolveConfig({ sites: { a: site('https://a.com', 'a'), b: site('https://www.a.com', 'b') } }, dir)).rejects.toThrow(/same website/)
    await expect(resolveConfig({ sites: { a: site('https://a.com', 'a'), inner: site('https://inner.com', 'a/inner') } }, dir)).rejects.toThrow(/overlap/)
    await expect(resolveConfig({ stateDir: 'a/.static-mcp', sites: { a: site('https://a.com', 'a') } }, dir)).rejects.toThrow(/stateDir/)
  })

  it('takes the build defaults from the detected framework', async () => {
    const { config } = await makeSite(ASTRO_SITE)
    expect(config.framework.id).toBe('astro')
    expect(config.build).toMatchObject({ command: 'npx astro build', outputDir: 'dist' })
    expect(config.host).toBe('example.com')
  })
})

describe('frameworks', () => {
  it('detects generators from their marker files', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ 'astro.config.mjs': '' }, 'astro'],
      [{ 'hugo.toml': '' }, 'hugo'],
      [{ 'eleventy.config.js': '' }, 'eleventy'],
      [{ '_config.yml': '' }, 'jekyll'],
      [{ 'docs/.vitepress/config.ts': '' }, 'vitepress'],
      [{ 'next.config.mjs': '' }, 'next-export'],
      [{ 'index.html': '' }, 'plain'],
    ]
    for (const [files, id] of cases) {
      const { config } = await makeSite(files)
      expect(await detectFramework(config.root), id).toBe(id)
    }
  })

  it('maps source files to routes', () => {
    expect(FRAMEWORKS.astro.routeFor('src/pages/index.astro')).toBe('/')
    expect(FRAMEWORKS.astro.routeFor('src/pages/blog/[slug].astro')).toBeNull()
    expect(FRAMEWORKS.astro.routeFor('src/content/blog/first-post.md')).toBe('/blog/first-post/')
    expect(FRAMEWORKS.hugo.routeFor('content/posts/_index.md')).toBe('/posts/')
    expect(FRAMEWORKS.jekyll.routeFor('_posts/2026-01-31-hello.md')).toBe('/2026/01/31/hello.html')
    expect(FRAMEWORKS['next-export'].routeFor('app/(marketing)/pricing/page.tsx')).toBe('/pricing/')
    expect(FRAMEWORKS.plain.routeFor('about/index.html')).toBe('/about/')
    expect(FRAMEWORKS.plain.routeFor('contact.html')).toBe('/contact.html')
  })
})

describe('pages', () => {
  it('lists and reads plain HTML pages', async () => {
    const { config } = await makeSite(PLAIN_SITE)
    const { pages, total } = await listPages(config)
    expect(total).toBe(3)
    expect(pages.find((p) => p.id === 'index.html')).toMatchObject({ route: '/', url: 'https://www.example.com/', title: 'Home & Garden', kind: 'html' })
    expect((await listPages(config, { query: 'about' })).pages.map((p) => p.id)).toEqual(['about/index.html'])
  })

  it('changes text only where it occurs exactly once', async () => {
    expect(applyReplacements('a b c', [{ find: 'b', replace: 'B' }])).toBe('a B c')
    expect(() => applyReplacements('a b b', [{ find: 'b', replace: 'B' }])).toThrow(/more than once/)
    expect(() => applyReplacements('a', [{ find: 'x', replace: 'y' }])).toThrow(/not found/)
    const { config } = await makeSite(PLAIN_SITE)
    const { previous, page } = await updatePage(config, 'index.html', { replacements: [{ find: '9-17', replace: '8-18' }] })
    expect(previous).toContain('9-17')
    expect(page.source).toContain('8-18')
    expect(await readFile(path.join(config.root, 'index.html'), 'utf8')).toContain('8-18')
  })

  it('merges frontmatter and replaces the body of Markdown pages', async () => {
    const { config } = await makeSite(ASTRO_SITE)
    const { page } = await updatePage(config, 'src/content/blog/first-post.md', { frontmatter: { title: 'Renamed', draft: null, tags: ['a'] }, body: 'New body\n' })
    expect(page.frontmatter).toEqual({ title: 'Renamed', tags: ['a'] })
    expect(page.body?.trim()).toBe('New body')
    expect(page.title).toBe('Renamed')
  })

  it('creates pages only where the framework renders them, and deletes with the previous source', async () => {
    const { config } = await makeSite(ASTRO_SITE)
    const created = await createPage(config, 'src/content/blog/second.md', { frontmatter: { title: 'Second' }, body: 'Text' })
    expect(created).toMatchObject({ route: '/blog/second/', title: 'Second', kind: 'content' })
    await expect(createPage(config, 'src/components/New.astro', { source: '<p/>' })).rejects.toThrow(/would not be a page/)
    await expect(createPage(config, 'src/content/blog/second.md', { body: 'x' })).rejects.toThrow(/already exists/)
    await expect(getPage(config, 'src/components/Header.astro')).rejects.toThrow(/Not a page/)
    const { previous } = await deletePage(config, 'src/content/blog/second.md')
    expect(previous).toContain('Second')
  })
})

describe('uploads', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])

  it('stores an image, never over an existing file, and deletes it again', async () => {
    const { config } = await makeSite(ASTRO_SITE)
    expect(await uploadAsset(config, 'public/images/hero.png', PNG.toString('base64'))).toEqual({ path: 'public/images/hero.png', size: PNG.length })
    expect(await readFile(path.join(config.root, 'public/images/hero.png'))).toEqual(PNG)
    await expect(uploadAsset(config, 'public/images/hero.png', PNG.toString('base64'))).rejects.toThrow(/already exists/)
    expect(await deleteFile(config, 'public/images/hero.png')).toEqual({ path: 'public/images/hero.png', previous: null, size: PNG.length })
  })

  it('refuses other types, content that does not match, and paths outside the fence', async () => {
    const { config } = await makeSite(ASTRO_SITE)
    const png = PNG.toString('base64')
    await expect(uploadAsset(config, 'public/x.svg', png)).rejects.toThrow(/Only these file types/)
    await expect(uploadAsset(config, 'public/x.js', png)).rejects.toThrow(/Only these file types/)
    await expect(uploadAsset(config, 'public/x.jpg', png)).rejects.toThrow(/no \.jpg file/)
    await expect(uploadAsset(config, 'public/x.png', 'not base64!')).rejects.toThrow(/base64/)
    await expect(uploadAsset(config, '../x.png', png)).rejects.toThrow(/outside/)
    await expect(uploadAsset(config, '.git/x.png', png)).rejects.toThrow(/not accessible/)
  })
})

describe('auth tokens', () => {
  it('stores only hashes and matches the right token', async () => {
    const { config } = await makeSite(PLAIN_SITE)
    const { token, stored } = await createToken(config.stateDir, 'maia', 'example')
    expect(stored.site).toBe('example')
    await expect(createToken(config.stateDir, 'none', '')).rejects.toThrow(/one site/)
    const raw = await readFile(path.join(config.stateDir, 'tokens.json'), 'utf8')
    expect(raw).not.toContain(token)
    const tokens = await readTokens(config.stateDir)
    expect(matchToken(tokens, token)?.id).toBe(stored.id)
    expect(matchToken(tokens, token + 'x')).toBeNull()
    expect(matchToken(tokens, undefined)).toBeNull()
    // Bound to its one configured site; an old multi-site entry or a removed site opens nothing
    const configured = new Set(['example', 'blog'])
    expect(tokenSite(stored, configured)).toBe('example')
    expect(tokenSite({ ...stored, site: 'gone' }, configured)).toBeNull()
    expect(tokenSite({ ...stored, site: undefined, sites: ['example', 'blog'] } as never, configured)).toBeNull()
    expect(await revokeToken(config.stateDir, 'maia')).toBe(true)
    expect(matchToken(await readTokens(config.stateDir), token)).toBeNull()
  })
})

describe('domain identity', () => {
  const nonce = 'n-0123456789abcdef'
  const setup = async () => {
    const { config } = await makeSite(PLAIN_SITE)
    const identity = await SiteIdentity.loadOrCreate(config.stateDir, config.siteUrl, config.host)
    return { identity, wellKnown: identity.wellKnown(), proof: identity.prove(nonce) }
  }

  it('accepts the MCP of the website (same host or a subdomain)', async () => {
    const { wellKnown, proof } = await setup()
    expect(verifyIdentity({ websiteUrl: 'https://example.com', mcpUrl: 'https://example.com/mcp', nonce, wellKnown, proof })).toEqual({ ok: true })
    expect(verifyIdentity({ websiteUrl: 'https://www.example.com', mcpUrl: 'https://mcp.example.com/mcp', nonce, wellKnown, proof })).toEqual({ ok: true })
  })

  it('rejects an MCP on another server, another site key, a replayed proof and a forged signature', async () => {
    const { wellKnown, proof } = await setup()
    const other = await setup()
    const base = { websiteUrl: 'https://example.com', mcpUrl: 'https://example.com/mcp', nonce, wellKnown, proof }
    expect(verifyIdentity({ ...base, mcpUrl: 'https://evil-example.com/mcp' })).toMatchObject({ ok: false })
    expect(verifyIdentity({ ...base, mcpUrl: 'https://example.com.evil.io/mcp' })).toMatchObject({ ok: false })
    expect(verifyIdentity({ ...base, proof: other.proof })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) })
    expect(verifyIdentity({ ...base, nonce: 'another-nonce-123456' })).toMatchObject({ ok: false })
    expect(verifyIdentity({ ...base, proof: { ...proof, signature: other.proof.signature, publicKey: wellKnown.publicKey } })).toMatchObject({ ok: false, reason: 'Invalid signature' })
    expect(verifyIdentity({ ...base, wellKnown: null })).toMatchObject({ ok: false })
    expect(verifyIdentity({ ...base, wellKnown: { ...wellKnown, host: 'other.com' } })).toMatchObject({ ok: false })
  })

  it('keeps the same key across restarts', async () => {
    const { config } = await makeSite(PLAIN_SITE)
    const a = await SiteIdentity.loadOrCreate(config.stateDir, config.siteUrl, config.host)
    const b = await SiteIdentity.loadOrCreate(config.stateDir, config.siteUrl, config.host)
    expect(a.publicKey).toBe(b.publicKey)
    const file = await a.publishTo(config.root)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ host: 'example.com', publicKey: a.publicKey })
  })
})
