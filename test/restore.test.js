import { describe, expect, test, vi } from "vitest";
import { groupByDirectory, restoreFiles } from "../src/restore.js";

describe("groupByDirectory", () => {
  test("groups files by parent directory", () => {
    const files = [
      { name: "a.jpg", path: "/pics/2023/a.jpg", rev: "r1" },
      { name: "b.jpg", path: "/pics/2023/b.jpg", rev: "r2" },
      { name: "c.jpg", path: "/pics/2024/c.jpg", rev: "r3" },
    ];

    const groups = groupByDirectory(files);

    expect(groups).toEqual([
      {
        directory: "/pics/2023",
        files: [
          { name: "a.jpg", path: "/pics/2023/a.jpg", rev: "r1" },
          { name: "b.jpg", path: "/pics/2023/b.jpg", rev: "r2" },
        ],
        folders: [],
      },
      {
        directory: "/pics/2024",
        files: [{ name: "c.jpg", path: "/pics/2024/c.jpg", rev: "r3" }],
        folders: [],
      },
    ]);
  });

  test("groups folders by parent directory alongside files", () => {
    const files = [{ name: "photo.jpg", path: "/pics/photo.jpg", rev: "r1" }];
    const folders = [
      { name: "album", path: "/pics/album" },
      { name: "vacation", path: "/pics/vacation" },
    ];

    const groups = groupByDirectory(files, folders);

    expect(groups).toEqual([
      {
        directory: "/pics",
        files: [{ name: "photo.jpg", path: "/pics/photo.jpg", rev: "r1" }],
        folders: [
          { name: "album", path: "/pics/album" },
          { name: "vacation", path: "/pics/vacation" },
        ],
      },
    ]);
  });

  test("creates groups from folders-only (no files)", () => {
    const folders = [{ name: "album", path: "/pics/album" }];

    const groups = groupByDirectory([], folders);

    expect(groups).toEqual([
      {
        directory: "/pics",
        files: [],
        folders: [{ name: "album", path: "/pics/album" }],
      },
    ]);
  });

  test("sorts directories depth-first (parent before children)", () => {
    const files = [
      { name: "deep.jpg", path: "/pics/a/b/c/deep.jpg", rev: "r1" },
      { name: "top.jpg", path: "/pics/top.jpg", rev: "r2" },
      { name: "mid.jpg", path: "/pics/a/mid.jpg", rev: "r3" },
    ];

    const groups = groupByDirectory(files);
    const dirs = groups.map((g) => g.directory);

    expect(dirs).toEqual(["/pics", "/pics/a", "/pics/a/b/c"]);
  });
});

