#!/usr/bin/env node

import {discoverDeletedPage} from './discover.js';
import {resolveRevisions} from './resolve.js';
import {restoreFiles} from './restore.js';
import {ProgressTracker} from './progress.js';
import {DropboxClient} from './client.js';
import {Spinner} from './spinner.js';

export async function run(options) {
    const {
        path,
        token,
        appKey,
        apiFn,
        promptFn,
        logFn = console.log,
        progressDir,
        previousErrors = [],
        dryRun = false,
        concurrency = 4,
        limit,
        retentionDays = 180,
        logLevel = 'INFO',
        autoApprove = false,
    } = options;

    const LOG_LEVELS = {DEBUG: 0, INFO: 1, WARNING: 2};
    const level = LOG_LEVELS[logLevel] ?? LOG_LEVELS.INFO;
    const debug = (...args) => level <= LOG_LEVELS.DEBUG && logFn(...args);
    const info = (...args) => level <= LOG_LEVELS.INFO && logFn(...args);
    const warn = (...args) => level <= LOG_LEVELS.WARNING && logFn(...args);

    let api = apiFn;
    if (!api) {
        const {Dropbox} = await import('dropbox');
        const {refreshToken, loadTokens, saveTokens} = await import('./auth.js');
        const sdk = new Dropbox({accessToken: token});
        const tokenDir = progressDir || '.';
        const client = new DropboxClient({
            sdk,
            appKey,
            onTokenRefresh: async () => {
                const cached = loadTokens(tokenDir);
                if (!cached?.refresh_token) throw new Error('No refresh token available');
                const refreshed = await refreshToken({
                    refreshTokenValue: cached.refresh_token,
                    appKey,
                });
                saveTokens(tokenDir, refreshed);
                sdk.setAccessToken(refreshed.access_token);
            },
        });
        api = (endpoint, body) => client.call(endpoint, body);
    }

    // Load progress tracker if persistence is enabled
    let tracker = null;
    let failedRetries = previousErrors;
    if (progressDir) {
        tracker = new ProgressTracker(progressDir);
        if (!previousErrors.length) {
            failedRetries = tracker.getFailedForRetry();
        }
    }

    const writeFn = options.writeFn || process.stdout.write.bind(process.stdout);
    const confirmedDirs = new Map();
    const PERMANENT_ERRORS = ['retention', 'invalid_revision', 'not_file'];

    // Shared accumulators across pages
    const allResolveErrors = [];
    const allRestoreErrors = [];
    let totalDiscovered = 0;
    let totalResolved = 0;
    let totalRestored = 0;
    let totalSkipped = 0;
    let totalDryRunCount = 0;
    let totalAttempted = 0;
    const spinner = new Spinner(writeFn);

    // Retry failed files from previous run first
    if (failedRetries.length > 0) {
        const retryable = failedRetries.filter(
            (e) => !PERMANENT_ERRORS.some((p) => e.error.toLowerCase().includes(p))
        );
        if (retryable.length < failedRetries.length) {
            info(`Skipping ${failedRetries.length - retryable.length} permanent failures from retry queue`);
        }
        if (retryable.length > 0) {
            const retryFiles = retryable.map((e) => ({
                name: e.path.split('/').pop(),
                path: e.path,
                rev: e.rev,
            }));
            info(`Retrying ${retryFiles.length} previously failed files...`);
            const retryResult = await restoreFiles(retryFiles, api, {
                promptFn,
                concurrency,
                dryRun,
                autoApprove,
                confirmedDirs,
            });
            totalRestored += retryResult.restored;
            totalSkipped += retryResult.skipped;
            totalDryRunCount += retryResult.dryRunCount;
            allRestoreErrors.push(...retryResult.errors);
            totalAttempted += retryFiles.length;

            if (tracker) {
                for (const file of retryFiles) {
                    if (!retryResult.errors.some((e) => e.path === file.path)) {
                        tracker.markCompleted(file.path);
                    }
                }
            }

            if (limit > 0 && totalRestored >= limit) {
                spinner.stop();
                writeFn('\n');
                return buildSummary();
            }
        }
    }

    // Per-page streaming: discover → resolve → restore per page
    info('Discovering deleted files...');
    let cursor = null;
    let hasMore = true;
    let page = 0;
    let filterPrefix = null;

    while (hasMore) {
        const pageResult = await discoverDeletedPage(path, api, {cursor, filterPrefix});
        cursor = pageResult.cursor;
        hasMore = pageResult.hasMore;
        if (pageResult.filterPrefix) filterPrefix = pageResult.filterPrefix;
        totalDiscovered += pageResult.deleted.length;
        page++;
        spinner.update(`Scanning page ${page}: ${totalDiscovered} found, ${totalResolved} restorable...`);

        if (pageResult.deleted.length > 0) {
            // Resolve revisions for this page
            const {resolved: pageResolved, errors: pageErrors} = await resolveRevisions(
                pageResult.deleted, api, {
                    concurrency,
                    retentionDays,
                    logFn: (path, response) => debug(`  DEBUG list_revisions ${path}: ${JSON.stringify(response)}`),
                }
            );
            totalResolved += pageResolved.length;
            allResolveErrors.push(...pageErrors);
            spinner.update(`Scanning page ${page}: ${totalDiscovered} found, ${totalResolved} restorable...`);

            for (const file of pageResolved) {
                debug(`  ${file.path} (rev: ${file.rev})`);
            }

            // Filter out already-completed files
            let toRestore = tracker ? tracker.filterUnprocessed(pageResolved) : pageResolved;

            // Apply remaining limit
            if (limit > 0) {
                const remaining = limit - totalRestored;
                if (toRestore.length > remaining) {
                    toRestore = toRestore.slice(0, remaining);
                }
            }

            if (toRestore.length > 0) {
                // End scanning line before starting restore progress
                spinner.stop();
                writeFn('\n');
                // Restore this page's files
                const pageResult = await restoreFiles(toRestore, api, {
                    promptFn,
                    concurrency,
                    dryRun,
                    autoApprove,
                    confirmedDirs,
                    onProgress: (completed, total) => {
                        spinner.update(`Restoring ${totalRestored + completed}/${totalAttempted + total}...`);
                    },
                });

                totalRestored += pageResult.restored;
                totalSkipped += pageResult.skipped;
                totalDryRunCount += pageResult.dryRunCount;
                allRestoreErrors.push(...pageResult.errors);
                totalAttempted += toRestore.length;

                // Track progress incrementally
                if (tracker) {
                    for (const file of toRestore) {
                        if (!pageResult.errors.some((e) => e.path === file.path)) {
                            tracker.markCompleted(file.path);
                        }
                    }
                }
            }
        }

        // Stop if limit reached
        if (limit > 0 && totalRestored >= limit) break;
    }
    spinner.stop();
    writeFn('\n');
    info(`Found ${totalDiscovered} deleted, ${totalResolved} restorable (${allResolveErrors.length} expired/skipped)`);

    function buildSummary() {
        return {
            discovered: totalDiscovered,
            resolved: totalResolved,
            restored: totalRestored,
            skipped: totalSkipped,
            errors: [...allResolveErrors, ...allRestoreErrors],
            dryRunCount: totalDryRunCount,
        };
    }

    const summary = buildSummary();

    const retention = [];
    const notFile = [];
    const restoreErrors = [];
    for (const err of summary.errors) {
        const msg = err.error.toLowerCase();
        if (msg.includes('retention')) retention.push(err);
        else if (msg.includes('not_file')) notFile.push(err);
        else restoreErrors.push(err);
    }
    if (retention.length > 0) warn(`Skipped ${retention.length} expired files (past ${retentionDays}-day retention)`);
    if (notFile.length > 0) warn(`Skipped ${notFile.length} deleted directories`);
    for (const err of restoreErrors) {
        warn(`  ERROR: ${err.path} — ${err.error}`);
    }
    warn(`Restored ${totalRestored}/${totalAttempted} files, ${restoreErrors.length} errors`);

    // Always save errors (even empty) to clear stale entries from previous runs
    if (tracker) {
        tracker.saveErrors(allRestoreErrors);
    }

    return summary;
}

