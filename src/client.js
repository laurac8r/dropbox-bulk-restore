const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ENDPOINT_MAP = {
  '/2/files/list_folder': 'filesListFolder',
  '/2/files/list_folder/continue': 'filesListFolderContinue',
  '/2/files/list_revisions': 'filesListRevisions',
  '/2/files/restore': 'filesRestore',
  '/2/files/create_folder_v2': 'filesCreateFolderV2',
};

export class DropboxClient {
  constructor({ sdk, sleepFn = defaultSleep, appKey, onTokenRefresh } = {}) {
    this.sdk = sdk;
    this.sleepFn = sleepFn;
    this.appKey = appKey;
    this.onTokenRefresh = onTokenRefresh;
  }

  async call(endpoint, body) {
    const method = ENDPOINT_MAP[endpoint];
    if (!method) {
      throw new Error(`Unknown endpoint: ${endpoint}`);
    }

    let refreshed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.sdk[method](body);
        return response.result;
      } catch (err) {
        const status = err.status;

        if (status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = parseFloat(err.headers?.get?.('Retry-After')) || 0;
          const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
          const baseWait = Math.max(retryAfter * 1000, exponentialDelay);
          const jitter = Math.random() * baseWait * 0.5;
          await this.sleepFn(baseWait + jitter);
          continue;
        }

        if (status === 429) {
          throw new Error(`Max retries exceeded for ${endpoint}`);
        }

        const errorBody = err.error;

        if (status === 409 && errorBody?.error_summary?.startsWith('in_progress')) {
          if (attempt < MAX_RETRIES) {
            const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
            const jitter = Math.random() * exponentialDelay * 0.5;
            await this.sleepFn(exponentialDelay + jitter);
            continue;
          }
          throw new Error(`Max retries exceeded for ${endpoint}`);
        }

        if (status === 401 && errorBody?.error_summary?.startsWith('expired_access_token')) {
          if (this.onTokenRefresh && !refreshed) {
            refreshed = true;
            try {
              await this.onTokenRefresh();
              attempt = -1; // will be incremented to 0 at loop top
              continue;
            } catch (refreshErr) {
              console.error('Token refresh failed:', refreshErr?.message || refreshErr);
              // Fall through to user-facing regeneration message below
            }
          }
          const url = `https://www.dropbox.com/developers/apps/info/${this.appKey}#settings:~:text=Generated%20access%20token`;
          throw new Error(
            `Your Dropbox access token has expired. Re-generate it here:\n${url}\nThen update your .env file with the new token.`
          );
        }

        throw new Error(`Dropbox API error ${status}: ${JSON.stringify(errorBody)}`);
      }
    }
  }
}