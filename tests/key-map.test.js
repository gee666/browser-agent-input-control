import { describe, expect, test } from '@jest/globals';
import {
  MODIFIER_BITS,
  SHIFTED_SYMBOLS,
  isModifierName,
  modifierBitFor,
  normalizeKeyName,
  resolveCharacter,
  resolveKey,
} from '../src/key-map.js';

describe('normalizeKeyName', () => {
  test.each([
    ['esc', 'escape'],
    ['ESC', 'escape'],
    ['return', 'enter'],
    ['RET', 'enter'],
    ['Ctrl', 'control'],
    ['CTL', 'control'],
    ['Cmd', 'meta'],
    ['Command', 'meta'],
    ['super', 'meta'],
    ['windows', 'meta'],
    ['del', 'delete'],
    ['ArrowUp', 'up'],
    ['arrowleft', 'left'],
    ['Page Up', 'pageup'],
    ['page_down', 'pagedown'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeKeyName(input)).toBe(expected);
  });
});

describe('resolveKey — named keys', () => {
  test.each(['enter', 'tab', 'escape', 'space', 'backspace'])('%s has key, code, VK', (name) => {
    const d = resolveKey(name);
    expect(typeof d.key).toBe('string');
    expect(d.key.length).toBeGreaterThan(0);
    expect(typeof d.code).toBe('string');
    expect(d.code.length).toBeGreaterThan(0);
    expect(typeof d.windowsVirtualKeyCode).toBe('number');
  });

  test('enter produces Enter key and code', () => {
    const d = resolveKey('return');
    expect(d.key).toBe('Enter');
    expect(d.code).toBe('Enter');
    expect(d.windowsVirtualKeyCode).toBe(13);
  });

  test('tab', () => {
    const d = resolveKey('tab');
    expect(d.key).toBe('Tab');
    expect(d.code).toBe('Tab');
    expect(d.windowsVirtualKeyCode).toBe(9);
  });

  test('escape', () => {
    const d = resolveKey('ESC');
    expect(d.key).toBe('Escape');
    expect(d.code).toBe('Escape');
  });

  test('function keys F1..F24', () => {
    for (let i = 1; i <= 24; i++) {
      const d = resolveKey(`f${i}`);
      expect(d.key).toBe(`F${i}`);
      expect(d.code).toBe(`F${i}`);
      expect(d.windowsVirtualKeyCode).toBe(111 + i);
    }
  });
});

describe('resolveCharacter — shifted symbols', () => {
  test('every shifted symbol resolves to shift + base', () => {
    for (const [shifted, base] of Object.entries(SHIFTED_SYMBOLS)) {
      const d = resolveCharacter(shifted);
      expect(d.shift).toBe(true);
      expect(d.text).toBe(shifted);
      expect(d.baseChar).toBe(base);
    }
  });

  test('uppercase ASCII letter requires shift', () => {
    const d = resolveCharacter('A');
    expect(d.shift).toBe(true);
    expect(d.text).toBe('A');
    expect(d.code).toBe('KeyA');
  });

  test('lowercase ASCII letter does not require shift', () => {
    const d = resolveCharacter('a');
    expect(d.shift).toBeFalsy();
    expect(d.code).toBe('KeyA');
    expect(d.text).toBe('a');
  });

  test('digit', () => {
    const d = resolveCharacter('5');
    expect(d.code).toBe('Digit5');
    expect(d.text).toBe('5');
  });

  test('space', () => {
    const d = resolveCharacter(' ');
    expect(d.code).toBe('Space');
    expect(d.key).toBe(' ');
  });

  test('newline maps to Enter', () => {
    const d = resolveCharacter('\n');
    expect(d.key).toBe('Enter');
    expect(d.code).toBe('Enter');
  });
});

describe('modifier bits', () => {
  test('bit values match CDP spec', () => {
    expect(MODIFIER_BITS).toEqual({ alt: 1, ctrl: 2, meta: 4, shift: 8 });
  });

  test('modifierBitFor names', () => {
    expect(modifierBitFor('shift')).toBe(8);
    expect(modifierBitFor('ctrl')).toBe(2);
    expect(modifierBitFor('control')).toBe(2);
    expect(modifierBitFor('alt')).toBe(1);
    expect(modifierBitFor('cmd')).toBe(4);
    expect(modifierBitFor('meta')).toBe(4);
    expect(modifierBitFor('a')).toBe(0);
  });

  test('isModifierName', () => {
    expect(isModifierName('ctrl')).toBe(true);
    expect(isModifierName('shift')).toBe(true);
    expect(isModifierName('k')).toBe(false);
  });
});
