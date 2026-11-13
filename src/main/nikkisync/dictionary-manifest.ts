/**
 * G4：本地字典 manifest 与已核验服装名补充的宿主装配（上游 windows-app.ts:101-102,167-168）。
 *
 * 上游 runtime.ts:69 会对 `metadataDictionary` 调 `replaceManifest()`，因此这一键必须是
 * **本地 manifest 对象**，绝不能把远端 provider 塞进来。文件缺失/损坏时整个键不下发，
 * 并给出可诊断 warning——绝不静默吞错，也不伪装成「用户关掉了字典」。
 */
export interface DictionaryInput {
  readonly dictionaryFile?: string
  readonly supplementFile?: string
  readonly loadDictionary?: (file: string) => unknown
  readonly nameSupplement?: (local: unknown) => unknown
}

export interface DictionaryLoadResult {
  readonly config: {
    metadataDictionary?: unknown
    metadataDictionarySupplement?: unknown
  }
  readonly warnings: string[]
}

export function loadDictionaryInputs(input: DictionaryInput): DictionaryLoadResult {
  if (!input.dictionaryFile || typeof input.loadDictionary !== 'function') {
    return { config: {}, warnings: [] }
  }
  const warnings: string[] = []
  const config: DictionaryLoadResult['config'] = {}
  let manifest: unknown
  try {
    manifest = input.loadDictionary(input.dictionaryFile)
  } catch {
    return { config: {}, warnings: ['Local dictionary manifest unreadable'] }
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { config: {}, warnings: ['Local dictionary manifest has an unexpected shape'] }
  }
  config.metadataDictionary = manifest

  if (input.supplementFile) {
    let local: unknown
    try {
      local = input.loadDictionary(input.supplementFile)
    } catch {
      warnings.push('Clothing name supplement unreadable')
    }
    if (local !== undefined && typeof input.nameSupplement === 'function') {
      try {
        config.metadataDictionarySupplement = input.nameSupplement(local)
      } catch {
        warnings.push('Clothing name supplement rejected the local dictionary')
      }
    }
  }
  return { config, warnings }
}
