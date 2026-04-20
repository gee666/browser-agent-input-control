# browser-agent-input-control

Chrome DevTools Protocol (CDP) backend for the input-control protocol used by
`browser-agent`. Drop-in replacement for `InputControlBridge` in
`browser-agent-core/background/input-control.js`; no native-messaging host
install required.

## Status

- Semantic protocol: identical to `python-input-control`.
- Transport: in-process async call — no stdio framing.
- Target: Chrome MV3 service worker with the `"debugger"` permission.

## Installation

```
npm install
npm test
```

## Usage

```js
import { CdpInputControlBridge } from 'browser-agent-input-control';

const cdp = new CdpInputControlBridge({
  // any object with getActiveTabId() -> number | Promise<number>
  bridge: browserBridge,
});

await cdp.execute('mouse_click', { x: 120, y: 240, button: 'left' }, context);
await cdp.execute('type', { text: 'hello', wpm: 80 }, context);

// Cancel the in-flight command (e.g. user pressed Stop)
cdp.abort();

// Fully tear down — detaches the debugger and drops listeners.
cdp.disconnect();
```

### API

- `new CdpInputControlBridge({ bridge, transport?, rng?, mouseBackend?,
  keyboardBackend? })`
- `execute(command, params, context): Promise<{id, status:'ok'}>` — rejects
  with an `InputControlError`, `InputControlTimeoutError`, or
  `InputControlAbortError` on failure.
- `abort()` — trips an `AbortController`, rejects pending executes, detaches
  the debugger asynchronously.
- `disconnect()` — permanent shutdown; every subsequent execute rejects.

### Errors

- `InputControlError` — validation or backend error. `.message` is the server
  error string.
- `InputControlTimeoutError` — command exceeded its timeout (30 s for most
  commands; scaled by text length for `type`).
- `InputControlAbortError` — abort/stop requested mid-execute. `.name` is
  exactly `'InputControlAbortError'` so `browser-agent-core/background/agent.js`
  can identify it.

## Commands → CDP mapping

| Command | CDP primitive |
|---|---|
| `mouse_move` | `Input.dispatchMouseEvent {type:'mouseMoved'}` along a Bézier path |
| `mouse_click` | `mouseMoved` + `mousePressed` + `mouseReleased` (`clickCount` for doubles) |
| `scroll` | `Input.dispatchMouseEvent {type:'mouseWheel', deltaX, deltaY}` stepped for smoothness |
| `type` | Per-char `Input.dispatchKeyEvent {type:'keyDown', text,…}` + `{type:'keyUp'}`, paced by WPM with jitter. **Does not** use `Input.insertText`. |
| `press_key` | `keyDown` + `keyUp` with mapped `key` / `code` / `windowsVirtualKeyCode` |
| `press_shortcut` | Modifier `keyDown`s (modifier bitmask alt=1 ctrl=2 meta=4 shift=8), then the key, then reverse |
| `pause` | Cancellable sleep |
| `sequence` | Iterate children |

## Caveats

- Chrome shows a non-dismissable yellow banner
  `"<extension> started debugging this browser"` the whole time the debugger
  is attached. This is part of the browser's security model; there is no way
  to suppress it.
- Only one debugger client per tab. If you have DevTools open on the target
  tab, `chrome.debugger.attach` fails and the first command surfaces that
  error.
- Some sites fingerprint debugger attachment. For higher stealth, use the
  `python-input-control` backend.

## Layout

```
src/
  bridge.js             — CdpInputControlBridge public class
  dispatcher.js         — parse + validate + route
  debugger-transport.js — chrome.debugger wrapper (+ onDetach)
  cancel.js             — cancellableSleep + CommandCancelledError
  errors.js             — Error classes
  mouse-motion.js       — Bézier path + scroll-step builders
  timing.js             — WPM, jitter, mouse/scroll duration estimation
  randomness.js         — SeededRandom
  key-map.js            — logical name → CDP key descriptor
  backends/
    mouse.js            — move / click / scroll via CDP
    keyboard.js         — type / press_key / press_shortcut via CDP
tests/                  — Jest test suite, uses a FakeTransport
```

## License

MIT.
