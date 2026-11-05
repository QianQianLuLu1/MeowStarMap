/**
 * @layer L2
 * @module src/main/app/auto-update
 * @coverage 更新错误归类推送 / beta 版本的 allowPrerelease 钉定 / 开发版未初始化抛错与假源开关 / available 与进度事件透传
 * @dependencies electron（mock）、electron-updater（mock）、../utils/logger、../i18n、./renderer-bridge（stub）
 * @remarks 观测面是 `sendToRenderer` 的入参：主进程对渲染端的全部可见行为都经它出门，因此不打桩 IPC 也能判定。
 *   修复前的误报形状：`autoUpdater.on('error')` 对所有失败一律推 `{stage:'error'}` 且不带归类，渲染层把 error
 *   写死成「当前网络繁忙，点击确定跳转官网」——线上真实原因是 Release 缺 latest.yml（实测 `releases.atom` 200、
 *   `latest.yml` 404），与用户网络无关。见 docs/plans/2026-11-05-fix-update-check-network-busy-misreport.md §一。
 *   allowPrerelease 的 fake 初值取 true，是因为 `AppUpdater` 构造时执行
 *   `this.allowPrerelease = hasPrereleaseComponents(currentVersion)`，而 package.json 版本是 `2.5.7-beta`。
 *   红绿分账（实测）：修复前 17 例中 7 红 10 绿。7 盏红为「latest.yml 缺失归 source」「连接被拒归
 *   network」「downloadUpdate 归类」「allowPrerelease 钉 false」「dev 未初始化 reject」「dev 假源开关
 *   可检查」「从未 init 时 reject」；10 盏绿是刻意保留的回归锁与守卫（防止本轮改动破坏既有行为、
 *   并挡住「设 channel」这类错修法），包括 error 只推一次、autoDownload/autoInstallOnAppQuit 取舍、
 *   生产包 forceDevUpdateConfig 恒 false，以及「事件透传与检查流程」describe 全部用例。
 *   审查轮（同日）另加一盏红：downloadUpdate 那条此前只 mockRejectedValue，测不到上游「先 emit 再
 *   rethrow」的双推；改按真实形状 mock 后，catch 里多推的那一条即被 `toHaveLength(1)` 判红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC_ERROR_CODES } from '../../shared/types/ipc-types'
import type { AppContext } from './app-context'
import type { UpdatePayload } from '../../shared/types/electron-api'

const { appMock, autoUpdaterMock, listeners, sendToRendererMock, loggerMock } = vi.hoisted(() => {
  const listeners: Record<string, Array<(payload: unknown) => void>> = {}
  const autoUpdaterMock = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    // electron-updater 对 `2.5.7-beta` 客户端的构造期默认值（AppUpdater.js:218）
    allowPrerelease: true,
    forceDevUpdateConfig: false,
    channel: undefined as string | undefined,
    allowDowngrade: false,
    on: (event: string, cb: (payload: unknown) => void): void => {
      ;(listeners[event] ||= []).push(cb)
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  }
  return {
    listeners,
    autoUpdaterMock,
    appMock: { isPackaged: true },
    sendToRendererMock: vi.fn(),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }
})

vi.mock('electron', () => ({ app: appMock }))
vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))
vi.mock('../utils/logger', () => ({ logger: loggerMock }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
vi.mock('./renderer-bridge', () => ({ sendToRenderer: sendToRendererMock }))

const fakeCtx = { mainWindow: null } as unknown as AppContext

/** 每个用例都要重置模块级单例状态（initialized / ctxRef），否则用例间互相污染 */
async function loadFresh() {
  vi.resetModules()
  return await import('./auto-update')
}

/** 触发 electron-updater 事件：本轮注册的监听器全部吃到 */
function emit(event: string, payload: unknown): void {
  for (const cb of listeners[event] ?? []) cb(payload)
}

/** 取本会话推给渲染端的最后一个 app:update 载荷 */
function lastPushedPayload(): UpdatePayload | undefined {
  for (let i = sendToRendererMock.mock.calls.length - 1; i >= 0; i -= 1) {
    const call = sendToRendererMock.mock.calls[i]
    if (call[1] === 'app:update') return call[2] as UpdatePayload
  }
  return undefined
}

