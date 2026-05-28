# canvapie

Language: [简体中文](./README.md) | **English**

An agent-first and pipeline-first CLI for Canva.cn Connect API. It lets agents accept a Canva design URL, design ID, temporary edit/view URL, or title keyword, resolve the target design, read metadata, export PPTX/PDF/images, and inspect exported PPTX files for hidden slides.

This repo also keeps a local OAuth debug service in `server.mjs` for validating the Canva.cn OAuth and Connect API flow.

## Quick Install

Install globally:

```sh
npm install -g canvapie
canvapie help
```

To pin the current version:

```sh
npm install -g canvapie@0.2.0
```

Then complete first-time authorization:

```sh
canvapie init
canvapie auth login
canvapie doctor --json
```

## Quick Examples

```sh
canvapie help
canvapie init
canvapie auth login
canvapie doctor --json
canvapie resolve "https://www.canva.cn/design/<design-id>/edit" --json
canvapie resolve "<title-keyword>" --json
canvapie pages <design-id> --json
canvapie export-formats <design-id> --json
canvapie profile get --json
canvapie folders list root --limit 10 --json
canvapie folders list uploads --item-types image --limit 10 --json
canvapie export "<title-keyword>" --format pptx --pages 1 --out cli-exports --inspect --json
canvapie inspect exports/<design-id>.pptx --json
canvapie resolve --input refs.txt --jsonl
canvapie export --input designs.jsonl --format pptx --inspect --jsonl
```

The CLI reads local `.env` and `.tokens.json` first. If no local `.tokens.json` exists, it falls back to:

```text
~/.canvapie/tokens.json
```

## First-Time Setup

New users start with install, config, and auth:

```sh
npm install -g canvapie
canvapie init --help
canvapie init
canvapie auth login
```

`canvapie init` stores the Canva.cn integration `client_id`, `client_secret`, redirect URL, API URL, and scopes at:

```text
~/.canvapie/config.json
```

If `~/.canvapie/config.json` already exists and contains a client ID / client secret, `canvapie init` reuses it without prompting or overwriting. To update the config, run:

```sh
canvapie init --force
```

Config does not expire locally; OAuth tokens expire. Check `token_expires_at`, `token_expires_in_seconds`, and `token_expired` with:

```sh
canvapie doctor --json
```

Get these values from the Canva.cn Developer Portal:

1. Open `https://www.canva.cn/developers/integrations`
2. Create or open a Connect API integration.
3. Copy the client ID and client secret from Authentication.
4. Add this redirect URL in Return navigation / redirect URLs:

   ```text
   http://127.0.0.1:3001/oauth/redirect
   ```

5. Enable these scopes:

   ```text
   design:meta:read design:content:read folder:read asset:read profile:read
   ```

Scopes are configured in two places: the Canva Developer Portal must allow the scope first; `canvapie init --scopes` or saved config scopes only control what the CLI requests during OAuth. They cannot change the Canva integration settings.

If an agent does not know the client ID or client secret, it should ask the user to create/open the Canva.cn Connect API integration and provide those values. It should not guess.

For agents, scripts, or CI, use non-interactive flags:

```sh
canvapie init \
  --client-id <client_id> \
  --client-secret <client_secret> \
  --redirect-uri http://127.0.0.1:3001/oauth/redirect
```

Environment variables also work:

```sh
CANVA_CLIENT_ID=<client_id> CANVA_CLIENT_SECRET=<client_secret> canvapie init
```

## Canva Integration Settings

In the Canva.cn Connect API integration page:

1. Add this redirect URL:

   ```text
   http://127.0.0.1:3001/oauth/redirect
   ```

2. Enable these scopes for listing and export:

   ```text
   design:meta:read design:content:read folder:read asset:read profile:read
   ```

   `design:content:read` is required for PPTX/PDF/image export and export-format discovery.

If a command returns `missing_scope`, open the Canva Developer Portal Scopes page, enable the returned `required_scopes`, save the integration, then run:

```sh
canvapie auth login
canvapie doctor --json
```

## Local Development

Copy the env template:

```sh
cp .env.example .env
```

For local development inside this repo, run the CLI through npm:

```sh
npm run canvapie -- doctor --json
```

After package installation, run `canvapie` directly.

Then fill these values from your Canva.cn integration:

```text
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
```

Do not commit `.env`, `.tokens.json`, or exported PPTX files.

## CLI Commands

### Help

```sh
canvapie help
canvapie help init
canvapie help export
canvapie -h
canvapie --help
```

`help` is a subcommand. `-h` / `--help` are flags. Use `-v` / `--version` for the version.

### Diagnostics

```sh
canvapie doctor --json
```

Returns environment, login status, token expiry, granted scopes, and missing scopes.

### Auth

```sh
canvapie auth login
canvapie auth status --json
canvapie auth logout
```

`auth login` opens a browser for Canva.cn OAuth PKCE and stores tokens locally.

### Resolve Design References

```sh
canvapie resolve "<design-ref>" --json
canvapie resolve --stdin --jsonl
canvapie resolve --input refs.txt --jsonl
```

`design-ref` can be:

