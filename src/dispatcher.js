// Validation + routing for the input-control protocol.
//
// Mirrors the behaviour of python-input-control/src/python_input_control/dispatch.py,
// minus the native-messaging framing.

import { InputControlError } from './errors.js';

const SUPPORTED_COMMANDS = new Set([
  'mouse_move',
  'mouse_click',
  'scroll',
  'type',
  'press_key',
  'press_shortcut',
  'pause',
  'sequence',
]);

const MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);

function vErr(message, commandId = null) {
  return new InputControlError(message, commandId);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function requireNumber(params, field, commandId) {
  if (!(field in params)) throw vErr(`Missing required field '${field}'`, commandId);
  const v = params[field];
  if (typeof v === 'boolean' || typeof v !== 'number') {
    throw vErr(`Field '${field}' must be a number`, commandId);
  }
  if (!Number.isFinite(v)) throw vErr(`Field '${field}' must be finite`, commandId);
  return v;
}

function optionalPositiveInt(params, field, commandId) {
  if (!(field in params) || params[field] == null) return null;
  const v = params[field];
  if (typeof v === 'boolean' || typeof v !== 'number' || !Number.isFinite(v)) {
    throw vErr(`Field '${field}' must be a positive integer`, commandId);
  }
  const i = Math.trunc(v);
  if (i <= 0 || i !== v) throw vErr(`Field '${field}' must be a positive integer`, commandId);
  return i;
}

function optionalNonNegativeInt(params, field, commandId) {
  if (!(field in params) || params[field] == null) return null;
  const v = params[field];
  if (typeof v === 'boolean' || typeof v !== 'number' || !Number.isFinite(v)) {
    throw vErr(`Field '${field}' must be a non-negative integer`, commandId);
  }
  const i = Math.trunc(v);
  if (i < 0 || i !== v) throw vErr(`Field '${field}' must be a non-negative integer`, commandId);
  return i;
}

function requireNonNegativeInt(params, field, commandId) {
  if (!(field in params)) throw vErr(`Missing required field '${field}'`, commandId);
  const v = params[field];
  if (typeof v === 'boolean' || typeof v !== 'number' || !Number.isFinite(v)) {
    throw vErr(`Field '${field}' must be a non-negative integer`, commandId);
  }
  const i = Math.trunc(v);
  if (i < 0 || i !== v) throw vErr(`Field '${field}' must be a non-negative integer`, commandId);
  return i;
}

function optionalPositiveNumber(params, field, commandId) {
  if (!(field in params) || params[field] == null) return null;
  const v = params[field];
  if (typeof v === 'boolean' || typeof v !== 'number') {
    throw vErr(`Field '${field}' must be a number`, commandId);
  }
  if (!Number.isFinite(v) || v <= 0) {
    throw vErr(`Field '${field}' must be a positive finite number`, commandId);
  }
  return v;
}

function requireString(params, field, commandId) {
  if (!(field in params)) throw vErr(`Missing required field '${field}'`, commandId);
  const v = params[field];
  if (typeof v !== 'string') throw vErr(`Field '${field}' must be a string`, commandId);
  return v;
}

function optionalMouseButton(params, field, commandId) {
  if (!(field in params) || params[field] == null) return 'left';
  const v = params[field];
  if (typeof v !== 'string' || !MOUSE_BUTTONS.has(v)) {
    throw vErr("Field 'button' must be one of: left, right, middle", commandId);
  }
  return v;
}

function parseShortcutKeys(params, commandId) {
  let keys;
  if ('keys' in params && params.keys != null) {
    const raw = params.keys;
    if (!Array.isArray(raw)) {
      throw vErr("Field 'keys' must be an array of strings", commandId);
    }
    keys = raw.map((k, i) => {
      if (typeof k !== 'string') throw vErr(`Field 'keys[${i}]' must be a string`, commandId);
      return k;
    });
  } else if ('shortcut' in params && params.shortcut != null) {
    const shortcut = requireString(params, 'shortcut', commandId);
    keys = shortcut.split('+').map((s) => s.trim()).filter(Boolean);
  } else {
    throw vErr("Missing required field 'keys'", commandId);
  }
  if (keys.length === 0) throw vErr("Field 'keys' must contain at least one key", commandId);
  return keys;
}

function parseBrowserContext(value, commandId) {
  // Context is optional for CDP — but if provided, validate it like python does
  // so bad values don't sneak through. Missing context entirely is accepted as {}.
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw vErr("Field 'context' must be an object", commandId);
  }
  const required = ['screenX','screenY','outerHeight','innerHeight','outerWidth','innerWidth','devicePixelRatio','scrollX','scrollY'];
  // Only validate when the caller went to the trouble of filling in the OS-backend fields.
  const anyPresent = required.some((f) => f in value);
  if (!anyPresent) return { ...value };
  for (const field of required) {
    if (!(field in value)) throw vErr(`Missing required field '${field}'`, commandId);
    const v = value[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw vErr(`Field '${field}' must be a number`, commandId);
    }
  }
  if (value.devicePixelRatio <= 0) {
    throw vErr("Field 'context.devicePixelRatio' must be greater than zero", commandId);
  }
  if (value.outerHeight < 0 || value.innerHeight < 0) {
    throw vErr('Browser heights must be greater than or equal to zero', commandId);
  }
  if (value.outerWidth < 0 || value.innerWidth < 0) {
    throw vErr('Browser widths must be greater than or equal to zero', commandId);
  }
  if (value.outerHeight < value.innerHeight) {
    throw vErr("Field 'context.outerHeight' must be greater than or equal to 'context.innerHeight'", commandId);
  }
  if (value.outerWidth < value.innerWidth) {
    throw vErr("Field 'context.outerWidth' must be greater than or equal to 'context.innerWidth'", commandId);
  }
  return { ...value };
}

