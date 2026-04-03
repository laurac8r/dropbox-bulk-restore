import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { spinnerFrame, Spinner, SPINNER_FRAMES } from '../src/spinner.js';

describe('spinnerFrame', () => {
  test('returns first frame for 0', () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
  });

  test('cycles through all frames', () => {
    const frames = [];
    for (let i = 0; i < SPINNER_FRAMES.length; i++) {
      frames.push(spinnerFrame(i));
    }
    expect(frames).toEqual(SPINNER_FRAMES);
  });

  test('wraps around after last frame', () => {
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(SPINNER_FRAMES.length + 1)).toBe(SPINNER_FRAMES[1]);
  });

  test('handles large numbers', () => {
    const frame = spinnerFrame(1000);
    expect(SPINNER_FRAMES).toContain(frame);
  });
});

describe('Spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('update() immediately renders the message with a spinner frame', () => {
    const writes = [];
    const spinner = new Spinner((s) => writes.push(s));

    spinner.update('Loading...');
    spinner.stop();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Loading...');
    expect(writes[0]).toMatch(/^\r/);
    const hasFrame = SPINNER_FRAMES.some((f) => writes[0].includes(f));
    expect(hasFrame).toBe(true);
  });

  test('redraws with next frame every second without new data', () => {
    const writes = [];
    const spinner = new Spinner((s) => writes.push(s));

    spinner.update('Working...');
    expect(writes).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(2);

    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(3);

    spinner.stop();

    // Each redraw should use a different frame
    const frames = writes.map((w) => {
      const match = SPINNER_FRAMES.find((f) => w.includes(f));
      return match;
    });
    expect(frames[0]).not.toBe(frames[1]);
    expect(frames[1]).not.toBe(frames[2]);
  });

  test('update() with new message redraws immediately with new text', () => {
    const writes = [];
    const spinner = new Spinner((s) => writes.push(s));

    spinner.update('Page 1...');
    spinner.update('Page 2...');
    spinner.stop();

    expect(writes[0]).toContain('Page 1...');
    expect(writes[1]).toContain('Page 2...');
  });

  test('stop() prevents further redraws', () => {
    const writes = [];
    const spinner = new Spinner((s) => writes.push(s));

    spinner.update('Working...');
    spinner.stop();
    const countAfterStop = writes.length;

    vi.advanceTimersByTime(5000);
    expect(writes).toHaveLength(countAfterStop);
  });

  test('timer redraws the most recent message', () => {
    const writes = [];
    const spinner = new Spinner((s) => writes.push(s));

    spinner.update('First');
    spinner.update('Second');

    vi.advanceTimersByTime(1000);
    spinner.stop();

    // The timer redraw (3rd write) should contain "Second", not "First"
    expect(writes[2]).toContain('Second');
  });

  test('update() after stop() restarts the timer', () => {
    const writes = [];
    const spinner = new Spinner((s) => writes.push(s));

    spinner.update('Phase 1');
    spinner.stop();
    const countAfterStop = writes.length;

    vi.advanceTimersByTime(2000);
    expect(writes).toHaveLength(countAfterStop);

    spinner.update('Phase 2');
    vi.advanceTimersByTime(1000);
    spinner.stop();

    // Should have: Phase 1 render + Phase 2 render + 1 timer redraw
    expect(writes.length).toBe(countAfterStop + 2);
    expect(writes[writes.length - 1]).toContain('Phase 2');
  });
});