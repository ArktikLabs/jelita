import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * Object storage, spoken as S3.
 *
 * MinIO in dev and in the test suite, real S3 in production -- the same
 * protocol either way, so the difference is an endpoint and a pair of
 * credentials, never a code path. `forcePathStyle` is what makes MinIO work:
 * virtual-host addressing needs DNS per bucket, which a container on a
 * compose network does not have.
 *
 * Deliberately NOT creating its own bucket. In production that needs
 * permissions no application should hold, and a typo in the bucket name would
 * quietly succeed instead of failing on the first upload. The bucket is
 * infrastructure (docker-compose.test.yml's s3-init, or terraform later).
 */
const g = globalThis as unknown as { _s3?: S3Client }

export const BUCKET = process.env.S3_BUCKET ?? 'jelita-assets'

export const s3 = (g._s3 ??= new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'jelita',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'jelitajelita',
  },
}))

/**
 * PNG, JPEG and WebP only, decided by the MAGIC BYTES rather than the declared
 * content type: browsers sniff, so trusting the client's label is trusting the
 * client. Returns the real type, or null to refuse.
 *
 * SVG is refused on purpose and would be even if it were detectable here -- it
 * is a script container, and this file is served from the app's own origin on
 * a page that also renders a booking form.
 */
export function imageType(bytes: Uint8Array): string | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/** Per salon, so one prospect's re-skin cannot reach another's. */
export const logoKey = (organizationId: string) => `salons/${organizationId}/logo`

export async function putObject(
  key: string, body: Uint8Array, contentType: string,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentType: contentType,
  }))
}

/** Null when the object is not there, so a salon with no logo is an ordinary
 *  answer rather than a 500. */
export async function getObject(
  key: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const body = await res.Body?.transformToByteArray()
    if (!body) return null
    return { body, contentType: res.ContentType ?? 'application/octet-stream' }
  } catch (e) {
    // NoSuchKey is the only expected miss; anything else is a real failure and
    // must not be laundered into "this salon has no logo".
    const name = (e as { name?: string }).name
    if (name === 'NoSuchKey' || name === 'NotFound') return null
    throw e
  }
}
