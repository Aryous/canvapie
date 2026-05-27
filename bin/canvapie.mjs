#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { URL, URLSearchParams } from "node:url";

const VERSION = "0.1.0";
const DEFAULT_SCOPES = [
  "design:meta:read",
  "design:content:read",
  "folder:read",
  "asset:read",
  "profile:read",
];
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:3001/oauth/redirect";
const DEFAULT_WEB_BASE_URL = "https://www.canva.cn";
const DEFAULT_API_BASE_URL = "https://api.canva.cn/rest/v1";
const EXIT = {
  generic: 1,
  invalidArgs: 2,
  authRequired: 3,
  missingScope: 4,
  ambiguousReference: 5,
  unresolvableReference: 6,
  apiError: 7,
  exportFailed: 8,
  timeout: 9,
  partialBatchFailure: 10,
};
const BOOLEAN_OPTIONS = new Set(["all", "force", "help", "inspect", "json", "noOpen", "nonInteractive", "version"]);

main(process.argv.slice(2)).catch((error) => {
  const normalized = normalizeError(error);
  writeJson(normalized.body);
  process.exitCode = normalized.exitCode;
});

async function main(argv) {
  const { positionals, options } = parseArgs(argv);
  const [command, subcommand, ...rest] = positionals;
  const config = loadConfig(options);

  if (command === "version" || options.version) {
    writeJson(envelope("version", { version: VERSION }));
    return;
  }

  if (!command || command === "help" || options.help) {
    const helpTopic =
      command === "help"
        ? [subcommand, ...rest].filter(Boolean).join(" ")
        : [command, subcommand].filter(Boolean).join(" ");
    printHelp(helpTopic);
    return;
  }

  if (command === "doctor") {
    return writeJson(envelope("doctor", await doctor(config)));
  }

  if (command === "init") {
    return writeJson(envelope("init", await initConfig(options, config)));
  }

  if (command === "auth") {
    return handleAuth(subcommand, rest, options, config);
  }

  if (command === "resolve") {
    const ref = firstRef([subcommand, ...rest].filter(Boolean), options);
    return writeJson(envelope("resolve", await resolveDesignRef(ref, config)));
  }

  if (command === "designs") {
    return handleDesigns(subcommand, rest, options, config);
  }

  if (command === "list") {
    return handleDesigns("list", [subcommand, ...rest].filter(Boolean), options, config);
  }

  if (command === "search") {
    return handleDesigns("search", [subcommand, ...rest].filter(Boolean), options, config);
  }

  if (command === "get" || command === "read") {
    return handleDesigns("get", [subcommand, ...rest].filter(Boolean), options, config);
  }

  if (command === "pages") {
    return handleDesigns("pages", [subcommand, ...rest].filter(Boolean), options, config);
  }

  if (command === "export") {
    const ref = firstRef([subcommand, ...rest].filter(Boolean), options);
    const result = await exportCommand(ref, options, config);
    return writeJson(envelope("export", result, result.artifacts || []));
  }

  if (command === "ppt") {
    return handlePpt(subcommand, rest, options);
  }

  if (command === "inspect") {
    return handlePpt("inspect", [subcommand, ...rest].filter(Boolean), options);
  }

  throw userError("invalid_arguments", `Unknown command: ${command}`, EXIT.invalidArgs);
}

async function handleAuth(subcommand, rest, options, config) {
  if (subcommand === "status") {
    return writeJson(envelope("auth status", await authStatus(config)));
  }

  if (subcommand === "login") {
    return writeJson(envelope("auth login", await authLogin(options, config)));
  }

  if (subcommand === "logout") {
    return writeJson(envelope("auth logout", authLogout(config)));
  }

  throw userError("invalid_arguments", "Expected auth subcommand: login, status, or logout.", EXIT.invalidArgs);
}

async function handleDesigns(subcommand, rest, options, config) {
  if (subcommand === "list") {
    const limit = Number(options.limit || 25);
    const all = Boolean(options.all);
    const result = await listDesigns(config, { limit, all });
    return writeJson(envelope("designs list", result));
  }

  if (subcommand === "search") {
    const query = firstRef(rest, options);
    const result = await searchDesigns(query, config);
    return writeJson(envelope("designs search", result));
  }

  if (subcommand === "get") {
    const ref = firstRef(rest, options);
    const resolved = await resolveDesignRef(ref, config);
    const design = await getDesign(config, resolved.design_id);
    return writeJson(envelope("designs get", { resolved, design: sanitizeDesign(design) }));
  }

  if (subcommand === "pages") {
    const ref = firstRef(rest, options);
    const resolved = await resolveDesignRef(ref, config);
    const pages = await getDesignPages(config, resolved.design_id);
    return writeJson(envelope("designs pages", { resolved, pages }));
  }

  throw userError("invalid_arguments", "Expected designs subcommand: list, search, get, or pages.", EXIT.invalidArgs);
}

