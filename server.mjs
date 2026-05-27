import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL, URLSearchParams } from "node:url";

const cwd = process.cwd();
const env = loadEnv(path.join(cwd, ".env"));

const host = "127.0.0.1";
const port = Number(env.CANVA_PORT || 3001);
const webBaseUrl = trimTrailingSlash(
  env.CANVA_WEB_BASE_URL || "https://www.canva.cn",
);
const apiBaseUrl = trimTrailingSlash(
  env.CANVA_API_BASE_URL || "https://api.canva.cn/rest/v1",
);
const redirectUri =
  env.CANVA_REDIRECT_URI || `http://${host}:${port}/oauth/redirect`;
const clientId = env.CANVA_CLIENT_ID || "";
const clientSecret = env.CANVA_CLIENT_SECRET || "";
const scopes = splitScopes(
  env.CANVA_SCOPES ||
    "design:meta:read design:content:read folder:read asset:read profile:read",
);
const tokenPath = path.join(cwd, ".tokens.json");
const exportsDir = path.join(cwd, "exports");
const pendingStates = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    if (url.pathname === "/") {
      return sendHtml(res, renderHome());
    }

    if (url.pathname === "/oauth/start") {
      return startOAuth(res);
    }

    if (url.pathname === "/oauth/redirect") {
      return handleOAuthRedirect(url, res);
    }

    if (url.pathname === "/oauth/refresh") {
      const token = await refreshToken();
      return sendJson(res, scrubToken(token));
    }

    if (url.pathname === "/api/designs") {
      const token = await getUsableToken();
      const designs = await canvaFetch("/designs", token.access_token);
      return sendJson(res, designs);
    }

    if (url.pathname.startsWith("/api/designs/")) {
      const designId = decodeURIComponent(url.pathname.slice("/api/designs/".length));
      if (!designId) {
        return sendText(res, "Missing design ID", 400);
      }
      const token = await getUsableToken();
      const design = await canvaFetch(`/designs/${encodeURIComponent(designId)}`, token.access_token);
      return sendJson(res, design);
    }

    if (url.pathname === "/api/export") {
      const designId = url.searchParams.get("designId");
      const format = url.searchParams.get("format") || "pptx";
      const pages = parsePages(url.searchParams.get("pages"));
      if (!designId) {
        return sendText(res, "Missing required query parameter: designId", 400);
      }
      const result = await exportDesign({ designId, format, pages });
      return sendJson(res, result);
    }

    if (url.pathname.startsWith("/api/exports/")) {
      const exportId = decodeURIComponent(url.pathname.slice("/api/exports/".length));
      if (!exportId) {
        return sendText(res, "Missing export job ID", 400);
      }
      const token = await getUsableToken();
      const job = await canvaFetch(`/exports/${encodeURIComponent(exportId)}`, token.access_token);
      return sendJson(res, job);
    }

    if (url.pathname === "/return-nav") {
      return sendHtml(
        res,
        page("Return Navigation", "<p>Canva returned to the local test app.</p>"),
      );
    }

    sendText(res, "Not found", 404);
  } catch (error) {
    sendHtml(
      res,
      page(
        "Error",
        `<pre>${escapeHtml(error instanceof Error ? error.stack || error.message : String(error))}</pre>`,
      ),
      500,
    );
  }
});

server.listen(port, host, () => {
  console.log(`Canva Connect OAuth probe running at http://${host}:${port}/`);
  console.log(`Redirect URL: ${redirectUri}`);
});

function startOAuth(res) {
  requireConfig();

  const state = base64Url(crypto.randomBytes(32));
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );

  pendingStates.set(state, {
    codeVerifier,
    createdAt: Date.now(),
  });

  const authorizeUrl = new URL("/api/oauth/authorize", webBaseUrl);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "s256",
  }).toString();

  res.writeHead(302, { Location: authorizeUrl.toString() });
  res.end();
}

