import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {createHash, randomBytes} from 'crypto';
import {createServer} from 'http';
import {execFileSync} from 'child_process';

const TOKEN_FILE = '.tokens.json';

export function loadTokens(dir) {
    try {
        const raw = readFileSync(join(dir, TOKEN_FILE), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function saveTokens(dir, tokens) {
    writeFileSync(join(dir, TOKEN_FILE), JSON.stringify(tokens, null, 2) + '\n');
}

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export function isTokenValid(tokens) {
    if (!tokens?.access_token || !tokens?.expires_at) return false;
    return new Date(tokens.expires_at).getTime() - Date.now() > EXPIRY_BUFFER_MS;
}

export function generatePKCE() {
    const verifier = randomBytes(64)
        .toString('base64url')
        .slice(0, 128);
    const challenge = createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return {verifier, challenge};
}

const CALLBACK_PORT = 8019;

export function runPKCEFlow({appKey, openFn, fetchFn = fetch, port = CALLBACK_PORT}) {
    const {verifier, challenge} = generatePKCE();

    return new Promise((resolve, reject) => {
        let redirectUri;

        const server = createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost:${server.address().port}`);

            if (url.pathname !== '/callback') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error || !code) {
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end('<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>');
                server.close();
                reject(new Error(`OAuth authorization failed: ${error || 'no code received'}`));
                return;
            }

            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end('<html><body><h1>Authorization successful!</h1><p>You can close this tab.</p></body></html>');
            server.close();

            try {
                const response = await fetchFn('https://api.dropboxapi.com/oauth2/token', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code,
                        client_id: appKey,
                        code_verifier: verifier,
                        redirect_uri: redirectUri,
                    }),
                });

                if (!response.ok) {
                    reject(new Error(`Token exchange failed (${response.status}): ${await response.text()}`));
                    return;
                }

                const data = await response.json();
                resolve({
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
                });
            } catch (err) {
                reject(err);
            }
        });

        server.on('error', reject);

        server.listen(port, () => {
            redirectUri = `http://localhost:${server.address().port}/callback`;

            const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
            authUrl.searchParams.set('client_id', appKey);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('code_challenge', challenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');
            authUrl.searchParams.set('token_access_type', 'offline');
            authUrl.searchParams.set('redirect_uri', redirectUri);

            openFn(authUrl.toString());
        });
    });
}

function openBrowser(url) {
    execFileSync('open', [url]);
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
        try {
            const refreshed = await refreshToken({
                refreshTokenValue: cached.refresh_token,
                appKey,
                fetchFn,
            });
            saveTokens(dir, refreshed);
            return refreshed.access_token;
        } catch {
            // Refresh failed (revoked app) — fall through to PKCE
        }
    }

    // Strategy 4: Full PKCE flow
    logFn('No valid token found. Starting browser authorization...');
    const tokens = await runPKCEFlow({appKey, openFn, fetchFn, port});
    saveTokens(dir, tokens);
    return tokens.access_token;
}

export async function refreshToken({refreshTokenValue, appKey, fetchFn = fetch}) {
    const response = await fetchFn('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshTokenValue,
            client_id: appKey,
        }),
    });

    if (!response.ok) {
        throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    return {
        access_token: data.access_token,
        refresh_token: refreshTokenValue,
        expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };
}