function validateId(value) {
  if (typeof value !== 'string' || !value) throw vErr("Field 'id' must be a non-empty string");
  return value;
}

function validateCommandName(value, commandId) {
  if (typeof value !== 'string' || !value) {
    throw vErr("Field 'command' must be a non-empty string", commandId);
  }
  if (!SUPPORTED_COMMANDS.has(value)) {
    throw vErr(`Unknown command: ${value}`, commandId);
  }
  return value;
}

function parseParams(value, commandId) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw vErr("Field 'params' must be an object", commandId);
  }
  return value;
}

/**
 * Validate a raw {id, command, params, context} envelope and return a
 * normalised command object the dispatcher can route. Throws
 * InputControlError on any validation failure.
 */
export function parseCommand(raw, { allowSequence = true } = {}) {
  if (raw == null || typeof raw !== 'object') {
    throw vErr('Message must be an object');
  }
  const commandId = validateId(raw.id);
  const commandName = validateCommandName(raw.command, commandId);
  const context = parseBrowserContext(raw.context, commandId);
  const params = parseParams(raw.params, commandId);
  return buildCommand(commandName, commandId, context, params, allowSequence);
}

function buildCommand(commandName, commandId, context, params, allowSequence) {
  switch (commandName) {
    case 'mouse_move':
      return {
        kind: 'mouse_move',
        id: commandId,
        context,
        x: requireNumber(params, 'x', commandId),
        y: requireNumber(params, 'y', commandId),
        durationMs: optionalNonNegativeInt(params, 'duration_ms', commandId),
      };
    case 'mouse_click':
      return {
        kind: 'mouse_click',
        id: commandId,
        context,
        x: requireNumber(params, 'x', commandId),
        y: requireNumber(params, 'y', commandId),
        button: optionalMouseButton(params, 'button', commandId),
        count: optionalPositiveInt(params, 'count', commandId) || 1,
        moveDurationMs: optionalNonNegativeInt(params, 'move_duration_ms', commandId),
        holdMs: optionalNonNegativeInt(params, 'hold_ms', commandId),
        intervalMs: optionalNonNegativeInt(params, 'interval_ms', commandId),
      };
    case 'scroll':
      return {
        kind: 'scroll',
        id: commandId,
        context,
        x: requireNumber(params, 'x', commandId),
        y: requireNumber(params, 'y', commandId),
        deltaX: requireNumber(params, 'delta_x', commandId),
        deltaY: requireNumber(params, 'delta_y', commandId),
        durationMs: optionalNonNegativeInt(params, 'duration_ms', commandId),
      };
    case 'type':
      return {
        kind: 'type',
        id: commandId,
        context,
        text: requireString(params, 'text', commandId),
        wpm: optionalPositiveNumber(params, 'wpm', commandId),
      };
    case 'press_key':
      return {
        kind: 'press_key',
        id: commandId,
        context,
        key: requireString(params, 'key', commandId),
        repeat: optionalPositiveInt(params, 'repeat', commandId) || 1,
      };
    case 'press_shortcut':
      return {
        kind: 'press_shortcut',
        id: commandId,
        context,
        keys: parseShortcutKeys(params, commandId),
      };
    case 'pause':
      return {
        kind: 'pause',
        id: commandId,
        context,
        durationMs: requireNonNegativeInt(params, 'duration_ms', commandId),
      };
    case 'sequence': {
      if (!allowSequence) throw vErr('Nested sequence commands are not supported', commandId);
      if (!('steps' in params)) throw vErr("Missing required field 'steps'", commandId);
      const steps = params.steps;
      if (!Array.isArray(steps)) throw vErr("Field 'steps' must be an array", commandId);
      const parsedSteps = [];
      for (let i = 0; i < steps.length; i++) {
        const raw = steps[i];
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw vErr(`Field 'steps[${i}]' must be an object`, commandId);
        }
        const childName = validateCommandName(raw.command, commandId);
        if (childName === 'sequence') {
          throw vErr('Nested sequence commands are not supported', commandId);
        }
        const childParams = parseParams(raw.params, commandId);
        // Child commands inherit parent id (matches python semantics) so the
        // ok/error envelope returned to the caller references the top-level id.
        parsedSteps.push(buildCommand(childName, commandId, context, childParams, false));
      }
      return { kind: 'sequence', id: commandId, context, steps: parsedSteps };
    }
    default:
      throw vErr(`Unknown command: ${commandName}`, commandId);
  }
}

