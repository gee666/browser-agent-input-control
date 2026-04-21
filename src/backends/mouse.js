// Mouse backend — dispatches mouse moves/clicks/scrolls via CDP
// (Input.dispatchMouseEvent). Motion is humanised through mouse-motion.js.

import { cancellableSleep, throwIfCancelled } from '../cancel.js';
import {
  buildMousePath,
  buildScrollSteps,
  defaultClickHoldMs,
  defaultDoubleClickIntervalMs,
  distanceBetweenPoints,
} from '../mouse-motion.js';
import { estimateMouseDurationMs } from '../timing.js';
import { InputControlError } from '../errors.js';

function mouseEvent(type, x, y, extras = {}) {
  return {
    type,
    x,
    y,
    ...extras,
  };
}

export class CdpMouseBackend {
  constructor({ transport, rng, getTabId } = {}) {
    this._transport = transport;
    this._rng = rng;
    // Legacy getTabId() hook — only consulted when the dispatcher didn't
    // supply a command-scoped tabId (older callers / direct unit-test usage).
    this._legacyGetTabId = typeof getTabId === 'function' ? getTabId : null;
    // Cursor history is kept per-tab-id. A command that starts on tab B can
    // never inherit coordinates that belonged to tab A.
    this._lastPoints = new Map(); // Map<number, {x, y}>
  }

  /** Clear all cached cursor positions (called on abort / detach). */
  resetState() {
    this._lastPoints.clear();
  }

  /** Drop cursor history for a single tab (e.g. active-tab changed). */
  forgetTab(tabId) {
    this._lastPoints.delete(tabId);
  }

  _resolveTabId(execContext) {
    if (execContext && typeof execContext.tabId === 'number') return execContext.tabId;
    if (this._legacyGetTabId) {
      const tabId = this._legacyGetTabId();
      if (typeof tabId !== 'number') {
        throw new InputControlError('No active tab resolved for CDP command');
      }
      return tabId;
    }
    throw new InputControlError('No active tab resolved for CDP command');
  }

  _getLastPoint(tabId) {
    return this._lastPoints.get(tabId) || { x: 0, y: 0 };
  }

  _setLastPoint(tabId, point) {
    this._lastPoints.set(tabId, { x: point.x, y: point.y });
  }

  async _dispatch(tabId, method, params) {
    return this._transport.send(tabId, method, params);
  }

  async _dispatchMouseEvent(tabId, params) {
    return this._dispatch(tabId, 'Input.dispatchMouseEvent', params);
  }

  async move(command, signal, execContext) {
    throwIfCancelled(signal);
    const tabId = this._resolveTabId(execContext);
    const target = { x: command.x, y: command.y };
    const lastPoint = this._getLastPoint(tabId);
    const distance = distanceBetweenPoints(lastPoint, target);

    // Zero-distance OR explicit instant-teleport: emit exactly one
    // mouseMoved event at the target coordinates and bail out. The protocol
    // says duration_ms === 0 MUST NOT emit intermediate hover events.
    if (distance < 1 || command.durationMs === 0) {
      await this._dispatchMouseEvent(tabId, mouseEvent('mouseMoved', target.x, target.y));
      this._setLastPoint(tabId, target);
      return;
    }

    const path = buildMousePath(lastPoint, target, this._rng);
    const durationMs = command.durationMs != null ? command.durationMs : estimateMouseDurationMs(distance);
    const perStepDelay = path.length > 1 ? durationMs / (path.length - 1) : 0;
    for (let i = 0; i < path.length; i++) {
      throwIfCancelled(signal);
      const p = path[i];
      await this._dispatchMouseEvent(tabId, mouseEvent('mouseMoved', p.x, p.y));
      if (i < path.length - 1 && perStepDelay > 0) {
        await cancellableSleep(perStepDelay, signal);
      }
    }
    this._setLastPoint(tabId, target);
  }

  async click(command, signal, execContext) {
    const tabId = this._resolveTabId(execContext);
    // Move to the target using the same humanised path logic. Zero move
    // duration now correctly short-circuits to a single mouseMoved event.
    await this.move({ x: command.x, y: command.y, durationMs: command.moveDurationMs }, signal, execContext);

    const button = command.button;
    const count = command.count || 1;
    const holdMs = command.holdMs != null ? command.holdMs : defaultClickHoldMs(this._rng);
    const intervalMs =
      command.intervalMs != null ? command.intervalMs : defaultDoubleClickIntervalMs(this._rng);

    for (let i = 0; i < count; i++) {
      throwIfCancelled(signal);
      const clickCount = i + 1;
      await this._dispatchMouseEvent(tabId, mouseEvent('mousePressed', command.x, command.y, { button, clickCount, buttons: buttonsMaskFor(button) }));
      await cancellableSleep(holdMs, signal);
      await this._dispatchMouseEvent(tabId, mouseEvent('mouseReleased', command.x, command.y, { button, clickCount }));
      if (i < count - 1) {
        await cancellableSleep(intervalMs, signal);
      }
    }
  }

  async scroll(command, signal, execContext) {
    const tabId = this._resolveTabId(execContext);
    // Move to scroll anchor first.
    await this.move({ x: command.x, y: command.y, durationMs: null }, signal, execContext);
    const steps = buildScrollSteps(command.deltaX, command.deltaY, this._rng, {
      durationMs: command.durationMs,
    });
    if (steps.length === 0) return;
    for (let i = 0; i < steps.length; i++) {
      throwIfCancelled(signal);
      const step = steps[i];
      if (step.deltaX === 0 && step.deltaY === 0 && i !== steps.length - 1) {
        if (step.delayMs > 0) await cancellableSleep(step.delayMs, signal);
        continue;
      }
      await this._dispatchMouseEvent(
        tabId,
        mouseEvent('mouseWheel', command.x, command.y, {
          deltaX: step.deltaX,
          deltaY: step.deltaY,
        })
      );
      if (i < steps.length - 1 && step.delayMs > 0) {
        await cancellableSleep(step.delayMs, signal);
      }
    }
  }
}

function buttonsMaskFor(button) {
  switch (button) {
    case 'left':
      return 1;
    case 'right':
      return 2;
    case 'middle':
      return 4;
    default:
      return 0;
  }
}
