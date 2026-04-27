import { describe, expect, test, vi } from "vitest";
import { resolveRevisions } from "../src/resolve.js";

describe("resolveRevisions", () => {
  test("gets revision for each deleted file via list_revisions", async () => {
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (body.path === "/pics/a.jpg") {
        return Promise.resolve({
          entries: [{ rev: "rev-a", name: "a.jpg" }],
        });
      }
      if (body.path === "/pics/b.jpg") {
        return Promise.resolve({
          entries: [{ rev: "rev-b", name: "b.jpg" }],
        });
      }
    });

    const deleted = [
      { name: "a.jpg", path: "/pics/a.jpg" },
      { name: "b.jpg", path: "/pics/b.jpg" },
    ];

    const result = await resolveRevisions(deleted, mockApi);

    expect(result.resolved).toEqual([
      { name: "a.jpg", path: "/pics/a.jpg", rev: "rev-a" },
      { name: "b.jpg", path: "/pics/b.jpg", rev: "rev-b" },
    ]);
    expect(result.errors).toEqual([]);
    expect(mockApi).toHaveBeenCalledWith("/2/files/list_revisions", {
      path: "/pics/a.jpg",
      limit: 1,
    });
  });

  test("limits concurrency to specified workers", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const mockApi = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      return { entries: [{ rev: "rev-x" }] };
    });

    const deleted = Array.from({ length: 10 }, (_, i) => ({
      name: `${i}.jpg`,
      path: `/pics/${i}.jpg`,
    }));

    await resolveRevisions(deleted, mockApi, { concurrency: 3 });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(mockApi).toHaveBeenCalledTimes(10);
  });

  test("calls logFn with raw response when provided", async () => {
    const mockApi = vi.fn().mockResolvedValue({
      entries: [{ rev: "rev-a", name: "a.jpg", server_modified: "2025-01-01" }],
      is_deleted: true,
    });

    const logFn = vi.fn();
    await resolveRevisions([{ name: "a.jpg", path: "/pics/a.jpg" }], mockApi, {
      logFn,
    });

    expect(logFn).toHaveBeenCalledWith(
      "/pics/a.jpg",
      expect.objectContaining({ is_deleted: true, entries: expect.any(Array) }),
    );
  });

  test("skips files past retention window with error", async () => {
    const now = new Date("2026-03-30T00:00:00Z");
    const expiredDate = "2025-01-03T17:49:22Z"; // ~452 days ago
    const recentDate = "2026-03-01T12:00:00Z"; // ~29 days ago

    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (body.path === "/pics/old.jpg") {
        return Promise.resolve({
          entries: [{ rev: "rev-old", name: "old.jpg" }],
          is_deleted: true,
          server_deleted: expiredDate,
        });
      }
      if (body.path === "/pics/recent.jpg") {
        return Promise.resolve({
          entries: [{ rev: "rev-recent", name: "recent.jpg" }],
          is_deleted: true,
          server_deleted: recentDate,
        });
      }
    });

    const deleted = [
      { name: "old.jpg", path: "/pics/old.jpg" },
      { name: "recent.jpg", path: "/pics/recent.jpg" },
    ];

    const result = await resolveRevisions(deleted, mockApi, {
      retentionDays: 180,
      now,
    });

    expect(result.resolved).toEqual([
      { name: "recent.jpg", path: "/pics/recent.jpg", rev: "rev-recent" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe("/pics/old.jpg");
    expect(result.errors[0].error).toMatch(/retention/i);
  });

  test("classifies not_file errors as folders, not errors", async () => {
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (body.path === "/pics/album") {
        return Promise.reject(
          new Error("Dropbox API error 409: path/not_file"),
        );
      }
      return Promise.resolve({ entries: [{ rev: "rev-a" }] });
    });

    const deleted = [
      { name: "photo.jpg", path: "/pics/photo.jpg" },
      { name: "album", path: "/pics/album" },
    ];

    const result = await resolveRevisions(deleted, mockApi);

    expect(result.resolved).toEqual([
      { name: "photo.jpg", path: "/pics/photo.jpg", rev: "rev-a" },
    ]);
    expect(result.folders).toEqual([{ name: "album", path: "/pics/album" }]);
    expect(result.errors).toEqual([]);
  });

  test("collects errors without stopping other files", async () => {
    const mockApi = vi.fn().mockImplementation((endpoint, body) => {
      if (body.path === "/pics/bad.jpg") {
        return Promise.reject(new Error("API error"));
      }
      return Promise.resolve({ entries: [{ rev: "rev-ok" }] });
    });

    const deleted = [
      { name: "good.jpg", path: "/pics/good.jpg" },
      { name: "bad.jpg", path: "/pics/bad.jpg" },
    ];

    const result = await resolveRevisions(deleted, mockApi);

    expect(result.resolved).toEqual([
      { name: "good.jpg", path: "/pics/good.jpg", rev: "rev-ok" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe("/pics/bad.jpg");
    expect(result.errors[0].error).toBe("API error");
  });
});
