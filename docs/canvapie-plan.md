# canvapie Planning Document

## 1. Objective

Build a pipeline-first CLI for agents and automation to access user-authorized Canva.cn resources through Canva Connect API.

The CLI should let an agent accept messy user input, resolve the target Canva design, export assets, inspect generated files, and return stable machine-readable output.

Primary goal:

```sh
canvapie export "$USER_INPUT" --format pptx --inspect --json
```

Where `$USER_INPUT` may be a Canva design URL, a design ID, a Connect API temporary edit/view URL, or a human title like `<title-keyword>`.

## 2. Product Positioning

This is not just a thin wrapper around Canva APIs.

It should behave as an **agent-safe resource adapter**:

- Normalize user-provided design references.
- Handle OAuth and local token lifecycle.
- Manage API pagination, retry, async export jobs, and download URLs.
- Export design resources into stable local artifacts.
- Inspect output files, especially PPTX hidden-slide state.
- Return deterministic JSON/JSONL for scripts, Codex, and MCP tools.

Human-friendly CLI output is secondary. Machine-friendly behavior is the default.

## 3. Initial Scope

V0 should support:

- `canva.cn` OAuth PKCE login.
- Local token storage and refresh.
- Design reference resolution.
- Design list, get, and page metadata.
- Export to `pptx`, `pdf`, `png`, and later other supported formats.
- PPTX inspection for slide visibility.
- JSON and JSONL output modes.
- Batch input from file or stdin.

Out of scope for V0:

- Multi-user SaaS auth.
- Canva.com global environment parity.
- Editing or creating Canva designs.
- Full MCP server implementation.

## 4. Security Model

### Open-Source Local Mode

The user creates their own Canva.cn Connect integration and stores credentials locally.

Local config:

```text
~/.canvapie/config.json
~/.canvapie/tokens.json
~/.canvapie/cache/
```

The CLI must never print access tokens, refresh tokens, or client secrets.
The project should not embed or distribute a shared `client_secret`. Each user is expected to configure their own Canva.cn integration via `canvapie init`.

Recommended config commands:

```sh
canvapie config set client_id OC-...
canvapie config set client_secret ...
canvapie config set api_base_url https://api.canva.cn/rest/v1
canvapie config set web_base_url https://www.canva.cn
```

## 5. Agent-First Command Contract

All non-auth commands must be non-interactive by default.

Rules:

- `stdout` is for JSON, JSONL, or requested file paths.
- `stderr` is for progress logs and warnings.
- Exit codes matter.
- Missing auth, missing scopes, ambiguous references, and API errors must be returned as structured errors.
- Commands should support `--json`, `--jsonl`, `--quiet`, `--timeout`, `--retry`, and `--non-interactive`.

Standard success envelope:

```json
{
  "ok": true,
  "command": "export",
  "result": {},
  "artifacts": [],
  "warnings": [],
  "metrics": {}
}
```

