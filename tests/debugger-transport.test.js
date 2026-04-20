import { describe, expect, test } from '@jest/globals';
import { DebuggerTransport } from '../src/debugger-transport.js';
import { CdpInspector } from '../../pi-browser-agent-bridge/src/cdp-inspector.js';

function createListenerBag() {
  const listeners = new Set();
  return {
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of [...listeners]) fn(...args);
    },
  };
}

class FakeDebuggerApi {
  constructor() {
    this.attachCalls = [];
    this.detachCalls = [];
    this.sendCalls = [];
    this.onDetach = createListenerBag();
    this.onEvent = createListenerBag();
    this._attachWait = null;
  }

  async attach(target, version) {
    this.attachCalls.push({ target, version });
    if (this._attachWait) {
      await this._attachWait;
    }
  }

  async detach(target) {
    this.detachCalls.push(target);
    this.onDetach.emit(target, 'target_closed');
  }

  async sendCommand(target, method, params) {
    this.sendCalls.push({ target, method, params });
    return { method, params };
  }
}

describe('DebuggerTransport', () => {
  test('uses an injected inspector without changing legacy detach semantics', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const transportA = new DebuggerTransport({ inspector });
    const transportB = new DebuggerTransport({ inspector });

    await Promise.all([
      transportA.send(12, 'Input.dispatchMouseEvent', { type: 'mouseMoved' }),
      transportB.send(12, 'Input.dispatchMouseEvent', { type: 'mouseMoved' }),
    ]);

    expect(api.attachCalls).toHaveLength(1);
    expect(transportA.isAttached(12)).toBe(true);
    expect(transportB.isAttached(12)).toBe(true);

    await transportA.detach();
    expect(api.detachCalls).toHaveLength(0);
    expect(transportB.isAttached(12)).toBe(true);

    await transportB.detach();
    expect(api.detachCalls).toEqual([{ tabId: 12 }]);
  });

  test('re-attaches through the inspector after an external detach', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    await transport.send(5, 'Runtime.evaluate', { expression: '1' });
    api.onDetach.emit({ tabId: 5 }, 'replaced_with_devtools');

    expect(transport.isAttached(5)).toBe(false);
    await transport.ensureAttached(5);

    expect(api.attachCalls).toHaveLength(2);
    await transport.detach();
    expect(api.detachCalls).toEqual([{ tabId: 5 }]);
  });

  test('detach during an inspector reattach does not leak an orphaned debugger session', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    await transport.send(6, 'Runtime.evaluate', { expression: '1' });
    api.onDetach.emit({ tabId: 6 }, 'replaced_with_devtools');
    let resolveAttach;
    api._attachWait = new Promise((resolve) => {
      resolveAttach = resolve;
    });

    const ensurePromise = transport.ensureAttached(6);
    await Promise.resolve();
    const detachPromise = transport.detach();
    resolveAttach();

    await expect(ensurePromise).rejects.toThrow(/released before it completed|Debugger transport detached/);
    await detachPromise;
    expect(transport.isAttached(6)).toBe(false);
    expect(api.attachCalls).toHaveLength(2);
    expect(api.detachCalls).toEqual([{ tabId: 6 }]);
  });

  test('detach-all waits for pending inspector acquires and does not resurrect attachments', async () => {
    const api = new FakeDebuggerApi();
    let resolveAttach;
    api._attachWait = new Promise((resolve) => {
      resolveAttach = resolve;
    });
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    const ensurePromise = transport.ensureAttached(8);
    await Promise.resolve();
    const detachPromise = transport.detach();
    resolveAttach();

    await expect(ensurePromise).rejects.toThrow('Debugger transport detached');
    await detachPromise;

    expect(api.attachCalls).toHaveLength(1);
    expect(api.detachCalls).toEqual([{ tabId: 8 }]);
    expect(transport.isAttached(8)).toBe(false);
  });

  test('send does not dispatch after detach wins a pending attach race', async () => {
    const api = new FakeDebuggerApi();
    let resolveAttach;
    api._attachWait = new Promise((resolve) => {
      resolveAttach = resolve;
    });
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    const sendPromise = transport.send(13, 'Runtime.evaluate', { expression: '3' });
    await Promise.resolve();
    const detachPromise = transport.detach();
    resolveAttach();

    await expect(sendPromise).rejects.toThrow('Debugger transport detached');
    await detachPromise;
    expect(api.sendCalls).toHaveLength(0);
    expect(api.detachCalls).toEqual([{ tabId: 13 }]);
  });

  test('send does not reacquire after detach wins when a lease already existed', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    await transport.ensureAttached(15);
    const sendPromise = transport.send(15, 'Runtime.evaluate', { expression: '5' });
    await Promise.resolve();
    await transport.detach();

    await expect(sendPromise).rejects.toThrow('Debugger transport detached');
    expect(api.sendCalls).toHaveLength(0);
    expect(api.detachCalls).toEqual([{ tabId: 15 }]);
  });

  test('detaching one tab does not invalidate in-flight work on another tab', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    await transport.ensureAttached(20);
    await transport.ensureAttached(21);
    const sendPromise = transport.send(20, 'Runtime.evaluate', { expression: '20' });
    await transport.detach(21);

    await expect(sendPromise).resolves.toEqual({
      method: 'Runtime.evaluate',
      params: { expression: '20' },
    });
    expect(api.sendCalls).toContainEqual({
      target: { tabId: 20 },
      method: 'Runtime.evaluate',
      params: { expression: '20' },
    });
  });

  test('detach waits for in-flight inspector sends to finish before resolving', async () => {
    const api = new FakeDebuggerApi();
    let resolveSend;
    api.sendCommand = async (target, method, params) => {
      api.sendCalls.push({ target, method, params });
      await new Promise((resolve) => {
        resolveSend = resolve;
      });
      return { method, params };
    };
    const inspector = new CdpInspector({ debuggerApi: api });
    const transport = new DebuggerTransport({ inspector });

    await transport.ensureAttached(16);
    const sendPromise = transport.send(16, 'Runtime.evaluate', { expression: '16' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let detached = false;
    const detachPromise = transport.detach().then(() => {
      detached = true;
    });
    await Promise.resolve();
    expect(detached).toBe(false);

    resolveSend();
    await Promise.all([sendPromise, detachPromise]);
    expect(api.detachCalls).toEqual([{ tabId: 16 }]);
  });

  test('dispose releases shared inspector leases so another transport can detach cleanly', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const transportA = new DebuggerTransport({ inspector });
    const transportB = new DebuggerTransport({ inspector });

    await transportA.send(14, 'Runtime.evaluate', { expression: '1' });
    await transportB.send(14, 'Runtime.evaluate', { expression: '2' });

    await transportA.dispose();
    await transportB.detach();

    expect(api.detachCalls).toEqual([{ tabId: 14 }]);
  });

  test('keeps existing direct chrome.debugger behavior when no inspector is passed', async () => {
    const api = new FakeDebuggerApi();
    const transport = new DebuggerTransport({ debuggerApi: api });

    const result = await transport.send(3, 'Runtime.evaluate', { expression: '2 + 2' });

    expect(result).toEqual({ method: 'Runtime.evaluate', params: { expression: '2 + 2' } });
    expect(api.attachCalls).toEqual([{ target: { tabId: 3 }, version: '1.3' }]);
    expect(api.sendCalls).toEqual([
      { target: { tabId: 3 }, method: 'Runtime.evaluate', params: { expression: '2 + 2' } },
    ]);

    await transport.detach();
    expect(api.detachCalls).toEqual([{ tabId: 3 }]);
  });

  test('direct debugger path does not send after detach wins the race', async () => {
    const api = new FakeDebuggerApi();
    let resolveDetach;
    api.detach = async (target) => {
      api.detachCalls.push(target);
      await new Promise((resolve) => {
        resolveDetach = resolve;
      });
      api.onDetach.emit(target, 'target_closed');
    };
    const transport = new DebuggerTransport({ debuggerApi: api });

    await transport.ensureAttached(22);
    const sendPromise = transport.send(22, 'Runtime.evaluate', { expression: '22' });
    const detachPromise = transport.detach();
    resolveDetach();

    await expect(sendPromise).rejects.toThrow('Debugger transport detached');
    await detachPromise;
    expect(api.sendCalls).toEqual([]);
    expect(api.detachCalls).toEqual([{ tabId: 22 }]);
  });

  test('direct debugger path cleans up a first attach that is still pending during detach', async () => {
    const api = new FakeDebuggerApi();
    let resolveAttach;
    api._attachWait = new Promise((resolve) => {
      resolveAttach = resolve;
    });
    const transport = new DebuggerTransport({ debuggerApi: api });

    const sendPromise = transport.send(23, 'Runtime.evaluate', { expression: '23' });
    await Promise.resolve();
    const detachPromise = transport.detach();
    resolveAttach();

    await expect(sendPromise).rejects.toThrow('Debugger transport detached');
    await detachPromise;
    expect(api.sendCalls).toEqual([]);
    expect(api.detachCalls).toEqual([{ tabId: 23 }]);
  });

  test('dispose during a pending direct attach still performs cleanup', async () => {
    const api = new FakeDebuggerApi();
    let resolveAttach;
    api._attachWait = new Promise((resolve) => {
      resolveAttach = resolve;
    });
    const transport = new DebuggerTransport({ debuggerApi: api });

    const ensurePromise = transport.ensureAttached(24);
    await Promise.resolve();
    const disposePromise = transport.dispose();
    resolveAttach();

    await expect(ensurePromise).rejects.toThrow('Debugger transport detached');
    await disposePromise;
    expect(transport.isAttached(24)).toBe(false);
    expect(api.detachCalls).toEqual([{ tabId: 24 }]);
  });
});
