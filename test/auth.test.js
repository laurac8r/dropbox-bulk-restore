import {beforeEach, describe, expect, test} from 'vitest';
import {mkdtempSync, statSync, writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {generatePKCE, getToken, isTokenValid, loadTokens, openBrowser, refreshToken, runPKCEFlow, saveTokens} from '../src/auth.js';

describe('token storage', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
    });

    test('loadTokens returns null when no file exists', () => {
        const result = loadTokens(dir);
        expect(result).toBeNull();
    });

    test('saveTokens writes and loadTokens reads back', () => {
        const tokens = {
            access_token: 'sl.test-access',
            refresh_token: 'test-refresh',
            expires_at: '2026-04-03T23:00:00.000Z',
        };
        saveTokens(dir, tokens);
        const loaded = loadTokens(dir);
        expect(loaded).toEqual(tokens);
    });

    test('saveTokens writes file with 0o600 permissions (owner-only)', () => {
        const tokens = {access_token: 'sl.test', refresh_token: 'r', expires_at: 'x'};
        saveTokens(dir, tokens);
        const stat = statSync(join(dir, '.tokens.json'));
        // Check mode: lower 9 bits should equal 0o600
        expect(stat.mode & 0o777).toBe(0o600);
    });

    test('loadTokens returns null on malformed JSON', () => {
        writeFileSync(join(dir, '.tokens.json'), 'not json');
        const result = loadTokens(dir);
        expect(result).toBeNull();
    });
});

