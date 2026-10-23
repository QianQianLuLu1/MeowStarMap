/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src.renderer.components.common.UpdateDialog
 * @coverage 检查更新弹窗改造契约：error / not-available 模态标题"更新"、双按钮"关闭"+"确定"、确定跳官网、not-available 移出 toast
 * @dependencies fs（源码结构检查）
 * @remarks 沿用 GalleryPage.test.tsx 的源码结构性断言模式。UpdateDialog 依赖 i18n / IPC，
 *   不直接 render，改用源码字符串断言。做否定断言前必须剔除注释行，否则会误命中本文件
 *   注释中引用的缺陷写法（如"更新出错""重试"）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const dialogSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'components', 'common', 'UpdateDialog.tsx'),
  'utf-8'
)

// 剔除 // 行注释与 /* */ 块注释，避免否定断言误命中注释中引用的缺陷写法
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const code = stripComments(dialogSrc)

describe('UpdateDialog 检查更新弹窗改造（error / not-available）', () => {
  it('error 模态标题使用 updateTitle（"更新"），不再硬编码"更新出错"', () => {
    expect(code).toContain("t('settings.about.updateTitle')")
    expect(code).not.toContain('更新出错')
  })

  it('error 模态正文使用 updateNetworkBusy 文案', () => {
    expect(code).toContain("t('settings.about.updateNetworkBusy')")
  })

  it('error 模态按钮为"关闭"(common.close) + "确定"(common.ok)，不再含"重试"', () => {
    expect(code).toContain("t('common.close')")
    expect(code).toContain("t('common.ok')")
    expect(code).not.toContain('重试')
  })

  it('isModalStage 已纳入 not-available', () => {
    expect(code).toMatch(/s === 'not-available'/)
  })

  it('onUpdate 回调不再为 not-available 弹 toast（避免重复提示）', () => {
    // not-available 进入模态，不应再走轻量 toast 分支
    expect(code).not.toContain("p.stage === 'not-available'")
  })

  it('not-available 模态正文使用 updateNoNewVersion 文案', () => {
    expect(code).toContain("t('settings.about.updateNoNewVersion')")
  })

  it('"确定"按钮调用 handleOpenOfficial，且该函数打开官网（openExternal + GITHUB_URL），不再重试 checkUpdate', () => {
    expect(code).toContain('handleOpenOfficial')
    expect(code).toContain('GITHUB_URL')
    expect(code).toContain('openExternal')
    // 不应存在重试逻辑（旧 handleRetry / 再次 checkUpdate）
    expect(code).not.toContain('handleRetry')
    expect(code).not.toMatch(/app\?\.checkUpdate\(\)/)
  })

  it('模块级 GITHUB_URL 常量指向目标官网', () => {
    expect(dialogSrc).toContain("const GITHUB_URL = 'https://github.com/QianQianLuLu1/MeowStarMap'")
  })

  it('i18n key 在 zh-CN / en 中均已声明', () => {
    const zh = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'renderer', 'i18n', 'locales', 'zh-CN.json'),
      'utf-8'
    )
    const en = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'renderer', 'i18n', 'locales', 'en.json'),
      'utf-8'
    )
    for (const key of ['updateTitle', 'updateNetworkBusy', 'updateNoNewVersion']) {
      expect(zh).toContain(`"${key}"`)
      expect(en).toContain(`"${key}"`)
    }
  })
})
