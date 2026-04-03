import { join } from 'path';
import fs from 'fs';

export class ProgressTracker {
  constructor(dir, options = {}) {
    this._fs = options.fs || fs;
    this._progressPath = join(dir, 'progress.json');
    this._errorsPath = join(dir, 'errors.json');
    this._completed = new Set();
    this._failedForRetry = [];

    this._load();
  }

  _load() {
    if (this._fs.existsSync(this._progressPath)) {
      const data = JSON.parse(this._fs.readFileSync(this._progressPath, 'utf8'));
      for (const path of data.completed) {
        this._completed.add(path);
      }
    }

    if (this._fs.existsSync(this._errorsPath)) {
      this._failedForRetry = JSON.parse(
        this._fs.readFileSync(this._errorsPath, 'utf8')
      );
    }
  }

  getCompleted() {
    return this._completed;
  }

  getFailedForRetry() {
    return this._failedForRetry;
  }

  markCompleted(path) {
    this._completed.add(path);
    this._save();
  }

  filterUnprocessed(files) {
    return files.filter((f) => !this._completed.has(f.path));
  }

  saveErrors(errors) {
    this._fs.writeFileSync(this._errorsPath, JSON.stringify(errors, null, 2));
  }

  _save() {
    this._fs.writeFileSync(
      this._progressPath,
      JSON.stringify({ completed: [...this._completed] }, null, 2)
    );
  }
}