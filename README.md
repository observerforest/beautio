# Beautio

Beautio is a low-friction, inventory-first personal beauty management system. Its core keeps inventory and lifecycle facts independent from any single AI provider, and exposes the same rules through MCP, GPT Actions, and a human management page.

## Product boundaries

- Prefer products already in inventory.
- Keep purchase intent separate from daily routine selection.
- Let skin state override expiry-driven consumption priority.
- Keep domain rules in the core service, not in prompts or client adapters.
- Treat the core database as the only source of truth.
- Upload or create inventory only after the user confirms the structured draft.

## Repository layout

```text
apps/
  web/                 Authenticated inventory and correction interface
services/
  core-api/            Remote MCP, GPT Action, Codex, and Admin HTTP adapters
  mcp-server/          Production thin-client and local-dev stdio MCP adapters
packages/
  contracts/           Strict input and output schemas
  domain/              Entities, value objects, and lifecycle policies
  application/         Shared business use cases and ports
  database/            Local SQLite repository and preserving migrations
  image-storage/       Private filesystem bytes and raster decoding
```

Every production entry point converges on the server's single `InventoryApplicationService`. The production stdio MCP reads controlled local files and calls that boundary over fixed HTTPS; it never opens SQLite or managed-image storage itself. The explicit dev stdio entry builds the same application boundary around temporary local storage. MCP transport, HTTP routing, and browser code do not calculate PAO deadlines, write SQLite directly, or invent persistent IDs.

## Local management page

Use Node.js 24 and pnpm 11. The HTTP process fails closed unless two different bearer keys and an Action file host allowlist are configured. For local UI work, clearly fictional host configuration is enough if the Action upload route is not called:

```sh
export BEAUTIO_ACTION_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ADMIN_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ACTION_FILE_HOST_ALLOWLIST="files.example.invalid"
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4173>, enter the Admin key for the current tab, and unlock the page. The key remains only in JavaScript memory; locking or leaving the page clears it. The browser does not read inventory or managed images before unlock.

By default, local development uses ignored paths:

```text
.local/beautio-validation.sqlite
.local/managed-images/
```

The page keeps one card per physical bottle. Product name, category, size, one display image, confirmed packaging ingredient text, and shared notes are shared by every bottle linked to that Product. Product edits therefore appear on every related card. Each bottle has separate custom notes. Inventory fact edits accept only direct lifecycle facts; PAO deadline, final usable-until date, status, and warnings are recalculated by the shared core and re-read after saving. Custom notes use a separate narrow route and remain editable for terminal history.

Opening dates preserve `exact`, `estimated`, or legacy-without-evidence semantics. An estimated opening and its derived PAO deadline remain visibly estimated until corrected. Terminal `finished` and `discarded` history cannot be rewritten through the active-inventory editor.

Managed `image_asset_id` images are fetched with the Admin key and displayed through revocable Blob URLs. Inventory cards request a private `card` rendition that conservatively removes confident near-white or transparent outer margins; low-confidence or failed processing falls back to the untouched original. Positive and conservative-negative results are checked before reading the original, and native rendering is serialized across different images to bound memory. Product details retain an explicit full-original viewer. The rendition is a versioned, rebuildable filesystem cache for the same ImageAsset, not another Product fact or asset ID, and it is removed with the original during image cleanup. The current filesystem provider assumes one Core API writer per image-storage root; a future multi-process deployment must add a shared lock and durable deletion coordination. When no managed image exists, the existing `image_ref` behavior remains unchanged. This slice does not migrate, delete, or reinterpret legacy image references.

### Production same-origin page

Build the management page once, then let the Core API serve that immutable build
from an absolute controlled directory. Do not run the Vite development server as
a production process:

```sh
pnpm install --frozen-lockfile
pnpm build