/** 线上真实抛出的错误：latest.yml 在最新 release 产物里找不到（404） */
function channelFileMissingError(): Error {
  const err = new Error(
    'Cannot find latest.yml in the latest release artifacts (https://github.com/QianQianLuLu1/MeowStarMap/releases/download/2.5.0/latest.yml): HttpError: Response code 404 (Not Found)'
  ) as Error & { code?: string }
  err.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  return err
}

/** 真断网形态：连接被拒（本地假源服务没起 / 现实里拔网线） */
function connectionRefusedError(): Error {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:8123') as Error & { code?: string }
  err.code = 'ECONNREFUSED'
  return err
}

describe('initAutoUpdater —— 更新事件归类推送', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key]
    sendToRendererMock.mockClear()
    loggerMock.info.mockClear()
    loggerMock.warn.mockClear()
    loggerMock.error.mockClear()
    appMock.isPackaged = true
    autoUpdaterMock.allowPrerelease = true
    autoUpdaterMock.forceDevUpdateConfig = false
    autoUpdaterMock.channel = undefined
    autoUpdaterMock.allowDowngrade = false
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(undefined)
    autoUpdaterMock.downloadUpdate.mockReset().mockResolvedValue(undefined)
    autoUpdaterMock.quitAndInstall.mockReset()
    delete process.env.MEOW_DEV_UPDATE_FEED
  })

  it('latest.yml 缺失（线上真实错误）必须归为 source，不得再冒充网络问题', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('error', channelFileMissingError())

    expect(lastPushedPayload()).toEqual(
      expect.objectContaining({ stage: 'error', errorKind: 'source' })
    )
    // 真实原因不得丢失：既要多推一份给渲染端，也要进主进程日志（UI 不显示技术串）
    expect(lastPushedPayload()?.errorMessage).toContain('Cannot find latest.yml')
  })

  it('连接被拒必须归为 network，保留原「当前网络繁忙」语义', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('error', connectionRefusedError())

    expect(lastPushedPayload()).toEqual(
      expect.objectContaining({ stage: 'error', errorKind: 'network' })
    )
  })

  it('error 事件只推一次（同一失败不得弹两次模态）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('error', channelFileMissingError())

    const errorPushes = sendToRendererMock.mock.calls.filter(
      (call) => (call[2] as UpdatePayload).stage === 'error'
    )
    expect(errorPushes).toHaveLength(1)
  })

  it('downloadUpdate 失败：上游既 emit error 又 reject，也只允许推一条 error（归类仍须是 network）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)
    const err = connectionRefusedError()
    // 忠实复刻上游：AppUpdater.downloadUpdate 的 errorHandler 先 dispatchError 再 rethrow
    // （node_modules/electron-updater/out/AppUpdater.js:650-672），故事件与 catch 会同时到达。
    // 双推的实害：UpdateDialog 的订阅回调每次推送都 setDismissed(false) ⇒ 刚点「关闭」的模态被弹回。
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      emit('error', err)
      throw err
    })

    await mod.downloadUpdate()

    expect(lastPushedPayload()).toEqual(
      expect.objectContaining({ stage: 'error', errorKind: 'network' })
    )
    const errorPushes = sendToRendererMock.mock.calls.filter(
      (call) => (call[2] as UpdatePayload).stage === 'error'
    )
    expect(errorPushes).toHaveLength(1)
  })
})

describe('initAutoUpdater —— beta 版本号的更新通道', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key]
    appMock.isPackaged = true
    autoUpdaterMock.allowPrerelease = true
    autoUpdaterMock.channel = undefined
    autoUpdaterMock.allowDowngrade = false
    autoUpdaterMock.forceDevUpdateConfig = false
    delete process.env.MEOW_DEV_UPDATE_FEED
  })

  it('生产环境必须把 allowPrerelease 钉回 false，否则 2.5.7-beta 客户端会在 feed 里抓错 tag', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    expect(autoUpdaterMock.allowPrerelease).toBe(false)
  })

  it('不得设置 channel：AppUpdater 的 channel setter 有 allowDowngrade=true 的副作用', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    expect(autoUpdaterMock.channel).toBeUndefined()
    expect(autoUpdaterMock.allowDowngrade).toBe(false)
  })

  it('保持既有取舍：autoDownload=false 与 autoInstallOnAppQuit=false（发现新版先问用户）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    expect(autoUpdaterMock.autoDownload).toBe(false)
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })
})