describe('isTokenValid', () => {
    test('returns true for token expiring in more than 5 minutes', () => {
        const tokens = {
            access_token: 'sl.test',
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
        expect(isTokenValid(tokens)).toBe(true);
    });

    test('returns false for token expiring in less than 5 minutes', () => {
        const tokens = {
            access_token: 'sl.test',
            expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        };
        expect(isTokenValid(tokens)).toBe(false);
    });

    test('returns false for already-expired token', () => {
        const tokens = {
            access_token: 'sl.test',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        expect(isTokenValid(tokens)).toBe(false);
    });

    test('returns false for null tokens', () => {
        expect(isTokenValid(null)).toBe(false);
    });

    test('returns false for tokens without expires_at', () => {
        expect(isTokenValid({access_token: 'sl.test'})).toBe(false);
    });
});

describe('generatePKCE', () => {
    test('generates verifier of 43-128 characters from unreserved charset', () => {
        const {verifier} = generatePKCE();
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier.length).toBeLessThanOrEqual(128);
        expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    test('generates verifier of exactly 128 characters', () => {
        const {verifier} = generatePKCE();
        expect(verifier.length).toBe(128);
    });

    test('generates base64url-encoded challenge from verifier', () => {
        const {challenge} = generatePKCE();
        expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    });

    test('generates different values on each call', () => {
        const a = generatePKCE();
        const b = generatePKCE();
        expect(a.verifier).not.toBe(b.verifier);
    });
});

describe('refreshToken', () => {
    test('exchanges refresh token for new access token', async () => {
        const mockFetch = async (url, opts) => {
            expect(url).toBe('https://api.dropboxapi.com/oauth2/token');
            const body = new URLSearchParams(opts.body);
            expect(body.get('grant_type')).toBe('refresh_token');
            expect(body.get('refresh_token')).toBe('old-refresh');
            expect(body.get('client_id')).toBe('test-app-key');
            return {
                ok: true,
                json: async () => ({
                    access_token: 'new-access',
                    expires_in: 14400,
                }),
            };
        };

        const result = await refreshToken({
            refreshTokenValue: 'old-refresh',
            appKey: 'test-app-key',
            fetchFn: mockFetch,
        });

        expect(result.access_token).toBe('new-access');
        expect(result.refresh_token).toBe('old-refresh');
        expect(result.expires_at).toBeDefined();
        const expiresIn = new Date(result.expires_at).getTime() - Date.now();
        expect(expiresIn).toBeGreaterThan(14000 * 1000);
        expect(expiresIn).toBeLessThanOrEqual(14400 * 1000);
    });

    test('throws on HTTP error from token endpoint', async () => {
        const mockFetch = async () => ({
            ok: false,
            status: 400,
            text: async () => 'invalid_grant',
        });

        await expect(
            refreshToken({
                refreshTokenValue: 'bad-refresh',
                appKey: 'test-app-key',
                fetchFn: mockFetch,
            })
        ).rejects.toThrow('Token refresh failed (400)');
    });

    test.each([400, 401, 500])('thrown error has .status = %i', async (status) => {
        const mockFetch = async () => ({
            ok: false,
            status,
            text: async () => 'error body',
        });

        const err = await refreshToken({
            refreshTokenValue: 'bad-refresh',
            appKey: 'test-app-key',
            fetchFn: mockFetch,
        }).catch((e) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err.status).toBe(status);
    });
});

describe('runPKCEFlow', () => {
    test('starts server, opens auth URL, and exchanges code for tokens', async () => {
        const openedUrls = [];
        const mockOpen = (url) => {
            openedUrls.push(url);
        };

        let capturedVerifier;
        let capturedRedirectUri;
        const mockFetch = async (url, opts) => {
            const body = new URLSearchParams(opts.body);
            capturedVerifier = body.get('code_verifier');
            capturedRedirectUri = body.get('redirect_uri');
            return {
                ok: true,
                json: async () => ({
                    access_token: 'new-access',
                    refresh_token: 'new-refresh',
                    expires_in: 14400,
                }),
            };
        };

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });

        // Wait for server to bind
        await new Promise((r) => setTimeout(r, 100));

        // Verify auth URL structure
        const authUrl = new URL(openedUrls[0]);
        expect(authUrl.origin).toBe('https://www.dropbox.com');
        expect(authUrl.pathname).toBe('/oauth2/authorize');
        expect(authUrl.searchParams.get('response_type')).toBe('code');
        expect(authUrl.searchParams.get('client_id')).toBe('test-key');
        expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authUrl.searchParams.get('token_access_type')).toBe('offline');
        expect(authUrl.searchParams.get('code_challenge')).toBeDefined();
        expect(authUrl.searchParams.get('redirect_uri')).toBeDefined();

        // Simulate OAuth callback
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');
        await fetch(`${redirectUri}?code=auth-code-123&state=${encodeURIComponent(state)}`);

        const tokens = await flowPromise;
        expect(tokens.access_token).toBe('new-access');
        expect(tokens.refresh_token).toBe('new-refresh');
        expect(tokens.expires_at).toBeDefined();
        expect(capturedVerifier).toBeDefined();
        expect(capturedVerifier.length).toBeGreaterThanOrEqual(43);
        expect(capturedRedirectUri).toBe(redirectUri);
    });

    test('includes state parameter in auth URL and validates on callback', async () => {
        const openedUrls = [];
        const mockOpen = (url) => { openedUrls.push(url); };
        const mockFetch = async () => ({
            ok: true,
            json: async () => ({access_token: 'a', refresh_token: 'r', expires_in: 14400}),
        });

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });

        await new Promise((r) => setTimeout(r, 100));

        const authUrl = new URL(openedUrls[0]);
        const state = authUrl.searchParams.get('state');
        expect(state).toBeDefined();
        expect(state.length).toBeGreaterThanOrEqual(32);

        const redirectUri = authUrl.searchParams.get('redirect_uri');
        await fetch(`${redirectUri}?code=abc&state=${encodeURIComponent(state)}`);

        const tokens = await flowPromise;
        expect(tokens.access_token).toBe('a');
    });

    test('rejects callback with mismatched state parameter', async () => {
        const openedUrls = [];
        const mockOpen = (url) => { openedUrls.push(url); };
        const mockFetch = async () => ({ok: true, json: async () => ({})});

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });
        flowPromise.catch(() => {});

        await new Promise((r) => setTimeout(r, 100));

        const redirectUri = new URL(openedUrls[0]).searchParams.get('redirect_uri');
        await fetch(`${redirectUri}?code=abc&state=wrong-state`);

        await expect(flowPromise).rejects.toThrow(/state/i);
    });

    test('rejects when callback receives error param', async () => {
        const openedUrls = [];
        const mockOpen = (url) => {
            openedUrls.push(url);
        };
        const mockFetch = async () => ({ok: true, json: async () => ({})});

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });
        // Suppress unhandled-rejection noise; the assertion below still catches it.
        flowPromise.catch(() => {
        });

        await new Promise((r) => setTimeout(r, 100));

        const authUrl = new URL(openedUrls[0]);
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');
        await fetch(`${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`);

        await expect(flowPromise).rejects.toThrow('OAuth authorization failed: access_denied');
    });

    test('rejects when callback receives no code and no error', async () => {
        const openedUrls = [];
        const mockOpen = (url) => {
            openedUrls.push(url);
        };
        const mockFetch = async () => ({ok: true, json: async () => ({})});

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });
        flowPromise.catch(() => {
        });

        await new Promise((r) => setTimeout(r, 100));

        const authUrl = new URL(openedUrls[0]);
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');
        await fetch(`${redirectUri}?state=${encodeURIComponent(state)}`);

        await expect(flowPromise).rejects.toThrow('OAuth authorization failed: no code received');
    });

    test('rejects when token exchange returns ok: false', async () => {
        const openedUrls = [];
        const mockOpen = (url) => {
            openedUrls.push(url);
        };
        const mockFetch = async () => ({
            ok: false,
            status: 400,
            text: async () => 'invalid_grant',
        });

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });
        flowPromise.catch(() => {
        });

        await new Promise((r) => setTimeout(r, 100));

        const authUrl = new URL(openedUrls[0]);
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');
        await fetch(`${redirectUri}?code=some-code&state=${encodeURIComponent(state)}`);

        await expect(flowPromise).rejects.toThrow('Token exchange failed (400)');
    });

    test('handled flag prevents double token exchange within single flow', async () => {
        const openedUrls = [];
        const mockOpen = (url) => { openedUrls.push(url); };
        let fetchCount = 0;
        const mockFetch = async () => {
            fetchCount++;
            // Delay to give the second request a chance to enter the handler
            await new Promise((r) => setTimeout(r, 50));
            return {
                ok: true,
                json: async () => ({access_token: 'a', refresh_token: 'r', expires_in: 14400}),
            };
        };

        const flowPromise = runPKCEFlow({
            appKey: 'test-key',
            openFn: mockOpen,
            fetchFn: mockFetch,
            port: 0,
        });

        await new Promise((r) => setTimeout(r, 100));

        const authUrl = new URL(openedUrls[0]);
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');

        // Fire two callbacks back-to-back without awaiting the first
        const r1 = fetch(`${redirectUri}?code=c1&state=${encodeURIComponent(state)}`);
        const r2 = fetch(`${redirectUri}?code=c2&state=${encodeURIComponent(state)}`).catch(() => null);

        await r1;
        const res2 = await r2;

        await flowPromise;
        expect(fetchCount).toBe(1);
        if (res2) expect(res2.status).toBe(409);
    });
});