async function handlePpt(subcommand, rest, options) {
  if (subcommand !== "inspect") {
    throw userError("invalid_arguments", "Expected ppt subcommand: inspect.", EXIT.invalidArgs);
  }

  const file = firstRef(rest, options);
  const result = inspectPptx(file);
  return writeJson(envelope("ppt inspect", result));
}

function printHelp(topic) {
  const topics = {
    init: `canvapie ${VERSION}

Initialize Canva integration config.

USAGE:
  canvapie init
  canvapie init --client-id <id> --client-secret <secret>

WHERE TO GET VALUES:
  1. Open Canva.cn Developer Portal:
     https://www.canva.cn/developers/integrations
  2. Create or open a Connect API integration.
  3. In Authentication, copy the client ID and client secret.
  4. In Return navigation / redirect URLs, add exactly:
     ${DEFAULT_REDIRECT_URI}
  5. In Scopes, enable:
     ${DEFAULT_SCOPES.join(" ")}

AGENT NOTES:
  If client ID or secret is unavailable, ask the user to create/open the
  Canva.cn Connect API integration and provide those values. Do not guess.

FLAGS:
  --client-id <id>       Canva integration client ID
  --client-secret <sec>  Canva integration client secret
  --redirect-uri <url>   OAuth redirect URL
  --scopes <scopes>      space-separated OAuth scopes
  --force                update existing config instead of reusing it
  --non-interactive      fail instead of prompting
  -h, --help             help for init

OUTPUT:
  ~/.canvapie/config.json

NOTES:
  If ~/.canvapie/config.json already has a client ID and secret, init exits
  without prompting. Use --force to update it.
  Config does not expire locally; OAuth tokens expire. Check token expiry with:
  canvapie doctor --json

NEXT:
  canvapie auth login
  canvapie doctor --json
`,
    auth: `canvapie ${VERSION}

OAuth credentials and authorization management.

USAGE:
  canvapie auth <command> [options]

AVAILABLE COMMANDS:
  login      Open browser and complete Canva OAuth login
  status     View current auth status
  logout     Clear saved token

EXAMPLES:
  canvapie init
  canvapie auth login
  canvapie doctor --json

If auth login reports missing_config, run:
  canvapie init --help

FLAGS:
  -h, --help  help for auth

Use "canvapie auth <command> --help" for more information about a command.
`,
    "auth login": `canvapie ${VERSION}

Open browser and complete Canva OAuth login.

USAGE:
  canvapie auth login [flags]

FLAGS:
  --no-open        print authorization URL instead of opening a browser
  --timeout <ms>   OAuth callback timeout in milliseconds
  --scopes <list>  override configured OAuth scopes
  -h, --help       help for auth login

OUTPUT:
  ~/.canvapie/tokens.json
`,
    "auth status": `canvapie ${VERSION}

View current auth status.

USAGE:
  canvapie auth status --json

FLAGS:
  -h, --help  help for auth status
`,
    "auth logout": `canvapie ${VERSION}

Clear saved OAuth token.

USAGE:
  canvapie auth logout

FLAGS:
  -h, --help  help for auth logout
`,
    doctor: `canvapie ${VERSION}

CLI health check: config, auth, scopes, and token expiry.

USAGE:
  canvapie doctor --json

OUTPUT INCLUDES:
  has_client_id, has_client_secret
  logged_in
  token_expires_at
  token_expires_in_seconds
  token_expired

FLAGS:
  -h, --help  help for doctor
`,
    resolve: `canvapie ${VERSION}

Resolve a Canva design reference.

USAGE:
  canvapie resolve <design-ref> --json

DESIGN REFERENCES:
  <design-id>
  https://www.canva.cn/design/<design-id>/edit
  <title-keyword>

FLAGS:
  --ref <design-ref>  pass reference as a flag
  -h, --help          help for resolve
`,
    export: `canvapie ${VERSION}

Export a Canva design.

USAGE:
  canvapie export <design-ref> --format pptx --out ./exports --inspect --json

DEFAULT OUTPUT:
  ./exports/<design_id>/

FLAGS:
  --format <fmt>      pptx | pdf | png | jpg | gif | mp4 | csv | html_bundle | html_standalone
  --pages <1,2,3>     export selected pages
  --out <directory>   output directory (default: ./exports)
  --inspect           inspect PPTX slide visibility after export
  --ref <design-ref>  pass reference as a flag
  -h, --help          help for export
`,
    read: `canvapie ${VERSION}

Read Canva design metadata.

USAGE:
  canvapie list --limit 25 --json
  canvapie search <query> --json
  canvapie get <design-ref> --json
  canvapie read <design-ref> --json
  canvapie pages <design-ref> --json

RESOURCE-STYLE ALIASES:
  canvapie designs list --limit 25 --json
  canvapie designs search <query> --json
  canvapie designs get <design-ref> --json
  canvapie designs pages <design-ref> --json

FLAGS:
  --limit <N>  max designs to list
  --all        paginate all list results
  -h, --help   help for read commands
`,
    inspect: `canvapie ${VERSION}

Inspect an exported PPTX.

USAGE:
  canvapie inspect <file.pptx> --json
  canvapie ppt inspect <file.pptx> --json

OUTPUT:
  slide totals, visible count, hidden count, and hidden slide indexes

FLAGS:
  -h, --help  help for inspect
`,
  };
  const normalizedTopic = normalizeHelpTopic(topic);
  if (topics[normalizedTopic]) {
    process.stdout.write(topics[normalizedTopic]);
    return;
  }

  const text = `canvapie ${VERSION}

Agent-first Canva.cn Connect API CLI.

USAGE:
  canvapie <command> [subcommand] [options]
  canvapie export <design-ref> [--format pptx] [--out <dir>] [--inspect]
  canvapie resolve <design-ref> --json

EXAMPLES:
  # First-time setup
  canvapie init
  canvapie auth login

  # Export a design
  canvapie export "<design-ref>" --format pptx --out ./exports --inspect --json

  # Inspect exported PPTX hidden slides
  canvapie inspect ./exports/<design_id>/<design_id>.pptx --json

DESIGN REFERENCES:
  <design-id>
  https://www.canva.cn/design/<design-id>/edit
  <title-keyword>

FLAGS:
  --json            machine-readable JSON output
  -h, --help        help for canvapie
  -v, --version     version for canvapie

AGENT WORKFLOW:
  1. canvapie doctor --json
  2. If config is missing: canvapie init
  3. If not logged in: canvapie auth login
  4. canvapie export "<design-ref>" --format pptx --out ./exports --inspect --json

DEFAULT EXPORT OUTPUT:
  ./exports/<design_id>/

Usage:
  canvapie [command]

Available Commands:
  auth       OAuth credentials and authorization management
  doctor     CLI health check: config, auth, scopes, and token expiry
  export     Export a Canva design
  get        Read one design's metadata
  help       Help about any command
  init       Initialize Canva integration config
  inspect    Inspect an exported PPTX
  list       List accessible designs
  pages      List pages in a design
  read       Alias for get
  resolve    Resolve a Canva design reference
  search     Search designs by title keyword

Advanced Resource Aliases:
  designs    Design metadata commands: list, search, get, pages
  ppt        PPTX commands: inspect

Use "canvapie <command> --help" for more information about a command.
`;
  process.stdout.write(text);
}

