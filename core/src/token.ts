import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time check of a shared secret (RUNNER_TOKEN). Both sides are hashed first, so the comparison always runs
 * over 32 bytes: neither the token's content nor its length can be learned from how long a reply takes, and a guess
 * of the wrong length cannot make timingSafeEqual throw. An empty expected token never matches.
 */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(given ?? ''), h(expected));
}
