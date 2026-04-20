import { describe, expect, test, jest } from '@jest/globals';
import { Dispatcher, parseCommand, SUPPORTED_COMMANDS } from '../src/dispatcher.js';
import { InputControlError } from '../src/errors.js';

function baseMsg(command, params = {}, id = 'cmd-1') {
  return { id, command, params, context: {} };
}

describe('parseCommand validation', () => {
  test('supported commands match the protocol spec', () => {
    expect(SUPPORTED_COMMANDS).toEqual(
      new Set(['mouse_move', 'mouse_click', 'scroll', 'type', 'press_key', 'press_shortcut', 'pause', 'sequence'])
    );
  });

  test('rejects unknown command name', () => {
    expect(() => parseCommand(baseMsg('nope'))).toThrow(/Unknown command: nope/);
  });

  test('rejects missing id', () => {
    expect(() => parseCommand({ command: 'pause', params: { duration_ms: 1 } })).toThrow(/Field 'id'/);
  });

  test('rejects missing required x/y on mouse_move', () => {
    expect(() => parseCommand(baseMsg('mouse_move', { y: 1 }))).toThrow(/Missing required field 'x'/);
  });

  test('rejects bad type on mouse_move.x', () => {
    expect(() => parseCommand(baseMsg('mouse_move', { x: '1', y: 1 }))).toThrow(/must be a number/);
  });

  test('rejects bad mouse button', () => {
    expect(() => parseCommand(baseMsg('mouse_click', { x: 0, y: 0, button: 'laser' }))).toThrow(/button/);
  });

  test('pause requires duration_ms', () => {
    expect(() => parseCommand(baseMsg('pause', {}))).toThrow(/duration_ms/);
  });

  test('type requires string text', () => {
    expect(() => parseCommand(baseMsg('type', { text: 5 }))).toThrow(/must be a string/);
  });

  test('press_shortcut accepts keys array', () => {
    const cmd = parseCommand(baseMsg('press_shortcut', { keys: ['control', 'a'] }));
    expect(cmd.keys).toEqual(['control', 'a']);
  });

  test('press_shortcut parses shortcut string', () => {
    const cmd = parseCommand(baseMsg('press_shortcut', { shortcut: 'ctrl+shift+k' }));
    expect(cmd.keys).toEqual(['ctrl', 'shift', 'k']);
  });

  test('press_shortcut rejects empty keys', () => {
    expect(() => parseCommand(baseMsg('press_shortcut', { keys: [] }))).toThrow(/at least one key/);
  });

  test('nested sequence is rejected', () => {
    expect(() =>
      parseCommand(
        baseMsg('sequence', {
          steps: [{ command: 'sequence', params: { steps: [] } }],
        })
      )
    ).toThrow(/Nested sequence/);
  });

  test('sequence parses child commands', () => {
    const cmd = parseCommand(
      baseMsg('sequence', {
        steps: [
          { command: 'pause', params: { duration_ms: 1 } },
          { command: 'type', params: { text: 'x' } },
        ],
      })
    );
    expect(cmd.kind).toBe('sequence');
    expect(cmd.steps).toHaveLength(2);
    expect(cmd.steps[0].kind).toBe('pause');
    expect(cmd.steps[1].kind).toBe('type');
  });

  test('rejects negative duration_ms', () => {
    expect(() => parseCommand(baseMsg('pause', { duration_ms: -1 }))).toThrow(/non-negative integer/);
  });

  test('rejects non-integer repeat', () => {
    expect(() => parseCommand(baseMsg('press_key', { key: 'tab', repeat: 1.5 }))).toThrow();
  });

  test('rejects zero repeat', () => {
    expect(() => parseCommand(baseMsg('press_key', { key: 'tab', repeat: 0 }))).toThrow();
  });
});

describe('Dispatcher routing', () => {
  const mkBackends = () => {
    return {
      mouseBackend: {
        move: jest.fn(async () => {}),
        click: jest.fn(async () => {}),
        scroll: jest.fn(async () => {}),
      },
      keyboardBackend: {
        pressKey: jest.fn(async () => {}),
        pressShortcut: jest.fn(async () => {}),
        typeText: jest.fn(async () => {}),
      },
    };
  };

  test('handle returns ok envelope on success', async () => {
    const backends = mkBackends();
    const d = new Dispatcher(backends);
    const resp = await d.handle(baseMsg('mouse_click', { x: 1, y: 2 }));
    expect(resp).toEqual({ id: 'cmd-1', status: 'ok' });
    expect(backends.mouseBackend.click).toHaveBeenCalledTimes(1);
  });

  test('handle returns error envelope on validation failure', async () => {
    const d = new Dispatcher(mkBackends());
    const resp = await d.handle(baseMsg('zzz'));
    expect(resp.status).toBe('error');
    expect(resp.error).toMatch(/Unknown command/);
  });

  test('handle forwards sequence steps in order', async () => {
    const backends = mkBackends();
    const d = new Dispatcher(backends);
    const resp = await d.handle(
      baseMsg('sequence', {
        steps: [
          { command: 'mouse_move', params: { x: 1, y: 2 } },
          { command: 'mouse_click', params: { x: 1, y: 2 } },
        ],
      })
    );
    expect(resp.status).toBe('ok');
    expect(backends.mouseBackend.move).toHaveBeenCalledTimes(1);
    expect(backends.mouseBackend.click).toHaveBeenCalledTimes(1);
  });

  test('cancelled backend call maps to "Command cancelled"', async () => {
    const d = new Dispatcher({
      mouseBackend: {
        click: async () => {
          const err = new Error('Command cancelled');
          err.name = 'CommandCancelledError';
          throw err;
        },
      },
      keyboardBackend: {},
    });
    const resp = await d.handle(baseMsg('mouse_click', { x: 1, y: 2 }));
    expect(resp).toEqual({ id: 'cmd-1', status: 'error', error: 'Command cancelled' });
  });
});
