/** Client-side signed feed verification, mirroring upstream IconPackUpdater.cs / DesktopUpdates.cs. */
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import fs from 'node:fs'

import { z } from 'zod'

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'cnb.cool',
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com'
]

export const ICON_CATALOG_URL =
  'https://cnb.cool/nikkisync/icon-packs/-/releases/download/icons-update/MomoCamera-Icons-catalog.json'
export const PROGRAM_UPDATE_MANIFEST_URL =
  'https://cnb.cool/nikkisync/icon-packs/-/releases/download/windows-update/MomoCamera-Windows-update.json'

/** Reject anything that is not an allowlisted, credential-free https URL. */
export function requireHttpsUrl(
  raw: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS
): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new Error('Invalid https URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid https URL')
  }
  const bad =
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    !allowedHosts.includes(url.hostname)
  if (bad) throw new Error('Invalid https URL')
  return url
}

export function loadPublicKey(pemPath: string): KeyObject {
  let pem: string
  try {
    pem = fs.readFileSync(pemPath, 'utf8')
  } catch {
    throw new Error('Invalid public key')
  }
  if (!pem.includes('-----BEGIN PUBLIC KEY-----')) throw new Error('Invalid public key')
  try {
    return createPublicKey(pem)
  } catch {
    throw new Error('Invalid public key')
  }
}

/** Fail-closed: never parse a document whose RSA signature does not verify. */
export function verifySignedDocument(
  bytes: Buffer,
  signature: Buffer,
  publicKey: KeyObject | string
): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 524288) {
    throw new Error('Invalid signed document size')
  }
  if (!Buffer.isBuffer(signature) || signature.length < 128 || signature.length > 1024) {
    throw new Error('Invalid signature size')
  }
  if (!verify('sha256', bytes, publicKey, signature)) {
    throw new Error('RSA signature mismatch')
  }
  return bytes
}

const HEX_64 = z.string().regex(/^[a-fA-F0-9]{64}$/)
const HTTPS_URL = z.string().refine((value) => {
  try {
    requireHttpsUrl(value)
    return true
  } catch {
    return false
  }
})

const IconDeltaSchema = z.object({
  Schema: z.literal(1),
  AppId: z.literal('NikkiSync.Icons'),
  BaseVersion: z.string().min(1).max(80),
  TargetVersion: z.string().min(1).max(80),
  BaseManifestSha256: HEX_64,
  TargetManifestSha256: HEX_64,
  DownloadUrl: HTTPS_URL,
  Sha256: HEX_64,
  Size: z.number().int().positive().max(134217728)
})

export const IconUpdateCatalogSchema = z.object({
  Schema: z.literal(2),
  AppId: z.literal('NikkiSync.Icons'),
  LatestVersion: z.string().min(1).max(80),
  LatestManifestSha256: HEX_64,
  Deltas: z.array(IconDeltaSchema).min(1).max(512)
})
export type IconUpdateCatalog = z.infer<typeof IconUpdateCatalogSchema>

/** Plan the continuous delta chain from the locally installed manifest to the latest one. */
export function planIconDeltas(catalog: unknown, currentManifestSha256: string): unknown[] {
  const parsed = IconUpdateCatalogSchema.safeParse(catalog)
  if (!parsed.success) throw new Error('Invalid icon catalog')
  const deltas = parsed.data.Deltas
  const seen = new Set<string>()
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index] as z.infer<typeof IconDeltaSchema>
    if (seen.has(delta.BaseManifestSha256)) throw new Error('Invalid icon catalog')
    seen.add(delta.BaseManifestSha256)
    if (index > 0) {
      const previous = deltas[index - 1] as z.infer<typeof IconDeltaSchema>
      if (previous.TargetManifestSha256 !== delta.BaseManifestSha256) {
        throw new Error('Invalid icon catalog')
      }
    }
  }
  const last = deltas[deltas.length - 1] as z.infer<typeof IconDeltaSchema>
  if (last.TargetManifestSha256 !== parsed.data.LatestManifestSha256) {
    throw new Error('Invalid icon catalog')
  }
  if (currentManifestSha256 === parsed.data.LatestManifestSha256) return []
  const start = deltas.findIndex(
    (item) => (item as z.infer<typeof IconDeltaSchema>).BaseManifestSha256 === currentManifestSha256
  )
  return start === -1 ? [] : deltas.slice(start)
}
