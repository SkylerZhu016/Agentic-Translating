import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
    ],
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
