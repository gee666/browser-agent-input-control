// Mouse motion — JS port of python-input-control/src/python_input_control/mouse_motion.py.
//
// We drop the virtual-desktop bounds clamp because CDP operates in viewport
// CSS pixels, not physical screen pixels, and the browser viewport handles
// bounds on its own.

import { boundedGauss } from './randomness.js';
import { clamp, easeInOut, estimateScrollDurationMs } from './timing.js';

export function distanceBetweenPoints(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.hypot(dx, dy);
}

export function cubicBezierPoint(start, c1, c2, end, t) {
  const bt = clamp(t, 0.0, 1.0);
  const it = 1.0 - bt;
  const x =
    it * it * it * start.x +
    3.0 * it * it * bt * c1.x +
    3.0 * it * bt * bt * c2.x +
    bt * bt * bt * end.x;
  const y =
    it * it * it * start.y +
    3.0 * it * it * bt * c1.y +
    3.0 * it * bt * bt * c2.y +
    bt * bt * bt * end.y;
  return { x, y };
}

function randomSign(rng) {
  return rng.random() < 0.5 ? -1.0 : 1.0;
}

export function generateBezierControlPoints(start, end, rng, minOffsetRatio = 0.15, maxOffsetRatio = 0.4) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.max(distanceBetweenPoints(start, end), 1.0);

  const unitX = dx / distance;
  const unitY = dy / distance;
  const perpX = -unitY;
  const perpY = unitX;

  const f1 = rng.uniform(0.2, 0.35);
  const f2 = rng.uniform(0.65, 0.8);
  const o1 = rng.uniform(minOffsetRatio, maxOffsetRatio) * distance * randomSign(rng);
  const o2 = rng.uniform(minOffsetRatio, maxOffsetRatio) * distance * randomSign(rng);

  return [
    { x: start.x + dx * f1 + perpX * o1, y: start.y + dy * f1 + perpY * o1 },
    { x: start.x + dx * f2 + perpX * o2, y: start.y + dy * f2 + perpY * o2 },
  ];
}

function estimateSampleCount(distancePx) {
  return Math.round(clamp(distancePx / 9.0, 24.0, 60.0));
}

export function buildMousePath(start, end, rng, options = {}) {
  const {
    sampleCount = null,
    jitterSigmaPx = 0.85,
    jitterLimitPx = 2.0,
  } = options;
  const distance = distanceBetweenPoints(start, end);
  if (distance < 1e-6) return [{ ...start }];

  const [c1, c2] = generateBezierControlPoints(start, end, rng);
  const total = sampleCount != null ? sampleCount : estimateSampleCount(distance);

  const path = [];
  for (let i = 0; i <= total; i++) {
    const tt = easeInOut(i / total);
    let p = cubicBezierPoint(start, c1, c2, end, tt);
    if (i > 0 && i < total) {
      p = {
        x: p.x + boundedGauss(rng, 0.0, jitterSigmaPx, -jitterLimitPx, jitterLimitPx),
        y: p.y + boundedGauss(rng, 0.0, jitterSigmaPx, -jitterLimitPx, jitterLimitPx),
      };
    }
    path.push(p);
  }
  path[0] = { ...start };
  path[path.length - 1] = { ...end };
  return path;
}

// --- Scroll step builder ---------------------------------------------------

function deltaCssToTicks(deltaCss, cssPixelsPerTick) {
  if (cssPixelsPerTick <= 0) throw new RangeError('cssPixelsPerTick must be > 0');
  if (Math.abs(deltaCss) < 1e-6) return 0;
  return Math.round(deltaCss / cssPixelsPerTick);
}

function estimateScrollStepCount(totalTickMagnitude) {
  if (totalTickMagnitude < 8) return Math.max(1, totalTickMagnitude);
  return Math.round(clamp(totalTickMagnitude, 8.0, 15.0));
}

function bellCurveWeights(count, rng) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const position = (i + 0.5) / count;
    const baseline = 0.55 + Math.sin(Math.PI * position);
    out.push(Math.max(0.05, baseline * rng.uniform(0.8, 1.2)));
  }
  return out;
}

