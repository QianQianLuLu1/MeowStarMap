// 阶段 0 代码探查 · 报告论断校验脚本
// 运行方式（WXNN XiangCe 根目录）：node --test docs/sync-integration/verify-audit.mjs
// 作用：程序化校验 00-code-audit-report.md 中的全部关键论断。
// 红灯预期：报告未写时 T6（报告存在性）失败；其余测试校验的是仓库客观事实。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const wxnnRoot = join(here, '..', '..')
const workspaceRoot = join(wxnnRoot, '..')
const nikkiRoot = join(workspaceRoot, 'NikkiSync')

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** 三段数字版本比较：actual >= min 时返回 true */
export function isAtLeast(actual, min) {
  const a = String(actual).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const m = String(min).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const x = a[i] ?? 0
    const y = m[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

// ---------------------------------------------------------------- T1 项目元信息
test('T1 两项目 package.json 可读且 name/engines 与预期一致', () => {
  const wxnn = readJson(join(wxnnRoot, 'package.json'))
  assert.equal(wxnn.name, 'wxnn-photo-manager')
  assert.equal(wxnn.engines.node, '>=22.12.0')

  const nikki = readJson(join(nikkiRoot, 'package.json'))
  assert.equal(nikki.name, 'nikkisync')
  assert.equal(nikki.engines.node, '>=24.0.0')
  assert.deepEqual(nikki.workspaces, ['apps/*', 'packages/*', 'tools/*'])
})

// ---------------------------------------------------------------- T9/T10 版本边界
test('T9 版本比较函数边界语义正确（>= 为满足）', () => {
  assert.equal(isAtLeast('24.0.0', '24.0.0'), true, '24.0.0 应视为满足 >=24.0.0')
  assert.equal(isAtLeast('23.9.9', '24.0.0'), false)
  assert.equal(isAtLeast('24.18.0', '24.0.0'), true)
  assert.equal(isAtLeast('26.3.0', '24.0.0'), true)
  assert.equal(isAtLeast('22.12.0', '22.12.0'), true)
  assert.equal(isAtLeast('22.11.0', '22.12.0'), false)
})

test('T10 本机 Node 与两个项目 engines 要求的满足性', () => {
  const local = process.versions.node
  assert.equal(isAtLeast(local, '22.12.0'), true, `本机 Node ${local} 应满足 WXNN >=22.12.0`)
  assert.equal(isAtLeast(local, '24.0.0'), true, `本机 Node ${local} 应满足 NikkiSync >=24.0.0`)
})

// ---------------------------------------------------------------- T2 Electron 与内置 Node
test('T2 WXNN Electron 实装版本一致且内置 Node >= 24', async () => {
  const wxnnPkg = readJson(join(wxnnRoot, 'package.json'))
  const declared = wxnnPkg.devDependencies.electron
  const installedPkg = readJson(join(wxnnRoot, 'node_modules', 'electron', 'package.json'))
  assert.equal(installedPkg.version, declared, `实装 electron(${installedPkg.version}) 应与声明(${declared}) 一致`)

  const distVersion = readFileSync(join(wxnnRoot, 'node_modules', 'electron', 'dist', 'version'), 'utf8').trim()
  assert.equal(distVersion, declared, `dist/version(${distVersion}) 应与声明(${declared}) 一致`)

  const electronExe = join(wxnnRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  assert.ok(existsSync(electronExe), 'electron.exe 应存在')
  const { stdout } = await execFileAsync(electronExe, ['-e', 'console.log(process.versions.node)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 60_000,
  })
  const nodeInElectron = stdout.trim()
  assert.match(nodeInElectron, /^\d+\.\d+\.\d+$/, `Electron 内置 Node 版本输出异常: "${nodeInElectron}"`)
  assert.ok(
    isAtLeast(nodeInElectron, '24.0.0'),
    `Electron 内置 Node ${nodeInElectron} 必须 >= 24.0.0`
  )
})

// ---------------------------------------------------------------- T3 WXNN 数据库层事实
test('T3 media_files 建表语句含全部 19 基础列且无 sha256 列；phash 经 safeEnsureColumn 增量加入', () => {
  const src = readFileSync(join(wxnnRoot, 'src', 'main', 'database', 'connection.ts'), 'utf8')

  const marker = 'CREATE TABLE IF NOT EXISTS media_files ('
  const start = src.indexOf(marker)
  assert.notEqual(start, -1, '未找到 media_files 建表语句')
  const end = src.indexOf(');', start)
  assert.notEqual(end, -1, 'media_files 建表语句块未正确闭合')
  const ddl = src.slice(start, end)

  const baseColumns = [
    'id', 'file_path', 'file_name', 'file_type', 'file_ext', 'file_size',
    'width', 'height', 'duration', 'created_at', 'modified_at', 'source_path',
    'thumbnail', 'tags', 'category_id', 'rating', 'is_favorite', 'notes', 'indexed_at',
  ]
  const missingCols = baseColumns.filter((c) => !new RegExp(`^\\s*${c}\\s`, 'm').test(ddl))
  assert.deepEqual(missingCols, [], `media_files 建表语句缺少列: ${missingCols.join(', ')}`)

  assert.ok(!/sha256/i.test(ddl), 'media_files 建表语句中不应出现 sha256 列（需求关键结论）')
  assert.ok(
    src.includes("this.safeEnsureColumn('media_files', 'phash TEXT')"),
    'media_files 的 phash 列应经 safeEnsureColumn 增量添加'
  )
  assert.ok(src.includes("const mod = await import('better-sqlite3')"), 'SQLite 驱动应为 better-sqlite3 惰性动态导入')
})

// ---------------------------------------------------------------- T4 NikkiSync 协议层事实
test('T4 协议层定义 12 条路由、9 个错误码、4 个认证头', () => {
  const src = readFileSync(join(nikkiRoot, 'packages', 'protocol', 'src', 'index.ts'), 'utf8')

  const routes = [
    "'/v1/server'",
    "'/v1/pair'",
    "'/v1/assets'",
    '/v1/assets/${encodeURIComponent(assetId)}',
    '/v1/assets/${encodeURIComponent(assetId)}/metadata',
    '/v1/assets/${encodeURIComponent(assetId)}/resources/${encodeURIComponent(resourceId)}',
    '/v1/assets/${encodeURIComponent(assetId)}/clothing/${encodeURIComponent(clothingId)}/thumbnail',
    "'/v1/search/suits'",
    "'/v1/search/clothing'",
    "'/v1/profile/stats'",
    "'/v1/changes'",
    "'/ws/v1'",
  ]
  const missingRoutes = routes.filter((r) => !src.includes(r))
  assert.deepEqual(missingRoutes, [], `API_ROUTES 缺少路由定义: ${missingRoutes.join(' | ')}`)

  const errorCodes = [
    'bad_request', 'unauthorized', 'pairing_expired', 'pairing_invalid', 'not_found',
    'revision_too_old', 'protocol_mismatch', 'resource_not_ready', 'internal_error',
  ]
  const missingCodes = errorCodes.filter((c) => !src.includes(`'${c}'`))
  assert.deepEqual(missingCodes, [], `API_ERROR_CODES 缺少错误码: ${missingCodes.join(', ')}`)

  const authHeaders = [
    "'X-NikkiSync-Device-Id'", "'X-NikkiSync-Timestamp'", "'X-NikkiSync-Nonce'", "'X-NikkiSync-Signature'",
  ]
  const missingHeaders = authHeaders.filter((h) => !src.includes(h))
  assert.deepEqual(missingHeaders, [], `AuthHeaders 缺少认证头: ${missingHeaders.join(', ')}`)

  assert.ok(src.includes('PROTOCOL_VERSION = 1'), '协议版本常量 PROTOCOL_VERSION = 1 应存在')
})

// ---------------------------------------------------------------- T5 依赖安装状态
test('T5 两个项目依赖均已成功安装（关键包存在）', () => {
  const wxnnKeyPkgs = ['electron', 'better-sqlite3', 'vitest', '@playwright/test', 'sharp']
  const wxnnMissing = wxnnKeyPkgs.filter((p) => !existsSync(join(wxnnRoot, 'node_modules', p, 'package.json')))
  assert.deepEqual(wxnnMissing, [], `WXNN node_modules 缺少关键包: ${wxnnMissing.join(', ')}`)

  const nikkiKeyPkgs = ['typescript', 'qrcode', 'esbuild', join('@esbuild', 'win32-x64'), '@types/node']
  const nikkiMissing = nikkiKeyPkgs.filter((p) => !existsSync(join(nikkiRoot, 'node_modules', p, 'package.json')))
  assert.deepEqual(nikkiMissing, [], `NikkiSync node_modules 缺少关键包: ${nikkiMissing.join(', ')}`)
})

// ---------------------------------------------------------------- T6/T7/T8 报告存在性与路径清单
test('T6 探查报告存在（根目录唯一真相源 + docs 副本）且包含关键结论', () => {
  const rootReport = join(workspaceRoot, '00-code-audit-report.md')
  const docsCopy = join(wxnnRoot, 'docs', 'sync-integration', '00-code-audit-report.md')
  assert.ok(existsSync(rootReport), `根目录报告缺失: ${rootReport}（红灯预期失败点）`)
  assert.ok(existsSync(docsCopy), `docs 副本缺失: ${docsCopy}`)

  const content = readFileSync(rootReport, 'utf8')
  assert.ok(content.includes('24.18.0'), '报告应明确记载 Electron 内置 Node 版本 24.18.0')
  assert.ok(content.includes('media_files'), '报告应明确回答 media_files 表结论')
  assert.ok(content.includes('sha256'), '报告应明确回答 sha256 字段结论')
})

test('T8 报告引用的全部关键文件路径真实存在（一次收集全部缺失项）', () => {
  const manifest = [
    // ---- WXNN XiangCe ----
    'WXNN XiangCe/package.json',
    'WXNN XiangCe/package-lock.json',
    'WXNN XiangCe/vitest.config.ts',
    'WXNN XiangCe/.node-version',
    'WXNN XiangCe/AGENTS.md',
    'WXNN XiangCe/ARCHITECTURE.md',
    'WXNN XiangCe/src/main/database/connection.ts',
    'WXNN XiangCe/src/main/database/media-repository.ts',
    'WXNN XiangCe/src/main/database/AGENTS.md',
    'WXNN XiangCe/src/main/database/worker/database-worker.ts',
    'WXNN XiangCe/src/main/database/worker/database-worker-bridge.ts',
    'WXNN XiangCe/src/main/database/worker/worker-protocol.ts',
    'WXNN XiangCe/src/main/scanner/index.ts',
    'WXNN XiangCe/src/main/scanner/worker-protocol.ts',
    'WXNN XiangCe/src/main/scanner/scanner-worker-bridge.ts',
    'WXNN XiangCe/src/main/scanner/worker-entry.ts',
    'WXNN XiangCe/src/main/scanner/scan-channels.ts',
    'WXNN XiangCe/src/main/app/ipc-setup.ts',
    'WXNN XiangCe/src/main/ipc/validator.ts',
    'WXNN XiangCe/src/main/ipc/handler-context.ts',
    'WXNN XiangCe/src/main/ipc/handlers/scanner-handler.ts',
    'WXNN XiangCe/src/main/ipc/handlers/share.ts',
    'WXNN XiangCe/src/main/ipc/handlers/decrypt-handler.ts',
    'WXNN XiangCe/src/main/services/share-wifi-service.ts',
    'WXNN XiangCe/src/main/services/decryption-service.ts',
    'WXNN XiangCe/src/main/utils/file-utils.ts',
    'WXNN XiangCe/src/main/utils/media-constants.ts',
    'WXNN XiangCe/src/shared/types/ipc.ts',
    'WXNN XiangCe/src/shared/types/progress.ts',
    'WXNN XiangCe/src/renderer/stores/mediaStore.ts',
    'WXNN XiangCe/src/renderer/pages/SettingsPage.tsx',
    'WXNN XiangCe/src/renderer/pages/settings/scan-sections.tsx',
    'WXNN XiangCe/tests/setup.ts',
    'WXNN XiangCe/tests/mocks/electron.ts',
    'WXNN XiangCe/e2e/playwright.config.ts',
    'WXNN XiangCe/docs/IPC_CONTRACT.md',
    'WXNN XiangCe/docs/CODING_CONVENTIONS.md',
    'WXNN XiangCe/scripts/core-path-gate.ts',
    'WXNN XiangCe/data/album_index.db',
    // ---- NikkiSync ----
    'NikkiSync/package.json',
    'NikkiSync/package-lock.json',
    'NikkiSync/AGENTS.md',
    'NikkiSync/README.md',
    'NikkiSync/tsconfig.base.json',
    'NikkiSync/.gitignore',
    'NikkiSync/scripts/build-wechat-runtime.mjs',
    'NikkiSync/packages/core/package.json',
    'NikkiSync/packages/core/src/index.ts',
    'NikkiSync/packages/core/src/types.ts',
    'NikkiSync/packages/core/src/path-key.ts',
    'NikkiSync/packages/core/src/resolver.ts',
    'NikkiSync/packages/core/src/metadata-dictionary.ts',
    'NikkiSync/packages/core/test/resolver.test.ts',
    'NikkiSync/packages/protocol/package.json',
    'NikkiSync/packages/protocol/src/index.ts',
    'NikkiSync/packages/protocol/README.md',
    'NikkiSync/packages/protocol/test/protocol.test.ts',
    'NikkiSync/packages/database/package.json',
    'NikkiSync/packages/database/migrations/0001_initial.sql',
    'NikkiSync/packages/database/src/database-manager.ts',
    'NikkiSync/packages/database/src/models.ts',
    'NikkiSync/packages/database/src/asset-repository.ts',
    'NikkiSync/packages/database/src/resource-repository.ts',
    'NikkiSync/packages/database/src/change-journal-repository.ts',
    'NikkiSync/packages/database/src/pairing-repository.ts',
    'NikkiSync/packages/database/src/sync-read-repository.ts',
    'NikkiSync/packages/database/src/index.ts',
    'NikkiSync/packages/database/scripts/validate-schema.mjs',
    'NikkiSync/packages/database/test/database.test.ts',
    'NikkiSync/apps/pc-companion/package.json',
    'NikkiSync/apps/pc-companion/src/server/LocalSyncServer.ts',
    'NikkiSync/apps/pc-companion/src/server/AuthService.ts',
    'NikkiSync/apps/pc-companion/src/server/PairingService.ts',
    'NikkiSync/apps/pc-companion/src/server/LocalTlsIdentityService.ts',
    'NikkiSync/apps/pc-companion/src/server/MdnsAdvertiser.ts',
    'NikkiSync/apps/pc-companion/src/server/WebSocketHub.ts',
    'NikkiSync/apps/pc-companion/src/server/row-mappers.ts',
    'NikkiSync/apps/pc-companion/src/server/index.ts',
    'NikkiSync/apps/pc-companion/src/qr.ts',
    'NikkiSync/apps/pc-companion/src/runtime.ts',
    'NikkiSync/apps/pc-companion/src/dev-server.ts',
    'NikkiSync/apps/pc-companion/src/windows-app.ts',
    'NikkiSync/apps/pc-companion/src/game-directory-discovery.ts',
    'NikkiSync/apps/pc-companion/src/desktop/DesktopControlServer.ts',
    'NikkiSync/apps/pc-companion/src/remote/RemoteBridgeService.ts',
    'NikkiSync/apps/pc-companion/src/remote/RemoteRoutes.ts',
    'NikkiSync/apps/pc-companion/src/remote/RemoteSessionStore.ts',
    'NikkiSync/apps/pc-companion/src/scanner/index.ts',
    'NikkiSync/apps/pc-companion/src/metadata/NikkiAlbumsMetadataDictionaryProvider.ts',
    'NikkiSync/apps/pc-companion/src/wechat/WeChatGalleryService.ts',
    'NikkiSync/apps/pc-companion/test/local-sync-server.test.ts',
    'NikkiSync/apps/pc-companion/test/scanner.test.ts',
    'NikkiSync/apps/mobile/app/build.gradle.kts',
    'NikkiSync/apps/wechat-mini-program/miniprogram/lib/THIRD_PARTY.md',
    'NikkiSync/apps/windows-shell/NikkiSync.WindowsShell.csproj',
    'NikkiSync/tools/wechat-gallery/server.mjs',
    'NikkiSync/tools/wechat-crypto-spike/client-api.mjs',
    'NikkiSync/docs/INTEGRATION.md',
    'NikkiSync/docs/GPT_HANDOFF_2026-09-04.md',
    'NikkiSync/.github/workflows/ci.yml',
  ]
  const missing = manifest.filter((rel) => !existsSync(join(workspaceRoot, rel)))
  assert.deepEqual(missing, [], `以下 ${missing.length} 个报告引用路径不存在:\n  ${missing.join('\n  ')}`)
})