describe("restoreFiles", () => {
  test("restores files in confirmed directories", async () => {
    const mockApi = vi.fn().mockResolvedValue({ name: "a.jpg" });
    const promptFn = vi.fn().mockResolvedValue("y");

    const files = [{ name: "a.jpg", path: "/pics/a.jpg", rev: "r1" }];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
    });

    expect(mockApi).toHaveBeenCalledWith("/2/files/restore", {
      path: "/pics/a.jpg",
      rev: "r1",
    });
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
  });

  test("skips directories when user answers n", async () => {
    const mockApi = vi.fn();
    const promptFn = vi.fn().mockResolvedValue("n");

    const files = [{ name: "a.jpg", path: "/pics/a.jpg", rev: "r1" }];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
    });

    expect(mockApi).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("auto-approves subdirectories when user answers a", async () => {
    const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
    const promptFn = vi.fn().mockResolvedValue("a");

    const files = [
      { name: "top.jpg", path: "/pics/top.jpg", rev: "r1" },
      { name: "sub.jpg", path: "/pics/sub/sub.jpg", rev: "r2" },
      { name: "deep.jpg", path: "/pics/sub/deep/deep.jpg", rev: "r3" },
    ];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
    });

    // Only prompted once for /pics, then auto-approved /pics/sub and /pics/sub/deep
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledTimes(3);
    expect(result.restored).toBe(3);
  });

  test("does not call restore API in dry-run mode", async () => {
    const mockApi = vi.fn();
    const promptFn = vi.fn().mockResolvedValue("y");

    const files = [{ name: "a.jpg", path: "/pics/a.jpg", rev: "r1" }];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
      dryRun: true,
    });

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(mockApi).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(result.dryRunCount).toBe(1);
  });

  test("calls onProgress after each restore with count and total", async () => {
    const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
    const promptFn = vi.fn().mockResolvedValue("a");
    const progress = [];

    const files = [
      { name: "a.jpg", path: "/pics/a.jpg", rev: "r1" },
      { name: "b.jpg", path: "/pics/b.jpg", rev: "r2" },
      { name: "c.jpg", path: "/pics/c.jpg", rev: "r3" },
    ];

    await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
      onProgress: (completed, total) => progress.push({ completed, total }),
    });

    expect(progress).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  test("creates deleted folders via create_folder_v2 in confirmed directories", async () => {
    const mockApi = vi.fn().mockResolvedValue({ metadata: { name: "album" } });
    const promptFn = vi.fn().mockResolvedValue("y");

    const result = await restoreFiles([], mockApi, {
      promptFn,
      folders: [{ name: "album", path: "/pics/album" }],
      concurrency: 1,
    });

    expect(mockApi).toHaveBeenCalledWith("/2/files/create_folder_v2", {
      path: "/pics/album",
      autorename: false,
    });
    expect(result.foldersCreated).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("skips folders in denied directories", async () => {
    const mockApi = vi.fn();
    const promptFn = vi.fn().mockResolvedValue("n");

    const result = await restoreFiles([], mockApi, {
      promptFn,
      folders: [{ name: "album", path: "/pics/album" }],
      concurrency: 1,
    });

    expect(mockApi).not.toHaveBeenCalled();
    expect(result.foldersCreated).toBe(0);
  });

  test("counts folders in dry-run mode", async () => {
    const mockApi = vi.fn();
    const promptFn = vi.fn().mockResolvedValue("y");

    const result = await restoreFiles([], mockApi, {
      promptFn,
      folders: [{ name: "album", path: "/pics/album" }],
      concurrency: 1,
      dryRun: true,
    });

    expect(mockApi).not.toHaveBeenCalled();
    expect(result.dryRunCount).toBe(1);
    expect(result.foldersCreated).toBe(0);
  });

  test("restores files and creates folders together in the same confirmation group", async () => {
    const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
    const promptFn = vi.fn().mockResolvedValue("y");

    const files = [{ name: "photo.jpg", path: "/pics/photo.jpg", rev: "r1" }];
    const folders = [{ name: "album", path: "/pics/album" }];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      folders,
      concurrency: 1,
    });

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(result.restored).toBe(1);
    expect(result.foldersCreated).toBe(1);
    expect(mockApi).toHaveBeenCalledWith("/2/files/restore", {
      path: "/pics/photo.jpg",
      rev: "r1",
    });
    expect(mockApi).toHaveBeenCalledWith("/2/files/create_folder_v2", {
      path: "/pics/album",
      autorename: false,
    });
  });

  test("auto-approves all directories without prompting when autoApprove is true", async () => {
    const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
    const promptFn = vi.fn();

    const files = [
      { name: "a.jpg", path: "/pics/2023/a.jpg", rev: "r1" },
      { name: "b.jpg", path: "/pics/2024/b.jpg", rev: "r2" },
    ];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
      autoApprove: true,
    });

    expect(promptFn).not.toHaveBeenCalled();
    expect(result.restored).toBe(2);
    expect(result.skipped).toBe(0);
  });

  test("auto-approves folders too when autoApprove is true", async () => {
    const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
    const promptFn = vi.fn();

    const result = await restoreFiles([], mockApi, {
      promptFn,
      folders: [{ name: "album", path: "/pics/album" }],
      concurrency: 1,
      autoApprove: true,
    });

    expect(promptFn).not.toHaveBeenCalled();
    expect(result.foldersCreated).toBe(1);
  });

  describe("confirmedDirs shared map", () => {
    test('reads "y" from confirmedDirs to auto-approve exact directory', async () => {
      const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
      const promptFn = vi.fn();
      const confirmedDirs = new Map([["/pics", "y"]]);

      const files = [{ name: "a.jpg", path: "/pics/a.jpg", rev: "r1" }];

      const result = await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        confirmedDirs,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(result.restored).toBe(1);
    });

    test('reads "n" from confirmedDirs to auto-skip exact directory', async () => {
      const mockApi = vi.fn();
      const promptFn = vi.fn();
      const confirmedDirs = new Map([["/pics", "n"]]);

      const files = [{ name: "a.jpg", path: "/pics/a.jpg", rev: "r1" }];

      const result = await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        confirmedDirs,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(mockApi).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    test('"y" does NOT prefix-match subdirectories', async () => {
      const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
      const promptFn = vi.fn().mockResolvedValue("y");
      const confirmedDirs = new Map([["/pics", "y"]]);

      const files = [
        { name: "a.jpg", path: "/pics/a.jpg", rev: "r1" },
        { name: "b.jpg", path: "/pics/sub/b.jpg", rev: "r2" },
      ];

      const result = await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        confirmedDirs,
      });

      // /pics auto-approved from map, /pics/sub prompted
      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(promptFn.mock.calls[0][0]).toBe("/pics/sub");
      expect(result.restored).toBe(2);
    });

    test('reads "a" from confirmedDirs to prefix-match subdirectories', async () => {
      const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
      const promptFn = vi.fn();
      const confirmedDirs = new Map([["/pics", "a"]]);

      const files = [
        { name: "a.jpg", path: "/pics/a.jpg", rev: "r1" },
        { name: "b.jpg", path: "/pics/sub/b.jpg", rev: "r2" },
        { name: "c.jpg", path: "/pics/sub/deep/c.jpg", rev: "r3" },
      ];

      const result = await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        confirmedDirs,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(result.restored).toBe(3);
    });

    test("writes new confirmations back to confirmedDirs map", async () => {
      const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
      // groups sorted alphabetically: /pics/alpha before /pics/beta
      const promptFn = vi
        .fn()
        .mockResolvedValueOnce("y")
        .mockResolvedValueOnce("n");
      const confirmedDirs = new Map();

      const files = [
        { name: "a.jpg", path: "/pics/alpha/a.jpg", rev: "r1" },
        { name: "b.jpg", path: "/pics/beta/b.jpg", rev: "r2" },
      ];

      await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        confirmedDirs,
      });

      expect(confirmedDirs.get("/pics/alpha")).toBe("y");
      expect(confirmedDirs.get("/pics/beta")).toBe("n");
    });

    test('writes "a" confirmation and applies it within same call', async () => {
      const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
      const promptFn = vi.fn().mockResolvedValue("a");
      const confirmedDirs = new Map();

      const files = [
        { name: "a.jpg", path: "/pics/a.jpg", rev: "r1" },
        { name: "b.jpg", path: "/pics/sub/b.jpg", rev: "r2" },
      ];

      const result = await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        confirmedDirs,
      });

      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(confirmedDirs.get("/pics")).toBe("a");
      expect(result.restored).toBe(2);
    });

    test("works without confirmedDirs option (backwards compatible)", async () => {
      const mockApi = vi.fn().mockResolvedValue({ name: "ok" });
      const promptFn = vi.fn().mockResolvedValue("y");

      const files = [{ name: "a.jpg", path: "/pics/a.jpg", rev: "r1" }];

      const result = await restoreFiles(files, mockApi, {
        promptFn,
        concurrency: 1,
        // no confirmedDirs
      });

      expect(result.restored).toBe(1);
    });
  });

  test("collects restore errors without stopping", async () => {
    const mockApi = vi
      .fn()
      .mockRejectedValueOnce(new Error("restore failed"))
      .mockResolvedValueOnce({ name: "b.jpg" });
    const promptFn = vi.fn().mockResolvedValue("a");

    const files = [
      { name: "a.jpg", path: "/pics/a.jpg", rev: "r1" },
      { name: "b.jpg", path: "/pics/b.jpg", rev: "r2" },
    ];

    const result = await restoreFiles(files, mockApi, {
      promptFn,
      concurrency: 1,
    });

    expect(result.restored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe("/pics/a.jpg");
  });
});
