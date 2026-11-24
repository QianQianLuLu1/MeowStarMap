import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 安装器前端：dev 端口固定 1420（与 tauri.conf.json 的 devUrl 对齐）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    target: 'chrome120'
  }
})
