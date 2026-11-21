import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AddressInfo } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createToken } from '../src/auth.js'
import { BuildRunner, type CommandRunner } from '../src/build.js'
import { resolveSite } from '../src/config.js'
import type { ServerContext } from '../src/context.js'
import { createApp } from '../src/http.js'
import { SiteIdentity, verifyIdentity } from '../src/identity.js'
import { buildMcpServer, type SiteContext } from '../src/server.js'
import { ASTRO_SITE, PLAIN_SITE, makeSite } from './helpers.js'

async function context(files: Record<string, string>, raw: Record<string, unknown> = {}, run?: CommandRunner): Promise<SiteContext> {
  const { config } = await makeSite(files, raw)
  const identity = await SiteIdentity.loadOrCreate(config.stateDir, config.siteUrl, config.host)
  return { config, identity, builds: new BuildRunner(config, identity, run) }
}

/** A client of a server with the given sites, allowed to use `allowed` (default: all) */
async function connect(sites: SiteContext[], allowed = sites.map((s) => s.config.id)) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildMcpServer(new Map(sites.map((s) => [s.config.id, s])), allowed).connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  return client
}

/** A second site ("shop") next to the first, on another domain */
async function secondSite(): Promise<SiteContext> {
  const { dir } = await makeSite({})
  await writeFile(path.join(dir, 'site', 'index.html'), '<html><head><title>Shop</title></head></html>')
  const config = await resolveSite('shop', { siteUrl: 'https://shop.example.org/', root: 'site' }, dir, path.join(dir, 'state'))
  const identity = await SiteIdentity.loadOrCreate(config.stateDir, config.siteUrl, config.host)
  return { config, identity, builds: new BuildRunner(config, identity) }
}

/** The JSON a tool returned (after the data notice line) */
function json(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = (result.content as Array<{ text: string }>)[0].text
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}
const errorText = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as Array<{ text: string }>)[0].text

const site = 'example'

describe('MCP tools', () => {
  it('announces read and write tools with annotations, each requiring the site', async () => {
    const client = await connect([await context(PLAIN_SITE)])
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.get_page.annotations?.readOnlyHint).toBe(true)
    expect(byName.update_page.annotations?.readOnlyHint).toBe(false)
    expect(byName.delete_page.annotations?.destructiveHint).toBe(true)
    for (const tool of tools.filter((t) => t.name !== 'list_sites')) expect(tool.inputSchema.required, tool.name).toContain('site')
  })

  it('proves the domain binding to a client', async () => {
    const ctx = await context(PLAIN_SITE)
    const client = await connect([ctx])
    const nonce = 'client-nonce-1234567890'
    const result = await client.callTool({ name: 'site_identity', arguments: { site, nonce } })
    const verdict = verifyIdentity({ websiteUrl: 'https://example.com', mcpUrl: 'https://example.com/mcp', nonce, wellKnown: ctx.identity.wellKnown(), proof: result.structuredContent })
    expect(verdict).toEqual({ ok: true })
  })

  it('reads and changes a page, and reports fence errors as tool errors', async () => {
    const ctx = await context(PLAIN_SITE)
    const client = await connect([ctx])
    const page = json(await client.callTool({ name: 'get_page', arguments: { site, id: 'about/index.html' } }))
    expect(page.title).toBe('About us')
    const changed = json(await client.callTool({ name: 'update_page', arguments: { site, id: 'about/index.html', replacements: [{ find: 'We are a team.', replace: 'We are a family business.' }] } }))
    expect(changed.previous).toContain('We are a team.')
    const denied = await client.callTool({ name: 'read_file', arguments: { site, path: '.env' } })
    expect(denied.isError).toBe(true)
    const missing = await client.callTool({ name: 'read_file', arguments: { site, path: 'nope.txt' } })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).not.toContain(ctx.config.root)
  })

  it('runs the configured build as a job and writes the identity into the output', async () => {
    const commands: string[] = []
    const fakeRun: CommandRunner = async (command, _args, { onLine }) => {
      commands.push(command)
      onLine('built 3 pages')
    }
    const ctx = await context(ASTRO_SITE, {}, fakeRun)
    const client = await connect([ctx])
    const job = json(await client.callTool({ name: 'build', arguments: { site } }))
    expect(job.status).toBe('running')
    const busy = await client.callTool({ name: 'build', arguments: { site } })
    expect(busy.isError).toBe(true)
    await ctx.builds.get(job.id)!.done
    const status = json(await client.callTool({ name: 'get_build_status', arguments: { site, jobId: job.id } }))
    expect(status).toMatchObject({ status: 'succeeded', error: null })
    expect(status.log).toContain('built 3 pages')
    expect(commands).toEqual(['npx astro build'])
    const doc = JSON.parse(await readFile(path.join(ctx.config.root, 'dist/.well-known/static-site-mcp.json'), 'utf8'))
    expect(doc.publicKey).toBe(ctx.identity.publicKey)
  })

  it('uploads an image into the asset directory', async () => {
    const ctx = await context(ASTRO_SITE)
    const client = await connect([ctx])
    expect(json(await client.callTool({ name: 'get_site_info', arguments: { site } })).assetDir).toBe('public')
    const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]).toString('base64')
    expect(json(await client.callTool({ name: 'upload_file', arguments: { site, path: 'public/team.jpg', data } }))).toMatchObject({ path: 'public/team.jpg' })
    expect((await client.callTool({ name: 'upload_file', arguments: { site, path: 'public/team.jpg', data } })).isError).toBe(true)
  })

  it('refuses to build a plain site and to publish without a target', async () => {
    const client = await connect([await context(PLAIN_SITE)])
    expect((await client.callTool({ name: 'build', arguments: { site } })).isError).toBe(true)
    const job = json(await client.callTool({ name: 'publish', arguments: { site } }))
    expect(job.status).toBe('running')
  })
})

