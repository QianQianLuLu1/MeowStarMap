/**
 * 第三方许可证声明的提交前回归（T3）。
 *
 * 义务依据：RanAxro/nikki_albums MIT License 要求「The above copyright notice and
 * this permission notice shall be included in all copies or substantial portions
 * of the Software」。本轮复用其热更管线、aes-gcm-filebox、Nuan5Config proto、
 * nuan5_decryption.dll 与语言资源，故须保留 `Copyright (c) 2025 Ran` 与 MIT 全文。
 *
 * 本套件只做提交前的配置 / 文件 / 文案静态断言，不构建、不打包、不校验实际分发物。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPackedLegalNotices } from '../pre-dist-check'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const UPSTREAM_COPYRIGHT = 'Copyright (c) 2025 Ran'
const MIT_PERMISSION =
  'Permission is hereby granted, free of charge, to any person obtaining a copy'

/** MIT 许可正文（条件段 + 担保免责声明段，与 THIRD_PARTY_NOTICES §1 逐字同形） */
const MIT_LICENSE_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

describe('THIRD_PARTY_NOTICES 与随包配置', () => {
  it('声明文件存在，且逐字包含上游版权行与 MIT 许可全文', () => {
    const text = read('THIRD_PARTY_NOTICES')
    expect(text).not.toBeNull()
    expect(text).toContain(UPSTREAM_COPYRIGHT)
    expect(text).toContain(MIT_PERMISSION)
    expect(text).toContain(
      'The above copyright notice and this permission notice shall be included'
    )
    expect(text).toContain('https://github.com/RanAxro/nikki_albums')
  })

  it('build.files 含 LICENSE 与 THIRD_PARTY_NOTICES 两个入包条目', () => {
    const pkg = JSON.parse(read('package.json') ?? '{}') as {
      build?: { files?: unknown[] }
    }
    const files = pkg.build?.files ?? []
    expect(files).toContain('LICENSE')
    expect(files).toContain('THIRD_PARTY_NOTICES')
  })

  it('README 中英两处「第三方来源与致谢」均明确署名 nikki_albums', () => {
    const text = read('README.md') ?? ''
    const zh = text.slice(text.indexOf('### 第三方来源与致谢'), text.indexOf('### 许可证'))
    const en = text.slice(text.indexOf('### Data Sources & Credits'), text.indexOf('### License'))
    expect(zh).toContain('nikki_albums')
    expect(en).toContain('nikki_albums')
  })

  it('关于页展示上游版权原文键，且 12 语包该键非空', () => {
    const about = read('src/renderer/pages/settings/about-sections.tsx') ?? ''
    expect(about).toContain('settings.about.upstreamCopyright')
    const codes = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'th', 'vi']
    for (const code of codes) {
      const locale = JSON.parse(read(`src/renderer/i18n/locales/${code}.json`) ?? '{}') as Record<
        string,
        unknown
      >
      const value = (locale.settings as Record<string, Record<string, unknown>> | undefined)?.about
        ?.upstreamCopyright
      expect(typeof value, `${code}.json settings.about.upstreamCopyright 缺失`).toBe('string')
      expect((value as string).trim(), `${code}.json 版权原文不应为空串`).not.toHaveLength(0)
    }
  })

  it('正常：README/CHANGELOG/总计划 §12 对静态底座章节的引用均为「第 4 节」', () => {
    expect(read('THIRD_PARTY_NOTICES')).toContain('## 4. 静态语言底座')
    const refs = [
      'README.md',
      'CHANGELOG.md',
      'docs/plans/2026-11-08-拍摄参数扩展与地图定位-实施计划.md'
    ]
    for (const rel of refs) {
      const found = sectionRefs(read(rel))
      expect(found.length, `${rel} 应含 THIRD_PARTY_NOTICES 节号引用`).toBeGreaterThan(0)
      expect(
        found.every((n) => n === '4'),
        `${rel} 节号引用漂移：${found.join(',')}`
      ).toBe(true)
    }
  })

  it('异常：误写「第 5 节」时判定函数返回漂移并被断言捕获', () => {
    const found = sectionRefs('许可标注见 `THIRD_PARTY_NOTICES` 第 5 节')
    expect(found).toContain('5')
    expect(found.every((n) => n === '4')).toBe(false)
  })

  it('边界：文案缺失/无引用/文件不存在（read 返回 null）时返回空集且不抛异常', () => {
    expect(sectionRefs(null)).toEqual([])
    expect(sectionRefs('')).toEqual([])
    expect(sectionRefs('纯文本无节号引用')).toEqual([])
    expect(() => sectionRefs(undefined as unknown as string | null)).not.toThrow()
  })
})