async function handleOAuthRedirect(url, res) {
  requireConfig();

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") || "";
    return sendHtml(
      res,
      page("Authorization Failed", `<pre>${escapeHtml(`${error}\n${description}`)}</pre>`),
      400,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return sendText(res, "Missing code or state", 400);
  }

  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending) {
    return sendText(res, "Unknown or expired OAuth state", 400);
  }

  const token = await exchangeCode(code, pending.codeVerifier);
  writeToken(token);

  sendHtml(
    res,
    page(
      "Authorized",
      `<p>OAuth token saved to <code>.tokens.json</code>.</p>
       <p><a href="/api/designs">List designs</a></p>
       <p><a href="/">Back home</a></p>`,
    ),
  );
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  return requestToken(body);
}

async function refreshToken() {
  requireConfig();
  const saved = readToken();
  if (!saved?.refresh_token) {
    throw new Error("No refresh_token saved. Authorize first at /oauth/start.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token,
  });

  const refreshed = await requestToken(body);
  const token = {
    ...saved,
    ...refreshed,
    refresh_token: refreshed.refresh_token || saved.refresh_token,
  };
  writeToken(token);
  return token;
}

async function requestToken(body) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  const response = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    throw new Error(
      `Token request failed (${response.status}): ${JSON.stringify(payload ?? text, null, 2)}`,
    );
  }

  return {
    ...payload,
    obtained_at: new Date().toISOString(),
  };
}

async function getUsableToken() {
  const saved = readToken();
  if (!saved?.access_token) {
    throw new Error("No access_token saved. Authorize first at /oauth/start.");
  }

  if (isTokenLikelyExpired(saved)) {
    return refreshToken();
  }

  return saved;
}

async function canvaFetch(endpoint, accessToken) {
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    throw new Error(
      `Canva API failed (${response.status}): ${JSON.stringify(payload ?? text, null, 2)}`,
    );
  }
  return payload;
}

async function canvaJsonFetch(endpoint, accessToken, { method, body }) {
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    throw new Error(
      `Canva API failed (${response.status}): ${JSON.stringify(payload ?? text, null, 2)}`,
    );
  }
  return payload;
}

async function exportDesign({ designId, format, pages }) {
  requireScope("design:content:read");

  const token = await getUsableToken();
  const created = await canvaJsonFetch("/exports", token.access_token, {
    method: "POST",
    body: {
      design_id: designId,
      format: buildExportFormat(format, pages),
    },
  });

  const exportId = created.job?.id;
  if (!exportId) {
    throw new Error(`Export creation response did not include job.id: ${JSON.stringify(created)}`);
  }

  const completed = await pollExportJob(exportId, token.access_token);
  const urls = completed.job?.urls || [];
  if (urls.length === 0) {
    throw new Error(`Export completed without download URLs: ${JSON.stringify(completed)}`);
  }

  const savedFiles = [];
  for (const [index, downloadUrl] of urls.entries()) {
    const filePath = await downloadExport({
      downloadUrl,
      designId,
      format,
      index,
      total: urls.length,
    });
    savedFiles.push(filePath);
  }

  return {
    export_id: exportId,
    status: completed.job.status,
    design_id: designId,
    format,
    saved_files: savedFiles,
  };
}

async function pollExportJob(exportId, accessToken) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await canvaFetch(`/exports/${encodeURIComponent(exportId)}`, accessToken);
    const status = result.job?.status;

    if (status === "success") {
      return result;
    }

    if (status === "failed") {
      throw new Error(`Export job failed: ${JSON.stringify(result.job.error || result)}`);
    }

    await sleep(Math.min(1000 + attempt * 300, 4000));
  }

  throw new Error(`Export job ${exportId} did not finish in time.`);
}

