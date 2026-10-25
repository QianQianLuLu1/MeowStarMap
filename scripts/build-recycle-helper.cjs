/**
 * K8-a：NikkiSync 回收站 helper 构建脚本（win32 用 .NET Framework4 csc.exe 编译）。
 *
 * 用途与调用契约见 `resources/nikkisync/recycle-helper.cs` 头注；本脚本只负责把
 * 那份 C# 源码编成 `resources/nikkisync/nikkisync-recycle-helper.exe`：
 * - win32：探测 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，
 *   `/nologo /target:exe /out:<output> /r:Microsoft.VisualBasic.dll <source>`；
 *   csc 缺失 / 编译失败 / 产物缺失都以**非零退出**并输出可诊断信息，绝不静默。
 * - 非 win32：直接跳过退出 0（helper 只在 Windows 回收站链路被消费）。
 * - 纯函数（resolveSourcePath/resolveOutputPath/resolveCscPath/buildCscArgs）与
 *   注入式 run() 供 `scripts/__tests__/build-recycle-helper.test.ts` 单测（mock 探测结果）。
 *
 * 用法：`npm run build:recycle-helper`（dist:win 链首自动执行，也可单独跑）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/** 产物文件名（与 package.json extraResources 的 filter、装配点 env 拼装保持一致）。 */
const HELPER_BASENAME = 'nikkisync-recycle-helper.exe'
/** csc.exe 相对 %WINDIR% 的固定路径段（.NET Framework 4 自带，无需额外安装 SDK）。 */
const CSC_SEGMENTS = ['Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe']

function resolveSourcePath(projectRoot) {
  return path.join(projectRoot, 'resources', 'nikkisync', 'recycle-helper.cs')
}

function resolveOutputPath(projectRoot) {
  return path.join(projectRoot, 'resources', 'nikkisync', HELPER_BASENAME)
}

/**
 * 探测 csc.exe。`exists` 可注入（单测 mock 探测结果）；
 * 缺失返回 null，由调用方给出可诊断错误——绝不静默跳过 win32 编译。
 */
function resolveCscPath(env, exists = (candidate) => fs.existsSync(candidate)) {
  const windir = (env && env.WINDIR) || 'C:\\Windows'
  const candidate = path.join(windir, ...CSC_SEGMENTS)
  return exists(candidate) ? candidate : null
}

/** csc 参数拼装：/nologo /target:exe /out:<output> /r:Microsoft.VisualBasic.dll <source>。 */
function buildCscArgs(sourcePath, outputPath) {
  return [
    '/nologo',
    '/target:exe',
    `/out:${outputPath}`,
    '/r:Microsoft.VisualBasic.dll',
    sourcePath
  ]
}

/**
 * 主流程。依赖全部可注入；返回进程退出码（0 成功 / 1 失败）。
 * 编译器 stdout 透传到 stderr：编译失败时输出必须可诊断，不允许只留一个退出码。
 */
function run({
  projectRoot,
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = (candidate) => fs.existsSync(candidate),
  log = console.log,
  error = console.error
} = {}) {
  if (platform !== 'win32') {
    log(`[recycle-helper] non-win32 (${platform}); skip building ${HELPER_BASENAME}`)
    return 0
  }
  const source = resolveSourcePath(projectRoot)
  const output = resolveOutputPath(projectRoot)
  if (!exists(source)) {
    error(`[recycle-helper] source not found: ${source}`)
    return 1
  }
  const csc = resolveCscPath(env, exists)
  if (!csc) {
    error(
      '[recycle-helper] csc.exe not found under %WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319; ' +
        'install .NET Framework 4 (preinstalled on Windows 8+) or check WINDIR'
    )
    return 1
  }
  const result = spawn(csc, buildCscArgs(source, output), { windowsHide: true })
  if (result.error) {
    error(`[recycle-helper] failed to spawn csc.exe: ${result.error.message}`)
    return 1
  }
  if (result.status !== 0) {
    error(`[recycle-helper] csc.exe exited with ${result.status}`)
    // 编译器输出必须可诊断：透传走注入的 error 通道（单测可断言），多行原样保留
    const diagnostics = [result.stdout, result.stderr]
      .filter((part) => part && part.length > 0)
      .map((part) => String(part).trim())
      .filter(Boolean)
      .join('\n')
    if (diagnostics) error(diagnostics)
    return 1
  }
  if (!exists(output)) {
    error(`[recycle-helper] csc reported success but output missing: ${output}`)
    return 1
  }
  log(`[recycle-helper] built ${output}`)
  return 0
}

module.exports = {
  HELPER_BASENAME,
  resolveSourcePath,
  resolveOutputPath,
  resolveCscPath,
  buildCscArgs,
  run
}

if (require.main === module) {
  process.exit(run({ projectRoot: path.resolve(__dirname, '..') }))
}
