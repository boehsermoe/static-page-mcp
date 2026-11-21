import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { FRAMEWORKS, detectFramework, type FrameworkId, type FrameworkProfile } from './frameworks.js'
import { normHost } from './identity.js'

/**
 * One server manages SEVERAL websites, each under its own id. Every tool call names the site it is for; there is
 * no default site. Everything the agent may trigger (build command, publish target) comes from this file, never
 * from a tool argument.
 */
const publishSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /** Copy the build output into the directory the web server serves */
  z.object({ type: z.literal('copy'), targetDir: z.string().min(1) }),
  /** Commit the working copy and push it; the hosting (Vercel, Netlify, Cloudflare, …) builds from git */
  z.object({ type: z.literal('git'), remote: z.string().default('origin'), branch: z.string().min(1) }),
  /** Call a deploy hook (POST, empty body) */
  z.object({ type: z.literal('hook'), url: z.string().url() }),
])

/** A site id: what every tool call and every token names */
export const SITE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

const siteSchema = z.object({
  siteUrl: z.string().url(),
  /** The working copy of the site (project root), relative to the config file. Required: no site without a path */
  root: z.string().min(1),
  framework: z.enum(['auto', ...Object.keys(FRAMEWORKS)] as [string, ...string[]]).default('auto'),
  build: z
    .object({
      /** null = no local build (plain sites, or the hosting builds after a git publish) */
      command: z.string().min(1).nullable().optional(),
      outputDir: z.string().optional(),
      timeoutSeconds: z.number().int().positive().max(3600).default(900),
    })
    .default({}),
  publish: publishSchema.default({ type: 'none' }),
  /** Extra directories (relative to root) that hold content pages */
  contentDirs: z.array(z.string()).optional(),
  /**
   * The ONLY folders and files (relative to root, prefix match) the agent may read or write, e.g. ["src", "public"];
   * "." = the whole site. Required: without an explicit list nothing is reachable. .git, .env*, node_modules and the
   * site key stay unreachable even inside an allowed folder.
   */
  allow: z
    .array(z.string().min(1))
    .min(1, 'allow: list the folders/files the agent may use, e.g. ["src", "public"] ("." = the whole site)'),
})

const configSchema = z.object({
  /** The websites, by id (lower case letters, digits, "-") */
  sites: z
    .record(z.string().regex(SITE_ID, 'Site ids are lower case letters, digits and "-" (max 40)'), siteSchema)
    .refine((sites) => Object.keys(sites).length > 0, 'At least one site is required'),
  /** Where keys and token hashes live, relative to the config file. Must not be inside a site or a served directory */
  stateDir: z.string().default('.static-mcp'),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(8787),
      /** Requests per minute and token */
      rateLimit: z.number().int().positive().default(120),
    })
    .default({}),
})

export type RawSite = z.input<typeof siteSchema>
type ParsedSite = z.infer<typeof siteSchema>

export interface SiteConfig {
  /** The site id, as tool calls and tokens name it */
  id: string
  siteUrl: string
  /** Host of siteUrl, lower case, without "www." */
  host: string
  root: string
  framework: FrameworkProfile
  build: { command: string | null; outputDir: string | null; timeoutSeconds: number }
  publish: ParsedSite['publish']
  contentDirs: string[]
  /** Allowed path prefixes, normalised ("" = the whole site) */
  allow: string[]
  /** This site's own state (its key): <stateDir>/sites/<id> */
  stateDir: string
}

export interface ServerConfig {
  /** Token hashes live here; each site's key below sites/<id> */
  stateDir: string
  server: z.infer<typeof configSchema>['server']
  sites: Map<string, SiteConfig>
}

