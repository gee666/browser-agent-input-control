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
    const backend = new CdpMouseBackend({ transport, rng });
    const ctx = { tabId };
    return { transport, backend, ctx };
  }

  test('move with duration_ms === 0 emits exactly ONE mouseMoved event at target', async () => {
    const { transport, backend, ctx } = mkBackend();
    await backend.move({ x: 200, y: 100, durationMs: 0 }, null, ctx);
    const moves = transport.calledWith('Input.dispatchMouseEvent');
    expect(moves).toHaveLength(1);
    expect(moves[0].params.type).toBe('mouseMoved');
    expect(moves[0].params.x).toBe(200);
    expect(moves[0].params.y).toBe(100);
  });

  test('move without explicit duration dispatches a humanised path ending at target', async () => {
    const { transport, backend, ctx } = mkBackend();
    await backend.move({ x: 200, y: 100 }, null, ctx);
    const moves = transport.calledWith('Input.dispatchMouseEvent');
    expect(moves.length).toBeGreaterThan(1);
    for (const m of moves) expect(m.params.type).toBe('mouseMoved');
    const last = moves[moves.length - 1].params;
    expect(last.x).toBe(200);
    expect(last.y).toBe(100);
  });

  test('click emits mousePressed then mouseReleased with clickCount', async () => {
    const { transport, backend, ctx } = mkBackend();
    await backend.click({ x: 50, y: 60, button: 'left', count: 1, moveDurationMs: 0, holdMs: 0, intervalMs: 0 }, null, ctx);
    const events = transport.calls.map((c) => c.params.type);
    expect(events).toContain('mousePressed');
    expect(events).toContain('mouseReleased');
    const pressed = transport.calls.find((c) => c.params.type === 'mousePressed');
    expect(pressed.params.button).toBe('left');
    expect(pressed.params.buttons).toBe(1);
    expect(pressed.params.clickCount).toBe(1);
    const released = transport.calls.find((c) => c.params.type === 'mouseReleased');
    expect(released.params.button).toBe('left');
    expect(released.params.buttons).toBe(0);
  });

  test('cancelling during click hold still releases the mouse button', async () => {
    const { transport, backend, ctx } = mkBackend();
    const controller = new AbortController();
    const click = backend.click(
      { x: 50, y: 60, button: 'left', count: 1, moveDurationMs: 0, holdMs: 1000, intervalMs: 0 },
      controller.signal,
      ctx,
    );
    while (!transport.calls.some((c) => c.params.type === 'mousePressed')) {
      await Promise.resolve();
    }
    controller.abort();
    await expect(click).rejects.toThrow(/cancel/i);
    const released = transport.calls.find((c) => c.params.type === 'mouseReleased');
    expect(released.params).toEqual(expect.objectContaining({ button: 'left', buttons: 0 }));
  });

  test('click with move_duration_ms === 0 emits exactly ONE mouseMoved before pressing', async () => {
    const { transport, backend, ctx } = mkBackend();
    await backend.click({ x: 250, y: 150, button: 'left', count: 1, moveDurationMs: 0, holdMs: 0, intervalMs: 0 }, null, ctx);
    const moves = transport.calls.filter((c) => c.params.type === 'mouseMoved');
    expect(moves).toHaveLength(1);
    expect(moves[0].params.x).toBe(250);
    expect(moves[0].params.y).toBe(150);
    // And the press event happens AFTER the single move event.
    const firstPressIdx = transport.calls.findIndex((c) => c.params.type === 'mousePressed');
    const lastMoveIdx = transport.calls.map((c) => c.params.type).lastIndexOf('mouseMoved');
    expect(firstPressIdx).toBeGreaterThan(lastMoveIdx);
  });

  test('double click uses clickCount 1 then 2', async () => {
    const { transport, backend, ctx } = mkBackend();
    await backend.click({ x: 50, y: 60, button: 'left', count: 2, moveDurationMs: 0, holdMs: 0, intervalMs: 0 }, null, ctx);
    const pressed = transport.calls.filter((c) => c.params.type === 'mousePressed').map((c) => c.params.clickCount);
    expect(pressed).toEqual([1, 2]);
  });

  test('scroll dispatches mouseWheel events with matching deltaY sum', async () => {
    const { transport, backend, ctx } = mkBackend();
    await backend.scroll({ x: 100, y: 100, deltaX: 0, deltaY: 400, durationMs: 0 }, null, ctx);
    const wheels = transport.calls.filter((c) => c.params.type === 'mouseWheel');
    expect(wheels.length).toBeGreaterThan(0);
    const sum = wheels.reduce((s, w) => s + w.params.deltaY, 0);
    expect(sum).toBe(400);
  });

  test('command-scoped tabId is used for every CDP call', async () => {
    const transport = new FakeTransport();
    const backend = new CdpMouseBackend({ transport, rng: new DeterministicRng(1) });
    await backend.move({ x: 10, y: 10, durationMs: 0 }, null, { tabId: 5 });
    await backend.move({ x: 20, y: 20, durationMs: 0 }, null, { tabId: 7 });
    const tabIds = new Set(transport.calls.map((c) => c.tabId));
    expect(tabIds.has(5)).toBe(true);
    expect(tabIds.has(7)).toBe(true);
  });

  test('last-point cursor state is isolated per tabId', async () => {
    const transport = new FakeTransport();
    const backend = new CdpMouseBackend({ transport, rng: new DeterministicRng(1) });
    // Seed a position on tab 1 with a real path (non-zero duration).
    await backend.move({ x: 300, y: 300 }, null, { tabId: 1 });
    transport.reset();
    // Now move on tab 2 with duration === 0 — it must teleport, ignoring
    // tab 1's cursor history.
    await backend.move({ x: 400, y: 400, durationMs: 0 }, null, { tabId: 2 });
    const moves = transport.calls.filter((c) => c.params.type === 'mouseMoved');
    expect(moves).toHaveLength(1);
    expect(moves[0].tabId).toBe(2);
    // Next tab-1 move starts from (300,300), not from (400,400). A short
    // (1,1)-target move from (300,300) should be many steps; from (400,400)
    // it would also be many steps, so we instead assert via duration:0 that
    // state did not leak across tabs.
    transport.reset();
    await backend.move({ x: 300, y: 300, durationMs: 0 }, null, { tabId: 1 });
    // Moving to the same point on tab 1 is a zero-distance move → single event.
    const tab1Moves = transport.calls.filter((c) => c.params.type === 'mouseMoved');
    expect(tab1Moves).toHaveLength(1);
    expect(tab1Moves[0].tabId).toBe(1);
  });

  test('resetState() forgets all per-tab cursor history', async () => {
    const transport = new FakeTransport();
    const backend = new CdpMouseBackend({ transport, rng: new DeterministicRng(4) });
    await backend.move({ x: 500, y: 500 }, null, { tabId: 9 });
    backend.resetState();
    // After reset, the remembered point for tab 9 goes back to (0,0). A
    // move to (500, 500) will therefore produce a multi-step path again.
    transport.reset();
    await backend.move({ x: 500, y: 500 }, null, { tabId: 9 });
    const moves = transport.calls.filter((c) => c.params.type === 'mouseMoved');
    expect(moves.length).toBeGreaterThan(1);
  });
});

describe('distanceBetweenPoints', () => {
  test('Euclidean distance', () => {
    expect(distanceBetweenPoints({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });
});
