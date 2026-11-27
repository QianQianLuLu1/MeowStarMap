import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

/**
 * 被测脚本以真子进程运行，跨进程的路径必须交给宿主的真内置单例：
 * CI 宿主模拟装置只改写测试图内的 import（装置轴 8 也只翻译 program 与 options.cwd），
 * 拿装置给的 posix 假路径当 `--require` / `--out` 会让子进程在 Windows 上找不到文件。
 * 真 CI（Linux）上这些真单例本就是 posix 语义，读数不变。
 */
const hostRequire = createRequire(import.meta.url)
const fs = hostRequire('node:fs')
const os = hostRequire('node:os')
const path = hostRequire('node:path')
const { spawnSync } = hostRequire('node:child_process')
const script = hostRequire.resolve('./build-payload.mjs')
const projectRoot = path.dirname(path.dirname(path.dirname(script)))

describe('build-payload', () => {
  it('生成清单时不得整文件读取 payload', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-payload-test-'))
    try {
      const unpacked = path.join(temp, 'win-unpacked')
      fs.mkdirSync(path.join(unpacked, 'resources'), { recursive: true })
      fs.writeFileSync(path.join(unpacked, 'resources', 'app.asar'), 'asar')
      const out = path.join(temp, 'payload.zip')
      const hook = path.join(temp, 'forbid-whole-read.cjs')
      fs.writeFileSync(
        hook,
        `const fs = require('node:fs'); const cp = require('node:child_process'); cp.execFileSync = (_command, args) => { fs.writeFileSync(args[3], 'zip'); }; require('node:module').syncBuiltinESMExports(); const original = fs.readFileSync; fs.readFileSync = function (file, ...args) { if (String(file).endsWith('payload.zip')) throw new Error('whole-file payload read'); return original.call(this, file, ...args); };`
      )

      const result = spawnSync(
        process.execPath,
        [script, `--unpacked=${unpacked}`, `--out=${out}`, '--version=2.5.8'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ?? ''} --require=${hook.replaceAll('\\', '/')}`.trim()
          }
        }
      )

      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(fs.existsSync(`${out}.json`)).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'))
      expect(manifest).toMatchObject({ file: 'payload.zip', format: 'zip', version: '2.5.8' })
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
