/**
 * Seeded randomness. Everything random in the project (terrain, and later
 * race incidents) draws from these generators, so one seed always gives the
 * same result on every machine.
 */

/** Hashes a seed string to an unsigned 32-bit integer (FNV-1a with a final avalanche). */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Returns a generator of uniform floats in [0, 1) (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random generator seeded from a string, e.g. `seededRandom("482913")`. */
export function seededRandom(seed: string): () => number {
  return mulberry32(hashSeed(seed));
}

/** A fresh six-digit seed for the "random seed" button. */
export function randomSeedString(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}