export BEAUTIO_DB_PATH="/var/lib/beautio/beautio.sqlite"
export BEAUTIO_IMAGE_STORAGE_ROOT="/var/lib/beautio/managed-images"
export BEAUTIO_ACTION_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ADMIN_BEARER_TOKEN="$(openssl rand -hex 32)"
export BEAUTIO_ACTION_FILE_HOST_ALLOWLIST="oaiusercontent.com"
export BEAUTIO_WEB_ROOT="$PWD/apps/web/dist"
export BEAUTIO_PUBLIC_ORIGIN="https://beautio.example.com"
node services/core-api/src/http.ts
```

`BEAUTIO_WEB_ROOT` is optional for local API tests, but when set it must resolve
to an existing absolute directory. `/` and built assets are public; inventory,
image, Action, and OpenAPI authorization rules remain unchanged. `/api` and
`/openapi` are reserved and can never be shadowed by static files. Root HTML is
revalidated while Vite's `/assets/` output is cached as immutable.

`BEAUTIO_PUBLIC_ORIGIN` is also optional locally. When set, it must be one exact
HTTPS origin with no path, query, fragment, or credentials. The Action OpenAPI
document then contains that origin in `servers`. The Node process listens on
`127.0.0.1` by default, so a same-host reverse proxy or outbound tunnel can
publish it without exposing the origin port directly.

For an isolated Docker Compose network, set `BEAUTIO_API_HOST=0.0.0.0` so a
sibling `cloudflared` container can reach the Core API. Keep the API port
unpublished on the host; `0.0.0.0` is a container-network adaptation, not a
reason to bypass the tunnel. A configured host must be a non-empty IPv4, IPv6,
or ASCII DNS hostname—URLs, ports, paths, and malformed hostnames fail startup.

The local UI example uses the deliberately fictional `files.example.invalid`
host because it does not call the upload route. The production example explicitly
trusts the OpenAI file-content root `oaiusercontent.com`. Other configured entries
remain exact HTTPS download hosts; configuring that one root accepts it and its
dot-boundary subdomains, including regional or multi-level names. It does not match
lookalike suffixes, domains below another root, or trailing-dot variants. Initial
URLs and every redirect use the same host and public-address checks. Keep the
database and managed-image directory outside replaceable release paths, and back
them up together before startup migrations or upgrades.

## Confirmed batch writes

The shared core exposes two write operations:

- `upload_product_images` validates JPEG, PNG, or static WebP content and creates private temporary assets. One call accepts 1–10 images, at most 20 MiB each and 50 MiB total, with a 40-megapixel decoded limit.
- `create_inventory_batch` atomically creates confirmed Product rows and one InventoryItem per bottle, or adds bottles to an existing Product. A new Product may include confirmed `ingredient_list_text` and Product-wide `shared_notes`; every new bottle may independently include `custom_notes`. Optional unknown facts remain `null`; derived fields are never accepted as input. If note ownership is unclear, the caller must ask before writing.

Unlinked temporary images expire after 24 hours. The Core API and local-dev stdio services run cleanup at startup and at least hourly; the production stdio thin client owns no storage to clean. Linked images are retained; replacing or clearing a Product image restarts the old asset's 24-hour unlinked window.

`create_inventory_batch` does not promise request idempotency. A caller must not silently retry when the result is unknown.

### Read-only remote MCP

The Core API can explicitly enable a separate Streamable HTTP MCP endpoint at
`/mcp`. It exposes exactly `search_inventory` and `fetch_inventory_item`; both
reuse the server's existing `InventoryApplicationService` and never register a
write, image-content, resource, or prompt surface. Search returns compact
inventory summaries. Fetch returns the complete Product ingredient text and
shared notes plus one bottle's custom notes. Images are reduced to
`has_image`; no image ID, legacy reference, URL, path, or bytes are returned.

An optional `as_of` adds the date-relative domain status. When it is omitted,
`derived_status` is `null`; the server never substitutes its clock or time zone.

The route is absent by default. Enabling it requires a complete, independent
Cloudflare Access configuration:

```sh
export BEAUTIO_REMOTE_MCP_ENABLED=true
export BEAUTIO_REMOTE_MCP_HOST="mcp.beautio.example.com"
export BEAUTIO_ACCESS_TEAM_DOMAIN="https://team.cloudflareaccess.com"
export BEAUTIO_ACCESS_AUDIENCE="managed-oauth-application-audience"
```

The public hostname must be protected by a Cloudflare Access MCP application
with Managed OAuth. Access performs the client OAuth flow and injects
`Cf-Access-Jwt-Assertion`; the origin independently verifies that JWT against
the team JWKS, exact issuer, exact application audience, and validity window.
The one-user email allow policy lives only in Cloudflare Access and is not
duplicated in the origin environment. Action/Admin bearer keys are never
accepted at this endpoint. The endpoint also rejects other Host or browser
Origin values, caps authenticated request bodies and concurrent requests, and
applies a deadline to each read operation. Keep every real Access value in
deployment secrets, not in source control or logs.

### Production stdio MCP

The default Codex adapter is a thin client for the deployed Beautio service. It
needs one fixed HTTPS origin, a protected file containing only the Action key,
and an absolute controlled local directory for files that the user selected:

```sh
export BEAUTIO_REMOTE_ORIGIN="https://beautio.example.com"
export BEAUTIO_ACTION_TOKEN_FILE="/absolute/private/path/beautio-action-token"
export BEAUTIO_MCP_UPLOAD_ROOT="$PWD/.local/confirmed-inputs"
node services/mcp-server/src/production-stdio.ts
```

The token file must be a current-user-owned, non-symlink regular file with mode
`0600`. The client fixes all five remote routes, rejects redirects, makes no
automatic request retry, applies a 45-second deadline and a 1 MiB response
limit, and validates every response against the shared strict contracts. It
exposes the existing four tools plus `set_product_display_image`; the new tool
changes only one Product's shared managed image, so every inventory card for
that Product changes together after re-read.

`upload_product_images` still rejects relative paths, URIs, directories,
devices, symbolic links, traversal, and files outside
`BEAUTIO_MCP_UPLOAD_ROOT`. Local paths are removed before HTTPS upload and never
enter the remote database or success output.

The production HTTP bridge is Action-key authenticated but intentionally absent
from the GPT Actions OpenAPI. It forwards all business operations into the same
server `InventoryApplicationService`, Domain, Repository, SQLite database, and
managed-image storage used by the mobile management page.

### Local development stdio MCP

The retained development adapter uses an isolated local database and image
directory. Keep it disabled in normal Codex configuration and enable it only for
explicit local tests:

```sh
mkdir -p .local/confirmed-inputs .local/managed-images
export BEAUTIO_DB_PATH="$PWD/.local/beautio-validation.sqlite"
export BEAUTIO_IMAGE_STORAGE_ROOT="$PWD/.local/managed-images"
export BEAUTIO_MCP_UPLOAD_ROOT="$PWD/.local/confirmed-inputs"
node services/mcp-server/src/stdio.ts
```

This dev entry retains the original four-tool local E2E and does not synchronize
its SQLite or image directory with production.

### GPT Actions HTTP

The versioned schema (currently API version 1.1) is available to the Action bearer key from a configured
server at:

```text
GET /openapi/beautio-actions-v1.json
```

It exposes only:

```text
POST /api/actions/upload-product-images
POST /api/actions/create-inventory-batch
```

Both require the Action bearer key and are marked consequential. Action file downloads require HTTPS and a configured trusted source: normal allowlist entries are exact, while the explicit `oaiusercontent.com` root also accepts only its dot-boundary subdomains. Public DNS results are required on every redirect, with at most three redirects, 15 seconds per file, and 40 seconds for the complete upload. Short-lived upstream file IDs and URLs are not persisted.

For a public deployment, `BEAUTIO_PUBLIC_ORIGIN` adds the exact HTTPS server URL
that Custom GPT should call. With the variable omitted, the schema keeps its
local-test form and has no `servers` entry.

This repository verifies the local Action contract with simulated upstream file delivery. It does not claim that a public domain, Custom GPT, TLS, DNS, or remote server deployment is live.

## Admin HTTP surface

Only health is public. The OpenAPI document, its two GPT Action writes, and the
fixed Codex automation bridge require the Action bearer key. Inventory,
management edits, browser image upload, and private-image reads require the
separate Admin bearer key:

```text
GET  /api/health
GET  /api/inventory?as_of=YYYY-MM-DD
POST /api/admin/image-assets
PUT  /api/admin/products/:product_id
PUT  /api/admin/inventory-items/:inventory_item_id/facts
PUT  /api/admin/inventory-items/:inventory_item_id/custom-notes
GET  /api/image-assets/:image_asset_id/content
GET  /api/image-assets/:image_asset_id/content?variant=card
```

The Codex-adapter routes are fixed transport adapters in the same Action-key
scope; they are intentionally not listed in the GPT OpenAPI:

```text
POST /api/actions/codex/record-product-opened
POST /api/actions/codex/get-inventory-item
POST /api/actions/codex/upload-product-images
POST /api/actions/codex/set-product-display-image
```

The Action and Admin keys cannot be exchanged. Missing, empty, equal, incorrect, or out-of-scope keys fail without database or filesystem side effects.

## Local-only seed import

For development fixtures, create JSON under ignored `.local/` and import it explicitly:

```sh
pnpm import:local -- .local/example-inventory.json
```

```json
{
  "products": [
    {
      "id": "product-example",
      "name": "Example product",
      "category": "serum",
      "size_label": "30 ml",
      "image_ref": "/local-assets/product-example.webp"
    }
  ],
  "inventory_items": [
    {
      "id": "bottle-example-1",
      "product_id": "product-example",
      "lifecycle_status": "unopened",
      "opened_on": null,
      "opened_on_accuracy": null,
      "expires_on": "2027-01-01"
    }
  ]
}
```

The import remains a local fixture helper, not an Agent or Admin API. It is additive and transactional: identical identifiers are left unchanged, while a conflicting identifier aborts instead of overwriting data.

## Development baseline

- Node.js 24
- pnpm 11
- TypeScript strict mode

```sh
pnpm install
pnpm check
pnpm build
git diff --check
```

No credentials, private images, inventory databases, backups, server configuration, or internal decision records belong in this public repository.
