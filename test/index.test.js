import { describe, test, expect, vi } from 'vitest';
import { run } from '../src/index.js';
import { SPINNER_FRAMES } from '../src/spinner.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('run (orchestrator)', () => {
  test('executes discover → resolve → restore pipeline', async () => {
    const callLog = [];

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      callLog.push(endpoint);

      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'photo.jpg', path_display: '/pics/photo.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({
          entries: [{ rev: 'rev-123' }],
        });
      }
      if (endpoint === '/2/files/restore') {
        return Promise.resolve({ name: 'photo.jpg' });
      }
    });

    const promptFn = vi.fn().mockResolvedValue('a');
    const logFn = vi.fn();

    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn,
      logFn,
      progressDir: null,
      writeFn: vi.fn(),
    });

    expect(callLog).toEqual([
      '/2/files/list_folder',
      '/2/files/list_revisions',
      '/2/files/restore',
    ]);
    expect(result.discovered).toBe(1);
    expect(result.restored).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  test('prioritizes failed files from previous run', async () => {
    const restoreCalls = [];

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'new.jpg', path_display: '/pics/new.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({
          entries: [{ rev: 'rev-new' }],
        });
      }
      if (endpoint === '/2/files/restore') {
        restoreCalls.push(body.path);
        return Promise.resolve({ name: 'ok' });
      }
    });

    const promptFn = vi.fn().mockResolvedValue('a');

    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn,
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
      previousErrors: [
        { path: '/pics/retry-me.jpg', rev: 'rev-retry', error: 'timeout' },
      ],
    });

    // retry-me.jpg should be restored first, then new.jpg
    expect(restoreCalls[0]).toBe('/pics/retry-me.jpg');
    expect(restoreCalls[1]).toBe('/pics/new.jpg');
    expect(result.restored).toBe(2);
  });

  test('limit caps the number of files restored', async () => {
    const restoreCalls = [];

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
            { '.tag': 'deleted', name: 'c.jpg', path_display: '/pics/c.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({ entries: [{ rev: 'r1' }] });
      }
      if (endpoint === '/2/files/restore') {
        restoreCalls.push(body.path);
        return Promise.resolve({ name: 'ok' });
      }
    });

    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
      limit: 2,
    });

    expect(restoreCalls).toHaveLength(2);
    expect(result.discovered).toBe(3);
    expect(result.restored).toBe(2);
  });

  test('resolved file listing hidden at INFO, shown at DEBUG', async () => {
    const mockApi = vi.fn().mockImplementation((endpoint) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'photo.jpg', path_display: '/pics/photo.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({ entries: [{ rev: 'abc123' }] });
      }
      if (endpoint === '/2/files/restore') {
        return Promise.resolve({ name: 'photo.jpg' });
      }
    });

    // At INFO: no individual file paths in output
    const infoLog = vi.fn();
    await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: infoLog,
      writeFn: vi.fn(),
      progressDir: null,
    });
    const infoLogs = infoLog.mock.calls.map(c => c[0]);
    expect(infoLogs.some(m => m.includes('/pics/photo.jpg') && m.includes('abc123'))).toBe(false);

    // At DEBUG: file paths shown
    const debugLog = vi.fn();
    await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: debugLog,
      writeFn: vi.fn(),
      progressDir: null,
      logLevel: 'DEBUG',
    });
    const debugLogs = debugLog.mock.calls.map(c => c[0]);
    expect(debugLogs.some(m => m.includes('/pics/photo.jpg') && m.includes('abc123'))).toBe(true);
  });

  test('summarizes errors by category instead of listing each one', async () => {
    let resolveCallCount = 0;
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
            { '.tag': 'deleted', name: 'c.jpg', path_display: '/pics/c.jpg' },
            { '.tag': 'deleted', name: 'PHOTOS', path_display: '/pics/PHOTOS' },
            { '.tag': 'deleted', name: 'ok.jpg', path_display: '/pics/ok.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        resolveCallCount++;
        // Two expired files
        if (body.path === '/pics/a.jpg' || body.path === '/pics/b.jpg') {
          return Promise.resolve({
            entries: [{ rev: 'r1' }],
            is_deleted: true,
            server_deleted: '2025-01-01T00:00:00Z',
          });
        }
        // One directory (not_file)
        if (body.path === '/pics/PHOTOS') {
          return Promise.reject(new Error('Dropbox API error 409: path/not_file'));
        }
        // One restore failure
        if (body.path === '/pics/c.jpg') {
          return Promise.resolve({
            entries: [{ rev: 'r2' }],
            is_deleted: true,
            server_deleted: '2026-03-25T00:00:00Z',
          });
        }
        // One success
        return Promise.resolve({
          entries: [{ rev: 'r3' }],
          is_deleted: true,
          server_deleted: '2026-03-25T00:00:00Z',
        });
      }
      if (endpoint === '/2/files/restore') {
        if (body.path === '/pics/c.jpg') {
          return Promise.reject(new Error('Some restore error'));
        }
        return Promise.resolve({ name: 'ok' });
      }
    });

    const logFn = vi.fn();
    await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn,
      writeFn: vi.fn(),
      progressDir: null,
      retentionDays: 180,
    });

    const allLogs = logFn.mock.calls.map(c => c[0]);
    // Retention errors should be summarized as a count
    expect(allLogs.some(m => /2.*expired/i.test(m) || /2.*retention/i.test(m))).toBe(true);
    // Should NOT list each expired file individually
    expect(allLogs.filter(m => m.includes('/pics/a.jpg')).length).toBe(0);
    expect(allLogs.filter(m => m.includes('/pics/b.jpg')).length).toBe(0);
    // Actual restore errors should still be shown individually
    expect(allLogs.some(m => m.includes('/pics/c.jpg') && m.includes('Some restore error'))).toBe(true);
  });

  test('keeps discovering pages until limit restorable files found', async () => {
    const expiredDate = '2025-01-03T00:00:00Z'; // ~452 days ago from 2026-03-30
    const recentDate = '2026-03-20T00:00:00Z';  // 10 days ago
    const restoreCalls = [];

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      // Page 1: one expired file
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'old.jpg', path_display: '/pics/old.jpg' },
          ],
          has_more: true,
          cursor: 'cursor-2',
        });
      }
      // Page 2: one recent file
      if (endpoint === '/2/files/list_folder/continue') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'recent.jpg', path_display: '/pics/recent.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        if (body.path === '/pics/old.jpg') {
          return Promise.resolve({
            entries: [{ rev: 'rev-old' }],
            is_deleted: true,
            server_deleted: expiredDate,
          });
        }
        return Promise.resolve({
          entries: [{ rev: 'rev-recent' }],
          is_deleted: true,
          server_deleted: recentDate,
        });
      }
      if (endpoint === '/2/files/restore') {
        restoreCalls.push(body.path);
        return Promise.resolve({ name: 'ok' });
      }
    });

    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
      limit: 1,
      retentionDays: 180,
    });

    // Should have discovered page 2 to find a restorable file
    expect(restoreCalls).toEqual(['/pics/recent.jpg']);
    expect(result.restored).toBe(1);
  });

  test('previousErrors with permanent failures are not retried', async () => {
    const restoreCalls = [];
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'new.jpg', path_display: '/pics/new.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({
          entries: [{ rev: 'rev-new' }],
          is_deleted: true,
          server_deleted: '2026-03-20T00:00:00Z',
        });
      }
      if (endpoint === '/2/files/restore') {
        restoreCalls.push(body.path);
        return Promise.resolve({ name: 'ok' });
      }
    });

    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
      limit: 1,
      previousErrors: [
        { path: '/pics/expired.jpg', rev: 'rev-expired', error: 'Past retention window (deleted 452 days ago, limit 180 days)' },
        { path: '/pics/invalid.jpg', rev: 'rev-invalid', error: 'Dropbox API error 409: invalid_revision' },
        { path: '/pics/transient.jpg', rev: 'rev-transient', error: 'Max retries exceeded' },
      ],
    });

    // Only transient failure should be retried, not permanent ones
    expect(restoreCalls).toContain('/pics/transient.jpg');
    expect(restoreCalls).not.toContain('/pics/expired.jpg');
    expect(restoreCalls).not.toContain('/pics/invalid.jpg');
  });

  test('autoApprove skips all confirmation prompts', async () => {
    const mockApi = vi.fn().mockImplementation((endpoint) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/sub/b.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({ entries: [{ rev: 'r1' }] });
      }
      if (endpoint === '/2/files/restore') {
        return Promise.resolve({ name: 'ok' });
      }
    });

    const promptFn = vi.fn();
    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn,
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
      autoApprove: true,
    });

    expect(promptFn).not.toHaveBeenCalled();
    expect(result.restored).toBe(2);
  });

  describe('logLevel', () => {
    function makeApi() {
      return vi.fn().mockImplementation((endpoint) => {
        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({
            entries: [{ rev: 'r1' }],
            is_deleted: true,
            server_deleted: '2026-03-20T00:00:00Z',
          });
        }
        if (endpoint === '/2/files/restore') {
          return Promise.resolve({ name: 'a.jpg' });
        }
      });
    }

    function baseOpts(mockApi, logFn) {
      return {
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn: vi.fn().mockResolvedValue('a'),
        logFn,
        writeFn: vi.fn(),
        progressDir: null,
      };
    }

    test('default logLevel is INFO — no DEBUG messages', async () => {
      const logFn = vi.fn();
      await run({ ...baseOpts(makeApi(), logFn) });
      const logs = logFn.mock.calls.map(c => c[0]);
      expect(logs.some(m => m.includes('DEBUG'))).toBe(false);
      expect(logs.some(m => m.includes('Discovering'))).toBe(true);
    });

    test('logLevel DEBUG includes raw API responses', async () => {
      const logFn = vi.fn();
      await run({ ...baseOpts(makeApi(), logFn), logLevel: 'DEBUG' });
      const logs = logFn.mock.calls.map(c => c[0]);
      expect(logs.some(m => m.includes('DEBUG') && m.includes('list_revisions'))).toBe(true);
    });

    test('logLevel WARNING suppresses INFO messages', async () => {
      const logFn = vi.fn();
      await run({ ...baseOpts(makeApi(), logFn), logLevel: 'WARNING' });
      const logs = logFn.mock.calls.map(c => c[0]);
      // Should not see phase progress
      expect(logs.some(m => m.includes('Discovering'))).toBe(false);
      expect(logs.some(m => m.includes('Resolving'))).toBe(false);
      // Summary line should still appear
      expect(logs.some(m => m.includes('Restored'))).toBe(true);
    });
  });

  test('discovers files when target path itself is deleted (path/not_found fallback)', async () => {
    const restoreCalls = [];

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder' && body.path === '/pics/album') {
        return Promise.reject(new Error('Dropbox API error 409: path/not_found'));
      }
      if (endpoint === '/2/files/list_folder' && body.path === '/pics') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/album/a.jpg' },
            { '.tag': 'deleted', name: 'other.jpg', path_display: '/pics/other.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({ entries: [{ rev: 'rev-1' }] });
      }
      if (endpoint === '/2/files/restore') {
        restoreCalls.push(body.path);
        return Promise.resolve({ name: 'ok' });
      }
    });

    const result = await run({
      path: '/pics/album',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
    });

    expect(result.discovered).toBe(1);
    expect(restoreCalls).toEqual(['/pics/album/a.jpg']);
    expect(result.restored).toBe(1);
  });

  describe('per-page streaming restore (phase 2)', () => {
    test('restores files after each discovery page, not all at end', async () => {
      const callLog = [];

      const mockApi = vi.fn().mockImplementation((endpoint, body) => {
        callLog.push(endpoint);

        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            ],
            has_more: true,
            cursor: 'cursor-2',
          });
        }
        if (endpoint === '/2/files/list_folder/continue') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({ entries: [{ rev: 'r1' }] });
        }
        if (endpoint === '/2/files/restore') {
          return Promise.resolve({ name: 'ok' });
        }
      });

      await run({
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn: vi.fn().mockResolvedValue('a'),
        logFn: vi.fn(),
        writeFn: vi.fn(),
        progressDir: null,
      });

      // Restore should interleave with discovery, not come all at the end
      // Pattern: list_folder, list_revisions, restore, list_folder/continue, list_revisions, restore
      const restoreIndices = callLog
        .map((c, i) => c === '/2/files/restore' ? i : -1)
        .filter(i => i >= 0);
      const continueIndex = callLog.indexOf('/2/files/list_folder/continue');

      // First restore should happen BEFORE the continue call
      expect(restoreIndices[0]).toBeLessThan(continueIndex);
    });

    test('directory confirmation persists across pages', async () => {
      const promptFn = vi.fn().mockResolvedValue('a');

      const mockApi = vi.fn().mockImplementation((endpoint, body) => {
        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            ],
            has_more: true,
            cursor: 'cursor-2',
          });
        }
        if (endpoint === '/2/files/list_folder/continue') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/sub/b.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({ entries: [{ rev: 'r1' }] });
        }
        if (endpoint === '/2/files/restore') {
          return Promise.resolve({ name: 'ok' });
        }
      });

      const result = await run({
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn,
        logFn: vi.fn(),
        writeFn: vi.fn(),
        progressDir: null,
      });

      // User answers "a" for /pics on page 1 → /pics/sub on page 2 auto-approved
      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(result.restored).toBe(2);
    });

    test('limit stops pipeline after N successful restores across pages', async () => {
      const restoreCalls = [];

      const mockApi = vi.fn().mockImplementation((endpoint, body) => {
        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            ],
            has_more: true,
            cursor: 'cursor-2',
          });
        }
        if (endpoint === '/2/files/list_folder/continue') {
          // This page should never be reached if limit=1 stops after page 1
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({ entries: [{ rev: 'r1' }] });
        }
        if (endpoint === '/2/files/restore') {
          restoreCalls.push(body.path);
          return Promise.resolve({ name: 'ok' });
        }
      });

      const result = await run({
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn: vi.fn().mockResolvedValue('a'),
        logFn: vi.fn(),
        writeFn: vi.fn(),
        progressDir: null,
        limit: 1,
      });

      expect(restoreCalls).toEqual(['/pics/a.jpg']);
      expect(result.restored).toBe(1);
    });

    test('error retries use shared confirmedDirs with page loop', async () => {
      const promptFn = vi.fn().mockResolvedValue('a');

      const mockApi = vi.fn().mockImplementation((endpoint, body) => {
        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'new.jpg', path_display: '/pics/sub/new.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({ entries: [{ rev: 'r1' }] });
        }
        if (endpoint === '/2/files/restore') {
          return Promise.resolve({ name: 'ok' });
        }
      });

      const result = await run({
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn,
        logFn: vi.fn(),
        writeFn: vi.fn(),
        progressDir: null,
        previousErrors: [
          { path: '/pics/retry.jpg', rev: 'rev-retry', error: 'timeout' },
        ],
      });

      // User prompted for /pics (retry file), then /pics/sub auto-approved via "a"
      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(result.restored).toBe(2);
    });

    test('scan and restore progress lines do not collide on same terminal line', async () => {
      const writes = [];

      const mockApi = vi.fn().mockImplementation((endpoint, body) => {
        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            ],
            has_more: true,
            cursor: 'cursor-2',
          });
        }
        if (endpoint === '/2/files/list_folder/continue') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({ entries: [{ rev: 'r1' }] });
        }
        if (endpoint === '/2/files/restore') {
          return Promise.resolve({ name: 'ok' });
        }
      });

      await run({
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn: vi.fn().mockResolvedValue('a'),
        logFn: vi.fn(),
        writeFn: (s) => writes.push(s),
        progressDir: null,
      });

      // Find each \r-based write and check no restore line immediately follows
      // a scan line without a \n separator between them
      for (let i = 1; i < writes.length; i++) {
        const prev = writes[i - 1];
        const curr = writes[i];
        if (curr.includes('Restoring') && prev.includes('Scanning')) {
          // There must be a \n between a scan line and a restore line
          expect(prev).toContain('\n');
        }
      }

      // Additionally: no single write should contain both "Scanning" and "Restoring"
      for (const w of writes) {
        const hasBoth = w.includes('Scanning') && w.includes('Restoring');
        expect(hasBoth).toBe(false);
      }
    });

    test('progress lines include a spinner character', async () => {
      const writes = [];

      const mockApi = vi.fn().mockImplementation((endpoint) => {
        if (endpoint === '/2/files/list_folder') {
          return Promise.resolve({
            entries: [
              { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
            ],
            has_more: false,
          });
        }
        if (endpoint === '/2/files/list_revisions') {
          return Promise.resolve({ entries: [{ rev: 'r1' }] });
        }
        if (endpoint === '/2/files/restore') {
          return Promise.resolve({ name: 'ok' });
        }
      });

      await run({
        path: '/pics',
        token: 'test-token',
        apiFn: mockApi,
        promptFn: vi.fn().mockResolvedValue('a'),
        logFn: vi.fn(),
        writeFn: (s) => writes.push(s),
        progressDir: null,
      });

      const progressLines = writes.filter((w) => w.startsWith('\r'));
      expect(progressLines.length).toBeGreaterThan(0);

      // Every \r progress line should contain a spinner frame character
      for (const line of progressLines) {
        const hasSpinner = SPINNER_FRAMES.some((f) => line.includes(f));
        expect(hasSpinner, `Missing spinner in: ${line}`).toBe(true);
      }
    });
  });

  test('successful retries clear errors.json so they are not retried again', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-test-'));
    // Seed errors.json with entries that will succeed on retry
    fs.writeFileSync(
      path.join(tmpDir, 'errors.json'),
      JSON.stringify([
        { path: '/pics/retry.jpg', rev: 'rev-retry', error: 'in_progress' },
      ])
    );
    fs.writeFileSync(
      path.join(tmpDir, 'progress.json'),
      JSON.stringify({ completed: [] })
    );

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({ entries: [], has_more: false });
      }
      if (endpoint === '/2/files/restore') {
        return Promise.resolve({ name: 'ok' });
      }
    });

    await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: tmpDir,
    });

    // errors.json should be cleared after successful retry
    const errors = JSON.parse(fs.readFileSync(path.join(tmpDir, 'errors.json'), 'utf8'));
    expect(errors).toEqual([]);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('dry-run skips restore calls', async () => {
    const mockApi = vi.fn().mockImplementation((endpoint) => {
      if (endpoint === '/2/files/list_folder') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
          ],
          has_more: false,
        });
      }
      if (endpoint === '/2/files/list_revisions') {
        return Promise.resolve({ entries: [{ rev: 'r1' }] });
      }
      if (endpoint === '/2/files/restore') {
        throw new Error('Should not be called in dry-run');
      }
    });

    const result = await run({
      path: '/pics',
      token: 'test-token',
      apiFn: mockApi,
      promptFn: vi.fn().mockResolvedValue('a'),
      logFn: vi.fn(),
      writeFn: vi.fn(),
      progressDir: null,
      dryRun: true,
    });

    expect(result.dryRunCount).toBe(1);
    expect(result.restored).toBe(0);
  });
});
