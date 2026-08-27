'use strict'
/**
 * electron-builder afterPack 钩子：将 VC++ 2015-2022 x64 运行库 DLL 随包分发。
 *
 * 背景：better-sqlite3 / koffi（VS2022 编译）与 sharp/libvips 均动态链接
 * vcruntime140.dll / vcruntime140_1.dll / msvcp140.dll / concrt140.dll。
 * 干净 Windows 10 环境缺少这些 DLL 时，原生模块 LoadLibrary 失败 → 进程静默退出。
 *
 * 做法：打包时把构建机 %SystemRoot%\System32 中的 4 个 DLL 复制到与 electron.exe
 * 同级的 appOutDir 根。Windows DLL 搜索顺序（.node 目录 → exe 目录 → System32）保证
 * 原生模块能找到它们，无需改应用代码。
 *
 * 许可：这 4 个 DLL 属于 Microsoft Visual C++ 2015-2022 可再发行组件，按微软再分发
 * 许可允许随应用分发。构建机须已安装该可再发行组件（CI windows-latest 自带）；
 * 任一 DLL 缺失则 throw 中断打包，避免“漏带运行库”被发版。
 */
const fs = require('fs')
const path = require('path')

const VC_DLLS = [
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'concrt140.dll'
]

module.exports = function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return
  }
  const appOutDir = context.appOutDir
  if (!appOutDir || !fs.existsSync(appOutDir)) {
    throw new Error('[afterPack:vc-runtime] appOutDir 不存在: ' + String(appOutDir))
  }
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  for (const dll of VC_DLLS) {
    const src = path.join(system32, dll)
    const dest = path.join(appOutDir, dll)
    if (!fs.existsSync(src)) {
      throw new Error(
        '[afterPack:vc-runtime] 构建机缺失 ' + dll + '（预期路径 ' + src +
        '）。请先在构建机安装 Microsoft Visual C++ 2015-2022 可再发行组件 (x64)，' +
        '否则打包产物在干净 Windows 系统将无法加载原生模块。'
      )
    }
    fs.copyFileSync(src, dest)
    console.log('[afterPack:vc-runtime] 已随包 ' + dll + ' -> ' + dest)
  }
}
