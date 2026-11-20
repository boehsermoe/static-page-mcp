import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Domain binding. Each site has an Ed25519 key pair. The public key is published
 * ON THE WEBSITE at WELL_KNOWN_PATH; the private key stays with the MCP server.
 * A client proves that an MCP server belongs to a website by sending a nonce to
 * the tool `site_identity` and checking the signature against the key it fetched
 * from the website itself. A server that cannot write to the website cannot
 * publish its key there, so it cannot pose as that website's MCP.
 */
export const WELL_KNOWN_PATH = '/.well-known/static-site-mcp.json'
const IDENTITY_VERSION = 1

export interface WellKnownDocument {
  version: number
  siteUrl: string
  host: string
  /** Ed25519 public key, SPKI DER, base64 */
  publicKey: string
}

export interface IdentityProof {
  version: number
  siteUrl: string
  host: string
  publicKey: string
  nonce: string
  /** base64 Ed25519 signature over signedMessage(host, nonce) */
  signature: string
}

export const signedMessage = (host: string, nonce: string) => `static-site-mcp:v${IDENTITY_VERSION}|${host}|${nonce}`

const identityFile = (stateDir: string) => path.join(stateDir, 'identity.pem')

export class SiteIdentity {
  constructor(
    private readonly privateKey: KeyObject,
    readonly publicKey: string,
    readonly siteUrl: string,
    readonly host: string
  ) {}

  static async loadOrCreate(stateDir: string, siteUrl: string, host: string): Promise<SiteIdentity> {
    let pem: string
    try {
      pem = await readFile(identityFile(stateDir), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const { privateKey } = generateKeyPairSync('ed25519')
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
      await mkdir(stateDir, { recursive: true, mode: 0o700 })
      await writeFile(identityFile(stateDir), pem, { mode: 0o600 })
    }
    const privateKey = createPrivateKey(pem)
    const publicKey = (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
    return new SiteIdentity(privateKey, publicKey, siteUrl, host)
  }

  wellKnown(): WellKnownDocument {
    return { version: IDENTITY_VERSION, siteUrl: this.siteUrl, host: this.host, publicKey: this.publicKey }
  }

  prove(nonce: string): IdentityProof {
    const signature = sign(null, Buffer.from(signedMessage(this.host, nonce)), this.privateKey).toString('base64')
    return { ...this.wellKnown(), nonce, signature }
  }

  /** Writes the public document into a served directory (output dir, public dir or the web root) */
  async publishTo(dir: string): Promise<string> {
    const file = path.join(dir, WELL_KNOWN_PATH)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(this.wellKnown(), null, 2) + '\n')
    return file
  }
}

/** Host name for comparisons: lower case, without a leading "www." */
export const normHost = (h: string) => h.toLowerCase().replace(/^www\./, '')

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * The check a client (MAIA) runs. Pure: the caller fetches the well-known
 * document from the website URL and asks the MCP for a proof of its own nonce.
 *  - the well-known document was served by the website host,
 *  - the MCP URL is on that host or a subdomain of it ("same server"),
 *  - both name the same host and public key,
 *  - the signature over the client's nonce is valid.
 */
export function verifyIdentity(input: { websiteUrl: string; mcpUrl: string; nonce: string; wellKnown: unknown; proof: unknown }): VerifyResult {
  const host = normHost(new URL(input.websiteUrl).hostname)
  const mcpHost = normHost(new URL(input.mcpUrl).hostname)
  // Same server: the MCP host is the website host or a subdomain of it (mcp.example.com)
  if (mcpHost !== host && !mcpHost.endsWith('.' + host)) return { ok: false, reason: `The MCP server (${mcpHost}) does not run on the website's domain (${host})` }
  const doc = input.wellKnown as Partial<WellKnownDocument> | null
  const proof = input.proof as Partial<IdentityProof> | null
  if (!doc || typeof doc.publicKey !== 'string' || typeof doc.host !== 'string') return { ok: false, reason: `The website does not publish ${WELL_KNOWN_PATH}` }
  if (normHost(doc.host) !== host) return { ok: false, reason: `The website's key file names another domain (${doc.host})` }
  if (!proof || typeof proof.signature !== 'string' || typeof proof.publicKey !== 'string') return { ok: false, reason: 'The MCP server returned no identity proof' }
  if (proof.nonce !== input.nonce) return { ok: false, reason: 'The identity proof is for another request' }
  if (normHost(String(proof.host)) !== host) return { ok: false, reason: `The MCP server is bound to another domain (${proof.host})` }
  if (proof.publicKey !== doc.publicKey) return { ok: false, reason: 'The MCP server key does not match the key published on the website' }
  try {
    const key = createPublicKey({ key: Buffer.from(doc.publicKey, 'base64'), format: 'der', type: 'spki' })
    if (!verify(null, Buffer.from(signedMessage(host, input.nonce)), key, Buffer.from(proof.signature, 'base64'))) return { ok: false, reason: 'Invalid signature' }
  } catch {
    return { ok: false, reason: 'Invalid public key or signature' }
  }
  return { ok: true }
}
