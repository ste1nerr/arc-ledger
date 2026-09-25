import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 700 },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
