export async function discoverDeletedPage(path, apiFn, options = {}) {
  const { cursor, filterPrefix } = options;
  let response;
  let resultFilterPrefix = filterPrefix || null;

  if (cursor) {
    response = await apiFn("/2/files/list_folder/continue", { cursor });
  } else {
    try {
      response = await apiFn("/2/files/list_folder", {
        path,
        include_deleted: true,
        recursive: true,
      });
    } catch (err) {
      if (err.message.includes("path/not_found")) {
        const parentPath = path.substring(0, path.lastIndexOf("/")) || "/";
        resultFilterPrefix = path;
        response = await apiFn("/2/files/list_folder", {
          path: parentPath,
          include_deleted: true,
          recursive: true,
        });
      } else {
        throw err;
      }
    }
  }

  const matchesPath = (entryPath) =>
    !resultFilterPrefix ||
    entryPath.toLowerCase().startsWith(resultFilterPrefix.toLowerCase() + "/");

  const deleted = [];
  for (const entry of response.entries) {
    if (entry[".tag"] === "deleted" && matchesPath(entry.path_display)) {
      deleted.push({ name: entry.name, path: entry.path_display });
    }
  }

  return {
    deleted,
    cursor: response.cursor,
    hasMore: response.has_more,
    ...(resultFilterPrefix && { filterPrefix: resultFilterPrefix }),
  };
}

export async function discoverDeleted(path, apiFn, options = {}) {
  const { onProgress, limit } = options;
  const deleted = [];
  let page = 0;
  let filterPrefix = null;

  let response;
  try {
    response = await apiFn("/2/files/list_folder", {
      path,
      include_deleted: true,
      recursive: true,
    });
  } catch (err) {
    if (err.message.includes("path/not_found")) {
      const parentPath = path.substring(0, path.lastIndexOf("/")) || "/";
      filterPrefix = path.toLowerCase();
      response = await apiFn("/2/files/list_folder", {
        path: parentPath,
        include_deleted: true,
        recursive: true,
      });
    } else {
      throw err;
    }
  }

  const atLimit = () => limit > 0 && deleted.length >= limit;

  const matchesPath = (entryPath) =>
    !filterPrefix || entryPath.toLowerCase().startsWith(filterPrefix + "/");

  page++;
  for (const entry of response.entries) {
    if (entry[".tag"] === "deleted" && matchesPath(entry.path_display)) {
      deleted.push({ name: entry.name, path: entry.path_display });
      if (atLimit()) break;
    }
  }
  if (onProgress) onProgress(deleted.length, page);

  while (response.has_more && !atLimit()) {
    response = await apiFn("/2/files/list_folder/continue", {
      cursor: response.cursor,
    });
    page++;
    for (const entry of response.entries) {
      if (entry[".tag"] === "deleted" && matchesPath(entry.path_display)) {
        deleted.push({ name: entry.name, path: entry.path_display });
        if (atLimit()) break;
      }
    }
    if (onProgress) onProgress(deleted.length, page);
  }

  return limit > 0 ? deleted.slice(0, limit) : deleted;
}
