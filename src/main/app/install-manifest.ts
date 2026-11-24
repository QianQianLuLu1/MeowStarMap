// @core-change: 新增安装信息清单（供后续自定义安装器读取安装目录/版本/渠道）
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { logger } from '../utils/logger'

/** 安装信息清单 schema 版本（自定义安装器读取时据此判兼容）。 */
export const INSTALL_MANIFEST_SCHEMA_VERSION = 1

/** 清单文件名（安装目录与 userData 各写一份）。 */
export const INSTALL_MANIFEST_FILENAME = 'install-manifest.json'

export type InstallChannel = 'stable' | 'beta' | 'dev'

export interface InstallManifestV1 {
  schemaVersion: 1
  /** package.json build.appId（读不到时为 null） */
  appId: string | null
  productName: string
  version: string
  channel: InstallChannel
  arch: string
  /** 安装目录（进程 exe 所在目录） */
  installDir: string
  exePath: string
  electronVersion: string
  generatedAt: string
}

export interface InstallManifestInput {
  appId: string | null
  productName: string
  version: string
  channel: InstallChannel
  arch: string
  installDir: string
  exePath: string
  electronVersion: string
}

/** 纯函数：构造清单对象（不触磁盘，便于单测）。 */
export function buildInstallManifest(input: InstallManifestInput, now: Date = new Date()): InstallManifestV1 {
  return {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    appId: input.appId,
    productName: input.productName,
    version: input.version,
    channel: input.channel,
    arch: input.arch,
    installDir: input.installDir,
    exePath: input.exePath,
    electronVersion: input.electronVersion,
    generatedAt: now.toISOString()
  }
}

/** 由版本号推断渠道：含预发布后缀（-beta/-rc 等）为 beta，未打包为 dev。 */
export function inferInstallChannel(version: string, packaged: boolean): InstallChannel {
  if (!packaged) return 'dev'
  return version.includes('-') ? 'beta' : 'stable'
}

/** 读取当前应用 package.json 的 build.appId（打包/开发态都可能可用，失败返回 null）。 */
function readAppId(): string | null {
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { build?: { appId?: unknown } }
    return typeof pkg.build?.appId === 'string' ? pkg.build.appId : null
  } catch {
    return null
  }
}

/**
 * 清单落点：安装目录 + userData。
 * - 安装目录：自定义安装器覆盖升级时直接读取；
 * - userData：即使安装目录被移动/权限受限也有备份。
 */
export function resolveInstallManifestPaths(): string[] {
  return [
    path.join(path.dirname(app.getPath('exe')), INSTALL_MANIFEST_FILENAME),
    path.join(app.getPath('userData'), INSTALL_MANIFEST_FILENAME)
  ]
}

/**
 * 写出安装信息清单（best-effort，失败不阻塞启动）。
 * dev 态不写，避免污染仓库；打包态启动时调用一次即可。
 */
export function writeInstallManifest(): InstallManifestV1 | null {
  if (!app.isPackaged) return null
  try {
    const version = app.getVersion()
    const manifest = buildInstallManifest({
      appId: readAppId(),
      productName: app.getName(),
      version,
      channel: inferInstallChannel(version, app.isPackaged),
      arch: process.arch,
      installDir: path.dirname(app.getPath('exe')),
      exePath: app.getPath('exe'),
      electronVersion: process.versions.electron ?? 'unknown'
    })
    const body = JSON.stringify(manifest, null, 2)
    for (const target of resolveInstallManifestPaths()) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, body, 'utf8')
      } catch (err) {
        logger.warn(`[install-manifest] 写入失败: ${target}`, err)
      }
    }
    logger.info(`[install-manifest] 已写入安装信息清单 v${manifest.schemaVersion}（${manifest.productName} ${manifest.version}）`)
    return manifest
  } catch (err) {
    logger.warn('[install-manifest] 构造/写入安装信息清单失败（不阻塞启动）', err)
    return null
  }
}