/** 抽取文本中所有 `THIRD_PARTY_NOTICES` 第 N 节引用；非字符串输入一律返回空集 */
function sectionRefs(text: string | null): string[] {
  if (typeof text !== 'string') return []
  return [...text.matchAll(/THIRD_PARTY_NOTICES`?\s*第\s*(\d+)\s*节/g)].map((m) => m[1])
}

describe('checkPackedLegalNotices 纯函数', () => {
  const okText = `${UPSTREAM_COPYRIGHT}\n${MIT_LICENSE_BODY}`
  const okInput = {
    files: ['dist/**/*', 'LICENSE', 'THIRD_PARTY_NOTICES'],
    readText: (rel: string) => (rel === 'THIRD_PARTY_NOTICES' ? okText : 'MIT License')
  }

  it('正常：配置与文件齐备时返回空问题集', () => {
    expect(checkPackedLegalNotices(okInput)).toEqual([])
  })

  it('异常：缺 LICENSE 入包条目 / 缺 THIRD_PARTY_NOTICES 入包条目各报对应问题', () => {
    expect(
      checkPackedLegalNotices({ ...okInput, files: ['dist/**/*', 'THIRD_PARTY_NOTICES'] })
    ).toContain('missing-license-entry')
    expect(checkPackedLegalNotices({ ...okInput, files: ['dist/**/*', 'LICENSE'] })).toContain(
      'missing-third-party-entry'
    )
  })

  it('异常：声明文件缺失或不含版权行时明确报错，不静默通过', () => {
    expect(checkPackedLegalNotices({ ...okInput, readText: () => null })).toContain(
      'missing-third-party-file'
    )
    expect(checkPackedLegalNotices({ ...okInput, readText: () => MIT_PERMISSION })).toContain(
      'missing-upstream-copyright'
    )
    expect(checkPackedLegalNotices({ ...okInput, readText: () => UPSTREAM_COPYRIGHT })).toContain(
      'missing-mit-permission-notice'
    )
  })

  it('边界：files 为对象式条目 / 非数组时按缺失处理，不抛未捕获异常', () => {
    expect(
      checkPackedLegalNotices({ ...okInput, files: [{ from: 'LICENSE', to: 'LICENSE' }] })
    ).toEqual(expect.arrayContaining(['missing-license-entry', 'missing-third-party-entry']))
    expect(() =>
      checkPackedLegalNotices({ ...okInput, files: undefined as unknown as string[] })
    ).not.toThrow()
    expect(
      checkPackedLegalNotices({ ...okInput, files: undefined as unknown as string[] }).length
    ).toBeGreaterThan(0)
  })
})

// ============================================================
// 审查修复（2026-11-11）：MIT 全文闸门强化 + 新增运行时依赖署名
// 原判定核只钉版权行与 Permission 首行，删掉条件/免责声明段落仍通过，
// 与「MIT 全文逐字保留」的声明不符——以下用例先红后绿。
// ============================================================

describe('checkPackedLegalNotices — MIT 全文闸门', () => {
  const base = {
    files: ['LICENSE', 'THIRD_PARTY_NOTICES'],
    readText: (rel: string) =>
      rel === 'THIRD_PARTY_NOTICES' ? `${UPSTREAM_COPYRIGHT}\n${MIT_LICENSE_BODY}` : 'MIT License'
  }

  it('正常：真实 THIRD_PARTY_NOTICES 通过全文闸门', () => {
    const problems = checkPackedLegalNotices({
      files: ['LICENSE', 'THIRD_PARTY_NOTICES'],
      readText: (rel) => read(rel)
    })
    expect(problems).toEqual([])
  })

  it('异常：保留版权行与 Permission 首行但删掉免责声明段 → 报 missing-mit-full-text', () => {
    const tampered = `${UPSTREAM_COPYRIGHT}\n${MIT_LICENSE_BODY.split('THE SOFTWARE IS PROVIDED')[0]}`
    expect(checkPackedLegalNotices({ ...base, readText: () => tampered })).toContain(
      'missing-mit-full-text'
    )
  })

  it('异常：删掉条件段（copyright/permission 保留义务）→ 报 missing-mit-full-text', () => {
    const tampered = `${UPSTREAM_COPYRIGHT}\n${MIT_PERMISSION}\n\nTHE SOFTWARE IS PROVIDED "AS IS"`
    expect(checkPackedLegalNotices({ ...base, readText: () => tampered })).toContain(
      'missing-mit-full-text'
    )
  })

  it('边界：空串声明文件 → 版权行 / Permission / 全文三项均报缺失', () => {
    const problems = checkPackedLegalNotices({ ...base, readText: () => '' })
    expect(problems).toEqual(
      expect.arrayContaining([
        'missing-upstream-copyright',
        'missing-mit-permission-notice',
        'missing-mit-full-text'
      ])
    )
  })
})

describe('新增运行时依赖署名（Leaflet / protobufjs）', () => {
  it('THIRD_PARTY_NOTICES 明确登记 Leaflet（BSD-2-Clause）与 protobufjs（Apache-2.0）', () => {
    const text = read('THIRD_PARTY_NOTICES') ?? ''
    expect(text).toContain('Leaflet')
    expect(text).toContain('BSD-2-Clause')
    expect(text).toContain('Vladimir Agafonkin')
    expect(text).toContain('protobufjs')
    expect(text).toContain('Apache-2.0')
  })

  it('关于页运行时依赖表登记 leaflet 与 protobufjs 条目', () => {
    const about = read('src/renderer/pages/settings/about-sections.tsx') ?? ''
    expect(about).toContain("name: 'leaflet'")
    expect(about).toContain("name: 'protobufjs'")
    expect(about).toContain('settings.about.depDesc.leaflet')
    expect(about).toContain('settings.about.depDesc.protobufjs')
  })
})
