import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'
import type { Plugin } from 'vite'

const root = __dirname

// 统一以 package.json 的 main（dist/main/main/app/index.js）为入口，
// 不再注入 ELECTRON_ENTRY 时间戳 hack；electron-vite 自动解析 main 块 entry。

/**
 * dev 下剥离 CSP meta：vite dev server 会注入 react-refresh 的 inline preamble，
 * 而 index.html 的严格 script-src 会把它挡掉导致 HMR 失效。仅在 serve 下剥离，
 * 构建产物保持带 CSP。沿用原白屏修复逻辑。
 */
function stripCspMetaInDev(): Plugin {
  return {
    name: 'strip-csp-meta-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n?/i, '')
    }
  }
}

/**
 * build 下剥离 <script>/<link> 上的 crossorigin：file://+asar 加载时 crossorigin 会触发
 * CORS 校验导致模块脚本不执行（白屏）。沿用原白屏修复逻辑。
 */
function stripCrossOriginOnTags(): Plugin {
  return {
    name: 'strip-crossorigin-attrs',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/(<(?:script|link)\b[^>]*?)\s+crossorigin(="[^"]*")?/gi, '$1')
    }
  }
}

/**
 * 写 dist/main/package.json {type:commonjs} 标记：根 package.json 为 type:module，
 * 不写此 shim 时 Node 会把 dist/main/main/app/index.js（CJS）误当 ESM 解析 → 启动即崩。
 * 在 dev / build 都生效，避免旧链“仅在 build 脚本写 shim”导致 dev 缺 shim。
 */
function writeCommonjsShim(): Plugin {
  return {
    name: 'write-commonjs-shim',
    closeBundle() {
      const shimPath = path.join(root, 'dist', 'main', 'package.json')
      fs.writeFileSync(shimPath, JSON.stringify({ type: 'commonjs' }))
    }
  }
}

/**
 * 主进程 / preload 外部化所有裸模块（node 内置、electron、npm 依赖、原生模块），
 * 仅打包项目源码与 @common/@main 别名。行为对齐旧 tsc 构建：依赖运行时从 node_modules 解析。
 * 不覆盖 electron-vite 自带的 electron + node 内置外部化，二者叠加生效。
 */
function externalizeNodeModules(): (id: string) => boolean {
  return (id: string) => {
    // 相对 / 绝对路径（含别名解析后的项目源码）保持打包
    if (id.startsWith('.') || path.isAbsolute(id)) return false
    // 项目别名源码保持打包，避免被外部化
    if (id.startsWith('@common') || id.startsWith('@main')) return false
    // 其余裸模块（electron、node 内置、better-sqlite3、sharp、zod、pluggable-electron 等）均外部化
    return true
  }
}