Standard error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "missing_scope",
    "message": "design:content:read is required",
    "retryable": false,
    "required_scopes": ["design:content:read"],
    "remediation": "Run canvapie auth login --scopes \"design:meta:read design:content:read\""
  }
}
```

## 6. Design Reference Resolver

All commands that operate on a design should accept a single `design-ref`.

Examples:

```sh
canvapie resolve "<design-id>" --json
canvapie designs get "https://www.canva.cn/design/<design-id>/edit" --json
canvapie export "<title-keyword>" --format pptx --inspect --json
```

### Resolver Inputs

1. Direct design ID:

```text
<design-id>
```

2. Standard Canva design URL:

```text
https://www.canva.cn/design/<design-id>/edit
https://www.canva.cn/design/<design-id>/view
https://www.canva.com/design/<design-id>/edit
```

3. URL query fallback:

```text
designId=...
design_id=...
utm_content=...
id=...
```

4. Connect temporary edit/view URL:

```text
https://www.canva.cn/api/design/<opaque-token>/edit
```

For opaque URLs, attempt matching against recently listed design `edit_url` and `view_url`. If no match is found, return a structured `unresolvable_design_reference` error.

5. Title or keyword:

```text
<title-keyword>
```

Search design list. If exactly one candidate matches, resolve it. If multiple candidates match, return `ambiguous_design_reference`.

### Resolver Output

High-confidence success:

```json
{
  "ok": true,
  "command": "resolve",
  "result": {
    "resource_type": "design",
    "design_id": "<design-id>",
    "matched_by": "url_path",
    "confidence": "high",
    "design": {
      "title": "<title-keyword>",
      "page_count": 86,
      "updated_at": 1778734402
    }
  },
  "artifacts": [],
  "warnings": [],
  "metrics": {}
}
```

Ambiguous reference:

```json
{
  "ok": false,
  "error": {
    "code": "ambiguous_design_reference",
    "message": "Multiple designs matched this reference.",
    "retryable": false
  },
  "candidates": [
    {
      "design_id": "<design-id>",
      "title": "<title-keyword>",
      "updated_at": 1778734402
    }
  ]
}
```

## 7. CLI Surface

### Auth

```sh
canvapie init
canvapie init --client-id <client_id> --client-secret <client_secret>
canvapie auth login
canvapie auth login --scopes "design:meta:read design:content:read folder:read asset:read profile:read"
canvapie auth status --json
canvapie auth logout
```

`init` is the first-time setup command. It writes `~/.canvapie/config.json` so `auth login` can run from any working directory.
`canvapie init --help` must explain where to get the client ID and client secret: Canva.cn Developer Portal -> Connect API integration -> Authentication. It must also show the exact redirect URL and recommended scopes. If an agent lacks those values, it should ask the user for them rather than guessing.
If config already exists with a client ID and secret, `init` should reuse it and exit without prompting; `--force` should update or replace it. Config itself does not expire locally. OAuth tokens expire and should be checked with `doctor` fields such as `token_expires_at`, `token_expires_in_seconds`, and `token_expired`.

`auth login` may be interactive because OAuth requires a browser. Everything else should be scriptable.

### Diagnostics

```sh
canvapie doctor --json
```

Return:

- CLI version.
- Environment: `canva.cn`.
- Login status.
- Token expiry.
- Current scopes.
- Missing recommended scopes.
- API base URL.
- Config file locations.

### Resolve

```sh
canvapie resolve "<design-ref>" --json
canvapie resolve --stdin --jsonl
canvapie resolve --input refs.txt --jsonl
```

### Designs

Human/agent-friendly aliases:

```sh
canvapie list --limit 100 --json
canvapie list --all --jsonl
canvapie get "<design-ref>" --json
canvapie pages "<design-ref>" --json
canvapie search "<title-keyword>" --json
```

Resource-style aliases:

```sh
canvapie designs list --limit 100 --json
canvapie designs list --all --jsonl
canvapie designs get "<design-ref>" --json
canvapie designs pages "<design-ref>" --json
canvapie designs search "<title-keyword>" --json
```

### Export

```sh
canvapie export "<design-ref>" --format pptx --out ./exports --json
canvapie export "<design-ref>" --format pdf --out ./exports --json
canvapie export "<design-ref>" --format png --pages 1,2,3 --out ./exports --json
canvapie export "<design-ref>" --format pptx --inspect --json
```

Export should create a manifest next to downloaded files.

Recommended artifact layout:

```text
exports/
  <design-id>/
    <design-id>.pptx
    manifest.json
    slides.json
```

### Jobs

Canva export is asynchronous, so jobs should be resumable.

```sh
canvapie jobs status <job-id> --json
canvapie jobs resume <job-id> --json
```

### PPTX Inspection

```sh
canvapie inspect ./exports/<design-id>/<design-id>.pptx --json
canvapie ppt inspect ./exports/<design-id>/<design-id>.pptx --json
canvapie remove-hidden ./exports/<design-id>/<design-id>.pptx --out ./exports/<design-id>/<design-id>.visible.pptx --json
canvapie ppt remove-hidden ./exports/<design-id>/<design-id>.pptx --out ./exports/<design-id>/<design-id>.visible.pptx --json
```

The CLI should parse the PPTX zip, inspect hidden-slide state, and optionally write a new PPTX with hidden slides removed:

```text
ppt/slides/slideN.xml
```

Hidden slides have a root attribute like:

```xml
<p:sld show="false" ...>
```

Expected output:

```json
{
  "ok": true,
  "command": "ppt inspect",
  "result": {
    "file": "./exports/<design-id>/<design-id>.pptx",
    "summary": {
      "total": 86,
      "visible": 14,
      "hidden": 72
    },
    "hidden_indexes": [15, 16, 17],
    "slides": [
      { "index": 1, "hidden": false },
      { "index": 15, "hidden": true }
    ]
  },
  "artifacts": [
    {
      "type": "json",
      "path": "./exports/<design-id>/slides.json"
    }
  ],
  "warnings": [],
  "metrics": {}
}
```

## 8. Pipeline Automation

The CLI supports stdin/file input and JSONL output for batch workflows.

Examples:

```sh
cat refs.txt \
  | canvapie resolve --stdin --jsonl \
  | canvapie export --stdin --format pptx --inspect --jsonl
