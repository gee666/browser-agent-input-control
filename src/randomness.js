// SeededRandom — port of python-input-control/src/python_input_control/randomness.py
//
// We do NOT try to replicate Python's `random.Random` bit-for-bit — that's a
// Mersenne Twister. For test reproducibility we instead expose a small
// deterministic RNG (mulberry32) seeded from the same input types Python
// accepts (int / string / Uint8Array / null). When the seed is null we fall
// back to Math.random for parity with Python's seedless mode.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256Uint32(bytes) {
  // Tiny FNV-ish digest — we only need a stable 32-bit seed, not a crypto
  // hash. Keep it synchronous and dependency-free.
  let h = 0x811c9dc5 >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function normalizeSeed(seed) {
  if (seed === null || seed === undefined) return null;
  if (typeof seed === 'number') return seed >>> 0;
  if (typeof seed === 'string') {
    const bytes = new TextEncoder().encode(seed);
    return sha256Uint32(bytes);
  }
  if (seed instanceof Uint8Array) {
    return sha256Uint32(seed);
  }
  if (Array.isArray(seed)) {
    return sha256Uint32(Uint8Array.from(seed));
  }
  throw new TypeError('Unsupported seed type');
}

export class SeededRandom {
  constructor(seed = null) {
    this.seed = seed;
    const normalized = normalizeSeed(seed);
    this._next = normalized === null ? Math.random : mulberry32(normalized);
    // Box-Muller carry for gauss().
    this._gaussCarry = null;
  }

  /** Uniform [0, 1). */
  random() {
    return this._next();
  }

  /** Uniform [a, b]. Mirrors python random.uniform. */
  uniform(a, b) {
    return a + (b - a) * this._next();
  }

  /** Normal(mu, sigma). Box-Muller with a cached second draw. */
  gauss(mu, sigma) {
    if (this._gaussCarry !== null) {
      const z = this._gaussCarry;
      this._gaussCarry = null;
      return mu + sigma * z;
    }
    let u1 = 0;
    // Avoid 0 for log().
    while (u1 <= Number.EPSILON) u1 = this._next();
    const u2 = this._next();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = mag * Math.cos(2.0 * Math.PI * u2);
    const z1 = mag * Math.sin(2.0 * Math.PI * u2);
    this._gaussCarry = z1;
    return mu + sigma * z0;
  }

  /** Inclusive [a, b] integer. */
  randint(a, b) {
    const lo = Math.ceil(a);
    const hi = Math.floor(b);
    return lo + Math.floor(this._next() * (hi - lo + 1));
  }
}

export function boundedGauss(rng, mu, sigma, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, rng.gauss(mu, sigma)));
}
