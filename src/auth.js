import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {createHash, randomBytes} from 'crypto';

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