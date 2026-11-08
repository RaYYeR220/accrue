import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // passing tests print the relayer's event log and onError lines on purpose; a failing test keeps its logs
    silent: 'passed-only',
    // node:sqlite (the D1 stand-in) warns that it is experimental in every test process
    poolOptions: { forks: { execArgv: ['--disable-warning=ExperimentalWarning'] } },
  },
})
