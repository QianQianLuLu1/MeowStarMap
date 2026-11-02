import dgram from 'node:dgram'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createRuntimeSession } from '../../src/main/nikkisync/runtime-facade'
import type { NikkiSyncRuntimeSession } from '../../src/main/nikkisync/runtime-types'
import {
  classifyMdnsLoopReadings,
  formatMdnsLoopReadings,
  parseMdnsProbeArgs
} from './mdns-loop-verdict'

/**
 * mDNS 组播自激复测探针（02 计划 N5）。
 *
 * 用途：把「上游修没修好、本仓该不该默认开 mDNS」从一个注释里的历史读数，变成一条可复跑的测量。
 * 做法是在进程内经真实装载缝起两次 `LocalSyncServer`（`mdns:true` / `mdns:false` 各一个窗口），
 * 另开一个**外部**组播监听 socket 数「载荷里带本次 serverId 的包」——观测面不注入上游公告器的
 * 内部状态，量的就是真的会打到局域网里的东西。
 *
 * 运行（需在已建链的开发机上）：
 *   npx tsx scripts/sync-e2e/mdns-loop-probe.ts --seconds 60
 *
 * 铁律：本脚本只测量并打印读数，不写设置、不改源码、不做单边测量（判据与参数解析都在
 * `mdns-loop-verdict.ts`，壳不长业务）。
 *
 * 与 `launch-server.ts` 同属「脚本 import 主进程模块」的在册例外：内嵌面必须用真实上游产物，
 * 复制装配逻辑就测不到东西；见 `scripts/AGENTS.md` 注意事项。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MULTICAST_GROUP = '224.0.0.251'
const MULTICAST_PORT = 5353

interface WindowReadings {
  onPackets: number
  offPackets: number
  seconds: number
}

/** 起一个窗口：按 mdns 开关建会话、起服务、外部监听组播，返回过滤后的包数。 */
async function runWindow(input: {
  seconds: number
  mdns: boolean
  databaseFile: string
}): Promise<number> {
  // 上游只负责开库，不负责建父目录；两个窗口各用独立库，免得第二个窗口继承第一个的 TLS 身份
  mkdirSync(path.dirname(input.databaseFile), { recursive: true })
  const session: NikkiSyncRuntimeSession = await createRuntimeSession({
    databaseFile: input.databaseFile,
    watcher: false,
    projectRoot,
    syncServer: {
      // 绑 0.0.0.0 才有局域网网卡可公告；端口 0 由系统分配，避免撞用户正在跑的服务
      host: '0.0.0.0',
      port: 0,
      mdns: input.mdns,
      name: 'Meow Star Map probe',
      journalPollMs: 250
    }
  })
  const observer = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  let packets = 0
  const needle = Buffer.from(session.server.serverId)
  const onMessage = (message: Buffer): void => {
    if (message.includes(needle)) packets += 1
  }
  try {
    const address = await session.server.start()
    await new Promise<void>((resolve, reject) => {
      observer.once('error', reject)
      observer.bind(MULTICAST_PORT, () => {
        try {
          observer.addMembership(MULTICAST_GROUP)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    observer.on('message', onMessage)
    process.stdout.write(
      `[mdns-loop-probe] window mdns=${String(input.mdns)} listening=${address.host}:${String(
        address.port
      )} serverId=${session.server.serverId} seconds=${String(input.seconds)}\n`
    )
    await new Promise<void>((resolve) => {
      setTimeout(resolve, input.seconds * 1000)
    })
  } finally {
    observer.off('message', onMessage)
    try {
      observer.close()
    } catch {
      /* 已关闭或从未绑定成功 */
    }
    try {
      await session.server.stop()
    } catch (error) {
      process.stderr.write(`[mdns-loop-probe] server.stop failed: ${String(error)}\n`)
    }
    session.dispose()
  }
  return packets
}

async function main(): Promise<number> {
  let seconds: number
  try {
    seconds = parseMdnsProbeArgs(process.argv.slice(2)).seconds
  } catch (error) {
    process.stderr.write(`[mdns-loop-probe] ${String(error)}\n`)
    return 1
  }
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'wxnn-mdns-probe-'))
  try {
    const onPackets = await runWindow({
      seconds,
      mdns: true,
      databaseFile: path.join(tempRoot, 'on', 'nikkisync.db')
    })
    const offPackets = await runWindow({
      seconds,
      mdns: false,
      databaseFile: path.join(tempRoot, 'off', 'nikkisync.db')
    })
    const readings: WindowReadings = { onPackets, offPackets, seconds }
    process.stdout.write(`${formatMdnsLoopReadings(readings, 0)}\n`)
    const judgement = classifyMdnsLoopReadings(readings)
    process.stdout.write(`${JSON.stringify({ ...readings, ...judgement })}\n`)
    // 探针本身不因结论失败而报错：inconclusive 与 feedback_loop 都是有效读数，
    // 退出码只表示「测量是否成功完成」，裁决与回写由调用方按 verdict 处理。
    return 0
  } catch (error) {
    process.stderr.write(`[mdns-loop-probe] measurement failed: ${String(error)}\n`)
    return 2
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error: unknown) => {
    process.stderr.write(`[mdns-loop-probe] unexpected: ${String(error)}\n`)
    process.exit(2)
  })
