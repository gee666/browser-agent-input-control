// Error classes for browser-agent-input-control.
//
// Names are chosen to be drop-in compatible with the InputControlBridge in
// browser-agent-core/background/input-control.js. The agent in
// browser-agent-core/background/agent.js checks for `err.name ===
// 'InputControlAbortError'` exactly, so the abort path MUST produce an error
// whose .name is that exact string.

export class InputControlError extends Error {
  constructor(message, commandId = null) {
    super(message);
    this.name = 'InputControlError';
    this.commandId = commandId;
  }
}

export class InputControlTimeoutError extends Error {
  constructor(message = 'Input control command timed out') {
    super(message);
    this.name = 'InputControlTimeoutError';
  }
}

export class InputControlAbortError extends Error {
  constructor(message = 'Aborted: stop was requested') {
    super(message);
    this.name = 'InputControlAbortError';
  }
}
