import { describe, expect, test } from '@jest/globals';
import { CdpMouseBackend } from '../src/backends/mouse.js';
import { buildMousePath, buildScrollSteps, distanceBetweenPoints } from '../src/mouse-motion.js';
import { estimateMouseDurationMs } from '../src/timing.js';
import { DeterministicRng, FakeTransport } from './_fakes.js';

describe('buildMousePath', () => {
  const rng = new DeterministicRng(7);

  test('zero distance returns start only', () => {
    const path = buildMousePath({ x: 10, y: 10 }, { x: 10, y: 10 }, rng);
    expect(path).toEqual([{ x: 10, y: 10 }]);
  });

  test('first and last points exactly hit endpoints, no NaN', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 500, y: 300 };
    const path = buildMousePath(start, end, new DeterministicRng(3));
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(end);
    for (const p of path) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  test('sample count scales with distance', () => {
    const short = buildMousePath({ x: 0, y: 0 }, { x: 30, y: 0 }, new DeterministicRng(1));
    const long = buildMousePath({ x: 0, y: 0 }, { x: 900, y: 0 }, new DeterministicRng(1));
    expect(short.length).toBeGreaterThan(1);
    expect(long.length).toBeGreaterThanOrEqual(short.length);
  });
});

describe('estimateMouseDurationMs', () => {
  test('monotonically increases within clamp', () => {
    const a = estimateMouseDurationMs(10);
    const b = estimateMouseDurationMs(500);
    const c = estimateMouseDurationMs(5000);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
    expect(a).toBeGreaterThanOrEqual(150);
    expect(c).toBeLessThanOrEqual(1200);
  });
});

describe('buildScrollSteps', () => {
  test('zero delta returns empty list', () => {
    expect(buildScrollSteps(0, 0, new DeterministicRng(1))).toEqual([]);
  });

  test('vertical delta produces steps summing to total ticks', () => {
    const steps = buildScrollSteps(0, 500, new DeterministicRng(2));
    expect(steps.length).toBeGreaterThan(0);
    const sum = steps.reduce((s, st) => s + st.deltaY, 0);
    // cssPixelsPerTick=100; 500 css = 5 ticks = 500 deltaY
    expect(sum).toBe(500);
    for (const s of steps) expect(s.deltaX).toBe(0);
  });
});

describe('CdpMouseBackend — CDP call sequence', () => {
  function mkBackend(tabId = 10) {
    const transport = new FakeTransport();
    const rng = new DeterministicRng(2);
    const backend = new CdpMouseBackend({ transport, getTabId: () => tabId, rng });
    return { transport, backend };
  }

  test('move dispatches a stream of mouseMoved events ending at target', async () => {
    const { transport, backend } = mkBackend();
    await backend.move({ x: 200, y: 100, durationMs: 0 }, null);
    const moves = transport.calledWith('Input.dispatchMouseEvent');
    expect(moves.length).toBeGreaterThan(1);
    for (const m of moves) expect(m.params.type).toBe('mouseMoved');
    const last = moves[moves.length - 1].params;
    expect(last.x).toBe(200);
    expect(last.y).toBe(100);
  });

  test('click emits mousePressed then mouseReleased with clickCount', async () => {
    const { transport, backend } = mkBackend();
    await backend.click({ x: 50, y: 60, button: 'left', count: 1, moveDurationMs: 0, holdMs: 0, intervalMs: 0 }, null);
    const events = transport.calls.map((c) => c.params.type);
    expect(events).toContain('mousePressed');
    expect(events).toContain('mouseReleased');
    const pressed = transport.calls.find((c) => c.params.type === 'mousePressed');
    expect(pressed.params.button).toBe('left');
    expect(pressed.params.clickCount).toBe(1);
  });

  test('double click uses clickCount 1 then 2', async () => {
    const { transport, backend } = mkBackend();
    await backend.click({ x: 50, y: 60, button: 'left', count: 2, moveDurationMs: 0, holdMs: 0, intervalMs: 0 }, null);
    const pressed = transport.calls.filter((c) => c.params.type === 'mousePressed').map((c) => c.params.clickCount);
    expect(pressed).toEqual([1, 2]);
  });

  test('scroll dispatches mouseWheel events with matching deltaY sum', async () => {
    const { transport, backend } = mkBackend();
    await backend.scroll({ x: 100, y: 100, deltaX: 0, deltaY: 400, durationMs: 0 }, null);
    const wheels = transport.calls.filter((c) => c.params.type === 'mouseWheel');
    expect(wheels.length).toBeGreaterThan(0);
    const sum = wheels.reduce((s, w) => s + w.params.deltaY, 0);
    expect(sum).toBe(400);
  });

  test('getTabId is consulted for every CDP call', async () => {
    const transport = new FakeTransport();
    let tabId = 5;
    const backend = new CdpMouseBackend({ transport, getTabId: () => tabId, rng: new DeterministicRng(1) });
    await backend.move({ x: 10, y: 10, durationMs: 0 }, null);
    tabId = 7;
    await backend.move({ x: 20, y: 20, durationMs: 0 }, null);
    const tabIds = new Set(transport.calls.map((c) => c.tabId));
    expect(tabIds.has(5)).toBe(true);
    expect(tabIds.has(7)).toBe(true);
  });
});

describe('distanceBetweenPoints', () => {
  test('Euclidean distance', () => {
    expect(distanceBetweenPoints({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });
});
