import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Request, type Response } from 'express'
import { matchToken, readTokens, tokenSites } from './auth.js'
import type { ServerContext } from './context.js'
import { buildMcpServer } from './server.js'

/**
 * HTTP endpoint: POST /mcp (Streamable HTTP, stateless, JSON responses), bearer token required. The token decides
 * which of the server's sites the caller may use; every tool call still names its site. Meant to run on the
 * websites' server behind the reverse proxy of each website (e.g. https://example.com/mcp or
 * https://mcp.example.com/mcp), which terminates TLS. Binds to 127.0.0.1 by default.
 */
export function createApp(ctx: ServerContext) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  // Simple fixed window per token
  const windows = new Map<string, { start: number; count: number }>()
  const allowed = (key: string) => {
    const now = Date.now()
    const w = windows.get(key)
    if (!w || now - w.start > 60_000) {
      windows.set(key, { start: now, count: 1 })
      return true
    }
    w.count++
    return w.count <= ctx.config.server.rateLimit
  }

  app.get('/health', (_req, res) => {
    // No site list here: it is not public which websites this server manages
    res.json({ ok: true })
  })

  app.post('/mcp', async (req: Request, res: Response) => {
    const header = req.get('authorization') ?? ''
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim()
    // Re-read on every request so `token revoke` applies at once
    const token = matchToken(await readTokens(ctx.config.stateDir), bearer)
    if (!token) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="static-site-mcp"').json({ error: 'invalid_token' })
      return
    }
    if (!allowed(token.id)) {
      res.status(429).json({ error: 'rate_limited' })
      return
    }
    const sites = tokenSites(token, ctx.sites.keys())
    if (sites.length === 0) {
      res.status(403).json({ error: 'no_sites', message: 'This token may not manage any configured site' })
      return
    }
    const server = buildMcpServer(ctx.sites, sites)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error('[static-site-mcp] request failed', err)
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })

  // Stateless server: no SSE stream, no sessions to end
  app.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' })
  })

  return app
}
