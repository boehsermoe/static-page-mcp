#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import path from 'node:path'
import { createToken, readTokens, revokeToken } from './auth.js'
import { loadConfig, type ServerConfig, type SiteConfig } from './config.js'
import { loadSites } from './context.js'
import { createApp } from './http.js'
import { WELL_KNOWN_PATH } from './identity.js'
import { buildMcpServer } from './server.js'

const USAGE = `static-site-mcp <command> [--config static-mcp.config.json]

Commands:
  sites                              List the configured sites
  init --site <id>                   Create the site's key and publish its public key on the website
  token create <name> --sites <a,b>  Create an access token for these sites (shown once)
  token list                         List tokens (names, ids and sites)
  token revoke <id|name>
  serve                              Start the HTTP server (POST /mcp)
  stdio                              Run over stdio (local MCP clients; all sites)
`

/** Where the public key file must go so the website serves it */
function wellKnownTargets(site: SiteConfig): string[] {
  const dirs: string[] = []
  if (site.framework.id === 'plain') dirs.push(site.root)
  if (site.framework.publicDir) dirs.push(path.resolve(site.root, site.framework.publicDir))
  if (site.publish.type === 'copy') dirs.push(site.publish.targetDir)
  return dirs
}

/** Takes `--name value` out of argv */
function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv.splice(i, 2)[1] : undefined
}

/** The sites named on the command line; every one must be configured (no implicit "all") */
function namedSites(config: ServerConfig, list: string | undefined, flag: string): string[] {
  const ids = (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error(`Name the site(s) with ${flag} (configured: ${[...config.sites.keys()].join(', ')})`)
  const unknown = ids.filter((id) => !config.sites.has(id))
  if (unknown.length) throw new Error(`Unknown site(s): ${unknown.join(', ')} (configured: ${[...config.sites.keys()].join(', ')})`)
  return ids
}

async function main(argv: string[]) {
  const configFile = option(argv, '--config') ?? 'static-mcp.config.json'
  const siteOption = option(argv, '--site')
  const sitesOption = option(argv, '--sites')
  const [command, sub, arg] = argv
  const config = await loadConfig(configFile)

  switch (command) {
    case 'sites': {
      for (const site of config.sites.values()) console.log(`${site.id}  ${site.siteUrl}  ${site.framework.label}  ${site.root}`)
      return
    }
    case 'init': {
      const ids = namedSites(config, siteOption, '--site')
      const { sites } = await loadSites(config)
      for (const id of ids) {
        const { config: site, identity } = sites.get(id)!
        for (const dir of wellKnownTargets(site)) console.log(`[${id}] Wrote ${await identity.publishTo(dir)}`)
        console.log(`[${id}] ${site.siteUrl} (${site.framework.label}) must serve ${new URL(WELL_KNOWN_PATH, site.siteUrl)} (it is written into every build output too).`)
      }
      return
    }
    case 'token': {
      if (sub === 'create' && arg) {
        const { token, stored } = await createToken(config.stateDir, arg, namedSites(config, sitesOption, '--sites'))
        console.log(`Token "${stored.name}" (${stored.id}) for ${stored.sites.join(', ')}. Copy it now, it is not shown again:\n${token}`)
      } else if (sub === 'list') {
        for (const t of await readTokens(config.stateDir)) console.log(`${t.id}  ${t.name}  sites: ${(t.sites ?? []).join(', ') || 'none'}  ${t.createdAt}`)
      } else if (sub === 'revoke' && arg) {
        console.log((await revokeToken(config.stateDir, arg)) ? 'Revoked' : 'No such token')
      } else console.log(USAGE)
      return
    }
    case 'serve': {
      const ctx = await loadSites(config)
      const { host, port } = config.server
      createApp(ctx).listen(port, host, () => console.log(`static-site-mcp for ${[...ctx.sites.keys()].join(', ')} on http://${host}:${port}/mcp`))
      return
    }
    case 'stdio': {
      // A local client started by the server's owner: every site, but each call still names its site
      const ctx = await loadSites(config)
      await buildMcpServer(ctx.sites, [...ctx.sites.keys()]).connect(new StdioServerTransport())
      return
    }
    default:
      console.log(USAGE)
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
