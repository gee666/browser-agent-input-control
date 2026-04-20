// Test fakes shared across spec files.

export class FakeTransport {
  constructor() {
    this.calls = []; // [{ method, params, tabId }]
    this.attached = new Set();
    this.disposed = false;
    this.failNext = null;
  }
  async ensureAttached(tabId) {
    this.attached.add(tabId);
  }
  async send(tabId, method, params) {
    this.attached.add(tabId);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.calls.push({ tabId, method, params });
    return {};
  }
  async detach(tabId) {
    if (tabId == null) this.attached.clear();
    else this.attached.delete(tabId);
  }
  dispose() {
    this.disposed = true;
  }
  isAttached(tabId) {
    return this.attached.has(tabId);
  }
  reset() {
    this.calls = [];
  }
  calledWith(method) {
    return this.calls.filter((c) => c.method === method);
  }
}

export class FakeBrowserBridge {
  constructor(tabId = 42) {
    this.tabId = tabId;
    this.getActiveTabIdCalls = 0;
  }
  async getActiveTabId() {
    this.getActiveTabIdCalls++;
    return this.tabId;
  }
}

// Deterministic RNG for motion tests — predictable, no noise.
export class DeterministicRng {
  constructor(seed = 1) {
    let a = seed >>> 0;
    this._next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  random() {
    return this._next();
  }
  uniform(a, b) {
    return a + (b - a) * this._next();
  }
  gauss() {
    // Centered to 0 so path jitter stays tiny and bounded by buildMousePath's clamp.
    return 0;
  }
  randint(a, b) {
    return a + Math.floor(this._next() * (b - a + 1));
  }
}