export { SUPPORTED_COMMANDS };

/**
 * Dispatcher: parses a raw envelope, routes validated commands at the
 * injected backends, and wraps the result in a protocol response envelope.
 */
export class Dispatcher {
  constructor({ mouseBackend, keyboardBackend }) {
    this.mouse = mouseBackend;
    this.keyboard = keyboardBackend;
  }

  async handle(raw, signal) {
    const fallbackId = typeof raw?.id === 'string' && raw.id ? raw.id : null;
    try {
      const command = parseCommand(raw);
      await this.route(command, signal);
      return { id: command.id, status: 'ok' };
    } catch (err) {
      if (err && err.name === 'CommandCancelledError') {
        return { id: fallbackId, status: 'error', error: 'Command cancelled' };
      }
      const id = (err && err.commandId) || fallbackId;
      return { id, status: 'error', error: err && err.message ? err.message : String(err) };
    }
  }

  async route(command, signal) {
    if (command.kind === 'sequence') {
      for (const step of command.steps) {
        await this.route(step, signal);
      }
      return;
    }
    if (command.kind === 'mouse_move') return this.mouse.move(command, signal);
    if (command.kind === 'mouse_click') return this.mouse.click(command, signal);
    if (command.kind === 'scroll') return this.mouse.scroll(command, signal);
    if (command.kind === 'press_key') return this.keyboard.pressKey(command, signal);
    if (command.kind === 'press_shortcut') return this.keyboard.pressShortcut(command, signal);
    if (command.kind === 'type') return this.keyboard.typeText(command, signal);
    if (command.kind === 'pause') {
      const { cancellableSleep } = await import('./cancel.js');
      return cancellableSleep(command.durationMs, signal);
    }
    throw new InputControlError(`Unsupported command kind: ${command.kind}`, command.id);
  }
}
