export const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export function spinnerFrame(n) {
  return SPINNER_FRAMES[n % SPINNER_FRAMES.length];
}

export class Spinner {
  constructor(writeFn, { interval = 250 } = {}) {
    this._writeFn = writeFn;
    this._interval = interval;
    this._message = "";
    this._tick = 0;
    this._timer = null;
  }

  update(message) {
    this._message = message;
    this._render();
    this._ensureTimer();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _render() {
    this._writeFn(`\r  ${spinnerFrame(this._tick++)} ${this._message}`);
  }

  _ensureTimer() {
    if (!this._timer) {
      this._timer = setInterval(() => this._render(), this._interval);
    }
  }
}