describe('getToken', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'auth-gettoken-'));
    });

    test('returns static token when envToken is provided', async () => {
        const result = await getToken({
            dir,
            envToken: 'static-token-from-env',
            appKey: 'key',
        });
        expect(result).toBe('static-token-from-env');
    });

    test('returns cached token when .tokens.json is valid', async () => {
        const tokens = {
            access_token: 'cached-access',
            refresh_token: 'cached-refresh',
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));

        const result = await getToken({dir, appKey: 'key'});
        expect(result).toBe('cached-access');
    });

    test('refreshes expired token using refresh_token', async () => {
        const tokens = {
            access_token: 'expired-access',
            refresh_token: 'valid-refresh',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));

        const mockFetch = async () => ({
            ok: true,
            json: async () => ({
                access_token: 'refreshed-access',
                expires_in: 14400,
            }),
        });

        const result = await getToken({dir, appKey: 'key', fetchFn: mockFetch});
        expect(result).toBe('refreshed-access');
    });

    test('runs PKCE flow when no tokens exist', async () => {
        let callbackUrl;
        let pkceState;
        const mockOpen = (url) => {
            const authUrl = new URL(url);
            callbackUrl = authUrl.searchParams.get('redirect_uri');
            pkceState = authUrl.searchParams.get('state');
        };
        const mockFetch = async () => ({
            ok: true,
            json: async () => ({
                access_token: 'pkce-access',
                refresh_token: 'pkce-refresh',
                expires_in: 14400,
            }),
        });

        const tokenPromise = getToken({
            dir,
            appKey: 'key',
            fetchFn: mockFetch,
            openFn: mockOpen,
            port: 0,
        });

        // Wait for server to start, then simulate callback
        await new Promise((r) => setTimeout(r, 150));
        await fetch(`${callbackUrl}?code=test-code&state=${encodeURIComponent(pkceState)}`);

        const result = await tokenPromise;
        expect(result).toBe('pkce-access');
    });

    test('falls through to PKCE when refresh fails', async () => {
        const tokens = {
            access_token: 'expired-access',
            refresh_token: 'revoked-refresh',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));

        let callbackUrl;
        let pkceState;
        let fetchCallCount = 0;
        const mockOpen = (url) => {
            const authUrl = new URL(url);
            callbackUrl = authUrl.searchParams.get('redirect_uri');
            pkceState = authUrl.searchParams.get('state');
        };
        const mockFetch = async () => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
                // First call: refresh fails
                return {ok: false, status: 400, text: async () => 'invalid_grant'};
            }
            // Second call: PKCE token exchange succeeds
            return {
                ok: true,
                json: async () => ({
                    access_token: 'pkce-fallback',
                    refresh_token: 'new-refresh',
                    expires_in: 14400,
                }),
            };
        };

        const tokenPromise = getToken({
            dir,
            appKey: 'key',
            fetchFn: mockFetch,
            openFn: mockOpen,
            port: 0,
        });

        await new Promise((r) => setTimeout(r, 150));
        await fetch(`${callbackUrl}?code=fallback-code&state=${encodeURIComponent(pkceState)}`);

        const result = await tokenPromise;
        expect(result).toBe('pkce-fallback');
    });

    test('propagates error whose message incidentally contains "400" as substring (not a real HTTP 400)', async () => {
        const tokens = {
            access_token: 'expired',
            refresh_token: 'valid',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));

        const fakeErr = new Error('upstream returned 14001 results, not a real HTTP 400');
        // No .status property — simulates a non-HTTP error whose message happens to contain "400"
        const mockFetch = async () => { throw fakeErr; };

        await expect(
            getToken({dir, appKey: 'key', fetchFn: mockFetch, openFn: () => {}, port: 0})
        ).rejects.toThrow('14001');
    });

    test('propagates transient network error during refresh (does not fall through)', async () => {
        const tokens = {
            access_token: 'expired',
            refresh_token: 'valid',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));

        const mockFetch = async () => { throw new Error('ECONNRESET'); };

        await expect(
            getToken({dir, appKey: 'key', fetchFn: mockFetch, openFn: () => {}, port: 0})
        ).rejects.toThrow('ECONNRESET');
    });

    test('logs when refresh fails with 400/401 and falls through to PKCE', async () => {
        const tokens = {
            access_token: 'expired',
            refresh_token: 'revoked',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));

        const logs = [];
        let callbackUrl;
        let pkceState;
        const mockOpen = (url) => {
            const authUrl = new URL(url);
            callbackUrl = authUrl.searchParams.get('redirect_uri');
            pkceState = authUrl.searchParams.get('state');
        };
        let fetchCalls = 0;
        const mockFetch = async () => {
            fetchCalls++;
            if (fetchCalls === 1) return {ok: false, status: 400, text: async () => 'invalid_grant'};
            return {
                ok: true,
                json: async () => ({access_token: 'pkce-a', refresh_token: 'r', expires_in: 14400}),
            };
        };

        const tokenPromise = getToken({
            dir, appKey: 'key',
            fetchFn: mockFetch, openFn: mockOpen, port: 0,
            logFn: (msg) => logs.push(msg),
        });

        await new Promise((r) => setTimeout(r, 150));
        await fetch(`${callbackUrl}?code=c&state=${encodeURIComponent(pkceState)}`);

        const result = await tokenPromise;
        expect(result).toBe('pkce-a');
        expect(logs.some((m) => /refresh/i.test(m))).toBe(true);
    });

    test('returns refreshed token even if saveTokens fails, logs warning', async () => {
        const tokens = {
            access_token: 'expired',
            refresh_token: 'valid',
            expires_at: new Date(Date.now() - 1000).toISOString(),
        };
        writeFileSync(join(dir, '.tokens.json'), JSON.stringify(tokens));
        // Make file/dir un-writable so saveTokens throws
        const {chmodSync} = await import('fs');
        chmodSync(join(dir, '.tokens.json'), 0o400);
        chmodSync(dir, 0o500);

        const logs = [];
        const mockFetch = async () => ({
            ok: true,
            json: async () => ({access_token: 'refreshed-a', expires_in: 14400}),
        });

        try {
            const result = await getToken({
                dir, appKey: 'key', fetchFn: mockFetch,
                logFn: (msg) => logs.push(msg),
            });
            expect(result).toBe('refreshed-a');
            expect(logs.some((m) => /save|warn/i.test(m))).toBe(true);
        } finally {
            chmodSync(dir, 0o700);
        }
    });
});

