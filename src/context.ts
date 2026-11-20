import { BuildRunner } from './build.js'
import type { ServerConfig } from './config.js'
import { SiteIdentity } from './identity.js'
import type { SiteContext } from './server.js'

/** Everything a running server needs: its config and one context (key, build runner) per site */
export interface ServerContext {
  config: ServerConfig
  sites: Map<string, SiteContext>
}

export async function loadSites(config: ServerConfig): Promise<ServerContext> {
  const sites = new Map<string, SiteContext>()
  for (const [id, site] of config.sites) {
    const identity = await SiteIdentity.loadOrCreate(site.stateDir, site.siteUrl, site.host)
    sites.set(id, { config: site, identity, builds: new BuildRunner(site, identity) })
  }
  return { config, sites }
}
