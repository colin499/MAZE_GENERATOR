/** Deterministic 32-bit string hashing (cyrb53-derived) used to seed RNG streams. */
export function hash32(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** Four 32-bit words derived from a string, for seeding sfc32. */
export function hash128(str: string): [number, number, number, number] {
  return [hash32(str, 1), hash32(str, 2), hash32(str, 3), hash32(str, 4)];
}
