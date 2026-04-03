import { describe, test, expect, vi } from 'vitest';
import { discoverDeleted, discoverDeletedPage } from '../src/discover.js';

describe('discoverDeleted', () => {
  test('collects DeletedMetadata entries from list_folder', async () => {
    const mockApi = vi.fn().mockResolvedValue({
      entries: [
        { '.tag': 'file', name: 'alive.jpg', path_display: '/pics/alive.jpg' },
        { '.tag': 'deleted', name: 'gone.jpg', path_display: '/pics/gone.jpg' },
        { '.tag': 'deleted', name: 'also-gone.png', path_display: '/pics/also-gone.png' },
      ],
      has_more: false,
    });

    const result = await discoverDeleted('/pics', mockApi);

    expect(result).toEqual([
      { name: 'gone.jpg', path: '/pics/gone.jpg' },
      { name: 'also-gone.png', path: '/pics/also-gone.png' },
    ]);
    expect(mockApi).toHaveBeenCalledWith('/2/files/list_folder', {
      path: '/pics',
      include_deleted: true,
      recursive: true,
    });
  });

  test('paginates using cursor when has_more is true', async () => {
    const mockApi = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
        ],
        has_more: true,
        cursor: 'cursor-page-2',
      })
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
        ],
        has_more: false,
      });

    const result = await discoverDeleted('/pics', mockApi);

    expect(result).toEqual([
      { name: 'a.jpg', path: '/pics/a.jpg' },
      { name: 'b.jpg', path: '/pics/b.jpg' },
    ]);
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi).toHaveBeenCalledWith('/2/files/list_folder/continue', {
      cursor: 'cursor-page-2',
    });
  });

  test('returns empty array when no deleted files found', async () => {
    const mockApi = vi.fn().mockResolvedValue({
      entries: [
        { '.tag': 'file', name: 'alive.jpg', path_display: '/pics/alive.jpg' },
      ],
      has_more: false,
    });

    const result = await discoverDeleted('/pics', mockApi);

    expect(result).toEqual([]);
  });

  test('stops discovery early when limit is reached', async () => {
    const mockApi = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
          { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
        ],
        has_more: true,
        cursor: 'c2',
      })
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'c.jpg', path_display: '/pics/c.jpg' },
          { '.tag': 'deleted', name: 'd.jpg', path_display: '/pics/d.jpg' },
        ],
        has_more: true,
        cursor: 'c3',
      })
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'e.jpg', path_display: '/pics/e.jpg' },
        ],
        has_more: false,
      });

    const result = await discoverDeleted('/pics', mockApi, { limit: 3 });

    expect(result).toHaveLength(3);
    // Should not fetch page 3 — already have enough after page 2
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  test('limit truncates within first page and skips pagination', async () => {
    const mockApi = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
          { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
          { '.tag': 'deleted', name: 'c.jpg', path_display: '/pics/c.jpg' },
        ],
        has_more: true,
        cursor: 'c2',
      })
      .mockImplementation(() => {
        throw new Error('Should not fetch page 2');
      });

    const result = await discoverDeleted('/pics', mockApi, { limit: 2 });

    expect(result).toHaveLength(2);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  describe('discoverDeletedPage', () => {
    test('fetches first page with path when no cursor given', async () => {
      const mockApi = vi.fn().mockResolvedValue({
        entries: [
          { '.tag': 'file', name: 'alive.jpg', path_display: '/pics/alive.jpg' },
          { '.tag': 'deleted', name: 'gone.jpg', path_display: '/pics/gone.jpg' },
        ],
        has_more: true,
        cursor: 'cursor-1',
      });

      const result = await discoverDeletedPage('/pics', mockApi);

      expect(result.deleted).toEqual([
        { name: 'gone.jpg', path: '/pics/gone.jpg' },
      ]);
      expect(result.cursor).toBe('cursor-1');
      expect(result.hasMore).toBe(true);
      expect(mockApi).toHaveBeenCalledWith('/2/files/list_folder', {
        path: '/pics',
        include_deleted: true,
        recursive: true,
      });
    });

    test('falls back to parent and returns filterPrefix when path is not_found', async () => {
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
            has_more: true,
            cursor: 'cursor-parent',
          });
        }
      });

      const result = await discoverDeletedPage('/pics/album', mockApi);

      expect(result.deleted).toEqual([
        { name: 'a.jpg', path: '/pics/album/a.jpg' },
      ]);
      expect(result.cursor).toBe('cursor-parent');
      expect(result.hasMore).toBe(true);
      expect(result.filterPrefix).toBe('/pics/album');
    });

    test('filters continued pages when filterPrefix is provided', async () => {
      const mockApi = vi.fn().mockResolvedValue({
        entries: [
          { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/album/b.jpg' },
          { '.tag': 'deleted', name: 'unrelated.jpg', path_display: '/pics/unrelated.jpg' },
          { '.tag': 'file', name: 'alive.jpg', path_display: '/pics/album/alive.jpg' },
        ],
        has_more: false,
      });

      const result = await discoverDeletedPage('/pics/album', mockApi, {
        cursor: 'cursor-parent',
        filterPrefix: '/pics/album',
      });

      expect(result.deleted).toEqual([
        { name: 'b.jpg', path: '/pics/album/b.jpg' },
      ]);
      expect(result.filterPrefix).toBe('/pics/album');
    });

    test('continues from cursor when provided', async () => {
      const mockApi = vi.fn().mockResolvedValue({
        entries: [
          { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
        ],
        has_more: false,
      });

      const result = await discoverDeletedPage('/pics', mockApi, { cursor: 'cursor-1' });

      expect(result.deleted).toEqual([
        { name: 'b.jpg', path: '/pics/b.jpg' },
      ]);
      expect(result.hasMore).toBe(false);
      expect(mockApi).toHaveBeenCalledWith('/2/files/list_folder/continue', {
        cursor: 'cursor-1',
      });
    });
  });

  test('falls back to parent directory when target path is not_found (deleted dir)', async () => {
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder' && body.path === '/pics/album') {
        return Promise.reject(new Error('Dropbox API error 409: path/not_found'));
      }
      if (endpoint === '/2/files/list_folder' && body.path === '/pics') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/album/a.jpg' },
            { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/album/b.jpg' },
            { '.tag': 'deleted', name: 'other.jpg', path_display: '/pics/other.jpg' },
            { '.tag': 'file', name: 'alive.jpg', path_display: '/pics/alive.jpg' },
          ],
          has_more: false,
        });
      }
    });

    const result = await discoverDeleted('/pics/album', mockApi);

    expect(result).toEqual([
      { name: 'a.jpg', path: '/pics/album/a.jpg' },
      { name: 'b.jpg', path: '/pics/album/b.jpg' },
    ]);
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  test('falls back to parent and still paginates', async () => {
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (endpoint === '/2/files/list_folder' && body?.path === '/pics/album') {
        return Promise.reject(new Error('Dropbox API error 409: path/not_found'));
      }
      if (endpoint === '/2/files/list_folder' && body?.path === '/pics') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/album/a.jpg' },
          ],
          has_more: true,
          cursor: 'c2',
        });
      }
      if (endpoint === '/2/files/list_folder/continue') {
        return Promise.resolve({
          entries: [
            { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/album/b.jpg' },
            { '.tag': 'deleted', name: 'unrelated.jpg', path_display: '/pics/unrelated.jpg' },
          ],
          has_more: false,
        });
      }
    });

    const result = await discoverDeleted('/pics/album', mockApi);

    expect(result).toEqual([
      { name: 'a.jpg', path: '/pics/album/a.jpg' },
      { name: 'b.jpg', path: '/pics/album/b.jpg' },
    ]);
  });

  test('calls onProgress with count and page after each page', async () => {
    const mockApi = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'a.jpg', path_display: '/pics/a.jpg' },
          { '.tag': 'file', name: 'live.jpg', path_display: '/pics/live.jpg' },
        ],
        has_more: true,
        cursor: 'c2',
      })
      .mockResolvedValueOnce({
        entries: [
          { '.tag': 'deleted', name: 'b.jpg', path_display: '/pics/b.jpg' },
          { '.tag': 'deleted', name: 'c.jpg', path_display: '/pics/c.jpg' },
        ],
        has_more: false,
      });

    const progress = [];
    await discoverDeleted('/pics', mockApi, {
      onProgress: (found, page) => progress.push({ found, page }),
    });

    expect(progress).toEqual([
      { found: 1, page: 1 },
      { found: 3, page: 2 },
    ]);
  });
});