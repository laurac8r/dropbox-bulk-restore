import { dirname } from "path";

export function groupByDirectory(files, folders = []) {
  const map = new Map();

  for (const file of files) {
    const dir = dirname(file.path);
    if (!map.has(dir)) map.set(dir, { files: [], folders: [] });
    map.get(dir).files.push(file);
  }

  for (const folder of folders) {
    const dir = dirname(folder.path);
    if (!map.has(dir)) map.set(dir, { files: [], folders: [] });
    map.get(dir).folders.push(folder);
  }

  return Array.from(map.entries())
    .map(([directory, { files, folders }]) => ({ directory, files, folders }))
    .sort((a, b) => a.directory.localeCompare(b.directory));
}

export async function restoreFiles(files, apiFn, options = {}) {
  const {
    promptFn,
    concurrency = 4,
    dryRun = false,
    onProgress,
    folders: deletedFolders = [],
    autoApprove = false,
    confirmedDirs = new Map(),
  } = options;
  const errors = [];
  let restored = 0;
  let skipped = 0;
  let dryRunCount = 0;
  let foldersCreated = 0;

  const groups = groupByDirectory(files, deletedFolders);
  const totalItems = files.length + deletedFolders.length;

  for (const group of groups) {
    // Check confirmedDirs: exact match for y/n, prefix match for "a"
    const exactAnswer = confirmedDirs.get(group.directory);
    const prefixApproved = [...confirmedDirs.entries()].some(
      ([dir, ans]) => ans === "a" && group.directory.startsWith(dir),
    );

    let answer;
    if (
      autoApprove ||
      prefixApproved ||
      exactAnswer === "y" ||
      exactAnswer === "a"
    ) {
      answer = "y";
    } else if (exactAnswer === "n") {
      answer = "n";
    } else {
      answer = await promptFn(group.directory, [
        ...group.files,
        ...group.folders,
      ]);
      confirmedDirs.set(group.directory, answer);
    }

    if (answer === "n") {
      skipped += group.files.length + group.folders.length;
      continue;
    }

    if (dryRun) {
      dryRunCount += group.files.length + group.folders.length;
      continue;
    }

    // Restore files with concurrency pool
    let fileIndex = 0;

    async function worker() {
      while (fileIndex < group.files.length) {
        const file = group.files[fileIndex++];
        try {
          await apiFn("/2/files/restore", { path: file.path, rev: file.rev });
          restored++;
          if (onProgress) onProgress(restored + errors.length, totalItems);
        } catch (err) {
          errors.push({ path: file.path, rev: file.rev, error: err.message });
          if (onProgress) onProgress(restored + errors.length, totalItems);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    // Create deleted folders
    for (const folder of group.folders) {
      try {
        await apiFn("/2/files/create_folder_v2", {
          path: folder.path,
          autorename: false,
        });
        foldersCreated++;
      } catch (err) {
        errors.push({ path: folder.path, error: err.message });
      }
    }
  }

  return { restored, skipped, errors, dryRunCount, foldersCreated };
}
