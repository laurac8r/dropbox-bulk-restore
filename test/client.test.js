import { describe, expect, test, vi } from "vitest";
import { DropboxClient } from "../src/client.js";

function mockSdk(responses) {
  const calls = [];
  let callIndex = 0;

  const handler = {
    get(_, method) {
      return async (args) => {
        calls.push({ method, args });
        const response = responses[callIndex++];
        if (response instanceof Error) throw response;
        return { result: response };
      };
    },
  };

  return { sdk: new Proxy({}, handler), calls };
}

function sdkError(status, body) {
  const err = new Error(body?.error_summary || `HTTP ${status}`);
  err.status = status;
  err.error = body;
  err.headers = { get: () => null };
  return err;
}

function sdkError429(retryAfter = null) {
  const err = new Error("too_many_requests");
  err.status = 429;
  err.error = { error_summary: "too_many_requests/" };
  err.headers = { get: (h) => (h === "Retry-After" ? retryAfter : null) };
  return err;
}

describe("DropboxClient", () => {
  test("maps endpoint to SDK method name and passes body as args", async () => {
    const { sdk, calls } = mockSdk([{ entries: [] }]);
    const client = new DropboxClient({ sdk });

    const result = await client.call("/2/files/list_folder", {
      path: "/test",
      include_deleted: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("filesListFolder");
    expect(calls[0].args).toEqual({ path: "/test", include_deleted: true });
    expect(result).toEqual({ entries: [] });
  });

  test("maps all used endpoints correctly", async () => {
    const endpoints = [
      ["/2/files/list_folder", "filesListFolder"],
      ["/2/files/list_folder/continue", "filesListFolderContinue"],
      ["/2/files/list_revisions", "filesListRevisions"],
      ["/2/files/restore", "filesRestore"],
      ["/2/files/create_folder_v2", "filesCreateFolderV2"],
    ];

    for (const [endpoint, expectedMethod] of endpoints) {
      const { sdk, calls } = mockSdk([{ ok: true }]);
      const client = new DropboxClient({ sdk });
      await client.call(endpoint, {});
      expect(calls[0].method).toBe(expectedMethod);
    }
  });

  test("retries on 429 with exponential backoff respecting Retry-After", async () => {
    const { sdk, calls } = mockSdk([sdkError429("2"), { success: true }]);

    const delays = [];
    const sleepFn = (ms) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const client = new DropboxClient({ sdk, sleepFn });

    const result = await client.call("/2/files/restore", {
      path: "/test.jpg",
      rev: "abc",
    });

    expect(result).toEqual({ success: true });
    expect(calls).toHaveLength(2);
    // Should wait at least 2s (Retry-After=2 wins over base 1s*2^0=1s)
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
  });

  test("applies jitter of 0-50% on top of backoff delay", async () => {
    const { sdk } = mockSdk([sdkError429(), { success: true }]);

    const delays = [];
    const sleepFn = (ms) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const client = new DropboxClient({ sdk, sleepFn });

    await client.call("/2/files/restore", { path: "/test.jpg", rev: "abc" });

    // Base delay = 1000ms * 2^0 = 1000ms, jitter adds 0-50%, so range is [1000, 1500]
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(1500);
  });

  test("throws after max retries (5) on persistent 429", async () => {
    const errors = Array.from({ length: 6 }, () => sdkError429());
    const { sdk } = mockSdk(errors);

    const sleepFn = () => Promise.resolve();
    const client = new DropboxClient({ sdk, sleepFn });

    await expect(
      client.call("/2/files/restore", { path: "/test.jpg", rev: "abc" }),
    ).rejects.toThrow("Max retries exceeded");
  });

  test("retries on 409 in_progress with exponential backoff", async () => {
    const { sdk, calls } = mockSdk([
      sdkError(409, {
        error_summary: "in_progress/.",
        error: { ".tag": "in_progress" },
      }),
      sdkError(409, {
        error_summary: "in_progress/..",
        error: { ".tag": "in_progress" },
      }),
      { name: "photo.jpg" },
    ]);

    const delays = [];
    const sleepFn = (ms) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const client = new DropboxClient({ sdk, sleepFn });

    const result = await client.call("/2/files/restore", {
      path: "/pics/photo.jpg",
      rev: "abc",
    });

    expect(result).toEqual({ name: "photo.jpg" });
    expect(calls).toHaveLength(3);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
  });

  test("throws after max retries on persistent in_progress", async () => {
    const errors = Array.from({ length: 6 }, () =>
      sdkError(409, {
        error_summary: "in_progress/.",
        error: { ".tag": "in_progress" },
      }),
    );
    const { sdk } = mockSdk(errors);
    const sleepFn = () => Promise.resolve();
    const client = new DropboxClient({ sdk, sleepFn });

    await expect(
      client.call("/2/files/restore", { path: "/test.jpg", rev: "abc" }),
    ).rejects.toThrow("Max retries exceeded");
  });

  test("throws immediately on non-retryable 409 errors", async () => {
    const { sdk, calls } = mockSdk([
      sdkError(409, {
        error_summary: "path/not_found",
        error: { ".tag": "path", path: { ".tag": "not_found" } },
      }),
    ]);
    const client = new DropboxClient({ sdk });

    await expect(
      client.call("/2/files/restore", { path: "/nope", rev: "abc" }),
    ).rejects.toThrow("409");

    expect(calls).toHaveLength(1);
  });

  test("throws user-friendly error with regeneration link on 401 expired token", async () => {
    const { sdk } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
    ]);
    const client = new DropboxClient({ sdk, appKey: "test-app-key" });

    const error = await client
      .call("/2/files/list_folder", { path: "/pics" })
      .catch((e) => e);

    expect(error.message).toContain("expired");
    expect(error.message).toContain(
      "https://www.dropbox.com/developers/apps/info/test-app-key",
    );
    expect(error.message).toContain(
      "#settings:~:text=Generated%20access%20token",
    );
  });

  test("refreshes token and retries once on 401 expired_access_token", async () => {
    const { sdk, calls } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
      { name: "photo.jpg" },
    ]);
    const refreshCalls = [];
    const onTokenRefresh = async () => {
      refreshCalls.push(true);
    };

    const client = new DropboxClient({ sdk, onTokenRefresh });
    const result = await client.call("/2/files/restore", {
      path: "/pic.jpg",
      rev: "abc",
    });

    expect(result).toEqual({ name: "photo.jpg" });
    expect(calls).toHaveLength(2);
    expect(refreshCalls).toHaveLength(1);
  });

  test("throws on 401 when no onTokenRefresh provided (backward compat)", async () => {
    const { sdk } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
    ]);

    const client = new DropboxClient({ sdk, appKey: "test-key" });

    await expect(
      client.call("/2/files/list_folder", { path: "/pics" }),
    ).rejects.toThrow("expired");
  });

  test("throws on second 401 after refresh (prevents infinite loop)", async () => {
    const { sdk } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
    ]);

    const client = new DropboxClient({
      sdk,
      onTokenRefresh: async () => {},
    });

    await expect(
      client.call("/2/files/restore", { path: "/pic.jpg", rev: "abc" }),
    ).rejects.toThrow("expired");
  });

  test("second call() on same instance can trigger refresh again", async () => {
    const { sdk, calls } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
      { success: "first" },
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
      { success: "second" },
    ]);
    let refreshCount = 0;
    const client = new DropboxClient({
      sdk,
      onTokenRefresh: async () => {
        refreshCount++;
      },
    });

    const r1 = await client.call("/2/files/list_folder", { path: "/a" });
    const r2 = await client.call("/2/files/list_folder", { path: "/b" });

    expect(r1).toEqual({ success: "first" });
    expect(r2).toEqual({ success: "second" });
    expect(refreshCount).toBe(2);
    expect(calls).toHaveLength(4);
  });

  test("falls back to regeneration message when onTokenRefresh throws", async () => {
    const { sdk } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
    ]);

    const logFn = vi.fn();
    const client = new DropboxClient({
      sdk,
      appKey: "test-app-key",
      logFn,
      onTokenRefresh: async () => {
        throw new Error("No refresh token available");
      },
    });

    const error = await client
      .call("/2/files/list_folder", { path: "/pics" })
      .catch((e) => e);

    expect(error.message).toContain("expired");
    expect(error.message).toContain(
      "https://www.dropbox.com/developers/apps/info/test-app-key",
    );
    expect(error.message).not.toContain("No refresh token available");
  });

  test("calls injected logFn with refresh error when onTokenRefresh throws", async () => {
    const { sdk } = mockSdk([
      sdkError(401, {
        error: { ".tag": "expired_access_token" },
        error_summary: "expired_access_token/",
      }),
    ]);

    const logFn = vi.fn();
    const refreshError = new Error("No refresh token available");
    const client = new DropboxClient({
      sdk,
      appKey: "test-app-key",
      logFn,
      onTokenRefresh: async () => {
        throw refreshError;
      },
    });

    await client
      .call("/2/files/list_folder", { path: "/pics" })
      .catch(() => {});

    expect(logFn).toHaveBeenCalledOnce();
    expect(logFn).toHaveBeenCalledWith(
      "Token refresh failed:",
      refreshError.message,
    );
  });

  test("throws on unknown endpoint", async () => {
    const { sdk } = mockSdk([]);
    const client = new DropboxClient({ sdk });

    await expect(client.call("/2/files/unknown_endpoint", {})).rejects.toThrow(
      "Unknown endpoint",
    );
  });
});