function normalizeHelpTopic(topic = "") {
  const normalized = String(topic).trim();
  if (["get", "list", "pages", "read", "search", "designs"].includes(normalized)) return "read";
  if (normalized.startsWith("designs ")) return "read";
  if (normalized === "ppt" || normalized === "ppt inspect") return "inspect";
  return normalized;
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) {
      const prefixLength = arg.startsWith("--") ? 2 : 1;
      const eq = arg.indexOf("=");
      const rawKey = eq !== -1 ? arg.slice(prefixLength, eq) : arg.slice(prefixLength);
      const key = normalizeOptionKey(rawKey);
      if (eq !== -1) {
        options[key] = arg.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_OPTIONS.has(key)) {
        options[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, options };
}

function normalizeOptionKey(rawKey) {
  if (rawKey === "h" || rawKey === "help") return "help";
  if (rawKey === "v" || rawKey === "version") return "version";
  return rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function firstRef(values, options) {
  if (options.ref) {
    return options.ref;
  }
  const ref = values.find(Boolean);
  if (!ref) {
    throw userError("invalid_arguments", "Missing design reference.", EXIT.invalidArgs);
  }
  return ref;
}

async function initConfig(options, config) {
  const existing = readJsonIfExists(config.configPath) || {};
  const hasExplicitInput = Boolean(
    options.clientId ||
      options.clientSecret ||
      options.redirectUri ||
      options.webBaseUrl ||
      options.apiBaseUrl ||
      options.scopes ||
      process.env.CANVA_CLIENT_ID ||
      process.env.CANVA_CLIENT_SECRET ||
      process.env.CANVA_REDIRECT_URI ||
      process.env.CANVA_WEB_BASE_URL ||
      process.env.CANVA_API_BASE_URL ||
      process.env.CANVA_SCOPES,
  );
  if (existing.client_id && existing.client_secret && !hasExplicitInput && !options.force) {
    return {
      config_exists: true,
      config_saved: false,
      config_path: config.configPath,
      has_client_id: true,
      has_client_secret: true,
      redirect_uri: existing.redirect_uri || DEFAULT_REDIRECT_URI,
      web_base_url: existing.web_base_url || DEFAULT_WEB_BASE_URL,
      api_base_url: existing.api_base_url || DEFAULT_API_BASE_URL,
      scopes: splitScopes(existing.scopes || DEFAULT_SCOPES),
      next_steps: ["canvapie auth status --json", "canvapie doctor --json"],
      notes: [
        "Existing config was found, so init did not prompt or overwrite it.",
        "Config does not expire locally; OAuth tokens expire. Use canvapie doctor --json to check token expiry.",
        "Use canvapie init --force to update or replace the saved integration config.",
      ],
    };
  }
  const values = {
    client_id: options.clientId || process.env.CANVA_CLIENT_ID || existing.client_id || config.clientId || "",
    client_secret:
      options.clientSecret || process.env.CANVA_CLIENT_SECRET || existing.client_secret || config.clientSecret || "",
    redirect_uri:
      options.redirectUri ||
      process.env.CANVA_REDIRECT_URI ||
      existing.redirect_uri ||
      config.redirectUri ||
      DEFAULT_REDIRECT_URI,
    web_base_url:
      options.webBaseUrl || process.env.CANVA_WEB_BASE_URL || existing.web_base_url || config.webBaseUrl || DEFAULT_WEB_BASE_URL,
    api_base_url:
      options.apiBaseUrl ||
      process.env.CANVA_API_BASE_URL ||
      existing.api_base_url ||
      config.apiBaseUrl ||
      DEFAULT_API_BASE_URL,
    scopes: splitScopes(
      options.scopes ||
        process.env.CANVA_SCOPES ||
        existing.scopes ||
        config.scopes ||
        DEFAULT_SCOPES.join(" "),
    ),
  };

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.nonInteractive;
  if (interactive) {
    process.stderr.write(initGuideText());
    if (existing.client_id && existing.client_secret && options.force) {
      process.stderr.write(`Existing config found at ${config.configPath}. --force will update it.\n\n`);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      values.client_id = await promptText(rl, "Canva client ID", values.client_id);
      values.client_secret = await promptSecret(rl, "Canva client secret", values.client_secret);
      values.redirect_uri = await promptText(rl, "Redirect URI", values.redirect_uri);
      values.web_base_url = await promptText(rl, "Canva web base URL", values.web_base_url);
      values.api_base_url = await promptText(rl, "Canva API base URL", values.api_base_url);
      values.scopes = splitScopes(await promptText(rl, "Scopes", values.scopes.join(" ")));
    } finally {
      rl.close();
    }
  }

  if (!values.client_id || !values.client_secret) {
    throw userError(
      "missing_config",
      "Missing Canva client_id or client_secret.",
      EXIT.invalidArgs,
      {
        remediation:
          "Run canvapie init --help to see where to get credentials, then run canvapie init and canvapie auth login.",
      },
    );
  }

  fs.mkdirSync(path.dirname(config.configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.configPath, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });

  return {
    config_saved: true,
    config_path: config.configPath,
    has_client_id: Boolean(values.client_id),
    has_client_secret: Boolean(values.client_secret),
    redirect_uri: values.redirect_uri,
    web_base_url: values.web_base_url,
    api_base_url: values.api_base_url,
    scopes: values.scopes,
    next_steps: ["canvapie auth login", "canvapie doctor --json"],
    notes: [
      "Config does not expire locally; OAuth tokens expire. Use canvapie doctor --json to check token expiry.",
    ],
  };
}

function initGuideText() {
  return `Before continuing, create or open your Canva.cn Connect API integration.

Where to get values:
  1. Open https://www.canva.cn/developers/integrations
  2. Create or open a Connect API integration.
  3. Copy client ID and client secret from Authentication.
  4. Add this redirect URL in Return navigation / redirect URLs:
     ${DEFAULT_REDIRECT_URI}
  5. Enable scopes:
     ${DEFAULT_SCOPES.join(" ")}

Press Enter to keep an existing/default value.
The client secret input is hidden.

`;
}

async function promptText(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function promptSecret(rl, label, defaultValue = "") {
  const suffix = defaultValue ? " [saved, press Enter to keep]" : "";
  rl.output.write(`${label}${suffix}: `);
  const originalWrite = rl._writeToOutput;
  rl._writeToOutput = function writeHidden() {
    rl.output.write("*");
  };
  try {
    const answer = await rl.question("");
    rl.output.write("\n");
    return answer.trim() || defaultValue;
  } finally {
    rl._writeToOutput = originalWrite;
  }
}

function loadConfig(options = {}) {
  const cwdEnv = parseDotEnv(path.join(process.cwd(), ".env"));
  const home =
    options.home ||
    process.env.CANVAPIE_HOME ||
    process.env.CANVA_CN_CLI_HOME ||
    path.join(os.homedir(), ".canvapie");
  const configPath =
    options.config ||
    process.env.CANVAPIE_CONFIG ||
    process.env.CANVA_CN_CONFIG ||
    path.join(home, "config.json");
  const fileConfig = readJsonIfExists(configPath) || {};
  const tokenPath =
    options.tokenPath ||
    process.env.CANVAPIE_TOKEN_PATH ||
    process.env.CANVA_CN_TOKEN_PATH ||
    fileConfig.token_path ||
    (fs.existsSync(path.join(process.cwd(), ".tokens.json"))
      ? path.join(process.cwd(), ".tokens.json")
      : path.join(home, "tokens.json"));

  return {
    home,
    configPath,
    tokenPath,
    clientId:
      options.clientId ||
      process.env.CANVA_CLIENT_ID ||
      fileConfig.client_id ||
      cwdEnv.CANVA_CLIENT_ID ||
      "",
    clientSecret:
      options.clientSecret ||
      process.env.CANVA_CLIENT_SECRET ||
      fileConfig.client_secret ||
      cwdEnv.CANVA_CLIENT_SECRET ||
      "",
    redirectUri:
      options.redirectUri ||
      process.env.CANVA_REDIRECT_URI ||
      fileConfig.redirect_uri ||
      cwdEnv.CANVA_REDIRECT_URI ||
      DEFAULT_REDIRECT_URI,
    webBaseUrl:
      trimTrailingSlash(
        options.webBaseUrl ||
          process.env.CANVA_WEB_BASE_URL ||
          fileConfig.web_base_url ||
          cwdEnv.CANVA_WEB_BASE_URL ||
          DEFAULT_WEB_BASE_URL,
      ),
    apiBaseUrl:
      trimTrailingSlash(
        options.apiBaseUrl ||
          process.env.CANVA_API_BASE_URL ||
          fileConfig.api_base_url ||
          cwdEnv.CANVA_API_BASE_URL ||
          DEFAULT_API_BASE_URL,
      ),
    scopes: splitScopes(
      options.scopes ||
        process.env.CANVA_SCOPES ||
        fileConfig.scopes ||
        cwdEnv.CANVA_SCOPES ||
        DEFAULT_SCOPES.join(" "),
    ),
  };
}

function parseDotEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) {
    return values;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    values[trimmed.slice(0, index).trim()] = stripQuotes(trimmed.slice(index + 1).trim());
  }
  return values;
}

async function doctor(config) {
  const token = readToken(config);
  const tokenScopes = splitScopes(token?.scope || "");
  const expiresAt = tokenExpiresAt(token);
  return {
    version: VERSION,
    environment: config.webBaseUrl.includes("canva.cn") ? "canva.cn" : "custom",
    api_base_url: config.apiBaseUrl,
    web_base_url: config.webBaseUrl,
    config_path: config.configPath,
    token_path: config.tokenPath,
    has_client_id: Boolean(config.clientId),
    has_client_secret: Boolean(config.clientSecret),
    logged_in: Boolean(token?.access_token),
    token_expires_at: expiresAt,
    token_expires_in_seconds: tokenSecondsUntilExpiry(token),
    token_expired: token ? isTokenLikelyExpired(token) : null,
    scopes: tokenScopes,
    missing_recommended_scopes: DEFAULT_SCOPES.filter((scope) => !tokenScopes.includes(scope)),
  };
}

async function authStatus(config) {
  const status = await doctor(config);
  return {
    logged_in: status.logged_in,
    token_expires_at: status.token_expires_at,
    token_expires_in_seconds: status.token_expires_in_seconds,
    token_expired: status.token_expired,
    scopes: status.scopes,
    missing_recommended_scopes: status.missing_recommended_scopes,
  };
}

async function authLogin(options, config) {
  requireConfig(config);
  const redirectUrl = new URL(config.redirectUri);
  const host = redirectUrl.hostname;
  const port = Number(redirectUrl.port || (redirectUrl.protocol === "https:" ? 443 : 80));
  const callbackPath = redirectUrl.pathname;
  const state = base64Url(crypto.randomBytes(32));
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());

  const authorizeUrl = new URL("/api/oauth/authorize", config.webBaseUrl);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "s256",
  }).toString();

  const timeoutMs = Number(options.timeout || 180_000);
  const tokenPromise = waitForOAuthCallback({
    host,
    port,
    callbackPath,
    state,
    timeoutMs,
    onCode: (code) => exchangeCode(config, code, codeVerifier),
  });

  if (options.noOpen) {
    process.stderr.write(`Open this URL in your browser:\n${authorizeUrl.toString()}\n`);
  } else {
    openUrl(authorizeUrl.toString());
  }

  const token = await tokenPromise;
  writeToken(config, token);
  return {
    token_saved: true,
    token_path: config.tokenPath,
    scopes: splitScopes(token.scope || ""),
    expires_at: tokenExpiresAt(token),
  };
}

