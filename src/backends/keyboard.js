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
  MIN_INTER_KEY_DELAY_MS,
  SHORTCUT_DELAY_MAX_MS,
  SHORTCUT_DELAY_MIN_MS,
  TYPING_JITTER_RATIO,
  extraPauseAfterChar,
  jitteredDelayMs,
  wpmToInterKeyDelayMs,
} from '../timing.js';

export class CdpKeyboardBackend {
  constructor({ transport, getTabId, rng }) {
    this._transport = transport;
    this._getTabId = getTabId;
    this._rng = rng;
  }

  async _dispatch(method, params) {
    return this._transport.send(this._getTabId(), method, params);
  }

  async _key(type, desc, modifiers) {
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
    return this._dispatch('Input.dispatchKeyEvent', params);
  }

  async _tapCharacter(ch, signal) {
    throwIfCancelled(signal);
    const desc = resolveCharacter(ch);
    const modifiers = desc.shift ? MODIFIER_BITS.shift : 0;
    if (desc.shift) {
      await this._key('keyDown', resolveKey('shift'), MODIFIER_BITS.shift);
    }
    await this._key('keyDown', desc, modifiers);
    await this._key('keyUp', desc, modifiers);
    if (desc.shift) {
      await this._key('keyUp', resolveKey('shift'), 0);
    }
  }

  async typeText(command, signal) {
    if (!command.text) return;
    const wpm = command.wpm != null ? command.wpm : this._rng.uniform(DEFAULT_MIN_WPM, DEFAULT_MAX_WPM);
    const baseDelay = wpmToInterKeyDelayMs(wpm);
    const last = command.text.length - 1;
    for (let i = 0; i < command.text.length; i++) {
      const ch = command.text[i];
      await this._tapCharacter(ch, signal);
      if (i === last) continue;
      let delay = jitteredDelayMs(baseDelay, this._rng, TYPING_JITTER_RATIO, MIN_INTER_KEY_DELAY_MS);
      delay += extraPauseAfterChar(ch, this._rng);
      await cancellableSleep(delay, signal);
    }
  }

  async pressKey(command, signal) {
    const repeat = command.repeat || 1;
    for (let i = 0; i < repeat; i++) {
      throwIfCancelled(signal);
      await this._tapKeySpec(command.key, signal);
    }
  }

  async _tapKeySpec(name, signal) {
    // A single-character key-spec tips through the same character path so
    // shift/text handling stays consistent.
    if (typeof name === 'string' && name.length === 1) {
      await this._tapCharacter(name, signal);
      return;
    }
    const desc = resolveKey(name);
    if (desc.isModifier) {
      // Pressing a lone modifier is unusual but permitted; no text.
      const mod = MODIFIER_BITS[desc.modifier] || 0;
      await this._key('keyDown', desc, mod);
      await this._key('keyUp', desc, 0);
      return;
    }
    await this._key('keyDown', desc, 0);
    await this._key('keyUp', desc, 0);
  }

  async pressShortcut(command, signal) {
    if (!command.keys || command.keys.length === 0) {
      throw new InputControlError("Field 'keys' must contain at least one key", command.id);
    }
    const keys = command.keys;
    const held = keys.slice(0, -1);
    const last = keys[keys.length - 1];

    let modifierMask = 0;
    const downStack = [];
    try {
      for (const k of held) {
        throwIfCancelled(signal);
        const desc = resolveKey(k);
        const bit = desc.isModifier ? MODIFIER_BITS[desc.modifier] || 0 : modifierBitFor(k);
        modifierMask |= bit;
        await this._key('keyDown', desc, modifierMask);
        downStack.push(desc);
      }
      throwIfCancelled(signal);
      // Last key: keyDown then keyUp with the accumulated modifier mask.
      if (typeof last === 'string' && last.length === 1) {
        const desc = resolveCharacter(last);
        const mask = modifierMask | (desc.shift ? MODIFIER_BITS.shift : 0);
        await this._key('keyDown', desc, mask);
        await this._key('keyUp', desc, mask);
      } else {
        const desc = resolveKey(last);
        const mask = modifierMask | (desc.isModifier ? MODIFIER_BITS[desc.modifier] || 0 : 0);
        await this._key('keyDown', desc, mask);
        await this._key('keyUp', desc, mask);
      }
    } finally {
      // Release modifiers in reverse order no matter what happened above.
      for (let i = downStack.length - 1; i >= 0; i--) {
        const desc = downStack[i];
        const bit = desc.isModifier ? MODIFIER_BITS[desc.modifier] || 0 : 0;
        modifierMask &= ~bit;
        try {
          await this._key('keyUp', desc, modifierMask);
        } catch {
          // keep releasing others even if one fails
        }
      }
    }

    await cancellableSleep(this._rng.uniform(SHORTCUT_DELAY_MIN_MS, SHORTCUT_DELAY_MAX_MS), signal);
  }
}
