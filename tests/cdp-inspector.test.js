import { describe, expect, test } from '@jest/globals';
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
    this._detachWait = null;
  }

  async attach(target, version) {
    this.attachCalls.push({ target, version });
    if (this._attachWait) {
      await this._attachWait;
    }
  }

  async detach(target) {
    this.detachCalls.push(target);
    if (this._detachWait) {
      await this._detachWait;
    }
    this.onDetach.emit(target, 'target_closed');
  }

  async sendCommand(target, method, params) {
    this.sendCalls.push({ target, method, params });
    return { ok: true };
  }
}

describe('CdpInspector', () => {
  test('ensureAttached and sendCommand work on a cold tab without an explicit lease', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });

    await inspector.ensureAttached(8);
    await inspector.sendCommand(8, 'Runtime.evaluate', { expression: '8' });

    expect(api.attachCalls).toHaveLength(1);
    expect(api.sendCalls).toEqual([
      { target: { tabId: 8 }, method: 'Runtime.evaluate', params: { expression: '8' } },
    ]);
  });

  test('shares a single attach under contention and detaches on final release', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });

    const [leaseA, leaseB] = await Promise.all([inspector.acquire(9), inspector.acquire(9)]);

    expect(api.attachCalls).toHaveLength(1);
    await inspector.send(9, 'Runtime.evaluate', { expression: '1' });
    expect(api.sendCalls).toHaveLength(1);

    await inspector.release(leaseA);
    expect(api.detachCalls).toHaveLength(0);

    await inspector.release(leaseB);
    expect(api.detachCalls).toEqual([{ tabId: 9 }]);
  });

  test('external detach clears attached state and avoids duplicate detach on release', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });

    const lease = await inspector.acquire(4);
    expect(api.attachCalls).toHaveLength(1);

    api.onDetach.emit({ tabId: 4 }, 'canceled_by_user');
    await inspector.release(lease);
    expect(api.detachCalls).toHaveLength(0);

    const lease2 = await inspector.acquire(4);
    expect(api.attachCalls).toHaveLength(2);
    await inspector.release(lease2);
    expect(api.detachCalls).toEqual([{ tabId: 4 }]);
  });

  test('waits for final detach before allowing a new acquire on the same tab', async () => {
    const api = new FakeDebuggerApi();
    let resolveDetach;
    api._detachWait = new Promise((resolve) => {
      resolveDetach = resolve;
    });
    const inspector = new CdpInspector({ debuggerApi: api });

    const lease = await inspector.acquire(6);
    const releasePromise = inspector.release(lease);
    const reacquirePromise = inspector.acquire(6);

    await Promise.resolve();
    expect(api.attachCalls).toHaveLength(1);

    resolveDetach();
    const lease2 = await reacquirePromise;
    await releasePromise;

    expect(api.detachCalls).toEqual([{ tabId: 6 }]);
    expect(api.attachCalls).toHaveLength(2);
    await inspector.release(lease2);
    expect(api.detachCalls).toEqual([{ tabId: 6 }, { tabId: 6 }]);
  });

  test('send without a retained lease uses a temporary lease and cleans it up', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });

    await inspector.send(10, 'Runtime.evaluate', { expression: '7' });

    expect(api.attachCalls).toHaveLength(1);
    expect(api.sendCalls).toEqual([
      { target: { tabId: 10 }, method: 'Runtime.evaluate', params: { expression: '7' } },
    ]);
    expect(api.detachCalls).toEqual([{ tabId: 10 }]);
    expect(inspector.isAttached(10)).toBe(false);
  });

  test('concurrent direct sends each retain the shared session until they finish', async () => {
    const api = new FakeDebuggerApi();
    const completions = [];
    api.sendCommand = async (target, method, params) => {
      api.sendCalls.push({ target, method, params });
      await new Promise((resolve) => {
        completions.push(resolve);
      });
      return { ok: true };
    };
    const inspector = new CdpInspector({ debuggerApi: api });

    const first = inspector.send(12, 'Runtime.evaluate', { expression: '1' });
    const second = inspector.send(12, 'Runtime.evaluate', { expression: '2' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    completions[0]();
    await Promise.resolve();
    expect(api.detachCalls).toHaveLength(0);

    completions[1]();
    await Promise.all([first, second]);
    expect(api.detachCalls).toEqual([{ tabId: 12 }]);
  });

  test('dispose detaches any live debugger sessions', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });

    await inspector.acquire(11);
    await inspector.dispose();

    expect(api.detachCalls).toEqual([{ tabId: 11 }]);
  });

  test('dispose during a pending attach prevents the send from running', async () => {
    const api = new FakeDebuggerApi();
    let resolveAttach;
    api._attachWait = new Promise((resolve) => {
      resolveAttach = resolve;
    });
    const inspector = new CdpInspector({ debuggerApi: api });

    const sendPromise = inspector.send(14, 'Runtime.evaluate', { expression: '14' });
    await Promise.resolve();
    const disposePromise = inspector.dispose();
    resolveAttach();

    await expect(sendPromise).rejects.toThrow('CdpInspector has been disposed');
    await disposePromise;
    expect(api.sendCalls).toHaveLength(0);
  });

  test('dispose while reacquire is waiting behind a detach does not start a new attach', async () => {
    const api = new FakeDebuggerApi();
    let resolveDetach;
    api._detachWait = new Promise((resolve) => {
      resolveDetach = resolve;
    });
    const inspector = new CdpInspector({ debuggerApi: api });

    const lease = await inspector.acquire(15);
    const releasePromise = inspector.release(lease);
    const reacquirePromise = inspector.acquire(15);
    await Promise.resolve();
    const disposePromise = inspector.dispose();
    resolveDetach();

    await expect(reacquirePromise).rejects.toThrow('CdpInspector has been disposed');
    await Promise.all([releasePromise, disposePromise]);
    expect(api.attachCalls).toHaveLength(1);
  });

  test('dispose is terminal and stale leases cannot affect future state', async () => {
    const api = new FakeDebuggerApi();
    const inspector = new CdpInspector({ debuggerApi: api });
    const lease = await inspector.acquire(13);

    await inspector.dispose();
    await inspector.release(lease);

    await expect(inspector.acquire(13)).rejects.toThrow('CdpInspector has been disposed');
    expect(api.detachCalls).toEqual([{ tabId: 13 }]);
  });
});