describe('开发版与假更新源开关', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key]
    sendToRendererMock.mockClear()
    appMock.isPackaged = false
    autoUpdaterMock.forceDevUpdateConfig = false
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(undefined)
    delete process.env.MEOW_DEV_UPDATE_FEED
  })

  it('未打包且未开假源时，checkForUpdates 必须 reject 出 PRECONDITION_FAILED（渲染层据此跳官网兜底）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    await expect(mod.checkForUpdates()).rejects.toMatchObject({
      code: IPC_ERROR_CODES.PRECONDITION_FAILED
    })
    // 不得先推 checking 让 UI 闪一下「正在检查更新…」再无声收场
    expect(
      sendToRendererMock.mock.calls.some((call) => (call[2] as UpdatePayload).stage === 'checking')
    ).toBe(false)
  })

  it('开了假源开关（MEOW_DEV_UPDATE_FEED=1）则 dev 也能真检查：推 checking 且不抛', async () => {
    process.env.MEOW_DEV_UPDATE_FEED = '1'
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    await expect(mod.checkForUpdates()).resolves.toBeUndefined()

    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(true)
    expect(lastPushedPayload()).toEqual(expect.objectContaining({ stage: 'checking' }))
  })

  it('生产包绝不允许 forceDevUpdateConfig 为 true（假更新源不得影响出货产物）', async () => {
    process.env.MEOW_DEV_UPDATE_FEED = '1'
    appMock.isPackaged = true
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(false)
  })

  it('未初始化（从未调 initAutoUpdater）时 checkForUpdates 也要 reject，不得静默 return', async () => {
    appMock.isPackaged = true
    const mod = await loadFresh()

    await expect(mod.checkForUpdates()).rejects.toMatchObject({
      code: IPC_ERROR_CODES.PRECONDITION_FAILED
    })
  })
})

describe('事件透传与检查流程（回归锁：修复前后都应绿）', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key]
    sendToRendererMock.mockClear()
    appMock.isPackaged = true
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(undefined)
    delete process.env.MEOW_DEV_UPDATE_FEED
  })

  it('update-available 推出版本号与发布说明（下载弹窗的数据来源）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('update-available', {
      version: '9.9.9',
      releaseName: 'v9.9.9',
      releaseNotes: [{ version: '9.9.9', note: '修复检查更新' }]
    })

    expect(lastPushedPayload()).toEqual(
      expect.objectContaining({ stage: 'available', version: '9.9.9' })
    )
    expect(lastPushedPayload()?.releaseNotes).toContain('修复检查更新')
  })

  it('update-not-available 推 not-available（不得退化成 error）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('update-not-available', { version: '2.5.7-beta' })

    expect(lastPushedPayload()).toEqual(expect.objectContaining({ stage: 'not-available' }))
  })

  it('download-progress 归一化 NaN 百分比为 0', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('download-progress', { percent: Number.NaN })

    expect(lastPushedPayload()).toEqual(
      expect.objectContaining({ stage: 'downloading', percent: 0 })
    )
  })

  it('update-downloaded 推 readyToInstall（安装并重启按钮的数据来源）', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    emit('update-downloaded', { version: '9.9.9', releaseNotes: null, releaseName: null })

    expect(lastPushedPayload()).toEqual(
      expect.objectContaining({ stage: 'downloaded', readyToInstall: true })
    )
  })

  it('检查抛错但 error 事件已触发时，checkForUpdates 不重复推 error、也不往外抛', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)
    autoUpdaterMock.checkForUpdates.mockRejectedValue(channelFileMissingError())

    await expect(mod.checkForUpdates()).resolves.toBeUndefined()

    const countErrorPushes = (): number =>
      sendToRendererMock.mock.calls.filter((call) => (call[2] as UpdatePayload).stage === 'error')
        .length

    // catch 分支只补日志，error 由事件唯一负责
    expect(countErrorPushes()).toBe(0)
    emit('error', channelFileMissingError())
    expect(countErrorPushes()).toBe(1)
    expect(loggerMock.warn).toHaveBeenCalled()
  })

  it('quitAndInstall 透传 (false, true)：显示安装进度并在装完后重启', async () => {
    const mod = await loadFresh()
    mod.initAutoUpdater(fakeCtx)

    mod.quitAndInstall()

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
