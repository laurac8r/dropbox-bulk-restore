const BASE_URL = 'https://api.dropboxapi.com';
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function dropboxFetch(endpoint, body, options) {
  const { token, appKey, fetchFn = fetch, sleepFn = defaultSleep } = options;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetchFn(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseFloat(response.headers.get('Retry-After')) || 0;
      const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
      const baseWait = Math.max(retryAfter * 1000, exponentialDelay);
      const jitter = Math.random() * baseWait * 0.5;
      await sleepFn(baseWait + jitter);
      continue;
    }

    if (response.status === 429) {
      throw new Error(`Max retries exceeded for ${endpoint}`);
    }

    const errorBody = await response.json();

    // Retry in_progress errors (async job still running, e.g. folder recreation)
    if (response.status === 409 && errorBody?.error_summary?.startsWith('in_progress')) {
      if (attempt < MAX_RETRIES) {
        const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.random() * exponentialDelay * 0.5;
        await sleepFn(exponentialDelay + jitter);
        continue;
      }
      throw new Error(`Max retries exceeded for ${endpoint}`);
    }

    if (response.status === 401 && errorBody?.error_summary?.startsWith('expired_access_token')) {
      const url = `https://www.dropbox.com/developers/apps/info/${appKey}#settings:~:text=Generated%20access%20token`;
      throw new Error(
        `Your Dropbox access token has expired. Re-generate it here:\n${url}\nThen update your .env file with the new token.`
      );
    }

    throw new Error(`Dropbox API error ${response.status}: ${JSON.stringify(errorBody)}`);
  }
}