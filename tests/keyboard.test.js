import { describe, expect, test } from '@jest/globals';
import { CdpKeyboardBackend } from '../src/backends/keyboard.js';
import { MODIFIER_BITS } from '../src/key-map.js';
import { DeterministicRng, FakeTransport } from './_fakes.js';

function mk(tabId = 1) {
  const transport = new FakeTransport();
  const rng = new DeterministicRng(11);
  const backend = new CdpKeyboardBackend({ transport, getTabId: () => tabId, rng });
  return { transport, backend };
}

describe('CdpKeyboardBackend.typeText', () => {
  test('types "hi" as exactly keyDown h, keyUp h, keyDown i, keyUp i', async () => {
    const { transport, backend } = mk();
    await backend.typeText({ text: 'hi', wpm: 10000 }, null); // huge WPM = ~0 delay
    const events = transport.calledWith('Input.dispatchKeyEvent').map((c) => ({
      type: c.params.type,
      key: c.params.key,
      text: c.params.text,
    }));
    expect(events).toEqual([
      { type: 'keyDown', key: 'h', text: 'h' },
      { type: 'keyUp', key: 'h', text: undefined },
      { type: 'keyDown', key: 'i', text: 'i' },
      { type: 'keyUp', key: 'i', text: undefined },
    ]);
  });

  test('uppercase letter wraps in shift down/up', async () => {
    const { transport, backend } = mk();
    await backend.typeText({ text: 'A', wpm: 10000 }, null);
    const events = transport.calls.map((c) => ({
      type: c.params.type,
      key: c.params.key,
      modifiers: c.params.modifiers,
    }));
    expect(events[0]).toEqual({ type: 'keyDown', key: 'Shift', modifiers: MODIFIER_BITS.shift });
    expect(events[1].type).toBe('keyDown');
    expect(events[1].key).toBe('A');
    expect(events[1].modifiers).toBe(MODIFIER_BITS.shift);
    expect(events[events.length - 1]).toEqual({ type: 'keyUp', key: 'Shift', modifiers: 0 });
  });

  test('empty text produces no CDP calls', async () => {
    const { transport, backend } = mk();
    await backend.typeText({ text: '' }, null);
    expect(transport.calls).toHaveLength(0);
  });

  test('inter-key delay scales with WPM — slow WPM takes longer', async () => {
    const { backend: fastBackend, transport: fastTr } = mk();
    const start = Date.now();
    await fastBackend.typeText({ text: 'abcdef', wpm: 600 }, null);
    const fastElapsed = Date.now() - start;
    expect(fastTr.calls.length).toBe(12); // 6 chars * (down + up)
    // Lower WPM => more delay. We assert an ordering not an exact value.
    const { backend: slowBackend } = mk();
    const slowStart = Date.now();
    await slowBackend.typeText({ text: 'abcdef', wpm: 60 }, null);
    const slowElapsed = Date.now() - slowStart;
    expect(slowElapsed).toBeGreaterThanOrEqual(fastElapsed);
  });
});

describe('CdpKeyboardBackend.pressKey', () => {
  test('press Enter emits keyDown then keyUp with code=Enter', async () => {
    const { transport, backend } = mk();
    await backend.pressKey({ key: 'enter', repeat: 1 }, null);
    const events = transport.calls.map((c) => ({ type: c.params.type, key: c.params.key, code: c.params.code }));
    expect(events).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter' },
      { type: 'keyUp', key: 'Enter', code: 'Enter' },
    ]);
  });

  test('repeat=3 presses Tab three times', async () => {
    const { transport, backend } = mk();
    await backend.pressKey({ key: 'tab', repeat: 3 }, null);
    const down = transport.calls.filter((c) => c.params.type === 'keyDown');
    const up = transport.calls.filter((c) => c.params.type === 'keyUp');
    expect(down).toHaveLength(3);
    expect(up).toHaveLength(3);
  });
});

describe('CdpKeyboardBackend.pressShortcut', () => {
  test('ctrl+a emits ctrl down, a down, a up, ctrl up', async () => {
    const { transport, backend } = mk();
    await backend.pressShortcut({ keys: ['control', 'a'] }, null);
    const events = transport.calledWith('Input.dispatchKeyEvent').map((c) => ({
      type: c.params.type,
      key: c.params.key,
      modifiers: c.params.modifiers,
    }));
    expect(events).toEqual([
      { type: 'keyDown', key: 'Control', modifiers: MODIFIER_BITS.ctrl },
      { type: 'keyDown', key: 'a', modifiers: MODIFIER_BITS.ctrl },
      { type: 'keyUp', key: 'a', modifiers: MODIFIER_BITS.ctrl },
      { type: 'keyUp', key: 'Control', modifiers: 0 },
    ]);
  });

  test('ctrl+shift+k sets both modifier bits on the final key', async () => {
    const { transport, backend } = mk();
    await backend.pressShortcut({ keys: ['ctrl', 'shift', 'k'] }, null);
    const final = transport.calls.find((c) => c.params.key === 'k' && c.params.type === 'keyDown');
    expect(final.params.modifiers & MODIFIER_BITS.ctrl).toBeTruthy();
    expect(final.params.modifiers & MODIFIER_BITS.shift).toBeTruthy();
  });
});
