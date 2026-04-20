// Cancellation helpers.
//
// A single AbortController per in-flight execute() call drives every internal
// async wait. Whenever we sleep we go through cancellableSleep(ms, signal) so
// abort() rejects the promise immediately with a CommandCancelledError.

export class CommandCancelledError extends Error {
  constructor(message = 'Command cancelled') {
    super(message);
    this.name = 'CommandCancelledError';
  }
}

/**
 * Sleep for `ms` milliseconds, but reject with CommandCancelledError the
 * moment `signal` aborts. If the signal is already aborted, reject
 * synchronously on the next microtask.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function cancellableSleep(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new CommandCancelledError());
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new CommandCancelledError());
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Throw CommandCancelledError synchronously if the signal has already
 * aborted. Useful to bail out between steps without a full sleep.
 */
export function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw new CommandCancelledError();
  }
}