async function downloadExport({ downloadUrl, designId, format, index, total }) {
  fs.mkdirSync(exportsDir, { recursive: true });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Download failed (${response.status}): ${text}`);
  }

  const safeDesignId = designId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const suffix = total > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
  const filePath = path.join(exportsDir, `${safeDesignId}${suffix}.${extensionForFormat(format)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function buildExportFormat(format, pages) {
  const type = format.toLowerCase();
  const supported = new Set([
    "pptx",
    "pdf",
    "png",
    "jpg",
    "gif",
    "mp4",
    "csv",
    "html_bundle",
    "html_standalone",
  ]);

  if (!supported.has(type)) {
    throw new Error(`Unsupported export format: ${format}`);
  }

  const result = { type };
  if (pages?.length) {
    result.pages = pages;
  }
  if (type === "jpg") {
    result.quality = 90;
  }
  if (type === "mp4") {
    result.quality = "horizontal_1080p";
  }
  return result;
}

function extensionForFormat(format) {
  if (format === "html_bundle") {
    return "zip";
  }
  if (format === "html_standalone") {
    return "html";
  }
  return format;
}

function parsePages(value) {
  if (!value) {
    return undefined;
  }
  const pages = value
    .split(",")
    .map((page) => Number(page.trim()))
    .filter((page) => Number.isInteger(page) && page > 0);
  return pages.length ? pages : undefined;
}

function requireScope(scope) {
  const token = readToken();
  const granted = new Set(String(token?.scope || "").split(/\s+/).filter(Boolean));
  if (!granted.has(scope)) {
    throw new Error(
      `Current token is missing ${scope}. Re-authorize at /oauth/start after enabling this scope in Canva and .env.`,
    );
  }
}

function renderHome() {
  const token = readToken();
  const configRows = [
    ["Web base URL", webBaseUrl],
    ["API base URL", apiBaseUrl],
    ["Redirect URL", redirectUri],
    ["Scopes", scopes.join(" ")],
    ["Client ID", clientId ? `${clientId.slice(0, 8)}...` : "missing"],
    ["Client Secret", clientSecret ? "configured" : "missing"],
    ["Token", token?.access_token ? "saved" : "not authorized"],
  ];

  const missingConfig = !clientId || !clientSecret;
  const rows = configRows
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(key)}</th><td><code>${escapeHtml(value)}</code></td></tr>`,
    )
    .join("");

  return page(
    "Canva.cn Connect OAuth Probe",
    `<table>${rows}</table>
     ${
       missingConfig
         ? `<p class="warn">Fill <code>CANVA_CLIENT_ID</code> and <code>CANVA_CLIENT_SECRET</code> in <code>.env</code>, then restart.</p>`
         : `<p><a class="button" href="/oauth/start">Authorize with Canva</a></p>`
     }
     <p><a href="/api/designs">List designs</a> · <a href="/oauth/refresh">Refresh token</a></p>
     <p>Export example: <code>/api/export?designId=DAHKwJCxT1g&amp;format=pptx</code></p>`,
  );
}

function requireConfig() {
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing CANVA_CLIENT_ID or CANVA_CLIENT_SECRET. Copy .env.example to .env and fill both values.",
    );
  }
}

function loadEnv(filePath) {
  const values = { ...process.env };
  if (!fs.existsSync(filePath)) {
    return values;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    values[key] = stripQuotes(value);
  }
  return values;
}

function readToken() {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(tokenPath, "utf8"));
}

function writeToken(token) {
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, {
    mode: 0o600,
  });
}

function isTokenLikelyExpired(token) {
  if (!token.obtained_at || !token.expires_in) {
    return false;
  }
  const obtainedAt = new Date(token.obtained_at).getTime();
  const expiresAt = obtainedAt + Number(token.expires_in) * 1000;
  return Date.now() > expiresAt - 60_000;
}

function scrubToken(token) {
  return {
    ...token,
    access_token: token.access_token ? `${token.access_token.slice(0, 12)}...` : undefined,
    refresh_token: token.refresh_token ? `${token.refresh_token.slice(0, 12)}...` : undefined,
  };
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 920px; line-height: 1.5; }
    code, pre { background: #f3f4f6; border-radius: 6px; padding: 2px 5px; }
    pre { padding: 14px; overflow: auto; }
    table { border-collapse: collapse; margin: 24px 0; width: 100%; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { width: 180px; color: #374151; }
    a.button { display: inline-block; background: #7c3aed; color: white; padding: 10px 14px; border-radius: 8px; text-decoration: none; }
    .warn { color: #92400e; background: #fffbeb; border: 1px solid #fde68a; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function splitScopes(value) {
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
