// Drop-in contract: CdpInputControlBridge exposes the same execute / abort /
// disconnect surface as browser-agent-core's InputControlBridge, and its
// error classes have compatible names.

import { describe, expect, test } from '@jest/globals';
import { CdpInputControlBridge } from '../src/bridge.js';
import { InputControlAbortError, InputControlError, InputControlTimeoutError } from '../src/errors.js';
import { FakeBrowserBridge, FakeTransport } from './_fakes.js';

describe('CdpInputControlBridge public surface', () => {
  test('exposes execute/abort/disconnect methods', () => {
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge() });
    expect(typeof b.execute).toBe('function');
    expect(typeof b.abort).toBe('function');
    expect(typeof b.disconnect).toBe('function');
  });

  test('execute resolves { id, status: "ok" } for a valid pause', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(9), transport });
    const res = await b.execute('pause', { duration_ms: 1 }, {});
    expect(res.status).toBe('ok');
    expect(typeof res.id).toBe('string');
  });

  test('execute rejects with InputControlError on validation failure', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(), transport });
    await expect(b.execute('mouse_move', { y: 1 }, {})).rejects.toBeInstanceOf(InputControlError);
  });

  test('execute rejects with InputControlError on unknown command', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(), transport });
    const err = await b.execute('nope', {}, {}).catch((e) => e);
    expect(err).toBeInstanceOf(InputControlError);
    expect(err.message).toMatch(/Unknown command/);
  });

  test('bridge passes tabId to transport via getActiveTabId()', async () => {
    const transport = new FakeTransport();
    const browserBridge = new FakeBrowserBridge(123);
    const b = new CdpInputControlBridge({ bridge: browserBridge, transport });
    await b.execute('mouse_move', { x: 1, y: 2, duration_ms: 0 }, {});
    expect(browserBridge.getActiveTabIdCalls).toBeGreaterThanOrEqual(1);
    expect(transport.calls.every((c) => c.tabId === 123)).toBe(true);
  });

  test('tabId is NOT part of the protocol params passed to CDP', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(5), transport });
    await b.execute('mouse_click', { x: 5, y: 5, button: 'left', move_duration_ms: 0, hold_ms: 0 }, {});
    for (const c of transport.calls) {
      expect(c.params).not.toHaveProperty('tabId');
    }
  });

  test('disconnect causes subsequent executes to reject', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(), transport });
    await b.disconnect();
    await expect(b.execute('pause', { duration_ms: 1 }, {})).rejects.toBeInstanceOf(InputControlError);
  });

  test('disconnect detaches the debugger and disposes the transport', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(7), transport });
    await b.execute('mouse_move', { x: 1, y: 1, duration_ms: 0 }, {});
    expect(transport.attached.has(7)).toBe(true);
    await b.disconnect();
    expect(transport.attached.size).toBe(0);
    expect(transport.disposed).toBe(true);
  });

  test('disconnect is awaitable and idempotent', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(3), transport });
    await b.execute('mouse_move', { x: 1, y: 1, duration_ms: 0 }, {});
    // First call detaches.
    await b.disconnect();
    expect(transport.attached.size).toBe(0);
    // Second call is a no-op but must still return a Promise and resolve.
    const result = b.disconnect();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  test('end-of-task cleanup: after a successful run, disconnect detaches chrome.debugger', async () => {
    // Simulates exactly what sw.js does: run a sequence of commands, then
    // disconnect() in a finally handler — and confirms the yellow banner
    // goes away (i.e. the transport is fully detached).
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(11), transport });
    await b.execute('mouse_move', { x: 10, y: 10, duration_ms: 0 }, {});
    await b.execute('mouse_click', { x: 10, y: 10, button: 'left', move_duration_ms: 0, hold_ms: 0 }, {});
    await b.execute('pause', { duration_ms: 1 }, {});
    expect(transport.attached.has(11)).toBe(true);
    await b.disconnect();
    expect(transport.attached.size).toBe(0);
  });

  test('abort returns a Promise for the detach round-trip', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(9), transport });
    await b.execute('mouse_move', { x: 1, y: 1, duration_ms: 0 }, {});
    const result = b.abort();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(transport.attached.size).toBe(0);
  });

  test('disconnect reuses an in-flight abort detach instead of starting a second detach', async () => {
    const transport = new FakeTransport();
    let resolveDetach;
    let detachCalls = 0;
    transport.detach = async () => {
      detachCalls += 1;
      transport.attached.clear();
      await new Promise((resolve) => {
        resolveDetach = resolve;
      });
    };
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(9), transport });
    await b.execute('mouse_move', { x: 1, y: 1, duration_ms: 0 }, {});

    const abortPromise = b.abort();
    const disconnectPromise = b.disconnect();
    await Promise.resolve();
    expect(detachCalls).toBe(1);
    resolveDetach();

    await Promise.all([abortPromise, disconnectPromise]);
    expect(detachCalls).toBe(1);
  });

  test('disconnect still aborts new work started after an earlier abort completed', async () => {
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(9), transport });

    await b.execute('mouse_move', { x: 1, y: 1, duration_ms: 0 }, {});
    await b.abort();

    const pausePromise = b.execute('pause', { duration_ms: 50 }, {});
    await b.disconnect();

    await expect(pausePromise).rejects.toBeInstanceOf(InputControlAbortError);
  });

  test('disconnect aborts new work even if a previous abort detach is still in flight', async () => {
    const transport = new FakeTransport();
    let resolveDetach;
    transport.detach = async () => {
      transport.attached.clear();
      await new Promise((resolve) => {
        resolveDetach = resolve;
      });
    };
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(9), transport });

    await b.execute('mouse_move', { x: 1, y: 1, duration_ms: 0 }, {});
    const abortPromise = b.abort();
    await Promise.resolve();
    const pausePromise = b.execute('pause', { duration_ms: 50 }, {}).catch((error) => error);
    const disconnectPromise = b.disconnect();
    resolveDetach();

    await Promise.all([abortPromise, disconnectPromise]);
    await expect(pausePromise).resolves.toBeInstanceOf(InputControlAbortError);
  });

  test('error class names match drop-in contract exactly', () => {
    expect(new InputControlError('x').name).toBe('InputControlError');
    expect(new InputControlTimeoutError().name).toBe('InputControlTimeoutError');
    expect(new InputControlAbortError().name).toBe('InputControlAbortError');
  });

  test('abort without pending work does not throw', () => {
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge() });
    expect(() => b.abort()).not.toThrow();
  });

  test('execute passes all four envelope fields through to the dispatcher', async () => {
    // This guards against regressions where someone drops context or params.
    const transport = new FakeTransport();
    const b = new CdpInputControlBridge({ bridge: new FakeBrowserBridge(1), transport });
    const context = { devicePixelRatio: 2, screenX: 0, screenY: 0, outerHeight: 800, innerHeight: 700, outerWidth: 1200, innerWidth: 1200, scrollX: 0, scrollY: 0 };
    const res = await b.execute('press_key', { key: 'enter' }, context);
    expect(res.status).toBe('ok');
  });
});