export const siteHost = (url: string) => normHost(new URL(url).hostname)

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The directories a web server serves for a site: the private keys must never be in one */
function servedDirs(site: SiteConfig): string[] {
  const dirs = [site.framework.id === 'plain' ? site.root : null, site.build.outputDir ? path.resolve(site.root, site.build.outputDir) : null]
  if (site.framework.publicDir) dirs.push(path.resolve(site.root, site.framework.publicDir))
  if (site.publish.type === 'copy') dirs.push(site.publish.targetDir)
  return dirs.filter((d): d is string => d !== null)
}

/** One allow entry as a clean relative prefix ("." becomes "", the whole site) */
function allowEntry(id: string, entry: string): string {
  const clean = path.posix.normalize(entry.replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (path.posix.isAbsolute(clean) || clean === '..' || clean.startsWith('../')) throw new Error(`Site "${id}": allow entries are paths inside the site, not "${entry}"`)
  return clean === '.' ? '' : clean
}

/** One site, resolved against the config file's directory */
export async function resolveSite(id: string, raw: unknown, baseDir: string, stateDir: string): Promise<SiteConfig> {
  if (!SITE_ID.test(id)) throw new Error(`Invalid site id "${id}"`)
  if (raw && typeof raw === 'object' && 'deny' in raw) throw new Error(`Site "${id}": "deny" was replaced by "allow", the list of folders the agent may use`)
  const parsed = siteSchema.parse(raw)
  const root = path.resolve(baseDir, parsed.root)
  const frameworkId = (parsed.framework === 'auto' ? await detectFramework(root) : parsed.framework) as FrameworkId
  const framework = FRAMEWORKS[frameworkId]
  const command = parsed.build.command === undefined ? framework.buildCommand : parsed.build.command
  const outputDir = parsed.build.outputDir ?? framework.outputDir
  return {
    id,
    siteUrl: parsed.siteUrl,
    host: siteHost(parsed.siteUrl),
    root,
    framework,
    build: { command: command ?? null, outputDir: outputDir ?? null, timeoutSeconds: parsed.build.timeoutSeconds },
    publish: parsed.publish.type === 'copy' ? { ...parsed.publish, targetDir: path.resolve(baseDir, parsed.publish.targetDir) } : parsed.publish,
    contentDirs: parsed.contentDirs ?? framework.contentDirs,
    allow: parsed.allow.map((entry) => allowEntry(id, entry)),
    stateDir: path.join(stateDir, 'sites', id),
  }
}

/**
 * Validates a raw config and resolves it against the directory it was read from. Refuses anything that would make
 * the assignment of a call to a site unclear or let one site reach another: two sites with the same website,
 * nested site roots, and a state dir inside a site or a served directory.
 */
export async function resolveConfig(raw: unknown, baseDir: string): Promise<ServerConfig> {
  const parsed = configSchema.parse(raw)
  const stateDir = path.resolve(baseDir, parsed.stateDir)
  const sites = new Map<string, SiteConfig>()
  for (const [id, rawSite] of Object.entries(parsed.sites)) sites.set(id, await resolveSite(id, rawSite, baseDir, stateDir))

  const list = [...sites.values()]
  for (const site of list) {
    for (const dir of [site.root, ...servedDirs(site)]) {
      if (isInside(stateDir, dir)) throw new Error(`stateDir (${stateDir}) is inside site "${site.id}" (${dir}); move it out of every site and web root`)
    }
    for (const other of list) {
      if (other === site) continue
      if (other.host === site.host) throw new Error(`Sites "${site.id}" and "${other.id}" have the same website (${site.host}); each website may be configured once`)
      if (isInside(other.root, site.root)) throw new Error(`Site "${other.id}" (${other.root}) is inside site "${site.id}" (${site.root}); site roots must not overlap`)
    }
  }
  return { stateDir, server: parsed.server, sites }
}

export async function loadConfig(file: string): Promise<ServerConfig> {
  const abs = path.resolve(file)
  const raw = JSON.parse(await readFile(abs, 'utf8'))
  return resolveConfig(raw, path.dirname(abs))
}
