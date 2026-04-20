import { describe, expect, test } from '@jest/globals';
import { CommandCancelledError, cancellableSleep, throwIfCancelled } from '../src/cancel.js';
import { CdpInputControlBridge } from '../src/bridge.js';
import { FakeBrowserBridge, FakeTransport } from './_fakes.js';

describe('cancellableSleep', () => {
  test('resolves after the delay when not aborted', async () => {
    const start = Date.now();
    await cancellableSleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  test('rejects with CommandCancelledError when signal aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(cancellableSleep(1000, controller.signal)).rejects.toBeInstanceOf(CommandCancelledError);
  });

  test('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(cancellableSleep(100, controller.signal)).rejects.toThrow(CommandCancelledError);
  });
});

describe('throwIfCancelled', () => {
  test('throws when aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfCancelled(controller.signal)).toThrow(CommandCancelledError);
  });

  test('does nothing when not aborted', () => {
    const controller = new AbortController();
    expect(() => throwIfCancelled(controller.signal)).not.toThrow();
  });
});

describe('CdpInputControlBridge.abort', () => {
  test('rejects a long type() with InputControlAbortError after abort', async () => {
    const transport = new FakeTransport();
    const bridge = new CdpInputControlBridge({
      bridge: new FakeBrowserBridge(77),
      transport,
    });
    const longText = 'a'.repeat(200);
    const promise = bridge.execute('type', { text: longText, wpm: 30 }, {});
    await new Promise((r) => setTimeout(r, 50));
    bridge.abort();
    await expect(promise).rejects.toMatchObject({ name: 'InputControlAbortError' });
  });

  test('no further CDP calls are recorded after abort', async () => {
    const transport = new FakeTransport();
    const bridge = new CdpInputControlBridge({
      bridge: new FakeBrowserBridge(77),
      transport,
    });
    const promise = bridge.execute('type', { text: 'abcdefghij'.repeat(20), wpm: 30 }, {});
    await new Promise((r) => setTimeout(r, 50));
    bridge.abort();
    await expect(promise).rejects.toMatchObject({ name: 'InputControlAbortError' });
    const beforeAbortCount = transport.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(transport.calls.length).toBe(beforeAbortCount);
  });
});