function authLogout(config) {
  if (fs.existsSync(config.tokenPath)) {
    fs.unlinkSync(config.tokenPath);
  }
  return { logged_out: true, token_path: config.tokenPath };
}

function waitForOAuthCallback({ host, port, callbackPath, state, timeoutMs, onCode }) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    let settled = false;
    const server = http.createServer(async (req, res) => {
      res.setHeader("Connection", "close");
      try {
        const url = new URL(req.url || "/", `http://${host}:${port}`);
        if (url.pathname !== callbackPath) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          throw userError("oauth_error", url.searchParams.get("error_description") || error, EXIT.authRequired);
        }
        if (url.searchParams.get("state") !== state) {
          throw userError("oauth_state_mismatch", "OAuth state did not match.", EXIT.authRequired);
        }
        const code = url.searchParams.get("code");
        if (!code) {
          throw userError("oauth_missing_code", "OAuth callback did not include a code.", EXIT.authRequired);
        }
        const token = await onCode(code);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end("<h1>Authorized</h1><p>You can return to the terminal.</p>", () => {
          finishServer(server, sockets, timer, () => {
            if (!settled) {
              settled = true;
              resolve(token);
            }
          });
        });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end(error instanceof Error ? error.message : String(error), () => {
          finishServer(server, sockets, timer, () => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
        });
      }
    });

    const timer = setTimeout(() => {
      finishServer(server, sockets, timer, () => {
        if (!settled) {
          settled = true;
          reject(userError("oauth_timeout", "Timed out waiting for OAuth redirect.", EXIT.timeout));
        }
      });
    }, timeoutMs);

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    server.listen(port, host);
  });
}