function edgeHeavyWeights(count, rng) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const position = (i + 1) / (count + 1);
    const edgeBias = 0.75 + Math.abs(2.0 * position - 1.0);
    out.push(Math.max(0.05, edgeBias * rng.uniform(0.9, 1.1)));
  }
  return out;
}

function allocateIntegerTotal(total, stepCount, rng) {
  if (stepCount <= 0) return [];
  const magnitude = Math.abs(total);
  if (magnitude === 0) return new Array(stepCount).fill(0);

  const sign = total >= 0 ? 1 : -1;
  const weights = bellCurveWeights(stepCount, rng);
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (magnitude * w) / sum);
  const floors = raw.map((v) => Math.floor(v));
  const remainders = raw.map((v, i) => v - floors[i]);
  let remaining = magnitude - floors.reduce((a, b) => a + b, 0);
  const result = floors.slice();
  const ranked = [...Array(stepCount).keys()].sort((a, b) => {
    const diff = remainders[b] - remainders[a];
    if (diff !== 0) return diff;
    // secondary: random order to break ties like python's (rem, rng.random())
    return rng.random() - 0.5;
  });
  for (const idx of ranked.slice(0, remaining)) result[idx] += 1;
  return result.map((v) => sign * v);
}

function allocateDelayBudget(totalDelayS, stepCount, rng) {
  if (stepCount <= 0) return [];
  if (stepCount === 1 || totalDelayS <= 0) return new Array(stepCount).fill(0.0);
  const weights = edgeHeavyWeights(stepCount - 1, rng);
  const sum = weights.reduce((a, b) => a + b, 0);
  const delays = new Array(stepCount).fill(0.0);
  for (let i = 0; i < weights.length; i++) {
    delays[i] = (totalDelayS * weights[i]) / sum;
  }
  return delays;
}

/**
 * Build a list of scroll steps to use with Input.dispatchMouseEvent
 * { type: 'mouseWheel' }. Python uses "ticks"; here one tick = 100 CSS px.
 * Each returned step has {deltaX, deltaY, delayMs}.
 */
export function buildScrollSteps(deltaXCss, deltaYCss, rng, options = {}) {
  const { durationMs = null, cssPixelsPerTick = 100.0 } = options;
  const horizontalTicks = deltaCssToTicks(deltaXCss, cssPixelsPerTick);
  // Python negates the vertical ticks to match its mouse-wheel convention;
  // CDP wants a signed deltaY (positive = scroll down). We keep the CSS
  // convention: positive deltaY in = positive CDP deltaY out.
  const verticalTicks = deltaCssToTicks(deltaYCss, cssPixelsPerTick);
  const magnitude = Math.max(Math.abs(horizontalTicks), Math.abs(verticalTicks));
  if (magnitude === 0) return [];

  const stepCount = estimateScrollStepCount(magnitude);
  const resolvedDurationMs =
    durationMs != null ? durationMs : estimateScrollDurationMs(Math.max(Math.abs(deltaXCss), Math.abs(deltaYCss)));

  const horizontalParts = allocateIntegerTotal(horizontalTicks, stepCount, rng);
  const verticalParts = allocateIntegerTotal(verticalTicks, stepCount, rng);
  const delayParts = allocateDelayBudget(Math.max(0, resolvedDurationMs / 1000.0), stepCount, rng);

  const steps = [];
  for (let i = 0; i < stepCount; i++) {
    steps.push({
      deltaX: horizontalParts[i] * cssPixelsPerTick,
      deltaY: verticalParts[i] * cssPixelsPerTick,
      delayMs: delayParts[i] * 1000.0,
    });
  }
  return steps;
}

// Misc click timings ported from python.
export function defaultClickHoldMs(rng, min = 60, max = 120) {
  return rng.randint(min, max);
}
export function defaultDoubleClickIntervalMs(rng, min = 80, max = 180) {
  return rng.randint(min, max);
}
export function defaultPostActionPauseMs(rng, min = 50, max = 150) {
  return rng.uniform(min, max);
}
