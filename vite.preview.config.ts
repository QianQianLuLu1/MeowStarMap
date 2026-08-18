import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'path'
import fs from 'fs'

// 预览版独立构建配置：将 src/renderer/ React 源码构建为单文件 preview.html
// 与 exe 版 vite.config.ts 完全解耦，不影响主构建链

// 后处理插件：viteSingleFile 输出 preview/index.html（保留入口相对路径），
// 此插件在 writeBundle 钩子将内容拷贝到根目录 preview.html
// 中间产物 preview/ 目录在 closeBundle 钩子清理（此时 Vite 已释放文件句柄，
// 避免 Windows 下 Node fs.rmSync 在 writeBundle 钩子内删除不可靠的问题）
const movePreviewHtmlPlugin = {
  name: 'move-preview-html',
  writeBundle() {
    const generatedPath = path.resolve(__dirname, 'preview/index.html')
    const targetPath = path.resolve(__dirname, 'preview.html')
    if (!fs.existsSync(generatedPath)) return
    // 先删除旧文件（避免文件锁导致覆盖失败）
    try {
      fs.unlinkSync(targetPath)
    } catch {
      /* 文件不存在或被占用，忽略 */
    }
    fs.copyFileSync(generatedPath, targetPath)
  },
  // closeBundle 在所有文件写入完成后执行，此时 Vite 已释放句柄
  closeBundle() {
    const previewDir = path.resolve(__dirname, 'preview')
    if (!fs.existsSync(previewDir)) return
    // 清理中间产物目录；失败不致命（下次构建 writeBundle 会覆盖 preview.html）
    try {
      fs.rmSync(previewDir, { recursive: true, force: true })
    } catch {
      /* Windows 文件句柄偶发占用，忽略；下次构建会覆盖 */
    }
  }
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), movePreviewHtmlPlugin],
  base: './',
  // root 仍指向 src/renderer，复用 exe 版源码与别名
  root: './src/renderer',
  // 入口 HTML：preview/index.html（与 exe 版 index.html 隔离，仅入口 script 不同）
  build: {
    outDir: path.resolve(__dirname, './'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, './src/renderer/preview/index.html')
      },
      output: {
        // 取消 i18n chunk 拆分（exe 版的 manualChunks 在此处不复用）
        manualChunks: undefined
      }
    },
    // 资源全部内联为 base64（图标、字体、SVG 占位图）
    assetsInlineLimit: 100000000,
    sourcemap: false,
    chunkSizeWarningLimit: 100000,
    cssCodeSplit: false
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@main': path.resolve(__dirname, './src/main'),
      '@common': path.resolve(__dirname, './src/common'),
      // 与 exe 版 vite.config.ts 保持一致：把 electron 指向空 stub，
      // 避免打包真实 electron 包（其 index.js 引用 __dirname 等 Node 全局，浏览器抛 ReferenceError 导致白屏）
      electron: path.resolve(__dirname, './scripts/electron-browser-stub.js')
    }
  },
  define: {
    // 编译期常量：业务代码用 if (__PREVIEW__) 分支判断预览版/exe 版环境
    __PREVIEW__: JSON.stringify(true)
  }
})
