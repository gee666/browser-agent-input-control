// Logical-key-name → CDP key descriptor.
//
// CDP Input.dispatchKeyEvent fields:
//   key:                    DOM KeyboardEvent.key (e.g. "a", "Enter", "ArrowLeft")
//   code:                   DOM KeyboardEvent.code (e.g. "KeyA", "Enter")
//   windowsVirtualKeyCode:  legacy VK code (some form validators require this)
//   text:                   the character a printable key would emit (optional)
//   modifiers:              bitmask alt=1 ctrl=2 meta=4 shift=8
//
// Aliases mirror python-input-control/src/python_input_control/backends/pynput_keyboard.py.

// Shifted printable symbols: typing '!' is Shift+'1' with text '!'.
export const SHIFTED_SYMBOLS = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  '_': '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
};

// Extra aliases — collapse several logical names onto a single canonical name.
const KEY_ALIASES = {
  esc: 'escape',
  return: 'enter',
  ret: 'enter',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
  ctrl: 'control',
  ctl: 'control',
  option: 'alt',
  opt: 'alt',
  altgr: 'altgraph',
  alt_gr: 'altgraph',
  del: 'delete',
  ins: 'insert',
  space: 'space',
  spacebar: 'space',
  pgup: 'pageup',
  page_up: 'pageup',
  pgdn: 'pagedown',
  page_down: 'pagedown',
  capslock: 'capslock',
  caps_lock: 'capslock',
  numlock: 'numlock',
  num_lock: 'numlock',
  scrolllock: 'scrolllock',
  scroll_lock: 'scrolllock',
  printscreen: 'printscreen',
  print_screen: 'printscreen',
  prtsc: 'printscreen',
  prtscr: 'printscreen',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

export function normalizeKeyName(name) {
  if (typeof name !== 'string') throw new TypeError('key name must be a string');
  const trimmed = name.trim();
  if (!trimmed) throw new RangeError('key name must be non-empty');
  const lower = trimmed.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  // Collapse common underscored spellings.
  const unscored = lower.replace(/_/g, '');
  if (KEY_ALIASES[unscored]) return KEY_ALIASES[unscored];
  return lower;
}

function vk(code) {
  return code;
}

// Core named-key table. Keys are canonical (after normalizeKeyName).
const NAMED_KEYS = {
  // Whitespace / editing
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: vk(13), text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: vk(9), text: '\t' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: vk(27) },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: vk(8) },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: vk(46) },
  insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: vk(45) },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: vk(32), text: ' ' },

  // Modifiers — text is intentionally omitted on modifiers.
  shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: vk(16), isModifier: true, modifier: 'shift' },
  control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: vk(17), isModifier: true, modifier: 'ctrl' },
  alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: vk(18), isModifier: true, modifier: 'alt' },
  meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: vk(91), isModifier: true, modifier: 'meta' },
  altgraph: { key: 'AltGraph', code: 'AltRight', windowsVirtualKeyCode: vk(18), isModifier: true, modifier: 'alt' },

  // Navigation
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: vk(38) },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: vk(40) },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: vk(37) },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: vk(39) },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: vk(36) },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: vk(35) },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: vk(33) },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: vk(34) },

  // Locks / system
  capslock: { key: 'CapsLock', code: 'CapsLock', windowsVirtualKeyCode: vk(20) },
  numlock: { key: 'NumLock', code: 'NumLock', windowsVirtualKeyCode: vk(144) },
  scrolllock: { key: 'ScrollLock', code: 'ScrollLock', windowsVirtualKeyCode: vk(145) },
  printscreen: { key: 'PrintScreen', code: 'PrintScreen', windowsVirtualKeyCode: vk(44) },
  pause: { key: 'Pause', code: 'Pause', windowsVirtualKeyCode: vk(19) },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: vk(93) },
};

// F1 … F24
for (let i = 1; i <= 24; i++) {
  NAMED_KEYS[`f${i}`] = {
    key: `F${i}`,
    code: `F${i}`,
    windowsVirtualKeyCode: 111 + i, // F1 = 112
  };
}

// Modifier bitmask per CDP spec.
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * Resolve a logical key name (single char or named key) into the fields CDP
 * needs. Returns an object { key, code, windowsVirtualKeyCode, text?, shift?,
 * isModifier?, modifier? } where `shift` indicates the key needs shift held.
 */
export function resolveKey(name) {
  if (typeof name !== 'string') throw new TypeError('key name must be a string');
  if (name.length === 1) {
    return resolveCharacter(name);
  }
  const canonical = normalizeKeyName(name);
  const entry = NAMED_KEYS[canonical];
  if (entry) return { ...entry };
  // Fall back: accept arbitrary names with uppercased key / a best-effort code.
  const pretty = canonical.charAt(0).toUpperCase() + canonical.slice(1);
  return { key: pretty, code: pretty, windowsVirtualKeyCode: 0 };
}

/** Resolve a single character for `type` / press-key of a single char. */
export function resolveCharacter(ch) {
  if (ch.length !== 1) throw new RangeError('character must be length 1');
  if (ch === '\n' || ch === '\r') return { ...NAMED_KEYS.enter };
  if (ch === '\t') return { ...NAMED_KEYS.tab };
  if (ch === ' ') return { ...NAMED_KEYS.space };

  // Uppercase ASCII letter → shift + lowercase.
  if (ch >= 'A' && ch <= 'Z') {
    const lower = ch.toLowerCase();
    return {
      key: ch,
      code: `Key${ch}`,
      windowsVirtualKeyCode: ch.charCodeAt(0),
      text: ch,
      shift: true,
      baseChar: lower,
    };
  }

  // Lowercase ASCII letter.
  if (ch >= 'a' && ch <= 'z') {
    return {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
      text: ch,
    };
  }

  // Digits.
  if (ch >= '0' && ch <= '9') {
    return {
      key: ch,
      code: `Digit${ch}`,
      windowsVirtualKeyCode: ch.charCodeAt(0),
      text: ch,
    };
  }

  // Shifted printable symbols → shift + the base key.
  if (SHIFTED_SYMBOLS[ch]) {
    const base = SHIFTED_SYMBOLS[ch];
    const baseDesc = resolveCharacter(base);
    return {
      key: ch,
      code: baseDesc.code,
      windowsVirtualKeyCode: baseDesc.windowsVirtualKeyCode,
      text: ch,
      shift: true,
      baseChar: base,
    };
  }

  // Un-shifted printable punctuation.
  const punctCode = {
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
  };
  if (punctCode[ch]) {
    return {
      key: ch,
      code: punctCode[ch],
      windowsVirtualKeyCode: ch.charCodeAt(0),
      text: ch,
    };
  }

  // Fallback — any other printable char.
  return {
    key: ch,
    code: '',
    windowsVirtualKeyCode: ch.charCodeAt(0),
    text: ch,
  };
}

export function modifierBitFor(name) {
  const desc = resolveKey(name);
  if (desc.isModifier) return MODIFIER_BITS[desc.modifier] || 0;
  return 0;
}

export function isModifierName(name) {
  try {
    const desc = resolveKey(name);
    return !!desc.isModifier;
  } catch {
    return false;
  }
}
