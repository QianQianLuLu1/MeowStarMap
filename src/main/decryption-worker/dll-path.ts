/**
 * nuan5_decryption.dll 路径解析（仅主进程可用）
 *
 * FIX(组17-1)：从 decryption-service.ts 迁出为独立模块——
 * DecryptionWorkerBridge 需要在主进程解析 dllPath 并经 DECRYPT_WORKER_INIT 下发给子进程
 * （utilityProcess 内 electron app 模块不可用，子进程无法自行解析 dev/asar 路径）。
 * 独立文件避免 service ↔ bridge 循环 import。
 */
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

export function findDllPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'nuan5_decryption.dll'),
    path.join(process.resourcesPath, 'nuan5_decryption.dll'),
    path.join(app.getAppPath(), 'resources', 'nuan5_decryption.dll')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error('nuan5_decryption.dll not found')
}