function finishServer(server, sockets, timer, done) {
  clearTimeout(timer);
  server.close(() => done());
  setImmediate(() => {
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

async function exchangeCode(config, code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
  return requestToken(config, body);
}

async function refreshToken(config, saved) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token,
  });
  const refreshed = await requestToken(config, body);
  const token = {
    ...saved,
    ...refreshed,
    refresh_token: refreshed.refresh_token || saved.refresh_token,
  };
  writeToken(config, token);
  return token;
}

async function requestToken(config, body) {
  requireConfig(config);
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetch(`${config.apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    throw apiError("token_request_failed", response.status, payload);
  }
  return { ...payload, obtained_at: new Date().toISOString() };
}

async function getUsableToken(config) {
  const saved = readToken(config);
  if (!saved?.access_token) {
    throw userError("auth_required", "Run canvapie auth login first.", EXIT.authRequired);
  }
  if (isTokenLikelyExpired(saved)) {
    if (!saved.refresh_token) {
      throw userError("auth_required", "Token is expired and no refresh token is saved.", EXIT.authRequired);
    }
    return refreshToken(config, saved);
  }
  return saved;
}

async function apiFetch(config, endpoint, init = {}) {
  const token = await getUsableToken(config);
  const response = await fetch(`${config.apiBaseUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    throw apiError("canva_api_error", response.status, payload);
  }
  return payload;
}

async function listDesigns(config, { limit = 25, all = false, includeUrls = false } = {}) {
  const items = [];
  let continuation;
  do {
    const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (continuation) {
      params.set("continuation", continuation);
    }
    const payload = await apiFetch(config, `/designs?${params}`);
    items.push(...(payload.items || []).map((item) => sanitizeDesign(item, { includeUrls })));
    continuation = payload.continuation;
  } while (all && continuation);
  return { count: items.length, has_continuation: Boolean(continuation), continuation, items };
}

async function getDesign(config, designId) {
  const payload = await apiFetch(config, `/designs/${encodeURIComponent(designId)}`);
  return payload.design || payload.item || payload;
}

async function getDesignPages(config, designId) {
  const payload = await apiFetch(config, `/designs/${encodeURIComponent(designId)}/pages?limit=200`);
  return {
    count: payload.items?.length || 0,
    items: (payload.items || []).map((page) => ({
      index: page.index,
      dimensions: page.dimensions,
      has_thumbnail: Boolean(page.thumbnail),
    })),
  };
}

async function searchDesigns(query, config) {
  const listed = await listDesigns(config, { limit: 100, all: true });
  const lower = query.toLowerCase();
  const candidates = listed.items.filter((item) => item.title?.toLowerCase().includes(lower));
  return { query, count: candidates.length, candidates };
}

async function resolveDesignRef(ref, config) {
  const parsed = parseDesignRef(ref);
  if (parsed.design_id) {
    const design = await getDesign(config, parsed.design_id);
    return {
      resource_type: "design",
      design_id: parsed.design_id,
      matched_by: parsed.matched_by,
      confidence: parsed.confidence,
      design: sanitizeDesign(design),
    };
  }

  if (parsed.opaque_url) {
    const listed = await listDesigns(config, { limit: 100, all: true, includeUrls: true });
    const input = normalizeUrl(ref);
    const candidates = listed.items.filter((item) => {
      const urls = [item.edit_url, item.view_url].filter(Boolean).map(normalizeUrl);
      return urls.includes(input);
    });
    return resolveCandidates(ref, candidates, "temporary_url");
  }

  const searched = await searchDesigns(ref, config);
  return resolveCandidates(ref, searched.candidates, "title_search");
}

function resolveCandidates(ref, candidates, matchedBy) {
  if (candidates.length === 1) {
    return {
      resource_type: "design",
      design_id: candidates[0].id,
      matched_by: matchedBy,
      confidence: matchedBy === "title_search" ? "medium" : "high",
      design: candidates[0],
    };
  }
  if (candidates.length > 1) {
    const error = userError("ambiguous_design_reference", `Multiple designs matched: ${ref}`, EXIT.ambiguousReference);
    error.candidates = candidates.slice(0, 20);
    throw error;
  }
  throw userError("unresolvable_design_reference", `Could not resolve design reference: ${ref}`, EXIT.unresolvableReference);
}

function parseDesignRef(ref) {
  const direct = ref.match(/^[A-Za-z0-9_-]{8,}$/);
  if (direct) {
    return { design_id: ref, matched_by: "direct_id", confidence: "high" };
  }

  try {
    const url = new URL(ref);
    const pathMatch = url.pathname.match(/\/design\/([^/]+)/);
    if (pathMatch?.[1]) {
      return { design_id: pathMatch[1], matched_by: "url_path", confidence: "high" };
    }

    for (const key of ["designId", "design_id", "utm_content", "id"]) {
      const value = url.searchParams.get(key);
      if (value && /^[A-Za-z0-9_-]{8,}$/.test(value)) {
        return { design_id: value, matched_by: `query_${key}`, confidence: "medium" };
      }
    }

    if (/\/api\/design\//.test(url.pathname)) {
      return { opaque_url: true, matched_by: "temporary_url", confidence: "low" };
    }
  } catch {
    // Not a URL; treat as title or keyword.
  }

  return { title: ref, matched_by: "title_search", confidence: "low" };
}

async function exportCommand(ref, options, config) {
  requireScope(config, "design:content:read");
  const resolved = await resolveDesignRef(ref, config);
  const format = String(options.format || "pptx").toLowerCase();
  const outDir = path.resolve(options.out || "exports");
  const inspect = Boolean(options.inspect);
  const pages = parsePages(options.pages);
  const exported = await exportDesign(config, {
    designId: resolved.design_id,
    title: resolved.design?.title,
    format,
    outDir,
    pages,
  });

  const artifacts = [...exported.artifacts];
  let inspection;
  if (inspect && format === "pptx" && exported.files[0]) {
    inspection = inspectPptx(exported.files[0]);
    const slidesPath = path.join(exported.design_dir, "slides.json");
    fs.writeFileSync(slidesPath, `${JSON.stringify(inspection, null, 2)}\n`);
    artifacts.push({ type: "slide_visibility", path: slidesPath });
  }

  const manifest = buildManifest({ resolved, exported, inspection, artifacts });
  const manifestPath = path.join(exported.design_dir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  artifacts.push({ type: "manifest", path: manifestPath });

  return {
    resolved,
    export: {
      job_id: exported.job_id,
      status: exported.status,
      format,
      files: exported.files,
    },
    inspection,
    artifacts,
  };
}

async function exportDesign(config, { designId, title, format, outDir, pages }) {
  const created = await apiFetch(config, "/exports", {
    method: "POST",
    body: JSON.stringify({
      design_id: designId,
      format: buildExportFormat(format, pages),
    }),
  });
  const jobId = created.job?.id;
  if (!jobId) {
    throw userError("export_job_missing_id", "Canva export response did not include job.id.", EXIT.exportFailed);
  }
  const completed = await pollExportJob(config, jobId);
  const urls = completed.job?.urls || [];
  if (!urls.length) {
    throw userError("export_missing_urls", "Canva export finished without download URLs.", EXIT.exportFailed);
  }

  const designDir = path.join(outDir, safeFileName(designId));
  fs.mkdirSync(designDir, { recursive: true });
  const files = [];
  for (const [index, downloadUrl] of urls.entries()) {
    const suffix = urls.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
    const filePath = path.join(designDir, `${safeFileName(designId)}${suffix}.${extensionForFormat(format)}`);
    await downloadFile(downloadUrl, filePath);
    files.push(filePath);
  }

  return {
    design_id: designId,
    title,
    job_id: jobId,
    status: completed.job.status,
    format,
    design_dir: designDir,
    files,
    artifacts: files.map((file) => ({ type: format, path: file, sha256: sha256File(file) })),
  };
}

async function pollExportJob(config, jobId) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await apiFetch(config, `/exports/${encodeURIComponent(jobId)}`);
    const status = result.job?.status;
    if (status === "success") {
      return result;
    }
    if (status === "failed") {
      throw userError("export_job_failed", JSON.stringify(result.job?.error || result), EXIT.exportFailed);
    }
    await sleep(Math.min(1000 + attempt * 300, 4000));
  }
  throw userError("export_timeout", `Export job ${jobId} did not finish in time.`, EXIT.timeout);
}

