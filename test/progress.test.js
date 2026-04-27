import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProgressTracker } from "../src/progress.js";

describe("ProgressTracker", () => {
  let mockFs;

  beforeEach(() => {
    mockFs = {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    };
  });

  test("starts fresh when no progress file exists", () => {
    const tracker = new ProgressTracker("/tmp", { fs: mockFs });

    expect(tracker.getCompleted()).toEqual(new Set());
    expect(tracker.getFailedForRetry()).toEqual([]);
  });

  test("loads completed paths from existing progress.json", () => {
    mockFs.existsSync.mockImplementation((p) => p.includes("progress.json"));
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes("progress.json")) {
        return JSON.stringify({ completed: ["/pics/a.jpg", "/pics/b.jpg"] });
      }
    });

    const tracker = new ProgressTracker("/tmp", { fs: mockFs });

    expect(tracker.getCompleted()).toEqual(
      new Set(["/pics/a.jpg", "/pics/b.jpg"]),
    );
  });

  test("loads failed entries from existing errors.json for retry priority", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes("progress.json")) {
        return JSON.stringify({ completed: ["/pics/a.jpg"] });
      }
      if (p.includes("errors.json")) {
        return JSON.stringify([
          { path: "/pics/bad.jpg", rev: "rev-bad", error: "timeout" },
        ]);
      }
    });

    const tracker = new ProgressTracker("/tmp", { fs: mockFs });
    const retries = tracker.getFailedForRetry();

    expect(retries).toEqual([
      { path: "/pics/bad.jpg", rev: "rev-bad", error: "timeout" },
    ]);
  });

  test("markCompleted adds path and saves to disk", () => {
    const tracker = new ProgressTracker("/tmp", { fs: mockFs });

    tracker.markCompleted("/pics/a.jpg");

    expect(tracker.getCompleted().has("/pics/a.jpg")).toBe(true);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/progress.json",
      expect.stringContaining("/pics/a.jpg"),
    );
  });

  test("filterUnprocessed removes already-completed paths", () => {
    mockFs.existsSync.mockImplementation((p) => p.includes("progress.json"));
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes("progress.json")) {
        return JSON.stringify({ completed: ["/pics/a.jpg"] });
      }
    });

    const tracker = new ProgressTracker("/tmp", { fs: mockFs });

    const files = [
      { name: "a.jpg", path: "/pics/a.jpg", rev: "r1" },
      { name: "b.jpg", path: "/pics/b.jpg", rev: "r2" },
    ];

    const remaining = tracker.filterUnprocessed(files);

    expect(remaining).toEqual([
      { name: "b.jpg", path: "/pics/b.jpg", rev: "r2" },
    ]);
  });

  test("saveErrors writes errors to errors.json", () => {
    const tracker = new ProgressTracker("/tmp", { fs: mockFs });

    tracker.saveErrors([{ path: "/pics/bad.jpg", error: "fail" }]);

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/errors.json",
      expect.stringContaining("/pics/bad.jpg"),
    );
  });

  test("saveErrors with empty array clears errors.json", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p) => {
      if (p.includes("progress.json")) {
        return JSON.stringify({ completed: [] });
      }
      if (p.includes("errors.json")) {
        return JSON.stringify([
          { path: "/pics/bad.jpg", rev: "rev-bad", error: "in_progress" },
        ]);
      }
    });

    const tracker = new ProgressTracker("/tmp", { fs: mockFs });
    expect(tracker.getFailedForRetry()).toHaveLength(1);

    // After successful retries, saving empty errors should clear the file
    tracker.saveErrors([]);

    expect(mockFs.writeFileSync).toHaveBeenCalledWith("/tmp/errors.json", "[]");
  });
});
