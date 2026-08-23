import { describe, it, expect } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import {
  SYSTEM_SENSITIVE_DIRS,
  validateFilePathArray,
  validateFilePath,
  validateNonSensitivePath,
  isSensitivePath,
  validateNumberRange,
  validateIntRange,
  validateStringLength,
  validateMediaId,
  validateMediaIdArray,
  validateTagName,
  validateHttpUrl,
  validateFilterPreset
} from './ipc-validate'
import {
  MAX_PATH_ARRAY_SIZE,
  MAX_MEDIA_ID_ARRAY_SIZE,
  MAX_TAG_NAME_LENGTH,
  MAX_FILE_PATH_LENGTH
} from './constants'

/**
 * IPC 校验 12 函数 characterization tests
 *
 * 目的：在 P2 重构前固化现有行为，作为安全网。
 * 测试在公共 seam（exported functions）上观察行为，不依赖内部实现。
 * 边界场景：null/undefined/空值/极端尺寸/类型错误/Unicode/路径分隔符。
 */

describe('ipc-validate', () => {
  describe('SYSTEM_SENSITIVE_DIRS 常量', () => {
    it('包含 5 个 Windows 系统敏感目录', () => {
      expect(SYSTEM_SENSITIVE_DIRS).toHaveLength(5)
      expect(SYSTEM_SENSITIVE_DIRS).toContain('C:\\Windows\\System32')
      expect(SYSTEM_SENSITIVE_DIRS).toContain('C:\\Windows\\SysWOW64')
      expect(SYSTEM_SENSITIVE_DIRS).toContain('C:\\Program Files')
      expect(SYSTEM_SENSITIVE_DIRS).toContain('C:\\Program Files (x86)')
      expect(SYSTEM_SENSITIVE_DIRS).toContain('C:\\ProgramData')
    })

    it('是只读数组（readonly）', () => {
      // TypeScript 层面的约束，运行时仍是数组
      expect(Array.isArray(SYSTEM_SENSITIVE_DIRS)).toBe(true)
    })
  })

  describe('validateFilePathArray', () => {
    it('非数组返回 invalid', () => {
      expect(validateFilePathArray(null)).toEqual({ valid: false, message: '参数必须是字符串数组' })
      expect(validateFilePathArray(undefined)).toEqual({
        valid: false,
        message: '参数必须是字符串数组'
      })
      expect(validateFilePathArray('C:\\foo')).toEqual({
        valid: false,
        message: '参数必须是字符串数组'
      })
      expect(validateFilePathArray({})).toEqual({ valid: false, message: '参数必须是字符串数组' })
    })

    it('空数组返回 invalid', () => {
      expect(validateFilePathArray([])).toEqual({ valid: false, message: '路径数组不能为空' })
    })

    it('超过默认上限 1000 返回 invalid', () => {
      const arr = Array(MAX_PATH_ARRAY_SIZE + 1).fill('C:\\file.jpg')
      const r = validateFilePathArray(arr)
      expect(r.valid).toBe(false)
      expect(r.message).toBe(`路径数量超过上限 ${MAX_PATH_ARRAY_SIZE}`)
    })

    it('刚好等于默认上限 1000 返回 valid', () => {
      const arr = Array(MAX_PATH_ARRAY_SIZE).fill('C:\\file.jpg')
      expect(validateFilePathArray(arr)).toEqual({ valid: true })
    })

    it('自定义 maxCount 生效', () => {
      expect(validateFilePathArray(['C:\\a'], 5)).toEqual({ valid: true })
      const arr = Array(6).fill('C:\\file.jpg')
      const r = validateFilePathArray(arr, 5)
      expect(r.valid).toBe(false)
      expect(r.message).toBe('路径数量超过上限 5')
    })

    it('元素非字符串返回 invalid', () => {
      expect(validateFilePathArray([123])).toEqual({
        valid: false,
        message: `路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`
      })
      expect(validateFilePathArray([null])).toEqual({
        valid: false,
        message: `路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`
      })
      expect(validateFilePathArray([undefined])).toEqual({
        valid: false,
        message: `路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`
      })
    })

    it('元素为空字符串返回 invalid', () => {
      expect(validateFilePathArray([''])).toEqual({
        valid: false,
        message: `路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`
      })
    })

    it('元素超过 1024 字符返回 invalid', () => {
      const long = 'C:\\' + 'a'.repeat(MAX_FILE_PATH_LENGTH)
      const r = validateFilePathArray([long])
      expect(r.valid).toBe(false)
      expect(r.message).toBe(`路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`)
    })

    it('相对路径元素返回 invalid', () => {
      const r = validateFilePathArray(['relative\\path.jpg'])
      expect(r.valid).toBe(false)
      expect(r.message).toBe('路径必须是绝对路径: relative\\path.jpg')
    })

    it('合法绝对路径数组返回 valid', () => {
      expect(validateFilePathArray(['C:\\foo.jpg', 'D:\\bar\\baz.png'])).toEqual({ valid: true })
    })

    it('首个非法元素立即返回（短路）', () => {
      const r = validateFilePathArray(['C:\\ok.jpg', 'bad', 'C:\\ok2.jpg'])
      expect(r.valid).toBe(false)
      expect(r.message).toBe('路径必须是绝对路径: bad')
    })
  })

  describe('validateFilePath', () => {
    it('非字符串返回 invalid', () => {
      const expected = {
        valid: false,
        message: `路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`
      }
      expect(validateFilePath(null)).toEqual(expected)
      expect(validateFilePath(undefined)).toEqual(expected)
      expect(validateFilePath(123)).toEqual(expected)
      expect(validateFilePath({})).toEqual(expected)
      expect(validateFilePath([])).toEqual(expected)
    })

    it('空字符串返回 invalid', () => {
      expect(validateFilePath('')).toEqual({
        valid: false,
        message: `路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`
      })
    })

    it('超过 1024 字符返回 invalid', () => {
      const long = 'C:\\' + 'a'.repeat(MAX_FILE_PATH_LENGTH)
      const r = validateFilePath(long)
      expect(r.valid).toBe(false)
      expect(r.message).toBe(`路径必须是 1-${MAX_FILE_PATH_LENGTH} 字符的字符串`)
    })

    it('刚好 1024 字符返回 valid', () => {
      const exact = 'C:\\' + 'a'.repeat(MAX_FILE_PATH_LENGTH - 3)
      expect(validateFilePath(exact)).toEqual({ valid: true })
    })

    it('相对路径返回 invalid', () => {
      const r = validateFilePath('foo\\bar.jpg')
      expect(r.valid).toBe(false)
      expect(r.message).toBe('路径必须是绝对路径: foo\\bar.jpg')
    })

    it('Unix 风格根路径 /foo 在 Windows 上被 path.isAbsolute 视为绝对路径', () => {
      // Node.js win32 path.isAbsolute 对任何以 / 或 \ 开头的路径都返回 true
      // 这是 Node.js 的行为，不是 validateFilePath 自身的逻辑
      // 潜在风险：攻击者可传入 /etc/passwd 绕过"绝对路径"校验
      // 后续重构 review 时可考虑加 win32 盘符校验（如 /^[A-Za-z]:[\\/]/）
      // 当前 characterization 阶段：固化现有行为
      const r = validateFilePath('/usr/local/foo.jpg')
      expect(r.valid).toBe(true)
    })

    it('合法绝对路径返回 valid', () => {
      expect(validateFilePath('C:\\foo.jpg')).toEqual({ valid: true })
      expect(validateFilePath('D:\\sub\\dir\\bar.png')).toEqual({ valid: true })
    })
  })

  describe('validateNonSensitivePath', () => {
    it('精确匹配敏感目录返回 invalid', () => {
      for (const d of SYSTEM_SENSITIVE_DIRS) {
        const r = validateNonSensitivePath(d)
        expect(r.valid).toBe(false)
        expect(r.message).toBe('出于安全考虑，不允许操作系统敏感目录')
      }
    })

    it('敏感目录子路径返回 invalid', () => {
      expect(validateNonSensitivePath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toEqual({
        valid: false,
        message: '出于安全考虑，不允许操作系统敏感目录'
      })
      expect(validateNonSensitivePath('C:\\Program Files\\App\\app.exe')).toEqual({
        valid: false,
        message: '出于安全考虑，不允许操作系统敏感目录'
      })
      expect(validateNonSensitivePath('C:\\ProgramData\\App\\config.json')).toEqual({
        valid: false,
        message: '出于安全考虑，不允许操作系统敏感目录'
      })
    })

    it('大小写不敏感匹配', () => {
      expect(validateNonSensitivePath('c:\\windows\\system32')).toEqual({
        valid: false,
        message: '出于安全考虑，不允许操作系统敏感目录'
      })
      expect(validateNonSensitivePath('C:\\WINDOWS\\SYSTEM32')).toEqual({
        valid: false,
        message: '出于安全考虑，不允许操作系统敏感目录'
      })
    })

    it('前缀相似但非敏感目录子路径不误拦截（边界检查）', () => {
      // 'C:\\Program Filesabc' 不应被 'C:\\Program Files' 误拦
      expect(validateNonSensitivePath('C:\\Program Filesabc\\app')).toEqual({ valid: true })
      // 'C:\\ProgramDataX' 不应被 'C:\\ProgramData' 误拦
      expect(validateNonSensitivePath('C:\\ProgramDataX\\foo')).toEqual({ valid: true })
    })

    it('非敏感路径返回 valid', () => {
      expect(validateNonSensitivePath('D:\\game\\photos\\foo.jpg')).toEqual({ valid: true })
      expect(validateNonSensitivePath('C:\\Users\\me\\Pictures\\bar.png')).toEqual({ valid: true })
    })

    it('相对路径会被 path.resolve 解析为工作目录子路径', () => {
      // 相对路径经 path.resolve 后通常落在 cwd（项目目录），不会进入敏感目录
      // 此处仅断言函数不抛错
      const r = validateNonSensitivePath('foo\\bar.jpg')
      expect(r.valid).toBe(true)
    })
  })

  // ============ FIX(组5-2): 敏感目录判定扩展 ============
  describe('isSensitivePath 扩展覆盖（组5-2）', () => {
    it('任意盘符的 Windows / Program Files / ProgramData 均拒绝', () => {
      expect(isSensitivePath('D:\\Windows\\System32\\cmd.exe')).toBe(true)
      expect(isSensitivePath('E:\\Program Files\\app\\app.exe')).toBe(true)
      expect(isSensitivePath('F:\\Program Files (x86)\\app')).toBe(true)
      expect(isSensitivePath('G:\\ProgramData\\secret')).toBe(true)
      expect(isSensitivePath('d:/windows/system32')).toBe(true)
    })

    it('UNC 管理共享（\\\\server\\c$）根与子路径均拒绝', () => {
      expect(isSensitivePath('\\\\server\\c$\\Windows\\notepad.exe')).toBe(true)
      expect(isSensitivePath('\\\\localhost\\c$')).toBe(true)
      // 非管理共享的普通 UNC 路径不按敏感处理
      expect(isSensitivePath('\\\\nas\\photos\\a.jpg')).toBe(false)
    })

    it('用户主目录下的凭据目录拒绝，普通目录放行', () => {
      const home = os.homedir()
      // path.posix.join 保证 Linux 上拼接出纯逻辑可判定的路径（源码已固化 win32 语义）
      expect(isSensitivePath(path.posix.join(home, '.ssh', 'id_rsa'))).toBe(true)
      expect(isSensitivePath(path.posix.join(home, '.aws', 'credentials'))).toBe(true)
      expect(isSensitivePath(path.posix.join(home, '.gnupg', 'pubring.kbx'))).toBe(true)
      expect(isSensitivePath(path.posix.join(home, 'Pictures', 'photo.jpg'))).toBe(false)
      // 同名目录不在主目录下时不误伤
      expect(isSensitivePath('D:\\game\\.ssh\\config')).toBe(false)
    })

    it('validateNonSensitivePath 对扩展场景生效', () => {
      expect(validateNonSensitivePath('D:\\Windows\\explorer.exe').valid).toBe(false)
      expect(validateNonSensitivePath('\\\\server\\c$\\Users\\x').valid).toBe(false)
      expect(validateNonSensitivePath(path.posix.join(os.homedir(), '.ssh', 'config')).valid).toBe(
        false
      )
    })

    // 依赖真实 Windows 文件系统（junction 符号链接 / D:\Windows 目录），仅 win32 执行；
    // 源码已用 path.win32 固化语义，其余纯逻辑用例全平台运行。
    describe.skipIf(process.platform !== 'win32')(
      '符号链接敏感目录复检（仅 Windows 真实文件系统）',
      () => {
        it('符号链接指向敏感目录时 realpath 复检拒绝（junction 不需要管理员权限）', () => {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-sensitive-'))
          const linkToSensitive = path.join(tmpDir, 'looks-normal')
          const normalTarget = path.join(tmpDir, 'normal')
          const linkToNormal = path.join(tmpDir, 'link-normal')
          // 假敏感目录：D:\Windows\<unique>，匹配 DRIVE_SYSTEM_DIR_RE（盘符后第一段为 windows），
          // 避开本机 C:\Windows\System32 被系统锁定导致 junction 创建失败（EBUSY）。
          // 唯一子目录避免与真实 D:\Windows 冲突，清理时只删自己创建的目录。
          const fakeSensitiveDir = path.join('D:\\Windows', `nikki-${process.pid}-${Date.now()}`)
          try {
            fs.mkdirSync(fakeSensitiveDir, { recursive: true })
            fs.symlinkSync(fakeSensitiveDir, linkToSensitive, 'junction')
            expect(validateNonSensitivePath(linkToSensitive).valid).toBe(false)

            // 对照组：junction 指向普通临时目录 → 放行
            fs.mkdirSync(normalTarget)
            fs.symlinkSync(normalTarget, linkToNormal, 'junction')
            expect(validateNonSensitivePath(linkToNormal).valid).toBe(true)
          } finally {
            // 先删除 junction 链接（rmdirSync 仅删除重解析点，不跟随目标），
            // 再逐个删除空目录。不用 fs.rmSync 递归：本机 Node 对非空目录
            // 的 rmdirSync 静默失败（不抛错也不删除），递归会残留目录。
            try {
              fs.rmdirSync(linkToSensitive)
            } catch {}
            try {
              fs.rmdirSync(linkToNormal)
            } catch {}
            try {
              fs.rmdirSync(normalTarget)
            } catch {}
            try {
              fs.rmdirSync(tmpDir)
            } catch {}
            // 清理假敏感目录及其空父目录（仅当是我们创建且为空时才删除）
            try {
              fs.rmdirSync(fakeSensitiveDir)
            } catch {}
            try {
              fs.rmdirSync('D:\\Windows')
            } catch {}
          }
        })
      }
    )
  })

  describe('validateNumberRange', () => {
    it('非数字返回 invalid', () => {
      const expected = { valid: false, message: 'value 必须是有限数字' }
      expect(validateNumberRange(null, 0, 10)).toEqual(expected)
      expect(validateNumberRange(undefined, 0, 10)).toEqual(expected)
      expect(validateNumberRange('5', 0, 10)).toEqual(expected)
      expect(validateNumberRange({}, 0, 10)).toEqual(expected)
    })

    it('NaN / Infinity / -Infinity 返回 invalid', () => {
      const expected = { valid: false, message: 'value 必须是有限数字' }
      expect(validateNumberRange(NaN, 0, 10)).toEqual(expected)
      expect(validateNumberRange(Infinity, 0, 10)).toEqual(expected)
      expect(validateNumberRange(-Infinity, 0, 10)).toEqual(expected)
    })

    it('低于下限返回 invalid', () => {
      expect(validateNumberRange(-1, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须在 0-10 范围内'
      })
    })

    it('高于上限返回 invalid', () => {
      expect(validateNumberRange(11, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须在 0-10 范围内'
      })
    })

    it('边界值（min 和 max）返回 valid', () => {
      expect(validateNumberRange(0, 0, 10)).toEqual({ valid: true })
      expect(validateNumberRange(10, 0, 10)).toEqual({ valid: true })
    })

    it('小数在范围内返回 valid', () => {
      expect(validateNumberRange(3.14, 0, 10)).toEqual({ valid: true })
      expect(validateNumberRange(-0.5, -1, 1)).toEqual({ valid: true })
    })

    it('自定义 name 出现在错误消息中', () => {
      expect(validateNumberRange(100, 0, 10, 'page')).toEqual({
        valid: false,
        message: 'page 必须在 0-10 范围内'
      })
      expect(validateNumberRange(null, 0, 10, 'page')).toEqual({
        valid: false,
        message: 'page 必须是有限数字'
      })
    })
  })

  describe('validateIntRange', () => {
    it('非整数返回 invalid（即使是数字）', () => {
      expect(validateIntRange(3.14, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须是整数'
      })
      expect(validateIntRange(0.5, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须是整数'
      })
    })

    it('非数字返回 invalid', () => {
      expect(validateIntRange(null, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须是整数'
      })
      expect(validateIntRange('5', 0, 10)).toEqual({
        valid: false,
        message: 'value 必须是整数'
      })
    })

    it('NaN 返回 invalid', () => {
      expect(validateIntRange(NaN, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须是整数'
      })
    })

    it('Infinity 返回 invalid（Number.isInteger(Infinity) === false）', () => {
      expect(validateIntRange(Infinity, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须是整数'
      })
    })

    it('负整数在范围内返回 valid', () => {
      expect(validateIntRange(-5, -10, 0)).toEqual({ valid: true })
    })

    it('超出范围返回 invalid', () => {
      expect(validateIntRange(11, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须在 0-10 范围内'
      })
      expect(validateIntRange(-1, 0, 10)).toEqual({
        valid: false,
        message: 'value 必须在 0-10 范围内'
      })
    })

    it('边界整数返回 valid', () => {
      expect(validateIntRange(0, 0, 10)).toEqual({ valid: true })
      expect(validateIntRange(10, 0, 10)).toEqual({ valid: true })
    })
  })

  describe('validateStringLength', () => {
    it('非字符串返回 invalid', () => {
      expect(validateStringLength(null)).toEqual({ valid: false, message: 'string 必须是字符串' })
      expect(validateStringLength(undefined)).toEqual({
        valid: false,
        message: 'string 必须是字符串'
      })
      expect(validateStringLength(123)).toEqual({ valid: false, message: 'string 必须是字符串' })
    })

    it('空字符串返回 invalid', () => {
      expect(validateStringLength('')).toEqual({
        valid: false,
        message: `string 长度必须在 1-${MAX_FILE_PATH_LENGTH} 之间`
      })
    })

    it('超过默认上限 1024 返回 invalid', () => {
      const long = 'a'.repeat(MAX_FILE_PATH_LENGTH + 1)
      const r = validateStringLength(long)
      expect(r.valid).toBe(false)
      expect(r.message).toBe(`string 长度必须在 1-${MAX_FILE_PATH_LENGTH} 之间`)
    })

    it('刚好 1024 字符返回 valid', () => {
      expect(validateStringLength('a'.repeat(MAX_FILE_PATH_LENGTH))).toEqual({ valid: true })
    })

    it('自定义 max 与 name 生效', () => {
      expect(validateStringLength('abc', 5, 'title')).toEqual({ valid: true })
      expect(validateStringLength('abcdef', 5, 'title')).toEqual({
        valid: false,
        message: 'title 长度必须在 1-5 之间'
      })
      expect(validateStringLength('', 5, 'title')).toEqual({
        valid: false,
        message: 'title 长度必须在 1-5 之间'
      })
    })

    it('Unicode 字符按 UTF-16 码元计数（String.length 语义）', () => {
      // '🚀'.length === 2（surrogate pair），不在长度 1 内
      expect(validateStringLength('🚀', 1, 'emoji')).toEqual({
        valid: false,
        message: 'emoji 长度必须在 1-1 之间'
      })
      // 单 BMP 字符 length === 1
      expect(validateStringLength('中', 1, 'cn')).toEqual({ valid: true })
    })
  })

  describe('validateMediaId', () => {
    it('委托 validateIntRange 范围 1 到 MAX_SAFE_INTEGER', () => {
      expect(validateMediaId(1)).toEqual({ valid: true })
      expect(validateMediaId(Number.MAX_SAFE_INTEGER)).toEqual({ valid: true })
    })

    it('0 返回 invalid（小于 1）', () => {
      expect(validateMediaId(0)).toEqual({
        valid: false,
        message: 'mediaId 必须在 1-9007199254740991 范围内'
      })
    })

    it('负数返回 invalid', () => {
      expect(validateMediaId(-1)).toEqual({
        valid: false,
        message: 'mediaId 必须在 1-9007199254740991 范围内'
      })
    })

    it('非整数返回 invalid', () => {
      expect(validateMediaId(3.14)).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
    })

    it('非数字返回 invalid', () => {
      expect(validateMediaId(null)).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
      expect(validateMediaId('1')).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
    })

    it('NaN 返回 invalid', () => {
      expect(validateMediaId(NaN)).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
    })

    it('超过 MAX_SAFE_INTEGER 返回 invalid', () => {
      expect(validateMediaId(Number.MAX_SAFE_INTEGER + 1)).toEqual({
        valid: false,
        message: 'mediaId 必须在 1-9007199254740991 范围内'
      })
    })
  })

  describe('validateMediaIdArray', () => {
    it('非数组返回 invalid', () => {
      expect(validateMediaIdArray(null)).toEqual({ valid: false, message: 'mediaIds 必须是数组' })
      expect(validateMediaIdArray(undefined)).toEqual({
        valid: false,
        message: 'mediaIds 必须是数组'
      })
      expect(validateMediaIdArray('1,2,3')).toEqual({
        valid: false,
        message: 'mediaIds 必须是数组'
      })
    })

    it('空数组返回 invalid', () => {
      expect(validateMediaIdArray([])).toEqual({ valid: false, message: 'mediaIds 不能为空' })
    })

    it('超过默认上限 1000 返回 invalid', () => {
      const arr = Array(MAX_MEDIA_ID_ARRAY_SIZE + 1).fill(1)
      const r = validateMediaIdArray(arr)
      expect(r.valid).toBe(false)
      expect(r.message).toBe(`mediaIds 数量超过上限 ${MAX_MEDIA_ID_ARRAY_SIZE}`)
    })

    it('刚好 1000 个返回 valid', () => {
      const arr = Array(MAX_MEDIA_ID_ARRAY_SIZE).fill(1)
      expect(validateMediaIdArray(arr)).toEqual({ valid: true })
    })

    it('自定义 maxCount 生效', () => {
      expect(validateMediaIdArray([1, 2], 5)).toEqual({ valid: true })
      const r = validateMediaIdArray([1, 2, 3], 2)
      expect(r.valid).toBe(false)
      expect(r.message).toBe('mediaIds 数量超过上限 2')
    })

    it('元素 0 返回 invalid（透传 validateMediaId）', () => {
      expect(validateMediaIdArray([0])).toEqual({
        valid: false,
        message: 'mediaId 必须在 1-9007199254740991 范围内'
      })
    })

    it('元素负数返回 invalid', () => {
      expect(validateMediaIdArray([-1])).toEqual({
        valid: false,
        message: 'mediaId 必须在 1-9007199254740991 范围内'
      })
    })

    it('元素非整数返回 invalid', () => {
      expect(validateMediaIdArray([1.5])).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
    })

    it('元素非数字返回 invalid', () => {
      expect(validateMediaIdArray(['1'])).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
      expect(validateMediaIdArray([null])).toEqual({
        valid: false,
        message: 'mediaId 必须是整数'
      })
    })

    it('首个非法元素立即返回（短路）', () => {
      const r = validateMediaIdArray([1, 2, 0, 3])
      expect(r.valid).toBe(false)
      expect(r.message).toBe('mediaId 必须在 1-9007199254740991 范围内')
    })

    it('合法数组返回 valid', () => {
      expect(validateMediaIdArray([1, 2, 3])).toEqual({ valid: true })
    })
  })

  describe('validateTagName', () => {
    it('非字符串返回 invalid', () => {
      expect(validateTagName(null)).toEqual({ valid: false, message: '标签名必须是字符串' })
      expect(validateTagName(undefined)).toEqual({ valid: false, message: '标签名必须是字符串' })
      expect(validateTagName(123)).toEqual({ valid: false, message: '标签名必须是字符串' })
    })

    it('空字符串返回 invalid', () => {
      expect(validateTagName('')).toEqual({
        valid: false,
        message: `标签名长度必须在 1-${MAX_TAG_NAME_LENGTH} 之间`
      })
    })

    it('超过 64 字符返回 invalid', () => {
      const long = 'a'.repeat(MAX_TAG_NAME_LENGTH + 1)
      const r = validateTagName(long)
      expect(r.valid).toBe(false)
      expect(r.message).toBe(`标签名长度必须在 1-${MAX_TAG_NAME_LENGTH} 之间`)
    })

    it('刚好 64 字符返回 valid', () => {
      expect(validateTagName('a'.repeat(MAX_TAG_NAME_LENGTH))).toEqual({ valid: true })
    })

    it('包含 NUL 字符（\\x00）返回 invalid', () => {
      expect(validateTagName('foo\x00bar')).toEqual({
        valid: false,
        message: '标签名包含非法控制字符'
      })
    })

    it('包含换行符（\\n \\x0a）返回 invalid', () => {
      expect(validateTagName('foo\nbar')).toEqual({
        valid: false,
        message: '标签名包含非法控制字符'
      })
    })

    it('包含 Tab（\\t \\x09）返回 invalid', () => {
      expect(validateTagName('foo\tbar')).toEqual({
        valid: false,
        message: '标签名包含非法控制字符'
      })
    })

    it('包含 DEL（\\x7f）返回 invalid', () => {
      expect(validateTagName('foo\x7fbar')).toEqual({
        valid: false,
        message: '标签名包含非法控制字符'
      })
    })

    it('包含最后一个控制字符 \\x1f 返回 invalid', () => {
      expect(validateTagName('foo\x1fbar')).toEqual({
        valid: false,
        message: '标签名包含非法控制字符'
      })
    })

    it('包含空格（\\x20）允许（非控制字符）', () => {
      expect(validateTagName('foo bar')).toEqual({ valid: true })
    })

    it('包含 Unicode 字符允许', () => {
      expect(validateTagName('无限暖暖相册')).toEqual({ valid: true })
      expect(validateTagName('🚀emoji🎉')).toEqual({ valid: true })
    })

    it('合法标签名返回 valid', () => {
      expect(validateTagName('风景')).toEqual({ valid: true })
      expect(validateTagName('travel-2024')).toEqual({ valid: true })
    })
  })

  describe('validateHttpUrl', () => {
    it('非字符串返回 invalid', () => {
      const expected = { valid: false, message: 'URL 长度必须在 1-2048 之间' }
      expect(validateHttpUrl(null)).toEqual(expected)
      expect(validateHttpUrl(undefined)).toEqual(expected)
      expect(validateHttpUrl(123)).toEqual(expected)
    })

    it('空字符串返回 invalid', () => {
      expect(validateHttpUrl('')).toEqual({
        valid: false,
        message: 'URL 长度必须在 1-2048 之间'
      })
    })

    it('超过 2048 字符返回 invalid', () => {
      const long = 'http://example.com/' + 'a'.repeat(2048)
      const r = validateHttpUrl(long)
      expect(r.valid).toBe(false)
      expect(r.message).toBe('URL 长度必须在 1-2048 之间')
    })

    it('无效 URL 语法返回 invalid', () => {
      expect(validateHttpUrl('not a url')).toEqual({
        valid: false,
        message: '无效的 URL'
      })
      expect(validateHttpUrl('://no-protocol')).toEqual({
        valid: false,
        message: '无效的 URL'
      })
    })

    it('file 协议返回 invalid', () => {
      const r = validateHttpUrl('file:///C:/foo.jpg')
      expect(r.valid).toBe(false)
      expect(r.message).toBe('不允许的协议: file:')
    })

    it('ftp 协议返回 invalid', () => {
      const r = validateHttpUrl('ftp://example.com/foo')
      expect(r.valid).toBe(false)
      expect(r.message).toBe('不允许的协议: ftp:')
    })

    it('javascript 协议返回 invalid', () => {
      const r = validateHttpUrl('javascript:alert(1)')
      expect(r.valid).toBe(false)
      expect(r.message).toBe('不允许的协议: javascript:')
    })

    it('http 协议返回 valid', () => {
      expect(validateHttpUrl('http://example.com')).toEqual({ valid: true })
      expect(validateHttpUrl('http://localhost:3000/api/photo?id=1')).toEqual({ valid: true })
    })

    it('https 协议返回 valid', () => {
      expect(validateHttpUrl('https://example.com')).toEqual({ valid: true })
      expect(validateHttpUrl('https://api.github.com/repos/foo/bar')).toEqual({ valid: true })
    })

    it('大写 HTTP 协议返回 valid（node URL 将协议小写化）', () => {
      // 实际行为：new URL('HTTP://example.com').protocol === 'http:'
      // node 的 URL 解析会将协议小写化，所以大写 HTTP 实际上会被接受为 http:
      // 固化此宽松行为（重构时需注意是否需要更严格校验）
      const r = validateHttpUrl('HTTP://example.com')
      expect(r.valid).toBe(true)
    })
  })

  describe('validateFilterPreset', () => {
    it('null 返回 invalid', () => {
      expect(validateFilterPreset(null)).toEqual({
        valid: false,
        message: '预设格式无效，应为 JSON 对象'
      })
    })

    it('非对象返回 invalid', () => {
      expect(validateFilterPreset('string')).toEqual({
        valid: false,
        message: '预设格式无效，应为 JSON 对象'
      })
      expect(validateFilterPreset(123)).toEqual({
        valid: false,
        message: '预设格式无效，应为 JSON 对象'
      })
      expect(validateFilterPreset(true)).toEqual({
        valid: false,
        message: '预设格式无效，应为 JSON 对象'
      })
    })

    it('数组返回 invalid（typeof [] === "object"，但仍非对象结构）', () => {
      // 注意：当前实现 typeof [] === 'object'，会通过第一关
      // 但数组没有 .name/.category/.params 字段，会落到 name 检查失败
      // 这是当前行为，需固化
      const r = validateFilterPreset([])
      expect(r.valid).toBe(false)
      expect(r.message).toBe('缺少有效的 name 字段')
    })

    it('缺 name 字段返回 invalid', () => {
      expect(validateFilterPreset({ category: 'a', params: {} })).toEqual({
        valid: false,
        message: '缺少有效的 name 字段'
      })
    })

    it('name 为空字符串返回 invalid', () => {
      expect(validateFilterPreset({ name: '', category: 'a', params: {} })).toEqual({
        valid: false,
        message: '缺少有效的 name 字段'
      })
    })

    it('name 为纯空格返回 invalid（trim 后为空）', () => {
      expect(validateFilterPreset({ name: '   ', category: 'a', params: {} })).toEqual({
        valid: false,
        message: '缺少有效的 name 字段'
      })
    })

    it('name 为非字符串返回 invalid', () => {
      expect(validateFilterPreset({ name: 123, category: 'a', params: {} })).toEqual({
        valid: false,
        message: '缺少有效的 name 字段'
      })
    })

    it('缺 category 字段返回 invalid', () => {
      expect(validateFilterPreset({ name: 'a', params: {} })).toEqual({
        valid: false,
        message: '缺少有效的 category 字段'
      })
    })

    it('category 为空字符串返回 invalid', () => {
      expect(validateFilterPreset({ name: 'a', category: '', params: {} })).toEqual({
        valid: false,
        message: '缺少有效的 category 字段'
      })
    })

    it('缺 params 字段返回 invalid', () => {
      expect(validateFilterPreset({ name: 'a', category: 'b' })).toEqual({
        valid: false,
        message: '缺少有效的 params 对象'
      })
    })

    it('params 为 null 返回 invalid', () => {
      expect(validateFilterPreset({ name: 'a', category: 'b', params: null })).toEqual({
        valid: false,
        message: '缺少有效的 params 对象'
      })
    })

    it('params 为非对象返回 invalid', () => {
      expect(validateFilterPreset({ name: 'a', category: 'b', params: 'str' })).toEqual({
        valid: false,
        message: '缺少有效的 params 对象'
      })
    })

    it('params 为数组返回 valid（typeof [] === "object" 且非 null，通过校验）', () => {
      // 当前实现 typeof [] === 'object' 且 [] !== null，会通过 params 检查
      // 固化此宽松行为（重构时需注意是否需要更严格校验）
      const r = validateFilterPreset({ name: 'a', category: 'b', params: [] })
      expect(r.valid).toBe(true)
    })

    it('合法预设返回 valid', () => {
      expect(
        validateFilterPreset({
          name: '风景',
          category: 'scene',
          params: { brightness: 0.5, tags: ['outdoor'] }
        })
      ).toEqual({ valid: true })
    })

    it('params 为空对象返回 valid', () => {
      expect(validateFilterPreset({ name: 'a', category: 'b', params: {} })).toEqual({
        valid: true
      })
    })
  })
})
