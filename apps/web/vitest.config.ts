import { defineConfig } from 'vitest/config'

// The tested modules (plates, status, displayMachine, csv) are all pure — no DOM,
// no I/O — which is the point of CLAUDE.md §1 "engine logic is pure and tested".
// So no jsdom, and the suite stays fast enough to run on every save.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
