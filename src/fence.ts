import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { SiteConfig } from './config.js'

/** Paths the agent may never read or write, whatever the config says */
const ALWAYS_DENIED = ['.git', '.env', 'node_modules', '.static-mcp', '.ssh', '.npmrc']
export const MAX_FILE_BYTES = 1024 * 1024

export class FenceError extends Error {}

const normalise = (rel: string) => rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')

/** The published site key: overwriting it would break the website's proof of its MCP */
const IDENTITY_FILE = '.well-known/static-site-mcp.json'

function denied(rel: string, extra: string[]): boolean {
  if (rel === IDENTITY_FILE || rel.endsWith('/' + IDENTITY_FILE)) return true
  const parts = rel.split('/')
  if (parts.some((part) => ALWAYS_DENIED.some((d) => part === d || (d === '.env' && part.startsWith('.env'))))) return true
  return extra.some((prefix) => {
    const p = normalise(prefix)
    return rel === p || rel.startsWith(p + '/')
  })
}

/**
 * Resolves a path the agent sent to an absolute path inside the site root.
 * Rejects absolute paths, "..", denied names and symlinks that lead out of the root.
 */
export async function resolveInside(config: SiteConfig, relPath: string): Promise<{ abs: string; rel: string }> {
  if (typeof relPath !== 'string' || relPath.includes('\0')) throw new FenceError('Invalid path')
  const rel = normalise(path.posix.normalize(normalise(relPath)))
  if (rel === '' || rel === '.') return { abs: config.root, rel: '' }
  if (path.isAbsolute(relPath) || rel.startsWith('../') || rel === '..') throw new FenceError(`Path is outside the site: ${relPath}`)
  if (denied(rel, config.deny)) throw new FenceError(`Path is not accessible: ${relPath}`)
  const abs = path.join(config.root, rel)
  // A symlink inside the root may point outside it: check the real location of the deepest existing part
  let probe = abs
  for (;;) {
    try {
      const real = await realpath(probe)
      const rootReal = await realpath(config.root)
      const back = path.relative(rootReal, real)
      if (back.startsWith('..') || path.isAbsolute(back)) throw new FenceError(`Path is outside the site: ${relPath}`)
      break
    } catch (err) {
      if (err instanceof FenceError) throw err
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return { abs, rel }
}

/** Whether a relative path (as found while walking the tree) may be shown to the agent */
export function isVisible(config: SiteConfig, rel: string): boolean {
  return !denied(normalise(rel), config.deny)
}