describe('openBrowser', () => {
    test('uses "open" on darwin', () => {
        const calls = [];
        openBrowser('https://example.com', {
            platform: 'darwin',
            execFn: (cmd, args) => calls.push([cmd, args]),
            logFn: () => {},
        });
        expect(calls).toEqual([['open', ['https://example.com']]]);
    });

    test('uses "cmd /c start" on win32', () => {
        const calls = [];
        openBrowser('https://example.com', {
            platform: 'win32',
            execFn: (cmd, args) => calls.push([cmd, args]),
            logFn: () => {},
        });
        expect(calls).toEqual([['cmd', ['/c', 'start', '', 'https://example.com']]]);
    });

    test('uses "xdg-open" on linux', () => {
        const calls = [];
        openBrowser('https://example.com', {
            platform: 'linux',
            execFn: (cmd, args) => calls.push([cmd, args]),
            logFn: () => {},
        });
        expect(calls).toEqual([['xdg-open', ['https://example.com']]]);
    });

    test('falls back to printing URL when exec throws', () => {
        const logs = [];
        openBrowser('https://example.com', {
            platform: 'linux',
            execFn: () => { throw new Error('ENOENT'); },
            logFn: (msg) => logs.push(msg),
        });
        expect(logs.some((m) => m.includes('https://example.com'))).toBe(true);
        expect(logs.some((m) => /manually|could not open/i.test(m))).toBe(true);
    });
});