export default defineConfig({
  main: {
    build: {
      // 嵌套到 app/ 复刻旧 tsc 布局：window-manager 的 __dirname 须为 dist/main/main/app，
      // 否则 ../preload.js 与 ../../../renderer 会差一层目录（白屏风险）。
      // 固定文件名 + emptyOutDir:true：整体清洁交给 clean 脚本，构建只写确定产物。
      outDir: 'dist/main/main/app',
      emptyOutDir: true,
      lib: {
        // 单一 main 入口会把所有 bridge 打包进 app/application.js，其 __dirname 变为 dist/main/main/app/；
        // 而 scanner/media/thumbnail/video/decryption 的 worker-entry.ts 是各自独立的 utilityProcess 入口，
        // 旧 tsc 布局下靠“与 bridge 同目录”的相对路径 fork。打包后必须把它们各自单独产出到 app/，
        // 并让 bridge 用区分性文件名 fork，否则 worker 会指向同一个不存在的 worker-entry.js。
        entry: {
          index: 'src/main/index.ts',
          'scanner-worker': 'src/main/scanner/worker-entry.ts',
          'media-worker': 'src/main/media-worker/worker-entry.ts',
          'thumbnail-worker': 'src/main/thumbnail/worker-entry.ts',
          'video-worker': 'src/main/video-editor/worker-entry.ts',
          'database-worker': 'src/main/database/worker/database-worker.ts',
          'decryption-worker': 'src/main/decryption-worker/worker-entry.ts',
          // 整合阶段 1：NikkiSync 依赖链接探针。单独成入口是为了让它经与真实主进程
          // 完全相同的 CJS 管线产出，从而可实测变量式动态 import 未被折叠成 require。
          'nikkisync-probe': 'src/main/nikkisync/probe-cli.ts'
        },
        formats: ['cjs'],
        // 多入口：每个入口输出为 <name>.js（index.js / scanner-worker.js / ...）
        fileName: (format, entryName) => `${entryName}.js`
      },
      rollupOptions: {
        external: externalizeNodeModules(),
        output: {
          // 根 package.json 为 type:module，Vite lib 模式对 CJS 默认输出 .cjs；
          // 强制 .js（配合 dist/main/package.json {type:commonjs} 标记）让产物以 CJS 解析。
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js'
        }
      },
      // 写 dist/main/package.json {type:commonjs} 标记（dev/build 通用），避免 CJS 产物被当 ESM 解析。
      plugins: [writeCommonjsShim()]
    },
    resolve: {
      alias: {
        '@common': path.resolve(root, 'src/common'),
        '@main': path.resolve(root, 'src/main')
      }
    },
    plugins: []
  },

  // preload 产出 dist/main/main/preload.js，文件名不可改（window-manager.ts 的 ../preload.js 依赖）。
  // 沙箱文件锁仅为环境产物，真实开发机不存在；统一由 electron-vite 接管，固定文件名。
  preload: {
    // 编译期常量：preload 的授信源自检（src/main/preload/origin-guard.ts）据此决定
    // 是否放行 dev server 源。不能用运行时 process.env —— preload 跑在 sandbox 环境，
    // 且 electron-vite 的 lib 模式不会替换 process.env.NODE_ENV（dist 产物保留字面量）。
    // 取值可靠：electron-vite 在加载本配置前已把 NODE_ENV 置为 defaultMode
    // （build → 'production'，serve → 'development'）。
    define: {
      __NIKKI_PRELOAD_DEV__: JSON.stringify(process.env.NODE_ENV === 'development')
    },
    build: {
      outDir: 'dist/main/main',
      // 父级 dist/main 由 clean 清空；此处 false 避免误删同级的 app/ 子目录（main 产物）。
      emptyOutDir: false,
      lib: { entry: 'src/main/preload.ts', formats: ['cjs'], fileName: 'preload' },
      rollupOptions: {
        external: externalizeNodeModules(),
        output: { entryFileNames: '[name].js', chunkFileNames: '[name].js' }
      }
    },
    resolve: {
      alias: {
        '@common': path.resolve(root, 'src/common'),
        '@main': path.resolve(root, 'src/main')
      }
    },
    plugins: []
  },

  renderer: {
    root: 'src/renderer',
    base: './',
    server: {
      port: 5173,
      strictPort: true
    },
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: false,
      modulePreload: { crossOrigin: false },
      // P1-路由代码分割：页面级代码分割后主 chunk 预期降至 1MB 以下，
      // 设 1500 既能在真的超标时告警，又不被 i18n/manualChunks 的合理体积淹没
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: path.resolve(root, 'src/renderer/index.html'),
        // 渲染进程在 sandbox:true + nodeIntegration:false 环境运行，
        // 不能打包 Node 内置 / 原生模块（否则 __dirname 等报错或白屏）。必须显式 external。
        external: [
          'fs',
          'path',
          'os',
          'child_process',
          'crypto',
          'stream',
          'url',
          'util',
          'events',
          'http',
          'https',
          'net',
          'tls',
          'zlib',
          'querystring',
          'buffer',
          'better-sqlite3',
          'sharp',
          'koffi',
          'fluent-ffmpeg',
          'ffmpeg-static',
          'ffprobe-static'
        ],
        output: {
          // 将 i18n 语言包 JSON 拆分为独立 chunk，按需加载
          manualChunks(id) {
            const m = id.match(/\/locales\/(.+?)\.json$/)
            if (m) return 'i18n-' + m[1]
            return undefined
          }
        }
      },
      sourcemap: false
    },
    resolve: {
      alias: {
        '@': path.resolve(root, 'src/renderer'),
        '@main': path.resolve(root, 'src/main'),
        '@common': path.resolve(root, 'src/common'),
        // 关键修复：把 electron 指向空 stub，避免浏览器/sandbox 环境解析 bare specifier "electron" 白屏
        electron: path.resolve(root, 'scripts/electron-browser-stub.js')
      }
    },
    define: {
      // 编译期常量：exe 版编译为 false（预览版走 --mode preview 分支，本阶段未启用）
      __PREVIEW__: JSON.stringify(false)
    },
    plugins: [react(), stripCspMetaInDev(), stripCrossOriginOnTags()]
  }
})
