// Timing helpers — JS port of python-input-control/src/python_input_control/timing.py
// and the typing-pacing helpers from backends/pynput_keyboard.py.

import { boundedGauss } from './randomness.js';

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function easeInOut(value) {
  const bounded = clamp(value, 0.0, 1.0);
  return bounded * bounded * (3.0 - 2.0 * bounded);
}

export function estimateMouseDurationMs(distancePx, minimumMs = 150, maximumMs = 1200) {
  const distance = Math.max(0.0, distancePx);
  const estimate = 120.0 + 180.0 * Math.log2(1.0 + distance / 100.0);
  return Math.round(clamp(estimate, minimumMs, maximumMs));
}

export function estimateScrollDurationMs(totalDeltaCss, minimumMs = 150, maximumMs = 1200) {
  const magnitude = Math.max(0.0, Math.abs(totalDeltaCss));
  const estimate = 100.0 + 160.0 * Math.log2(1.0 + magnitude / 120.0);
  return Math.round(clamp(estimate, minimumMs, maximumMs));
}

export function wpmToInterKeyDelayMs(wpm) {
  if (wpm <= 0) {
    throw new RangeError('wpm must be greater than zero');
  }
  return 12000.0 / wpm;
}

export function jitteredDelayMs(baseMs, rng, jitterRatio = 0.25, minimumMs = 0.0) {
  const sigma = Math.abs(baseMs) * Math.abs(jitterRatio);
  return boundedGauss(rng, baseMs, sigma, minimumMs, Number.POSITIVE_INFINITY);
}

// Ported from pynput_keyboard._EXTRA_PAUSE_CHARACTERS.
const EXTRA_PAUSE_CHARACTERS = new Set([' ', ',', '.', ';', ':', '!', '?']);

export function extraPauseAfterChar(character, rng) {
  if (!EXTRA_PAUSE_CHARACTERS.has(character)) return 0.0;
  const pauseProbability = character === ' ' ? 0.35 : 0.6;
  if (rng.random() >= pauseProbability) return 0.0;
  return rng.uniform(150.0, 300.0);
}

// Defaults ported from pynput_keyboard.
export const DEFAULT_MIN_WPM = 60.0;
export const DEFAULT_MAX_WPM = 100.0;
export const SHORTCUT_DELAY_MIN_MS = 50.0;
export const SHORTCUT_DELAY_MAX_MS = 100.0;
export const TYPING_JITTER_RATIO = 0.25;
export const MIN_INTER_KEY_DELAY_MS = 10.0;