async function downloadFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw apiError("download_failed", response.status, await response.text());
  }
  fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
}

function inspectPptx(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw userError("file_not_found", `PPTX not found: ${absPath}`, EXIT.invalidArgs);
  }
  const entries = run("zipinfo", ["-1", absPath])
    .split(/\r?\n/)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = entries.map((entry) => {
    const xml = run("unzip", ["-p", absPath, entry]);
    const hidden = /<p:sld\b[^>]*\bshow=["'](?:false|0)["']/.test(xml);
    return { index: slideNumber(entry), hidden };
  });
  const hiddenIndexes = slides.filter((slide) => slide.hidden).map((slide) => slide.index);
  return {
    file: absPath,
    summary: {
      total: slides.length,
      visible: slides.length - hiddenIndexes.length,
      hidden: hiddenIndexes.length,
    },
    hidden_indexes: hiddenIndexes,
    slides,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 100 });
  if (result.status !== 0) {
    throw userError("command_failed", `${command} failed: ${result.stderr || result.stdout}`, EXIT.generic);
  }
  return result.stdout;
}

function slideNumber(entry) {
  return Number(entry.match(/slide(\d+)\.xml$/)?.[1] || 0);
}

function sanitizeDesign(design, { includeUrls = false } = {}) {
  const result = {
    id: design.id,
    title: design.title,
    owner: design.owner,
    page_count: design.page_count,
    created_at: design.created_at,
    updated_at: design.updated_at,
    has_thumbnail: Boolean(design.thumbnail),
  };
  if (includeUrls) {
    result.edit_url = design.urls?.edit_url || design.edit_url;
    result.view_url = design.urls?.view_url || design.view_url;
  }
  return result;
}

