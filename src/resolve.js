export async function resolveRevisions(deleted, apiFn, options = {}) {
  const { concurrency = 4, logFn, retentionDays, now } = options;
  const resolved = [];
  const errors = [];
  const folders = [];
  let index = 0;

  function isPastRetention(serverDeleted) {
    if (!retentionDays || !serverDeleted) return false;
    const deletedAt = new Date(serverDeleted);
    const cutoff = new Date(now || Date.now());
    cutoff.setDate(cutoff.getDate() - retentionDays);
    return deletedAt < cutoff;
  }

  async function worker() {
    while (index < deleted.length) {
      const current = deleted[index++];
      try {
        const response = await apiFn("/2/files/list_revisions", {
          path: current.path,
          limit: 1,
        });
        if (logFn) logFn(current.path, response);
        if (isPastRetention(response.server_deleted)) {
          const daysAgo = Math.floor(
            (new Date(now || Date.now()) - new Date(response.server_deleted)) /
              (1000 * 60 * 60 * 24),
          );
          errors.push({
            path: current.path,
            error: `Past retention window (deleted ${daysAgo} days ago, limit ${retentionDays} days)`,
          });
          continue;
        }
        resolved.push({
          name: current.name,
          path: current.path,
          rev: response.entries[0].rev,
        });
      } catch (err) {
        if (err.message.includes("path/not_file")) {
          folders.push({ name: current.name, path: current.path });
        } else {
          errors.push({ path: current.path, error: err.message });
        }
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return { resolved, errors, folders };
}
