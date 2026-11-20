# static-site-mcp

An MCP server for statically generated or plain static websites. ONE server manages SEVERAL websites on the same machine, each under its own id. An agent (for example MAIA) uses it to read and change pages, content and code, build a site and publish it.

Supported: Astro, Hugo, Eleventy, Jekyll, VitePress, Next.js (static export) and plain HTML. The generator is detected from each site's root, or you set `framework`.

**Every tool call names its site** (`site`). There is no default site: a call without a site, for an unknown site, or for a site its token may not use is refused before anything happens.

## Installation on the websites' server

Requires Node.js 20 or newer and git.

```bash
git clone git@github.com:boehsermoe/static-site-mcp.git /opt/static-site-mcp
cd /opt/static-site-mcp
npm ci && npm run build
cp static-mcp.config.example.json static-mcp.config.json
```

### Configure the sites

```json
{
  "stateDir": "/var/lib/static-site-mcp",
  "server": { "host": "127.0.0.1", "port": 8787, "rateLimit": 120 },
  "sites": {
    "example": {
      "siteUrl": "https://www.example.com/",
      "root": "/srv/sites/example",
      "framework": "auto",
      "publish": { "type": "copy", "targetDir": "/var/www/example.com" }
    },
    "blog": {
      "siteUrl": "https://blog.example.org/",
      "root": "/srv/sites/blog",
      "publish": { "type": "git", "branch": "main" }
    }
  }
}
```

- The keys of `sites` are the site ids (lower case letters, digits, `-`). Clients and tokens name sites by these ids.
- `root` is the site's working copy. Site roots must not overlap, and each website may appear only once.
- `build.command` / `build.outputDir` default to the generator's (e.g. `npx astro build` / `dist`). Plain HTML sites have no build.
- `publish`: `copy` (into the served directory), `git` (commit + push, the hosting builds), `hook` (`{ "type": "hook", "url": "…" }`, a deploy hook) or `none`.
- `deny`: extra path prefixes the agent may never touch.
- `stateDir` holds the site keys and token hashes. It must be outside every site and every served directory, or the server refuses to start.

### Keys, tokens, start

```bash
node dist/cli.js sites                            # check the configured sites
node dist/cli.js init --site example              # creates the site key, writes /.well-known/static-site-mcp.json
node dist/cli.js init --site blog
node dist/cli.js token create maia --sites example,blog   # prints the token once
node dist/cli.js serve                            # POST http://127.0.0.1:8787/mcp
```

- After `init`, a generator site needs one build + publish so the website serves `/.well-known/static-site-mcp.json`. Every build writes it again.
- A token opens exactly the listed sites. `token list` shows them, `token revoke <name>` revokes a token at once.
- Run `serve` as a service (systemd, pm2). Example unit:

```ini
[Service]
WorkingDirectory=/opt/static-site-mcp
ExecStart=/usr/bin/node dist/cli.js serve
Restart=always
User=www-data
```

### Reverse proxy (one per website)

MAIA accepts an MCP server only on the website's own domain or a subdomain of it. So expose the same server on each website's domain, e.g. `https://www.example.com/mcp` and `https://blog.example.org/mcp`, or on `mcp.<domain>`:

```nginx
location = /mcp {
  proxy_pass http://127.0.0.1:8787/mcp;
  proxy_set_header Authorization $http_authorization;
  proxy_read_timeout 60s;
}
```

### In MAIA

Websites → Add website → platform **Static site (MCP)**: the website URL, the MCP server URL (on that website's domain), the site id and the token. MAIA checks that the MCP proves the website's key before it saves it, and again every 24 hours.

## Domain binding

`init` writes the site's public key to `/.well-known/static-site-mcp.json`:
- plain sites: into the web root,
- generators: into the public dir (Astro `public/`, Hugo `static/`, …) and the publish target,
- local builds: into every build output.

A client checks the binding like this:
1. Fetch `https://<website>/.well-known/static-site-mcp.json` **from the website URL**.
2. Call the tool `site_identity` with the site id and its own random nonce.
3. Run `verifyIdentity({ websiteUrl, mcpUrl, nonce, wellKnown, proof })` (exported from this package).

The check passes only when all of these hold:
- the MCP host is the website host or a subdomain of it,
- both name the same host and key,
- the signature over the nonce is valid.

## Tools

Every tool except `list_sites` takes `site`.


| Tool | Kind | |
|---|---|---|
| `list_sites` | read | The sites this token may use |
| `site_identity` | read | Signs a nonce with the site's key (domain binding) |
| `get_site_info` | read | Generator, build and publish setup, latest job |
| `list_pages`, `get_page` | read | Pages with route, URL, title, kind (content / html / template) |
| `list_files`, `read_file`, `search_files` | read | Site sources |
| `update_page` | write | Frontmatter merge + body (Markdown), exact replacements, or full source; returns `previous` |
| `create_page`, `write_file` | write | Returns `previous` (null for new files) |
| `delete_page`, `delete_file` | destructive | Returns `previous` |
| `build`, `publish` | write | Background jobs; poll `get_build_status` |
| `get_build_status` | read | Job status and last 200 log lines |

Tools are annotated with `readOnlyHint` / `destructiveHint`, so clients can ask for approval before writes. The agent can never pass a command. The build command and the publish target come only from the config.

Publish targets:
- `copy`: copy the output into the served directory,
- `git`: commit and push, so the hosting (Vercel, Netlify, Cloudflare, …) builds,
- `hook`: call a deploy hook,
- `none`.

## Safety

- Path fence:
  - no absolute paths, no `..`, no symlinks out of the root,
  - `.git`, `.env*`, `node_modules`, the state dir and the published key are never reachable,
  - extra `deny` prefixes from the config are blocked too.
- 1 MB per file. Bearer tokens are stored as SHA-256 hashes, and revoking one applies at once. Rate limit per token.
- The build runs with a minimal environment (PATH, HOME, locale), never the server's secrets.
- Every tool result starts with a notice that website content is data, not instructions.

## Development

```bash
npm test        # vitest
npm run typecheck
```
