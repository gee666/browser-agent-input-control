// Wraps chrome.debugger so backends can send CDP commands without caring
// about attach/detach bookkeeping. Exposes a small surface so tests can
// swap in a FakeTransport.

import { InputControlError } from './errors.js';

const DEBUGGER_PROTOCOL_VERSION = '1.3';

/**
 * @typedef {Object} ChromeDebuggerLike
 * @property {(target: object, version: string) => Promise<void>} attach
 * @property {(target: object) => Promise<void>} detach
 * @property {(target: object, method: string, params?: object) => Promise<any>} sendCommand
 * @property {{ addListener: Function, removeListener: Function }} [onDetach]
 */

export class DebuggerTransport {
  /**
   * @param {{ debuggerApi?: ChromeDebuggerLike, inspector?: object }} [options]
   */
  constructor(options = {}) {
    this._inspector = options.inspector || null;
    this._api = options.debuggerApi || (typeof chrome !== 'undefined' ? chrome.debugger : null);
    if (!this._api && !this._inspector) {
      // Don't throw here — test code may inject a fake transport instead of
      // going through this class. Real constructions without chrome.debugger
      // will surface an error on the first attach attempt.
    }
    this._attached = new Set(); // Set<number> of tabIds we attached ourselves.
    this._leases = new Map();
    this._pendingLeases = new Map();
    this._pendingDirectAttach = new Map();
    this._tabGenerations = new Map();
    this._inFlight = new Map();
    this._detaching = new Set();
    this._onDetachHandler = null;
    if (!this._inspector && this._api && this._api.onDetach && typeof this._api.onDetach.addListener === 'function') {
      this._onDetachHandler = (source, _reason) => {
        if (source && typeof source.tabId === 'number') {
          this._attached.delete(source.tabId);
        }
      };
      this._api.onDetach.addListener(this._onDetachHandler);
    }
  }

  _wrapInspectorError(err) {
    if (err instanceof InputControlError) return err;
    return new InputControlError(err && err.message ? err.message : String(err));
  }

  _trackInFlight(tabId, promise, wrapError = (err) => err) {
    let inFlight = this._inFlight.get(tabId);
    if (!inFlight) {
      inFlight = new Set();
      this._inFlight.set(tabId, inFlight);
    }
    inFlight.add(promise);
    return promise
      .catch((err) => {
        throw wrapError(err);
      })
      .finally(() => {
        inFlight.delete(promise);
        if (inFlight.size === 0) {
          this._inFlight.delete(tabId);
        }
      });
  }

