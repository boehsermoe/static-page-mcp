import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * A token as stored: only its SHA-256 hash, the token itself is shown once. It opens exactly the listed sites;
 * a token without sites (or one written before tokens had sites) opens none.
 */
export interface StoredToken {
  id: string
  name: string
  hash: string
  sites: string[]
  createdAt: string
}

const TOKEN_PREFIX = 'ssm_'
const tokensFile = (stateDir: string) => path.join(stateDir, 'tokens.json')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function readTokens(stateDir: string): Promise<StoredToken[]> {
  try {
    return JSON.parse(await readFile(tokensFile(stateDir), 'utf8')) as StoredToken[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeTokens(stateDir: string, tokens: StoredToken[]) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(tokensFile(stateDir), JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

/** Creates a token for the given sites (at least one, named explicitly), stores its hash and returns the token (shown once) */
export async function createToken(stateDir: string, name: string, sites: string[]): Promise<{ token: string; stored: StoredToken }> {
  const unique = [...new Set(sites)]
  if (unique.length === 0) throw new Error('A token needs the sites it may manage (--sites a,b)')
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const stored: StoredToken = { id: randomUUID(), name, hash: sha256(token), sites: unique, createdAt: new Date().toISOString() }
  await writeTokens(stateDir, [...(await readTokens(stateDir)), stored])
  return { token, stored }
}

export async function revokeToken(stateDir: string, idOrName: string): Promise<boolean> {
  const tokens = await readTokens(stateDir)
  const kept = tokens.filter((t) => t.id !== idOrName && t.name !== idOrName)
  if (kept.length === tokens.length) return false
  await writeTokens(stateDir, kept)
  return true
}

/** The sites a token may manage, limited to the configured ones */
export function tokenSites(token: StoredToken, configured: Iterable<string>): string[] {
  const known = new Set(configured)
  return (Array.isArray(token.sites) ? token.sites : []).filter((id) => known.has(id))
}

/** The stored token a bearer value belongs to, or null (constant time per stored token) */
export function matchToken(tokens: StoredToken[], bearer: string | undefined): StoredToken | null {
  if (!bearer || !bearer.startsWith(TOKEN_PREFIX)) return null
  const hash = Buffer.from(sha256(bearer), 'hex')
  let found: StoredToken | null = null
  for (const t of tokens) {
    if (timingSafeEqual(hash, Buffer.from(t.hash, 'hex'))) found = t
  }
  return found
}