// CLI entry point
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
        console.log(`dropbox-restore — Bulk restore deleted files from Dropbox

Usage:
  node src/index.js [options]

Options:
  --path <path>   Dropbox folder path to scan (default: /AREAS/MEDIA/PICTURES)
  --limit <n>     Maximum number of files to restore (optional)
  --dry-run       Show what would be restored without making changes
  --yes, -y       Auto-approve all confirmation prompts (default: false)
  --log-level <l> Logging verbosity: DEBUG, INFO (default), WARNING
  --help, -h      Show this help message

Environment:
  DROPBOX_APP_KEY        Required. Your Dropbox app key from the App Console.
  DROPBOX_ACCESS_TOKEN   Optional. If set, skips OAuth and uses this token directly.
                         Generate at https://www.dropbox.com/developers/apps

Authentication:
  On first run (without DROPBOX_ACCESS_TOKEN), opens a browser for OAuth2
  authorization. Tokens are cached in .tokens.json and refreshed automatically.

Confirmation prompts:
  y   Restore files in this directory only
  n   Skip this directory
  a   Restore this directory and all subdirectories without further prompts

Resume:
  Re-run the script to resume where you left off. Previously failed files
  are retried first.`);
        process.exit(0);
    }

    const knownFlags = new Set(['--path', '--limit', '--dry-run', '--yes', '-y', '--log-level', '--help', '-h', 'help']);
    for (const arg of args) {
        if (arg.startsWith('-') && !knownFlags.has(arg)) {
            console.error(`Unknown argument: ${arg}\nRun with --help for usage.`);
            process.exit(1);
        }
    }

    const pathFlag = args.indexOf('--path');
    const targetPath = pathFlag !== -1 ? args[pathFlag + 1] : '/AREAS/MEDIA/PICTURES';
    const limitFlag = args.indexOf('--limit');
    const limit = limitFlag !== -1 ? parseInt(args[limitFlag + 1], 10) : undefined;
    const dryRun = args.includes('--dry-run');
    const autoApprove = args.includes('--yes') || args.includes('-y');
    const logLevelFlag = args.indexOf('--log-level');
    const logLevel = logLevelFlag !== -1 ? args[logLevelFlag + 1].toUpperCase() : 'INFO';

    const {config} = await import('dotenv');
    config();

    const appKey = process.env.DROPBOX_APP_KEY;
    if (!appKey) {
        console.error('Error: DROPBOX_APP_KEY not set. Add it to your .env file.');
        process.exit(1);
    }

    const {getToken} = await import('./auth.js');
    const cwd = new URL('.', import.meta.url).pathname;
    const token = await getToken({
        dir: cwd,
        envToken: process.env.DROPBOX_ACCESS_TOKEN,
        appKey,
    });

    const readline = await import('readline');
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const promptFn = (directory, files) => {
        const sample = files.slice(0, 3).map((f) => f.name).join(', ');
        const more = files.length > 3 ? ` (+${files.length - 3} more)` : '';
        return new Promise((resolve) => {
            rl.question(
                `\nRestore ${files.length} files in ${directory}?\n  sample: ${sample}${more}\n[y]es / [n]o / [a]ll (include subdirectories): `,
                (answer) => resolve(answer.trim().toLowerCase())
            );
        });
    };

    try {
        await run({
            path: targetPath,
            token,
            appKey,
            promptFn,
            progressDir: cwd,
            dryRun,
            autoApprove,
            limit,
            logLevel,
        });
    } finally {
        rl.close();
    }
}

// Only run CLI when executed directly
const isMain = process.argv[1] && (
    process.argv[1].endsWith('/index.js') ||
    process.argv[1].endsWith('/dropbox-restore')
);
if (isMain) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
