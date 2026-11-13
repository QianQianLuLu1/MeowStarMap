/**
 * N4/G4 红灯来源：dictionary-manifest.ts 与两个深入口常量尚不存在。
 * 上游 windows-app.ts:101-102,167-168 会把本地字典 manifest 与服装名补充下传给
 * PcCompanionRuntime；本仓此前刻意不下传（怕误传 provider 触发 replaceManifest 报错）。
 */
import { describe, expect, it, vi } from 'vitest'

import { loadDictionaryInputs } from './dictionary-manifest'
import {
  METADATA_DICTIONARY_CONFIG_DEEP_ENTRY,
  VERIFIED_CLOTHING_NAMES_DEEP_ENTRY
} from './runtime-facade'

describe('local dictionary manifest host assembly', () => {
  it('declares both upstream deep entries', () => {
    expect(METADATA_DICTIONARY_CONFIG_DEEP_ENTRY).toEqual([
      'metadata',
      'MetadataDictionaryConfigFile.js'
    ])
    expect(VERIFIED_CLOTHING_NAMES_DEEP_ENTRY).toEqual(['metadata', 'VerifiedClothingNames.js'])
  })

  it('normal: forwards a real manifest and the clothing-name supplement', () => {
    const manifest = { schemaVersion: 1, entries: { '1001': 'Coat' } }
    const supplement = { '1002': 'Dress' }
    const loadDictionary = vi.fn(() => manifest)
    const nameSupplement = vi.fn(() => supplement)
    const result = loadDictionaryInputs({
      dictionaryFile: '/data/dictionary.json',
      supplementFile: '/data/supplement.json',
      loadDictionary,
      nameSupplement
    })
    expect(result.config.metadataDictionary).toBe(manifest)
    expect(result.config.metadataDictionarySupplement).toBe(supplement)
    expect(loadDictionary).toHaveBeenCalledTimes(2)
    expect(result.warnings).toEqual([])
  })

  it('abnormal: a broken dictionary file drops that key and records a warning', () => {
    const result = loadDictionaryInputs({
      dictionaryFile: '/data/dictionary.json',
      loadDictionary: () => {
        throw new Error('bad json')
      }
    })
    expect(result.config.metadataDictionary).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
  })

  it('boundary: no paths or loaders means no keys at all (clean install)', () => {
    const result = loadDictionaryInputs({})
    expect(result.config).toEqual({})
    expect(result.warnings).toEqual([])
  })
})
