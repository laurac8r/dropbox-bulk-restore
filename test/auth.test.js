import { describe, expect, test, beforeEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { loadTokens, saveTokens, isTokenValid, generatePKCE, refreshToken } from '../src/auth.js';

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
        expect(isTokenValid({ access_token: 'sl.test' })).toBe(false);
    });
});

describe('generatePKCE', () => {
    test('generates verifier of 43-128 characters from unreserved charset', () => {
        const { verifier } = generatePKCE();
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier.length).toBeLessThanOrEqual(128);
        expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    test('generates base64url-encoded challenge from verifier', () => {
        const { challenge } = generatePKCE();
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
});