// Keyboard backend — type / press_key / press_shortcut via CDP
// (Input.dispatchKeyEvent). Per-character keydown/keyup with human-pacing
// WPM + jitter + extra pauses after punctuation. We do NOT use
// Input.insertText: it doesn't fire real keydown events and breaks frameworks
// that listen for them.

import { cancellableSleep, throwIfCancelled } from '../cancel.js';
import { InputControlError } from '../errors.js';
import {
  MODIFIER_BITS,
  modifierBitFor,
  resolveCharacter,
  resolveKey,
} from '../key-map.js';
import {
  DEFAULT_MAX_WPM,
  DEFAULT_MIN_WPM,
  KEY_PRESS_HOLD_MAX_MS,
  KEY_PRESS_HOLD_MIN_MS,
  KEY_REPEAT_DELAY_MAX_MS,
  KEY_REPEAT_DELAY_MIN_MS,
  MIN_INTER_KEY_DELAY_MS,
  SHORTCUT_DELAY_MAX_MS,
  SHORTCUT_DELAY_MIN_MS,
  TYPING_JITTER_RATIO,
  extraPauseAfterChar,
  jitteredDelayMs,
  wpmToInterKeyDelayMs,
} from '../timing.js';

export class CdpKeyboardBackend {
  constructor({ transport, rng, getTabId } = {}) {
    this._transport = transport;
    this._rng = rng;
    this._legacyGetTabId = typeof getTabId === 'function' ? getTabId : null;
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

  async _dispatch(tabId, method, params) {
    return this._transport.send(tabId, method, params);
  }

  async _key(tabId, type, desc, modifiers) {
    const params = {
      type,
      modifiers,
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.windowsVirtualKeyCode || 0,
      nativeVirtualKeyCode: desc.windowsVirtualKeyCode || 0,
    };
    // CDP convention: `text` only on keyDown for printable keys, and only
    // when modifiers other than shift aren't set.
    if (type === 'keyDown' && desc.text && (modifiers & ~MODIFIER_BITS.shift) === 0) {
      params.text = desc.text;
    }
    return this._dispatch(tabId, 'Input.dispatchKeyEvent', params);
  }

  async _tapCharacter(tabId, ch, signal) {
    throwIfCancelled(signal);
    const desc = resolveCharacter(ch);
    const modifiers = desc.shift ? MODIFIER_BITS.shift : 0;
    if (desc.shift) {
      await this._key(tabId, 'keyDown', resolveKey('shift'), MODIFIER_BITS.shift);
    }
    await this._key(tabId, 'keyDown', desc, modifiers);
    await this._key(tabId, 'keyUp', desc, modifiers);
    if (desc.shift) {
      await this._key(tabId, 'keyUp', resolveKey('shift'), 0);
    }
  }

  async typeText(command, signal, execContext) {
    if (!command.text) return;
    const tabId = this._resolveTabId(execContext);
    const wpm = command.wpm != null ? command.wpm : this._rng.uniform(DEFAULT_MIN_WPM, DEFAULT_MAX_WPM);
    const baseDelay = wpmToInterKeyDelayMs(wpm);
    // Iterate Unicode code points, not UTF-16 code units, so emoji and
    // other astral characters aren't split into lone surrogate halves.
    const codePoints = [...command.text];
    const last = codePoints.length - 1;
    for (let i = 0; i < codePoints.length; i++) {
      const ch = codePoints[i];
      await this._tapCharacter(tabId, ch, signal);
      if (i === last) continue;
      let delay = jitteredDelayMs(baseDelay, this._rng, TYPING_JITTER_RATIO, MIN_INTER_KEY_DELAY_MS);
      delay += extraPauseAfterChar(ch, this._rng);
      await cancellableSleep(delay, signal);
    }
  }

  async pressKey(command, signal, execContext) {
    const tabId = this._resolveTabId(execContext);
    const repeat = command.repeat || 1;
    for (let i = 0; i < repeat; i++) {
      throwIfCancelled(signal);
      await this._tapKeySpec(tabId, command.key, signal);
      if (i < repeat - 1) {
        // Space out repeats with the same jitter envelope shortcuts use so
        // press_key with repeat>1 doesn't look like a machine-gun burst.
        await cancellableSleep(this._rng.uniform(KEY_REPEAT_DELAY_MIN_MS, KEY_REPEAT_DELAY_MAX_MS), signal);
      }
    }
  }

  async _tapKeySpec(tabId, name, signal) {
    // A single-character key-spec taps through the same character path so
    // shift/text handling stays consistent.
    if (typeof name === 'string' && name.length === 1) {
      await this._tapCharacter(tabId, name, signal);
      return;
    }
    const desc = resolveKey(name);
    const holdMs = this._rng.uniform(KEY_PRESS_HOLD_MIN_MS, KEY_PRESS_HOLD_MAX_MS);
    if (desc.isModifier) {
      // Pressing a lone modifier is unusual but permitted; no text.
      const mod = MODIFIER_BITS[desc.modifier] || 0;
      await this._key(tabId, 'keyDown', desc, mod);
      await cancellableSleep(holdMs, signal);
      await this._key(tabId, 'keyUp', desc, 0);
      return;
    }
    await this._key(tabId, 'keyDown', desc, 0);
    await cancellableSleep(holdMs, signal);
    await this._key(tabId, 'keyUp', desc, 0);
  }

  async pressShortcut(command, signal, execContext) {
    if (!command.keys || command.keys.length === 0) {
      throw new InputControlError("Field 'keys' must contain at least one key", command.id);
    }
    const tabId = this._resolveTabId(execContext);
    const keys = command.keys;
    const held = keys.slice(0, -1);
    const last = keys[keys.length - 1];

    let modifierMask = 0;
    const downStack = [];
    // Track whether we injected a synthetic Shift for a shifted terminal
    // character (e.g. `ctrl+A` or `ctrl+?`). Some apps only react to real
    // Shift keyDown/keyUp transitions rather than the modifier bit on the
    // final event, so we mirror _tapCharacter()'s behaviour here.
    let injectedShift = false;
    try {
      for (const k of held) {
        throwIfCancelled(signal);
        const desc = resolveKey(k);
        const bit = desc.isModifier ? MODIFIER_BITS[desc.modifier] || 0 : modifierBitFor(k);
        modifierMask |= bit;
        await this._key(tabId, 'keyDown', desc, modifierMask);
        downStack.push(desc);
      }
      throwIfCancelled(signal);
      // Last key: keyDown then keyUp with the accumulated modifier mask.
      if (typeof last === 'string' && last.length === 1) {
        const desc = resolveCharacter(last);
        const shiftAlreadyHeld = (modifierMask & MODIFIER_BITS.shift) !== 0;
        if (desc.shift && !shiftAlreadyHeld) {
          await this._key(tabId, 'keyDown', resolveKey('shift'), modifierMask | MODIFIER_BITS.shift);
          modifierMask |= MODIFIER_BITS.shift;
          injectedShift = true;
        }
        const mask = modifierMask | (desc.shift ? MODIFIER_BITS.shift : 0);
        await this._key(tabId, 'keyDown', desc, mask);
        await this._key(tabId, 'keyUp', desc, mask);
      } else {
        const desc = resolveKey(last);
        const mask = modifierMask | (desc.isModifier ? MODIFIER_BITS[desc.modifier] || 0 : 0);
        await this._key(tabId, 'keyDown', desc, mask);
        await this._key(tabId, 'keyUp', desc, mask);
      }
    } finally {
      if (injectedShift) {
        modifierMask &= ~MODIFIER_BITS.shift;
        try {
          await this._key(tabId, 'keyUp', resolveKey('shift'), modifierMask);
        } catch {
          // keep releasing others even if one fails
        }
      }
      // Release modifiers in reverse order no matter what happened above.
      for (let i = downStack.length - 1; i >= 0; i--) {
        const desc = downStack[i];
        const bit = desc.isModifier ? MODIFIER_BITS[desc.modifier] || 0 : 0;
        modifierMask &= ~bit;
        try {
          await this._key(tabId, 'keyUp', desc, modifierMask);
        } catch {
          // keep releasing others even if one fails
        }
      }
    }

    await cancellableSleep(this._rng.uniform(SHORTCUT_DELAY_MIN_MS, SHORTCUT_DELAY_MAX_MS), signal);
  }
}