describe('several sites', () => {
  it('nothing happens without the site, or for a site that is unknown or not allowed', async () => {
    const a = await context(PLAIN_SITE)
    const b = await secondSite()
    const client = await connect([a, b], ['example'])
    // No site: refused by the input schema before any code runs
    const missing = await client.callTool({ name: 'write_file', arguments: { path: 'x.txt', content: 'x' } })
    expect(missing.isError).toBe(true)
    const unknown = await client.callTool({ name: 'write_file', arguments: { site: 'nope', path: 'x.txt', content: 'x' } })
    expect(errorText(unknown)).toMatch(/Unknown site "nope".*Sites: example/)
    // Configured, but not this caller's
    const other = await client.callTool({ name: 'get_page', arguments: { site: 'shop', id: 'index.html' } })
    expect(other.isError).toBe(true)
    const nonce = 'client-nonce-1234567890'
    expect((await client.callTool({ name: 'site_identity', arguments: { site: 'shop', nonce } })).isError).toBe(true)
    expect(json(await client.callTool({ name: 'list_sites', arguments: {} })).sites.map((s: { id: string }) => s.id)).toEqual(['example'])
  })

  it('keeps every site to its own files and key', async () => {
    const a = await context(PLAIN_SITE)
    const b = await secondSite()
    const client = await connect([a, b])
    expect(json(await client.callTool({ name: 'get_page', arguments: { site: 'shop', id: 'index.html' } })).title).toBe('Shop')
    expect(json(await client.callTool({ name: 'get_page', arguments: { site: 'example', id: 'index.html' } })).title).toBe('Home & Garden')
    expect((await client.callTool({ name: 'get_page', arguments: { site: 'shop', id: 'about/index.html' } })).isError).toBe(true)
    const nonce = 'client-nonce-1234567890'
    const proof = (await client.callTool({ name: 'site_identity', arguments: { site: 'shop', nonce } })).structuredContent
    expect(verifyIdentity({ websiteUrl: 'https://shop.example.org', mcpUrl: 'https://shop.example.org/mcp', nonce, wellKnown: b.identity.wellKnown(), proof })).toEqual({ ok: true })
    // The other site's key does not prove this website
    expect(verifyIdentity({ websiteUrl: 'https://shop.example.org', mcpUrl: 'https://shop.example.org/mcp', nonce, wellKnown: a.identity.wellKnown(), proof })).toMatchObject({ ok: false })
  })
})

describe('HTTP endpoint', () => {
  async function serve() {
    const a = await context(PLAIN_SITE)
    const b = await secondSite()
    const stateDir = path.dirname(path.dirname(a.config.stateDir))
    const ctx: ServerContext = {
      config: { stateDir, server: { host: '127.0.0.1', port: 0, rateLimit: 120 }, sites: new Map([[a.config.id, a.config], [b.config.id, b.config]]) },
      sites: new Map([[a.config.id, a], [b.config.id, b]]),
    }
    const server = createApp(ctx).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    return { url, stateDir, close: () => server.close() }
  }
  const rpc = (url: string, token: string | undefined, method: string, params: Record<string, unknown>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  const init = (url: string, token?: string) => rpc(url, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })

  it('requires a valid bearer token bound to a configured site', async () => {
    const { url, stateDir, close } = await serve()
    try {
      const { token } = await createToken(stateDir, 'maia', 'example')
      expect((await init(url)).status).toBe(401)
      expect((await init(url, 'ssm_wrong')).status).toBe(401)
      const res = await init(url, token)
      expect(res.status).toBe(200)
      expect((await res.json()).result.serverInfo.name).toBe('static-site-mcp')
      expect((await fetch(url)).status).toBe(405)
      const { token: stale } = await createToken(stateDir, 'old', 'removed-site')
      expect((await init(url, stale)).status).toBe(403)
    } finally {
      close()
    }
  })

  it('a token reaches only its one site', async () => {
    const { url, stateDir, close } = await serve()
    try {
      const { token } = await createToken(stateDir, 'maia', 'example')
      const call = async (name: string, args: Record<string, unknown>) => (await (await rpc(url, token, 'tools/call', { name, arguments: args })).json()).result
      expect((await call('get_page', { site: 'example', id: 'index.html' })).isError).toBeFalsy()
      expect((await call('get_page', { site: 'shop', id: 'index.html' })).isError).toBe(true)
    } finally {
      close()
    }
  })
})
