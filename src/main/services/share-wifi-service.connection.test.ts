import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import path from 'path'

// 在导入服务模块前覆盖 network-address（默认路由探测），使其可注入“默认路由 IP”
let routeIp = '192.168.1.100'
const Module = require('module')
const originalLoad = Module._load as (...args: unknown[]) => unknown
Module._load = function (request: string, ...args: unknown[]): unknown {
  if (request === 'network-address') {
    return () => routeIp
  }
  return originalLoad(request, ...args)
}

// 网卡：真实 WiFi + VMware 虚拟网卡（私有 IP，但不可作为对外分享地址）
const MOCK_INTERFACES: Record<string, unknown[]> = {
  'Wi-Fi': [
    {
      address: '192.168.1.100',
      family: 'IPv4',
      internal: false,
      mac: '00:00:00:00:00:00',
      netmask: '255.255.255.0',
      cidr: '192.168.1.100/24'
    },
    {
      address: 'fe80::1',
      family: 'IPv6',
      internal: false,
      mac: '00:00:00:00:00:00',
      netmask: 'ffff::',
      cidr: 'fe80::1/64',
      scopeid: 1
    }
  ],
  'VMware Network Adapter VMnet8': [
    {
      address: '192.168.184.1',
      family: 'IPv4',
      internal: false,
      mac: '00:00:00:00:00:00',
      netmask: '255.255.255.0',
      cidr: '192.168.184.1/24'
    }
  ]
}
vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => `C:\\mock\\${name}`) }
}))
vi.mock('os', () => ({
  default: { networkInterfaces: vi.fn(() => MOCK_INTERFACES) }
}))

const { wifiShareService } = await import('./share-wifi-service')

// 真实临时文件（fs 不 mock，确保下载内容与源一致可校验）
const tmpDir = process.env.TEMP || process.env.TMP || '/tmp'
const tempFile = path.join(tmpDir, `wifi-share-test-${Date.now()}.bin`)
const sourceContent = Buffer.from('HELLO-WIFI-SHARE-TEST-' + 'x'.repeat(2048))

// 大文件：用于"客户端下载中途断开"用例——小文件可能在一个 chunk 内传完，来不及断开
const bigFile = path.join(tmpDir, `wifi-share-test-big-${Date.now()}.bin`)
const BIG_FILE_SIZE = 8 * 1024 * 1024

beforeAll(() => {
  fs.writeFileSync(tempFile, sourceContent)
  fs.writeFileSync(bigFile, Buffer.alloc(BIG_FILE_SIZE, 7))
})
afterAll(() => {
  for (const f of [tempFile, bigFile]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* noop */
    }
  }
})

beforeEach(() => {
  routeIp = '192.168.1.100'
})
afterEach(() => {
  wifiShareService.stop()
})

function httpReq(
  port: number,
  pathname: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method ?? 'GET',
        headers: { ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.headers ?? {}) }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('WiFi 局域网分享：绑定与连通性（TDD 红-绿）', () => {
  it('绑定 0.0.0.0，回环可达：GET / 未认证返回 401 认证页（隐式验证 0.0.0.0 绑定，否则 127.0.0.1 会被拒连）', async () => {
    const session = await wifiShareService.start([tempFile])
    expect(session.active).toBe(true)
    expect(session.url).toContain('192.168.1.100')
    expect(String(session.pin).length).toBe(6)

    // 未携带 cookie：返回 401 + 认证页（含 PIN 输入框），浏览器据此展示输入表单
    const res = await httpReq(session.port, '/')
    expect(res.status).toBe(401)
    expect(String(res.headers['content-type'] ?? '')).toContain('text/html')
    expect(res.body.toString()).toContain('id="pin"')

    // 验证实际监听地址为 0.0.0.0（全网卡）
    const addr = (wifiShareService as unknown as { server?: http.Server }).server?.address() as {
      address: string
      port: number
    } | null
    expect(addr?.address).toBe('0.0.0.0')
    expect(addr?.port).toBeGreaterThan(0)

    // 认证后再次访问根路径应返回 200 主页
    const authRes = await httpReq(session.port, `/auth?pin=${session.pin}`, { method: 'POST' })
    const cookie = (authRes.headers['set-cookie'] as string[])[0].split(';')[0]
    const idx = await httpReq(session.port, '/', { cookie })
    expect(idx.status).toBe(200)
  })

  it('PIN 认证后可下载文件，内容与源文件一致', async () => {
    const session = await wifiShareService.start([tempFile])
    const authRes = await httpReq(session.port, `/auth?pin=${session.pin}`, { method: 'POST' })
    expect(authRes.status).toBe(200)
    const setCookie = authRes.headers['set-cookie']
    expect(setCookie).toBeDefined()
    const cookie = (setCookie as string[])[0].split(';')[0]

    const dl = await httpReq(session.port, '/download?id=0', { cookie })
    expect(dl.status).toBe(200)
    expect(dl.body.equals(sourceContent)).toBe(true)
  })

  it('未携带有效 cookie 时下载被拒绝（401），回环地址已放行而非 403', async () => {
    const session = await wifiShareService.start([tempFile])
    const dl = await httpReq(session.port, '/download?id=0')
    expect(dl.status).toBe(401)
  })

  it('network-address 返回虚拟网卡 IP 时，getLanIp 回退到真实 WiFi IP（跳过 VMware）', async () => {
    routeIp = '192.168.184.1' // 默认路由指向 VMware NAT
    const session = await wifiShareService.start([tempFile])
    expect(session.url).toContain('192.168.1.100')
    expect(session.url).not.toContain('192.168.184.1')
  })
})

describe('WiFi 局域网分享：读流生命周期（H2 回归）', () => {
  async function authCookie(port: number, pin: string): Promise<string> {
    const authRes = await httpReq(port, `/auth?pin=${pin}`, { method: 'POST' })
    expect(authRes.status).toBe(200)
    return (authRes.headers['set-cookie'] as string[])[0].split(';')[0]
  }

  it('Range 请求返回 206，内容与源文件对应区间一致', async () => {
    const session = await wifiShareService.start([tempFile])
    const cookie = await authCookie(session.port, session.pin)

    const res = await httpReq(session.port, '/download?id=0', {
      cookie,
      headers: { Range: 'bytes=0-9' }
    })

    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 0-9/${sourceContent.length}`)
    expect(res.body.equals(sourceContent.subarray(0, 10))).toBe(true)
  })

  it('客户端中途断开 → 服务端释放 fd（随后源文件可删除，Windows 上未释放会 EBUSY）', async () => {
    const session = await wifiShareService.start([bigFile])
    const cookie = await authCookie(session.port, session.pin)

    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: session.port,
          path: '/download?id=0',
          headers: { Cookie: cookie }
        },
        (res) => {
          // 收到首个数据块即断开：模拟手机上取消下载
          res.on('data', () => req.destroy())
          res.on('close', () => resolve())
          res.on('end', () => resolve())
        }
      )
      // 客户端主动 destroy 会触发 ECONNRESET，属预期结果
      req.on('error', () => resolve())
      req.end()
    })

    // 给服务端一点时间处理 res 'close' 并销毁读流
    await new Promise((r) => setTimeout(r, 300))

    // 修复前：读流未 destroy，Windows 上这里会抛 EBUSY/EPERM
    expect(() => fs.unlinkSync(bigFile)).not.toThrow()
  })
})
