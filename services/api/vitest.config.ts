import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const apiRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: apiRoot,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 15000,
    fileParallelism: false,
    // vitest 4 把 poolOptions 移到顶层，强制单进程串行避免共享 test DB 污染
    pool: 'forks',
    singleFork: true,
  },
})