function buildExportFormat(format, pages) {
  const supported = new Set(["pptx", "pdf", "png", "jpg", "gif", "mp4", "csv", "html_bundle", "html_standalone"]);
  if (!supported.has(format)) {
    throw userError("unsupported_format", `Unsupported export format: ${format}`, EXIT.invalidArgs);
  }
  const result = { type: format };
  if (pages?.length) {
    result.pages = pages;
  }
  if (format === "jpg") {
    result.quality = 90;
  }
  if (format === "mp4") {
    result.quality = "horizontal_1080p";
  }
  return result;
}

function buildManifest({ resolved, exported, inspection, artifacts }) {
  return {
    schema_version: 1,
    source: {
      environment: "canva.cn",
      design_id: resolved.design_id,
      title: resolved.design?.title,
      matched_by: resolved.matched_by,
    },
    export: {
      format: exported.format,
      job_id: exported.job_id,
      status: exported.status,
      created_at: new Date().toISOString(),
    },
    artifacts,
    inspection: inspection
      ? {
          slides_total: inspection.summary.total,
          slides_visible: inspection.summary.visible,
          slides_hidden: inspection.summary.hidden,
        }
      : undefined,
  };
}

function extensionForFormat(format) {
  if (format === "html_bundle") return "zip";
  if (format === "html_standalone") return "html";
  return format;
}

