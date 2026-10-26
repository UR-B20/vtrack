import { describe, expect, it } from 'vitest'
import { newDeviceToken, tokenHash, TOKEN_SHAPE } from './deviceToken'

describe('newDeviceToken', () => {
  it('is eight groups of four, with no letter that reads as another', () => {
    const t = newDeviceToken()
    expect(t).toMatch(TOKEN_SHAPE)
    expect(t).not.toMatch(/[ILOU]/)
    expect(t.replace(/-/g, '')).toHaveLength(32)
  })

  it('uses the whole alphabet from the random bytes', () => {
    const t = newDeviceToken((b) => b.map((_, i) => i))
    expect(t).toBe('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ')
  })

  it('is new every time', () => {
    expect(new Set(Array.from({ length: 50 }, () => newDeviceToken())).size).toBe(50)
  })
})

describe('tokenHash', () => {
  it('matches the engine: sha256 hex (auth.py token_hash, tested on the same input)', async () => {
    expect(await tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
