import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * A token as stored: only its SHA-256 hash, the token itself is shown once. A token opens exactly ONE site;
 * a token without a site (or one written in another format) opens none.
 */
export interface StoredToken {
  id: string
  name: string
  hash: string
  site: string
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

/** Creates a token for exactly one site, stores its hash and returns the token (shown once) */
export async function createToken(stateDir: string, name: string, site: string): Promise<{ token: string; stored: StoredToken }> {
  if (!site) throw new Error('A token needs the one site it may manage (--site <id>)')
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const stored: StoredToken = { id: randomUUID(), name, hash: sha256(token), site, createdAt: new Date().toISOString() }
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

/** The one site a token may manage, or null when it names none or one that is not configured (any more) */
export function tokenSite(token: StoredToken, configured: ReadonlySet<string> | ReadonlyMap<string, unknown>): string | null {
  return typeof token.site === 'string' && configured.has(token.site) ? token.site : null
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