function parsePages(value) {
  if (!value) return undefined;
  const pages = String(value)
    .split(",")
    .map((page) => Number(page.trim()))
    .filter((page) => Number.isInteger(page) && page > 0);
  return pages.length ? pages : undefined;
}

function requireScope(config, scope) {
  const token = readToken(config);
  const granted = splitScopes(token?.scope || "");
  if (!granted.includes(scope)) {
    throw userError("missing_scope", `${scope} is required.`, EXIT.missingScope, {
      required_scopes: [scope],
      remediation: `Run canvapie auth login --scopes "${DEFAULT_SCOPES.join(" ")}"`,
    });
  }
}

function requireConfig(config) {
  if (!config.clientId || !config.clientSecret) {
    throw userError("missing_config", "Missing Canva client_id or client_secret.", EXIT.invalidArgs, {
      remediation:
        "Run canvapie init --help to see where to get credentials, then run canvapie init and canvapie auth login.",
    });
  }
}

function readToken(config) {
  return readJsonIfExists(config.tokenPath);
}

function writeToken(config, token) {
  fs.mkdirSync(path.dirname(config.tokenPath), { recursive: true });
  fs.writeFileSync(config.tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isTokenLikelyExpired(token) {
  if (!token?.obtained_at || !token.expires_in) return false;
  return Date.now() > new Date(token.obtained_at).getTime() + Number(token.expires_in) * 1000 - 60_000;
}

function tokenExpiresAt(token) {
  if (!token?.obtained_at || !token.expires_in) return null;
  return new Date(new Date(token.obtained_at).getTime() + Number(token.expires_in) * 1000).toISOString();
}

function tokenSecondsUntilExpiry(token) {
  const expiresAt = tokenExpiresAt(token);
  if (!expiresAt) return null;
  return Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
}

function openUrl(url) {
  const platform = os.platform();
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    process.stderr.write(`Open this URL in your browser:\n${url}\n`);
  }
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function apiError(code, status, payload) {
  return userError(code, `Canva API request failed with status ${status}.`, EXIT.apiError, { status, payload });
}

function userError(code, message, exitCode = EXIT.generic, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  Object.assign(error, extra);
  return error;
}

function normalizeError(error) {
  const exitCode = error.exitCode || EXIT.generic;
  const body = {
    ok: false,
    error: {
      code: error.code || "unexpected_error",
      message: error.message || String(error),
      retryable: Boolean(error.retryable),
    },
  };
  for (const key of ["required_scopes", "remediation", "status", "payload", "candidates"]) {
    if (error[key] !== undefined) {
      if (key === "candidates") {
        body.candidates = error[key];
      } else {
        body.error[key] = error[key];
      }
    }
  }
  return { exitCode, body };
}

function envelope(command, result, artifacts = [], warnings = [], metrics = {}) {
  return { ok: true, command, result, artifacts, warnings, metrics };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function splitScopes(value) {
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
