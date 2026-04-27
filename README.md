# dropbox-restore

Bulk restore deleted files from Dropbox via the API. Scans a folder for deleted
entries, resolves their latest revisions, and restores them — with interactive
per-directory confirmation, automatic retry, and crash-resumable progress.

## Features

- **OAuth2 PKCE authentication** — browser-based login on first run, tokens
  cached and auto-refreshed
- **Resume & retry** — progress saved to disk; re-run to pick up where you left
  off and retry failures
- **Dry-run mode** — preview what would be restored without making changes
- **Concurrent operations** — parallel API calls for discovery, resolution, and
  restore (default: 4 workers)
- **Per-directory prompts** — approve, skip, or bulk-approve entire directory
  trees
- **Retention filtering** — skips files past Dropbox's retention window
  (default: 180 days)
- **Rate-limit backoff** — exponential backoff with jitter on 429s and transient
  errors

## Prerequisites

- Node.js 18+
- A Dropbox app registered at the
  [Dropbox App Console](https://www.dropbox.com/developers/apps)
   - Permissions needed: `files.metadata.read`, `files.content.write`

## Installation

```sh
git clone <repo-url> && cd dropbox-restore
npm install
```

## Setup

Copy the example env file and fill in your app key:

```sh
cp .env.example .env
```

```
DROPBOX_APP_KEY=your_app_key_here
```

Optionally set `DROPBOX_ACCESS_TOKEN` to skip the OAuth flow entirely (useful
for scripts/CI). Generate one at your app's page in the Dropbox App Console.

## Usage

```sh
node src/index.js --path /Photos --dry-run # preview what would be restored
node src/index.js --path /Photos # restore interactively
node src/index.js --path /Photos --yes # auto-approve all prompts
node src/index.js --path /Photos --limit 50 # restore at most 50 files
node src/index.js --path /Photos --log-level DEBUG # verbose output
```

### Options

| Flag                  | Description                                        |
| --------------------- | -------------------------------------------------- |
| `--path <path>`       | Dropbox folder path to scan (required)             |
| `--limit <n>`         | Maximum number of files to restore                 |
| `--dry-run`           | Show what would be restored without making changes |
| `--yes`, `-y`         | Auto-approve all confirmation prompts              |
| `--log-level <level>` | `DEBUG`, `INFO` (default), or `WARNING`            |
| `--help`, `-h`        | Show help message                                  |

### Authentication

On first run (without `DROPBOX_ACCESS_TOKEN`), the tool opens a browser for
OAuth2 authorization using PKCE. Tokens are cached in `.tokens.json` and
refreshed automatically on subsequent runs.

### Interactive prompts

When restoring, you are prompted once per directory:

- **y** — restore files in this directory only
- **n** — skip this directory
- **a** — restore this directory and all subdirectories without further prompts

### Resume

Re-run the same command to resume where you left off. Progress is tracked in
`progress.json` and previously failed files are retried first (permanent
failures like expired retention are skipped).

## Development

```sh
npm test # run tests (vitest)
npm run test:watch # watch mode
```

### Project structure

```
src/
  index.js      CLI entry point and orchestration
  auth.js       OAuth2 PKCE flow, token caching and refresh
  client.js     Dropbox SDK wrapper with retry/backoff
  discover.js   Enumerate deleted files (paginated)
  resolve.js    Fetch latest revision per file (concurrent)
  restore.js    Restore files grouped by directory (concurrent)
  progress.js   Crash-resumable progress tracking
  spinner.js    Terminal spinner
test/
  *.test.js     Unit tests (vitest)
```

## License

[MIT](LICENSE)
