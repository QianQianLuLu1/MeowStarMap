/**
 * 「电脑端优先本地解析照片」的宿主适配器（上游 windows-app.ts:136-140 的等价接线）。
 *
 * 上游 createLocalPhotoMetadataResolver 依赖 C# windows-shell 的 `--decode-photo-local`
 * helper exe；本仓不新建 helper，改为复用 src/main/services/decryption-service.ts 的
 * koffi 解码原始文本，再交给上游 parseLocalPhotoMetadata 做归一化。
 *
 * 本模块是纯函数层：不 import electron、不加载 DLL、不引用 @nikkisync/* 类型，
 * 所有外部能力由选项注入，便于在 node 环境单测。
 */

/** 本仓 koffi 解密链产出的两段原始文本（photoText = step1 JSON，cameraText = step3 数组文本）。 */
export interface LocalPhotoRawTexts {
  readonly cameraText: string
  readonly photoText: string
}

export type DecodeRawTexts = (
  filePath: string,
  uid: string,
  sha256: string
) => Promise<LocalPhotoRawTexts>

/** 上游 PhotoMetadataResolveRequest 的最小投影（只声明本适配器真正读取的键）。 */
export interface LocalPhotoResolveRequest {
  readonly sourcePhotoPath?: string
  readonly sourcePhotoSha256?: string
  readonly uid?: string
  readonly signal?: AbortSignal
  readonly localOnly?: boolean
  readonly isCurrent?: () => boolean
}

export interface ValidatedLocalPhotoRequest {
  readonly filePath: string
  readonly uid: string
  readonly sha256: string
}

export interface LocalPhotoResolverOptions {
  readonly decodeRawTexts: DecodeRawTexts
  readonly parseLocalPhotoMetadata: (cameraText: string, photoText: string) => unknown
}

export interface LocalPhotoResolverResult {
  readonly provider: string
  readonly providerVersion: string
  readonly metadata: unknown
}

/** 上游 PhotoMetadataResolver 的最小形状（AGENTS.md：不引用上游类型）。 */
export interface LocalPhotoResolver {
  readonly id: string
  readonly version: string
  readonly usesPhotoFile: true
  readonly batchSize: number
  resolve(request: LocalPhotoResolveRequest): Promise<LocalPhotoResolverResult>
}

export const LOCAL_PHOTO_PROVIDER_ID = 'local-photo'
export const LOCAL_PHOTO_PROVIDER_VERSION = '2'

const UID_PATTERN = /^[0-9]{1,20}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
// 平台中立：Windows 盘符与 POSIX 根都算绝对路径，避免 ci-linux 假宿主下误判。
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/)/

/**
 * 外部输入默认不可信：路径/UID/摘要逐项校验，非法值抛错而不是静默返回空结果。
 * 抛出的错误由上游 withLocalPhotoFallback 判定是否回退在线候补。
 */
export function validateLocalPhotoRequest(
  request: LocalPhotoResolveRequest | null | undefined
): ValidatedLocalPhotoRequest {
  const filePath = request?.sourcePhotoPath
  const uid = request?.uid
  const sha256 = request?.sourcePhotoSha256
  const valid =
    typeof filePath === 'string' &&
    filePath.length > 0 &&
    !filePath.includes('\0') &&
    ABSOLUTE_PATH_PATTERN.test(filePath) &&
    typeof uid === 'string' &&
    UID_PATTERN.test(uid) &&
    typeof sha256 === 'string' &&
    SHA256_PATTERN.test(sha256)
  if (!valid) throw new Error('Invalid local photo request')
  return { filePath, uid, sha256 } as ValidatedLocalPhotoRequest
}

/** 构造本地 resolver；省略 previousLocalValues（首次接入无旧解码器缓存可剔除，见计划 §8）。 */
export function createLocalPhotoResolverAdapter(
  options: LocalPhotoResolverOptions
): LocalPhotoResolver {
  return {
    id: LOCAL_PHOTO_PROVIDER_ID,
    version: LOCAL_PHOTO_PROVIDER_VERSION,
    usesPhotoFile: true,
    batchSize: 12,
    async resolve(request: LocalPhotoResolveRequest): Promise<LocalPhotoResolverResult> {
      const { filePath, uid, sha256 } = validateLocalPhotoRequest(request)
      if (request.signal?.aborted) throw new Error('Local decode cancelled')
      const texts = await options.decodeRawTexts(filePath, uid, sha256)
      if (!texts || !texts.cameraText || !texts.photoText) {
        throw new Error('Invalid local photo request')
      }
      const metadata = options.parseLocalPhotoMetadata(texts.cameraText, texts.photoText)
      return {
        provider: LOCAL_PHOTO_PROVIDER_ID,
        providerVersion: LOCAL_PHOTO_PROVIDER_VERSION,
        metadata
      }
    }
  }
}

/**
 * 用上游 withLocalPhotoFallback 包一层「本地优先、在线候补」。
 * 深入口缺席（老构建）时保持纯本地，不伪造在线能力。
 */
export function composeLocalPhotoResolver(input: {
  readonly local: LocalPhotoResolver
  readonly online?: unknown
  readonly onlineEnabled: () => boolean
  readonly withLocalPhotoFallback?: (
    local: unknown,
    online: unknown,
    onlineEnabled: () => boolean
  ) => unknown
}): unknown {
  if (!input.online || typeof input.withLocalPhotoFallback !== 'function') return input.local
  return input.withLocalPhotoFallback(input.local, input.online, input.onlineEnabled)
}
