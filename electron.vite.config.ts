import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    base: './',
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react()],
    build: {
      sourcemap: true,
      rollupOptions: {
        output: { manualChunks(id) { return id.includes('node_modules/react') ? 'react-vendor' : undefined } }
      }
    }
  }
})
