/**
 * deviceToken.ts — a new device token, made in the admin's browser (CLAUDE.md §11, Device
 * tokens, 26 Oct 2026). Pure apart from the random source and WebCrypto.
 *
 * The token is shown once on the Devices page for pairing and never stored: only its
 * sha256 goes to `devices.token_hash`, and the engine (auth.py token_hash) hashes what a
 * device sends the same way. It is typed by hand at a desktop (Chrome on Windows cannot
 * scan the pairing QR), so it is Crockford base32 — no I, L, O or U to misread — in groups
 * of four: 32 symbols, 160 bits.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SYMBOLS = 32

export function newDeviceToken(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(SYMBOLS))
  // 256 is a multiple of 32, so the low five bits of a uniform byte are uniform.
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31])
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4).join(''))
  return groups.join('-')
}

export const TOKEN_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/

/** sha256 of the token's UTF-8, lowercase hex — devices.token_hash. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
