# canvapie

Language: [简体中文](./README.md) | **English**

An agent-first and pipeline-first CLI for Canva.cn Connect API. It lets agents accept a Canva design URL, design ID, temporary edit/view URL, or title keyword, resolve the target design, read metadata, export PPTX/PDF/images, and inspect exported PPTX files for hidden slides.

This repo also keeps a local OAuth debug service in `server.mjs` for validating the Canva.cn OAuth and Connect API flow.

## Quick Examples

```sh
canvapie help
canvapie init
canvapie auth login
canvapie doctor --json
canvapie resolve "https://www.canva.cn/design/<design-id>/edit" --json
canvapie resolve "<title-keyword>" --json
canvapie pages <design-id> --json
canvapie export "<title-keyword>" --format pptx --pages 1 --out cli-exports --inspect --json
canvapie inspect exports/<design-id>.pptx --json
```

The CLI reads local `.env` and `.tokens.json` first. If no local `.tokens.json` exists, it falls back to:

```text
~/.canvapie/tokens.json
```

## First-Time Setup

New users start with two commands:

```sh
canvapie init
canvapie auth login
```

`canvapie init` stores the Canva.cn integration `client_id`, `client_secret`, redirect URL, API URL, and scopes at:

```text
~/.canvapie/config.json
```

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

   `design:content:read` is required for PPTX/PDF/image export.

## Local Setup

Copy the env template:

```sh
cp .env.example .env
```

For local development inside this repo, run the CLI through npm:

```sh
npm run canvapie -- doctor --json
```

After `npm link` or package installation, run `canvapie` directly.

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
```

The resource-style aliases are also kept for scripts that want to stay closer to the API shape:

```sh
canvapie designs list --limit 25 --json
canvapie designs search "<title-keyword>" --json
canvapie designs get "<title-keyword>" --json
canvapie designs pages <design-id> --json
```

`pages` / `designs pages` reads page metadata from Canva Connect API. The API does not currently expose hidden-slide state directly.

### Export Designs

```sh
canvapie export "<title-keyword>" --format pptx --out cli-exports --inspect --json
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

### Inspect PPTX Hidden Slides

```sh
canvapie inspect cli-exports/<design-id>/<design-id>.pptx --json
```

`canvapie ppt inspect <file.pptx>` is kept as a compatibility alias.

PPTX hidden-slide state is stored in:

```text
ppt/slides/slideN.xml
```

For example:

```xml
<p:sld show="false" ...>
```

The CLI returns total, visible, hidden slide counts, and hidden slide indexes.

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

- No JSONL/stdin batch mode yet.
- No `jobs status/resume` yet.
- Local/internal mode uses the user's own Canva.cn integration and client secret.
- Public distribution should use a backend token broker; do not bundle `client_secret` into the CLI.
