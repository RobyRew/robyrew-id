import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp, { type Metadata } from 'sharp'
import type { HandleService } from './handles.ts'
import { ManagementError, type ManagementClient } from './management.ts'

// Avatars: any common image in, one 512×512 WebP of at most 256 KB out, re-encoded
// by sharp (which also drops EXIF/XMP, GPS included). Files live in DATA_DIR/avatars
// under a random name and are served publicly at /avatars/<name>.webp; the URL is
// written as the Logto `avatar`, so every app receives it as the `picture` claim.

export const AVATAR_MAX_BYTES = 256 * 1024
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const AVATAR_PX = 512
const MAX_INPUT_PIXELS = 40_000_000
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'])
export const AVATAR_FILE = /^[A-Za-z0-9_-]{22}\.webp$/

// One libvips worker thread and no operation cache: the VPS has little memory to spare.
sharp.cache(false)
sharp.concurrency(1)

export class AvatarError extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 415 | 422 | 503,
    readonly code: 'empty' | 'too_large' | 'not_an_image' | 'unsupported_format' | 'too_small' | 'suspended' | 'unavailable',
  ) {
    super(code)
    this.name = 'AvatarError'
  }
}

/** Re-encodes an uploaded image as the avatar WebP. Throws AvatarError. */
export async function toAvatarWebp(input: Uint8Array): Promise<Buffer> {
  if (input.byteLength === 0) throw new AvatarError(400, 'empty')
  if (input.byteLength > UPLOAD_MAX_BYTES) throw new AvatarError(413, 'too_large')
  let meta: Metadata
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch {
    throw new AvatarError(415, 'not_an_image')
  }
  if (!meta.format || !INPUT_FORMATS.has(meta.format)) throw new AvatarError(415, 'unsupported_format')
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) throw new AvatarError(422, 'too_small')
  // Smaller and softer until it fits; a 512px WebP at q82 is usually 20–80 KB.
  for (const [px, quality] of [
    [AVATAR_PX, 82],
    [AVATAR_PX, 70],
    [384, 70],
    [256, 60],
  ] as const) {
    let out: Buffer
    try {
      out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .rotate()
        .resize(px, px, { fit: 'cover', position: 'attention' })
        .webp({ quality, effort: 4 })
        .toBuffer()
    } catch {
      throw new AvatarError(415, 'not_an_image')
    }
    if (out.byteLength <= AVATAR_MAX_BYTES) return out
  }
  throw new AvatarError(413, 'too_large')
}

export function createAvatarStore(options: { dir: string; publicOrigin: string }) {
  const { dir } = options
  const prefix = `${options.publicOrigin.replace(/\/+$/, '')}/avatars/`

  /** The file name behind one of our avatar URLs, or null (someone else's URL, a social login picture…). */
  function fileOf(url: string | null | undefined): string | null {
    if (!url || !url.startsWith(prefix)) return null
    const file = url.slice(prefix.length)
    return AVATAR_FILE.test(file) ? file : null
  }

  return {
    dir,
    fileOf,
    pathOf(file: string): string | null {
      return AVATAR_FILE.test(file) ? join(dir, file) : null
    },
    async save(webp: Buffer): Promise<{ file: string; url: string }> {
      await mkdir(dir, { recursive: true })
      const file = `${randomBytes(16).toString('base64url')}.webp`
      const tmp = join(dir, `.${file}.tmp`)
      await writeFile(tmp, webp, { mode: 0o644 })
      await rename(tmp, join(dir, file))
      return { file, url: `${prefix}${file}` }
    },
    /** Deletes the file behind `url` when it is one of ours; anything else is left alone. */
    async remove(url: string | null | undefined): Promise<void> {
      const file = fileOf(url)
      if (file) await rm(join(dir, file), { force: true })
    },
    /** Deletes files no profile points at, older than `olderThanMs` (failed uploads, missed deletes). */
    async sweep(inUse: Set<string>, olderThanMs = 86_400_000): Promise<number> {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return 0
      }
      const referenced = new Set([...inUse].map(fileOf).filter(Boolean))
      let removed = 0
      for (const name of names) {
        const stale = name.endsWith('.tmp') || (AVATAR_FILE.test(name) && !referenced.has(name))
        if (!stale) continue
        const info = await stat(join(dir, name)).catch(() => null)
        if (info && Date.now() - info.mtimeMs > olderThanMs) {
          await rm(join(dir, name), { force: true })
          removed++
        }
      }
      return removed
    },
  }
}

export type AvatarStore = ReturnType<typeof createAvatarStore>

/** Upload and removal, written through to Logto. One conversion at a time. */
export function createAvatarService(options: { store: AvatarStore; management: ManagementClient; handles: HandleService; logger?: Pick<Console, 'error'> }) {
  const { store, management, handles } = options
  const log = options.logger ?? console
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }

  async function current(userId: string) {
    try {
      const user = await management.getUser(userId)
      if (user.isSuspended) throw new AvatarError(403, 'suspended')
      return user
    } catch (err) {
      if (err instanceof AvatarError) throw err
      log.error('[avatars] reading the Logto user failed:', err instanceof Error ? err.message : String(err))
      throw new AvatarError(503, 'unavailable')
    }
  }

  async function set(userId: string, input: Uint8Array): Promise<string> {
    return serialize(async () => {
      const webp = await toAvatarWebp(input)
      const before = await current(userId)
      const saved = await store.save(webp)
      try {
        handles.mirror(await management.patchUser(userId, { avatar: saved.url }))
      } catch (err) {
        await store.remove(saved.url)
        log.error('[avatars] writing the Logto avatar failed:', err instanceof ManagementError ? err.code : String(err))
        throw new AvatarError(503, 'unavailable')
      }
      if (before.avatar !== saved.url) await store.remove(before.avatar)
      return saved.url
    })
  }

  async function remove(userId: string): Promise<void> {
    return serialize(async () => {
      const before = await current(userId)
      if (!before.avatar) return
      try {
        handles.mirror(await management.patchUser(userId, { avatar: null }))
      } catch (err) {
        log.error('[avatars] clearing the Logto avatar failed:', err instanceof ManagementError ? err.code : String(err))
        throw new AvatarError(503, 'unavailable')
      }
      await store.remove(before.avatar)
    })
  }

  return { set, remove }
}

export type AvatarService = ReturnType<typeof createAvatarService>
