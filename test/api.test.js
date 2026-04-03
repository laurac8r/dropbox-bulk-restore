import { describe, test, expect, vi } from 'vitest';
import { dropboxFetch } from '../src/api.js';

describe('dropboxFetch', () => {
  test('makes a POST request with auth header and JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [] }),
    });

    const result = await dropboxFetch('/2/files/list_folder', {
      path: '/test',
    }, {
      token: 'test-token',
      fetchFn: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.dropboxapi.com/2/files/list_folder',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: '/test' }),
      }
    );
    expect(result).toEqual({ entries: [] });
  });

  test('retries on 429 with exponential backoff respecting Retry-After', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (h) => h === 'Retry-After' ? '2' : null },
        json: () => Promise.resolve({ error: 'too_many_requests' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

    const delays = [];
    const mockSleep = (ms) => { delays.push(ms); return Promise.resolve(); };

    const result = await dropboxFetch('/2/files/restore', {
      path: '/test.jpg', rev: 'abc',
    }, {
      token: 'test-token',
      fetchFn: mockFetch,
      sleepFn: mockSleep,
    });

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should wait at least 2s (Retry-After) — base delay 1s * 2^0 = 1s, but Retry-After=2 wins
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
  });

  test('applies jitter of 0-50% on top of backoff delay', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: () => Promise.resolve({ error: 'too_many_requests' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

    const delays = [];
    const mockSleep = (ms) => { delays.push(ms); return Promise.resolve(); };

    await dropboxFetch('/2/files/restore', { path: '/test.jpg', rev: 'abc' }, {
      token: 'test-token',
      fetchFn: mockFetch,
      sleepFn: mockSleep,
    });

    // Base delay = 1000ms * 2^0 = 1000ms, jitter adds 0-50%, so range is [1000, 1500]
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(1500);
  });

  test('throws after max retries (5) on persistent 429', async () => {
    const make429 = () => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: 'too_many_requests' }),
    });
    const mockFetch = vi.fn()
      .mockResolvedValue(make429());

    const mockSleep = () => Promise.resolve();

    await expect(
      dropboxFetch('/2/files/restore', { path: '/test.jpg', rev: 'abc' }, {
        token: 'test-token',
        fetchFn: mockFetch,
        sleepFn: mockSleep,
      })
    ).rejects.toThrow('Max retries exceeded');

    // 1 initial + 5 retries = 6 total calls
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test('retries on 409 in_progress with exponential backoff', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          error_summary: 'in_progress/.',
          error: { '.tag': 'in_progress' },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          error_summary: 'in_progress/..',
          error: { '.tag': 'in_progress' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: 'photo.jpg' }),
      });

    const delays = [];
    const mockSleep = (ms) => { delays.push(ms); return Promise.resolve(); };

    const result = await dropboxFetch('/2/files/restore', {
      path: '/pics/photo.jpg', rev: 'abc',
    }, {
      token: 'test-token',
      fetchFn: mockFetch,
      sleepFn: mockSleep,
    });

    expect(result).toEqual({ name: 'photo.jpg' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
    // First retry: base 1000ms * 2^0 = 1000ms + jitter
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    // Second retry: base 1000ms * 2^1 = 2000ms + jitter
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
  });

  test('throws after max retries on persistent in_progress', async () => {
    const makeInProgress = () => ({
      ok: false,
      status: 409,
      json: () => Promise.resolve({
        error_summary: 'in_progress/.',
        error: { '.tag': 'in_progress' },
      }),
    });
    const mockFetch = vi.fn().mockResolvedValue(makeInProgress());
    const mockSleep = () => Promise.resolve();

    await expect(
      dropboxFetch('/2/files/restore', { path: '/test.jpg', rev: 'abc' }, {
        token: 'test-token',
        fetchFn: mockFetch,
        sleepFn: mockSleep,
      })
    ).rejects.toThrow('Max retries exceeded');

    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test('throws immediately on non-retryable 409 error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({
        error_summary: 'path/not_found',
        error: { '.tag': 'path', path: { '.tag': 'not_found' } },
      }),
    });

    await expect(
      dropboxFetch('/2/files/restore', { path: '/nope', rev: 'abc' }, {
        token: 'test-token',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('409');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('throws user-friendly error with regeneration link on 401 expired token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({
        error: { '.tag': 'expired_access_token' },
        error_summary: 'expired_access_token/',
      }),
    });

    const error = await dropboxFetch('/2/files/list_folder', { path: '/pics' }, {
      token: 'expired-token',
      appKey: 'test-app-key',
      fetchFn: mockFetch,
    }).catch((e) => e);

    expect(error.message).toContain('expired');
    expect(error.message).toContain('https://www.dropbox.com/developers/apps/info/test-app-key');
    expect(error.message).toContain('#settings:~:text=Generated%20access%20token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});