  /** Ensure we are attached to the given tab. No-op if already attached. */
  async ensureAttached(tabId) {
    if (typeof tabId !== 'number') {
      throw new InputControlError('tabId must be a number');
    }
    if (this._detaching.has(tabId)) {
      throw new InputControlError('Debugger transport detached');
    }
    if (this._inspector) {
      try {
        const generation = this._tabGenerations.get(tabId) || 0;
        if (this._leases.has(tabId)) {
        if (typeof this._inspector.isAttached !== 'function' || this._inspector.isAttached(tabId)) {
          return;
        }
        if (typeof this._inspector.ensureAttached === 'function') {
          await this._inspector.ensureAttached(tabId, { requireLease: true });
          if ((this._tabGenerations.get(tabId) || 0) !== generation || !this._leases.has(tabId)) {
            throw new InputControlError('Debugger transport detached');
          }
          this._attached.add(tabId);
          return;
        }
      }
      let pending = this._pendingLeases.get(tabId);
      if (!pending) {
        pending = { cancelled: false, promise: null };
        pending.promise = Promise.resolve()
          .then(() => this._inspector.acquire(tabId))
          .then(async (lease) => {
            if (pending.cancelled) {
              await this._inspector.release(lease);
              return null;
            }
            this._leases.set(tabId, lease);
            this._attached.add(tabId);
            return lease;
          })
          .finally(() => {
            if (this._pendingLeases.get(tabId) === pending) {
              this._pendingLeases.delete(tabId);
            }
          });
        this._pendingLeases.set(tabId, pending);
      }
        await pending.promise;
        if (!this._leases.has(tabId)) {
          throw new InputControlError('Debugger transport detached');
        }
        return;
      } catch (err) {
        throw this._wrapInspectorError(err);
      }
    }
    if (!this._api) {
      throw new InputControlError('chrome.debugger API is unavailable');
    }
    const generation = this._tabGenerations.get(tabId) || 0;
    if (this._attached.has(tabId)) return;
    let pending = this._pendingDirectAttach.get(tabId);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this._api.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION))
        .then(() => {
          this._attached.add(tabId);
        })
        .catch((err) => {
          throw new InputControlError(
            `Failed to attach debugger to tab ${tabId}: ${err && err.message ? err.message : err}`
          );
        })
        .finally(() => {
          if (this._pendingDirectAttach.get(tabId) === pending) {
            this._pendingDirectAttach.delete(tabId);
          }
        });
      this._pendingDirectAttach.set(tabId, pending);
    }
    await pending;
    if ((this._tabGenerations.get(tabId) || 0) !== generation || this._detaching.has(tabId)) {
      throw new InputControlError('Debugger transport detached');
    }
  }

  /** Send a CDP command on the given tab; attach first if needed. */
  async send(tabId, method, params = {}) {
    const generation = this._tabGenerations.get(tabId) || 0;
    await this.ensureAttached(tabId);
    if ((this._tabGenerations.get(tabId) || 0) !== generation || this._detaching.has(tabId)) {
      throw new InputControlError('Debugger transport detached');
    }
    if (this._inspector) {
      if (!this._leases.has(tabId)) {
        throw new InputControlError('Debugger transport detached');
      }
      const beforeSend = () => {
        if ((this._tabGenerations.get(tabId) || 0) !== generation || this._detaching.has(tabId) || !this._leases.has(tabId)) {
          throw new InputControlError('Debugger transport detached');
        }
      };
      const call = typeof this._inspector.sendCommand === 'function'
        ? this._inspector.sendCommand(tabId, method, params, { beforeSend, requireLease: true })
        : this._inspector.send(tabId, method, params);
      return this._trackInFlight(tabId, call, (err) => this._wrapInspectorError(err));
    }
    try {
      const call = this._api.sendCommand({ tabId }, method, params);
      return await this._trackInFlight(tabId, call);
    } catch (err) {
      throw new InputControlError(
        `CDP command ${method} failed: ${err && err.message ? err.message : err}`
      );
    }
  }

  /** Detach from a single tab (or all attached tabs). */
  async detach(tabId) {
    const targets = tabId != null
      ? [tabId]
      : [...new Set([...this._attached, ...this._leases.keys(), ...this._pendingLeases.keys(), ...this._pendingDirectAttach.keys(), ...this._inFlight.keys()])];
    for (const id of targets) {
      this._tabGenerations.set(id, (this._tabGenerations.get(id) || 0) + 1);
      this._detaching.add(id);
    }
    if (this._inspector) {
      for (const id of targets) {
        const pending = this._pendingLeases.get(id);
        if (pending) pending.cancelled = true;
        const lease = this._leases.get(id);
        if (!lease && pending) {
          try {
            await pending.promise;
          } catch {
            // ignore attach failures during cleanup
          }
        }
        const inFlight = this._inFlight.get(id);
        if (inFlight && inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
        this._leases.delete(id);
        this._attached.delete(id);
        if (lease) {
          await this._inspector.release(lease);
        }
      }
      for (const id of targets) {
        this._detaching.delete(id);
      }
      return;
    }
    if (!this._api) {
      for (const id of targets) {
        this._detaching.delete(id);
      }
      return;
    }
    for (const id of targets) {
      this._attached.delete(id);
      const pendingAttach = this._pendingDirectAttach.get(id);
      if (pendingAttach) {
        try {
          await pendingAttach;
        } catch {
          // ignore attach failures during cleanup
        }
      }
      const inFlight = this._inFlight.get(id);
      if (inFlight && inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      try {
        await this._api.detach({ tabId: id });
      } catch {
        // ignore — tab may already be gone
      } finally {
        this._detaching.delete(id);
      }
    }
  }

  /** Fully tear down state and stop listening for onDetach events. */
  async dispose() {
    if (this._inspector) {
      for (const id of new Set([...this._attached, ...this._leases.keys(), ...this._pendingLeases.keys(), ...this._inFlight.keys()])) {
        this._tabGenerations.set(id, (this._tabGenerations.get(id) || 0) + 1);
      }
    }
    const finalize = () => {
      if (this._api && this._onDetachHandler && this._api.onDetach && typeof this._api.onDetach.removeListener === 'function') {
        this._api.onDetach.removeListener(this._onDetachHandler);
      }
      this._onDetachHandler = null;
      this._attached.clear();
      this._leases.clear();
      this._pendingLeases.clear();
      this._pendingDirectAttach.clear();
      this._tabGenerations.clear();
      this._inFlight.clear();
      this._detaching.clear();
    };
    const needsAsyncCleanup = this._inspector
      ? (this._leases.size > 0 || this._pendingLeases.size > 0 || this._inFlight.size > 0)
      : (this._attached.size > 0 || this._pendingDirectAttach.size > 0 || this._inFlight.size > 0);
    if (needsAsyncCleanup) {
      try {
        await this.detach();
      } catch {
        // ignore cleanup failures during disposal
      } finally {
        finalize();
      }
      return;
    }
    finalize();
  }

  /** Is this transport currently attached to the given tab? */
  isAttached(tabId) {
    if (this._inspector) {
      return this._leases.has(tabId)
        && (typeof this._inspector.isAttached !== 'function' || this._inspector.isAttached(tabId));
    }
    return this._attached.has(tabId);
  }
}