```

Batch export:

```sh
canvapie export --input designs.jsonl --format pptx --out ./exports --inspect --jsonl
```

Each JSONL input can be either:

```json
{"ref":"https://www.canva.cn/design/<design-id>/edit"}
```

or already resolved:

```json
{"design_id":"<design-id>","title":"<title-keyword>"}
```

Each output line is independently successful or failed. One bad design does not abort the whole batch. If any item fails, the process exits with code `10`.

## 9. Exit Codes

Recommended exit codes:

```text
0  success
1  generic failure
2  invalid arguments
3  auth required
4  missing scope
5  ambiguous reference
6  unresolvable reference
7  API error
8  export job failed
9  timeout
10 partial batch failure
```

## 10. Implementation Architecture

Recommended stack:

- Node.js.
- TypeScript.
- `commander` for CLI routing.
- Built-in `http` for local OAuth callback server.
- Native `fetch`.
- ZIP/XML parsing library for PPTX inspection.

Proposed structure:

```text
src/
  cli.ts
  config.ts
  output.ts
  errors.ts
  auth/
    oauth.ts
    token-store.ts
  canva/
    client.ts
    designs.ts
    exports.ts
  resolver/
    resolve-design-ref.ts
    url-parser.ts
    title-search.ts
  pptx/
    inspect.ts
  pipeline/
    jsonl.ts
    stdin.ts
```

The current prototype can be used as reference for:

- PKCE OAuth.
- Local callback.
- Token exchange.
- `GET /designs`.
- Export job creation, polling, and download.
- PPTX hidden-slide inspection.

## 11. Manifest Format

Every export should write a `manifest.json`.

Example:

```json
{
  "schema_version": 1,
  "source": {
    "environment": "canva.cn",
    "design_id": "<design-id>",
    "title": "<title-keyword>",
    "input_ref": "<title-keyword>"
  },
  "export": {
    "format": "pptx",
    "job_id": "4ac79cf2-1776-40aa-8b16-46eb18dca6b2",
    "created_at": "2026-05-27T19:11:00+08:00"
  },
  "artifacts": [
    {
      "type": "pptx",
      "path": "<design-id>.pptx",
      "sha256": "..."
    },
    {
      "type": "slide_visibility",
      "path": "slides.json"
    }
  ],
  "inspection": {
    "slides_total": 86,
    "slides_visible": 14,
    "slides_hidden": 72
  }
}
```

## 12. Phased Roadmap

### Phase 0: Stabilize Prototype

- Keep current OAuth/export probe working.
- Add `GET /api/designs/:id`.
- Add export endpoint.
- Add PPTX hidden-slide parser.

### Phase 1: Local CLI V0

- Create `canvapie` executable.
- Implement config and token storage.
- Implement `auth login/status/logout`.
- Implement `resolve`.
- Implement `designs list/get/pages/search`.
- Implement `export`.
- Implement `ppt inspect`.
- Implement `ppt remove-hidden`.
- Add JSON output contracts and exit codes.

### Phase 2: Pipeline Hardening

- Add `--fail-fast`, `--retry`, `--timeout`.
- Add job resume.
- Add artifact manifests and hashes.
- Add integration tests using mocked Canva responses.

### Phase 3: Agent and MCP Integration

- Define MCP tools backed by the CLI:
  - `resolve_design`
  - `list_designs`
  - `get_design`
  - `export_design`
  - `inspect_pptx`
- Keep CLI as the canonical implementation.
- MCP should call the CLI or reuse the same library.

### Phase 4: Open-Source Packaging

- Add installer or package manager distribution.
- Keep the bring-your-own Canva.cn integration model.
- Document local secret handling and gitignore expectations.
- Add update mechanism.

## 13. Success Criteria

The CLI is successful when an agent can reliably run:

```sh
canvapie export "https://www.canva.cn/design/<design-id>/edit" --format pptx --inspect --json
```

and receive:

- The resolved design ID.
- The design title.
- Local exported PPTX path.
- Manifest path.
- Slide visibility summary.
- Structured errors if auth, scope, or reference resolution fails.

The agent should not need to know Canva URL formats, OAuth details, export job semantics, or PPTX internals.
