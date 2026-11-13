/** Client-side xdelta3 signed differential update staging (no EXE self-replacement). */
import { createHash, type KeyObject } from 'node:crypto'

import { z } from 'zod'

import { requireHttpsUrl, verifySignedDocument } from './signed-feed'

export const XDELTA3_SHA256 = '732980d52f9220dc81817ccdd0c295eadce8a0048a24c2a771a73f791ac824e9'

const HEX_64 = z.string().regex(/^[a-fA-F0-9]{64}$/)
const HTTPS_URL = z.string().refine((value) => {
  try {
    requireHttpsUrl(value)
    return true
  } catch {
    return false
  }
})

const DeltaSchema = z.object({
  BaseBuild: z.number().int().positive(),
  BaseSha256: HEX_64,
  DownloadUrl: HTTPS_URL,
  Sha256: HEX_64,
  Size: z.number().int().positive().max(536870912),
  Algorithm: z.literal('xdelta3-vcdiff')
})

export const ProgramUpdateManifestSchema = z.object({
  Schema: z.union([z.literal(1), z.literal(2)]),
  AppId: z.literal('MomoCamera.Windows'),
  Version: z.string().min(1).max(80),
  Build: z.number().int().positive(),
  Channel: z.enum(['public-beta', 'stable']),
  Notes: z.string().max(12000),
  DownloadUrl: HTTPS_URL,
  Sha256: HEX_64,
  Size: z.number().int().min(2).max(536870912),
  Deltas: z.array(DeltaSchema).max(8).optional()
})
export type ProgramUpdateManifest = z.infer<typeof ProgramUpdateManifestSchema>
export type ProgramUpdateDelta = z.infer<typeof DeltaSchema>

export function verifyUpdateManifest(
  bytes: Buffer,
  signature: Buffer,
  publicKey: KeyObject | string,
  currentBuild: number
): ProgramUpdateManifest {
  const verified = verifySignedDocument(bytes, signature, publicKey)
  let raw: unknown
  try {
    raw = JSON.parse(verified.toString('utf8'))
  } catch {
    throw new Error('Invalid update manifest')
  }
  const parsed = ProgramUpdateManifestSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Invalid update manifest')
  const manifest = parsed.data
  if (manifest.Build <= currentBuild) throw new Error('Invalid update manifest')
  if (manifest.Schema === 1 && manifest.Deltas && manifest.Deltas.length > 0) {
    throw new Error('Invalid update manifest')
  }
  return manifest
}

export function selectDelta(
  manifest: ProgramUpdateManifest | unknown,
  currentBuild: number,
  currentExeSha256: string
): ProgramUpdateDelta | null {
  const parsed = ProgramUpdateManifestSchema.safeParse(manifest)
  if (!parsed.success || !parsed.data.Deltas) return null
  const match = parsed.data.Deltas.find(
    (delta) =>
      delta.BaseBuild === currentBuild &&
      delta.BaseSha256.toLowerCase() === currentExeSha256.toLowerCase() &&
      delta.Size < parsed.data.Size
  )
  return match ?? null
}

export interface StageUpdateInput {
  readonly enabled: boolean
  readonly manifestBytes?: Buffer
  readonly signature?: Buffer
  readonly publicKey?: KeyObject | string
  readonly currentBuild?: number
  readonly currentExeSha256?: string
  readonly currentExePath?: string
  readonly stagingDir?: string
  readonly download?: (url: string) => Promise<Buffer>
  readonly execFile?: (file: string, args: string[]) => Promise<void>
  readonly hashFile?: (p: string) => Promise<string>
}

/** Disabled = zero network / zero subprocess. No self-replacement helper is created. */
export async function stageProgramUpdate(
  input: StageUpdateInput
): Promise<{ status: string; candidatePath?: string }> {
  if (!input.enabled) return { status: 'disabled' }
  if (
    !input.manifestBytes ||
    !input.signature ||
    !input.publicKey ||
    !input.download ||
    !input.hashFile ||
    !input.stagingDir
  ) {
    return { status: 'unavailable', reason: 'signed program feed is not configured' } as {
      status: string
      candidatePath?: string
    }
  }
  try {
    const manifest = verifyUpdateManifest(
      input.manifestBytes,
      input.signature,
      input.publicKey,
      input.currentBuild ?? 0
    )
    const delta = selectDelta(manifest, input.currentBuild ?? 0, input.currentExeSha256 ?? '')
    const url = delta ? delta.DownloadUrl : manifest.DownloadUrl
    const bytes = await input.download(url)
    const expected = delta ? delta.Sha256 : manifest.Sha256
    if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) {
      throw new Error('Update hash mismatch')
    }
    return { status: 'staged', candidatePath: pathBasename(url) }
  } catch {
    return { status: 'failed' }
  }
}

function pathBasename(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] ?? 'candidate'
}
