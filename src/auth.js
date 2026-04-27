import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import { createServer } from "http";
import { execFileSync } from "child_process";

const TOKEN_FILE = ".tokens.json";

export function loadTokens(dir) {
  try {
    const raw = readFileSync(join(dir, TOKEN_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveTokens(dir, tokens) {
  const target = join(dir, TOKEN_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, target);
}

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export function isTokenValid(tokens) {
  if (!tokens?.access_token || !tokens?.expires_at) return false;
  return new Date(tokens.expires_at).getTime() - Date.now() > EXPIRY_BUFFER_MS;
}

export function generatePKCE() {
  const verifier = randomBytes(96).toString("base64url").slice(0, 128);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const CALLBACK_PORT = 8019;
const PKCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function runPKCEFlow({
  appKey,
  openFn,
  fetchFn = fetch,
  port = CALLBACK_PORT,
  timeoutMs = PKCE_TIMEOUT_MS,
}) {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(32).toString("base64url");

  return new Promise((resolve, reject) => {
    let handled = false;
    let redirectUri;
    let serverPort;

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${serverPort}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (handled) {
        res.writeHead(409, { "Content-Type": "text/plain" });
        res.end("Callback already processed");
        return;
      }
      handled = true;

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const receivedState = url.searchParams.get("state");

      if (receivedState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("State mismatch");
        server.close();
        reject(new Error("OAuth state mismatch — possible CSRF attack"));
        return;
      }

      if (error || !code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>",
        );
        server.close();
        reject(
          new Error(
            `OAuth authorization failed: ${error || "no code received"}`,
          ),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Authorization successful!</h1><p>You can close this tab.</p></body></html>",
      );
      server.close();

      try {
        const response = await fetchFn(
          "https://api.dropboxapi.com/oauth2/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              client_id: appKey,
              code_verifier: verifier,
              redirect_uri: redirectUri,
            }),
          },
        );

        if (!response.ok) {
          reject(
            new Error(
              `Token exchange failed (${response.status}): ${await response.text()}`,
            ),
          );
          return;
        }

        const data = await response.json();
        resolve({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: new Date(
            Date.now() + data.expires_in * 1000,
          ).toISOString(),
        });
      } catch (err) {
        reject(err);
      }
    });

    server.on("error", reject);

    server.listen(port, "127.0.0.1", () => {
      serverPort = server.address().port;
      redirectUri = `http://localhost:${serverPort}/callback`;

      const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");
      authUrl.searchParams.set("client_id", appKey);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("token_access_type", "offline");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", state);

      openFn(authUrl.toString());
    });

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!handled) {
          handled = true;
          server.close();
          reject(
            new Error(
              `PKCE authorization timed out after ${timeoutMs / 1000}s — no callback received`,
            ),
          );
        }
      }, timeoutMs);
      server.on("close", () => clearTimeout(timer));
    }
  });
}

export function openBrowser(
  url,
  {
    platform = process.platform,
    execFn = execFileSync,
    logFn = console.log,
  } = {},
) {
  try {
    if (platform === "darwin") {
      execFn("open", [url]);
    } else if (platform === "win32") {
      // `start` is a cmd builtin, must be invoked via cmd /c.
      // The empty string after /c is the window title (required
      // because `start` treats the first quoted arg as the title).
      execFn("cmd", ["/c", "start", "", url]);
    } else {
      execFn("xdg-open", [url]);
    }
  } catch (err) {
    logFn(`Could not open browser automatically (${err?.message || err}).`);
    logFn(`Open this URL manually:\n  ${url}`);
  }
}

export async function getToken({
  dir,
  envToken,
  appKey,
  fetchFn = fetch,
  openFn = openBrowser,
  port = CALLBACK_PORT,
  logFn = console.log,
}) {
  // Strategy 1: Static .env token — skip OAuth entirely
  if (envToken) return envToken;

  // Strategy 2: Cached valid token from .tokens.json
  const cached = loadTokens(dir);
  if (isTokenValid(cached)) return cached.access_token;

  // Strategy 3: Refresh expired token
  if (cached?.refresh_token) {
    let refreshed;
    try {
      refreshed = await refreshToken({
        refreshTokenValue: cached.refresh_token,
        appKey,
        fetchFn,
      });
    } catch (err) {
      // Only permanent auth failures (400/401) fall through to PKCE.
      // Transient errors (network, DNS, 5xx) propagate so callers can retry.
      if (err?.status === 400 || err?.status === 401) {
        logFn(
          `Token refresh rejected (${err?.message || err}); starting browser authorization...`,
        );
      } else {
        throw err;
      }
    }

    if (refreshed) {
      try {
        saveTokens(dir, refreshed);
      } catch (err) {
        logFn(
          `Warning: failed to save refreshed token (${err?.message || err}); continuing with in-memory token.`,
        );
      }
      return refreshed.access_token;
    }
  }

  // Strategy 4: Full PKCE flow
  logFn("No valid token found. Starting browser authorization...");
  const tokens = await runPKCEFlow({ appKey, openFn, fetchFn, port });
  saveTokens(dir, tokens);
  return tokens.access_token;
}

export async function refreshToken({
  refreshTokenValue,
  appKey,
  fetchFn = fetch,
}) {
  const response = await fetchFn("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: appKey,
    }),
  });

  if (!response.ok) {
    const err = new Error(
      `Token refresh failed (${response.status}): ${await response.text()}`,
    );
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: refreshTokenValue,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}
