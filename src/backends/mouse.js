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

function mouseEvent(type, x, y, extras = {}) {
  return {
    type,
    x,
    y,
    ...extras,
  };
}

export class CdpMouseBackend {
  constructor({ transport, getTabId, rng }) {
    this._transport = transport;
    this._getTabId = getTabId;
    this._rng = rng;
    this._lastPoint = { x: 0, y: 0 };
  }

  async _dispatch(method, params) {
    const tabId = this._getTabId();
    return this._transport.send(tabId, method, params);
  }

  async _dispatchMouseEvent(params) {
    return this._dispatch('Input.dispatchMouseEvent', params);
  }

  async move(command, signal) {
    throwIfCancelled(signal);
    const target = { x: command.x, y: command.y };
    const distance = distanceBetweenPoints(this._lastPoint, target);
    if (distance < 1) {
      await this._dispatchMouseEvent(mouseEvent('mouseMoved', target.x, target.y));
      this._lastPoint = target;
      return;
    }
    const path = buildMousePath(this._lastPoint, target, this._rng);
    const durationMs = command.durationMs != null ? command.durationMs : estimateMouseDurationMs(distance);
    const perStepDelay = path.length > 1 ? durationMs / (path.length - 1) : 0;
    for (let i = 0; i < path.length; i++) {
      throwIfCancelled(signal);
      const p = path[i];
      await this._dispatchMouseEvent(mouseEvent('mouseMoved', p.x, p.y));
      if (i < path.length - 1 && perStepDelay > 0) {
        await cancellableSleep(perStepDelay, signal);
      }
    }
    this._lastPoint = target;
  }

  async click(command, signal) {
    // Move to the target using the same humanised path logic.
    await this.move({ x: command.x, y: command.y, durationMs: command.moveDurationMs }, signal);

    const button = command.button;
    const count = command.count || 1;
    const holdMs = command.holdMs != null ? command.holdMs : defaultClickHoldMs(this._rng);
    const intervalMs =
      command.intervalMs != null ? command.intervalMs : defaultDoubleClickIntervalMs(this._rng);

    for (let i = 0; i < count; i++) {
      throwIfCancelled(signal);
      const clickCount = i + 1;
      await this._dispatchMouseEvent(mouseEvent('mousePressed', command.x, command.y, { button, clickCount, buttons: buttonsMaskFor(button) }));
      await cancellableSleep(holdMs, signal);
      await this._dispatchMouseEvent(mouseEvent('mouseReleased', command.x, command.y, { button, clickCount }));
      if (i < count - 1) {
        await cancellableSleep(intervalMs, signal);
      }
    }
  }

  async scroll(command, signal) {
    // Move to scroll anchor first.
    await this.move({ x: command.x, y: command.y, durationMs: null }, signal);
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