- Design ID: `<design-id>`
- Standard design URL: `https://www.canva.cn/design/<design-id>/edit`
- Temporary API edit/view URL
- Title keyword: `<title-keyword>`

### Read Designs

```sh
canvapie list --limit 25 --json
canvapie search "<title-keyword>" --json
canvapie get "<title-keyword>" --json
canvapie pages <design-id> --json
canvapie export-formats <design-id> --json
```

The resource-style aliases are also kept for scripts that want to stay closer to the API shape:

```sh
canvapie designs list --limit 25 --json
canvapie designs search "<title-keyword>" --json
canvapie designs get "<title-keyword>" --json
canvapie designs pages <design-id> --json
canvapie designs export-formats <design-id> --json
```

`pages` / `designs pages` reads page metadata from Canva Connect API. The API does not currently expose hidden-slide state directly.

`export-formats` / `designs export-formats` returns the formats currently available for a specific design. It does not add new export formats; it helps agents check whether the target design supports `pptx`, `pdf`, `png`, and other formats before exporting.

### Read Profile / Folder / Asset

```sh
canvapie profile get --json
canvapie folders get root --json
canvapie folders list root --limit 25 --json
canvapie folders list uploads --item-types image --limit 25 --json
canvapie assets get <asset-id> --json
```

These commands require:

```text
profile:read
folder:read
asset:read
```

`folders list` defaults to `root`. Common special folder IDs:

```text
root
uploads
```

To avoid printing temporary access URLs, folder item, asset, and design output is normalized by default and keeps stable fields such as IDs, titles/names, timestamps, and thumbnail presence.

### Export Designs

```sh
canvapie export "<title-keyword>" --format pptx --out cli-exports --inspect --json
canvapie export --stdin --format pptx --out cli-exports --inspect --jsonl
canvapie export --input designs.jsonl --format pptx --out cli-exports --inspect --jsonl
```

The CLI creates a Canva export job, polls it until success, then downloads files to:

```text
cli-exports/<design_id>/
```

When `--inspect` is used with `pptx`, it also writes:

```text
manifest.json
slides.json
```

### Batch Workflows

Batch input supports plain text, JSONL, and JSON arrays. Plain text uses one design reference per line:

```text
https://www.canva.cn/design/<design-id>/edit
<title-keyword>
```

JSONL can use any of these forms:

```json
{"ref":"https://www.canva.cn/design/<design-id>/edit"}
{"design_id":"<design-id>"}
{"title":"<title-keyword>"}
```

You can pipe `resolve` into `export`:

```sh
canvapie resolve --input refs.txt --jsonl \
  | canvapie export --stdin --format pptx --out cli-exports --inspect --jsonl
```

Batch commands write one JSON envelope per line. One failed item does not stop later items. If any item fails, the process exits with code `10`.

### Inspect PPTX Hidden Slides

```sh
canvapie inspect cli-exports/<design-id>/<design-id>.pptx --json
canvapie remove-hidden cli-exports/<design-id>/<design-id>.pptx --out cli-exports/<design-id>/<design-id>.visible.pptx --json
```

`canvapie ppt inspect <file.pptx>` is kept as a compatibility alias.
`canvapie ppt remove-hidden <file.pptx>` is kept as a compatibility alias.

PPTX hidden-slide state is stored in:

```text
ppt/slides/slideN.xml
```

For example:

```xml
<p:sld show="false" ...>
```

The CLI returns total, visible, hidden slide counts, and hidden slide indexes. `remove-hidden` writes a new PPTX without hidden slides and leaves the original file unchanged.

## Local OAuth Debug Service

For manual browser-based OAuth/API testing, start the prototype server:

```sh
npm start
```

Then open:

```text
http://127.0.0.1:3001/
```

Useful endpoints:

- `/` shows configuration and auth state
- `/oauth/start` starts Canva authorization
- `/oauth/redirect` receives Canva's OAuth callback
- `/oauth/refresh` refreshes the saved token
- `/api/designs` lists accessible designs
- `/api/designs/:id` gets one design's metadata
- `/api/export?designId=...&format=pptx` exports a design and downloads the result

## Agent / Pipeline Principles

`bin/canvapie.mjs` is designed for agents:

- JSON output by default.
- Non-auth commands are non-interactive.
- `stdout` is for machine-readable output; `stderr` is for progress and warnings.
- Design reference resolution is centralized in the CLI, so agents can pass raw user input through.
- Exported artifacts use stable directories and `manifest.json`.
- Agents can learn the main flow from `canvapie help`: `doctor`, `init`, `auth login`, `export`, and `inspect`.
- Without `--out`, exports go to `exports/<design_id>/` under the current working directory.

## Current V0 Limitations

- No `jobs status/resume` yet.
- Canva-side write capabilities are not implemented yet, including creating/updating designs, uploading/deleting assets, creating comments, or modifying permissions.
- The current open-source mode requires users to bring their own Canva.cn integration and store their own client secret locally.
- The project does not embed or distribute a shared `client_secret`; users should protect `~/.canvapie/config.json` and `~/.canvapie/tokens.json`.
