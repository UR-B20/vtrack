import { describe, expect, it } from 'vitest'
import { parsePairing, parsePairingCode, storageKey, typedToken } from './device'

const good = { deviceId: 'cam-a', token: 'x'.repeat(32) }

describe('parsePairing', () => {
  it('accepts a real pairing', () => {
    expect(parsePairing(JSON.stringify(good))).toEqual(good)
  })

  it('trims what was pasted', () => {
    expect(parsePairing(JSON.stringify({ deviceId: ' cam-a ', token: ` ${good.token}\n` }))).toEqual(good)
  })

  it.each([
    ['nothing', null],
    ['not JSON', 'cam-a'],
    ['a short token', JSON.stringify({ ...good, token: 'short' })],
    ['the .env.example placeholder', JSON.stringify({ ...good, token: '<random 32 chars>' })],
    ['a device id with spaces', JSON.stringify({ ...good, deviceId: 'cam a' })],
    ['no device id', JSON.stringify({ token: good.token })],
  ])('refuses %s', (_, raw) => {
    expect(parsePairing(raw)).toBeNull()
  })
})

it('keeps capture and display pairings apart on one origin', () => {
  expect(storageKey('capture')).not.toBe(storageKey('display'))
})

describe('parsePairingCode (the QR from vtrack-pair-qr)', () => {
  const token = 'x'.repeat(32)

  it('reads the pairing payload', () => {
    expect(parsePairingCode(`{"vtrack":1,"device":"cam-a","token":"${token}"}`)).toEqual({ deviceId: 'cam-a', token })
  })

  it('refuses any other QR code', () => {
    expect(parsePairingCode('https://example.com/?token=' + token)).toBeNull()
    expect(parsePairingCode(`{"device":"cam-a","token":"${token}"}`)).toBeNull()      // no marker
    expect(parsePairingCode(`{"vtrack":1,"device":"cam-a","token":"short"}`)).toBeNull()
    expect(parsePairingCode(`{"vtrack":1,"device":"../x","token":"${token}"}`)).toBeNull()
    expect(parsePairingCode('')).toBeNull()
  })
})


describe('typedToken', () => {
  it('upper-cases a token set in admin, typed in lower case or with stray spaces', () => {
    expect(typedToken(' 7k3m-qx9d-0123-4567-89ab-cdef-ghjk-mnpq ')).toBe('7K3M-QX9D-0123-4567-89AB-CDEF-GHJK-MNPQ')
    expect(typedToken('7K3M-QX9D-0123-4567 -89AB-CDEF-GHJK-MNPQ')).toBe('7K3M-QX9D-0123-4567-89AB-CDEF-GHJK-MNPQ')
  })

  it('leaves a DEVICE_TOKENS token exactly as typed — those are case-sensitive', () => {
    expect(typedToken(' aB3_xY9-kLmN0pQr2sTuVwXyZ01234567 ')).toBe('aB3_xY9-kLmN0pQr2sTuVwXyZ01234567')
  })
})
