import { afterAll, describe, expect, it } from 'vitest'
import { BUCKET, getObject, imageType, logoKey, putObject, s3 } from '../lib/storage'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

/**
 * Object storage, against the real MinIO from docker-compose.test.yml.
 *
 * Not a mock: the point of choosing an S3-compatible store is that dev, this
 * suite and production differ by endpoint and credentials rather than by code
 * path, and a mocked client would prove only that the mock works.
 */
const ORG = 'stor_org'
const KEY = logoKey(ORG)

const png = () => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3,
])
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3])
const webp = () => new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3,
])
const svg = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

afterAll(async () => {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY })).catch(() => {})
})

describe('imageType', () => {
  it('accepts the three raster formats, by their magic bytes', () => {
    expect(imageType(png())).toBe('image/png')
    expect(imageType(jpeg())).toBe('image/jpeg')
    expect(imageType(webp())).toBe('image/webp')
  })

  it('refuses SVG -- a script container served from the app\'s own origin', () => {
    expect(imageType(svg())).toBeNull()
  })

  it('refuses bytes that merely CLAIM to be an image', () => {
    // The whole reason this reads magic bytes: a browser sniffs, so a file
    // labelled image/png that is not one would be executed as whatever it is.
    expect(imageType(new TextEncoder().encode('GIF89a...'))).toBeNull()
    expect(imageType(new TextEncoder().encode('<html><script>'))).toBeNull()
    expect(imageType(new Uint8Array([]))).toBeNull()
  })

  it('is not fooled by a PNG signature that is only nearly right', () => {
    const nearly = png()
    nearly[7] = 0x00
    expect(imageType(nearly)).toBeNull()
  })
})

describe('object storage', () => {
  it('round-trips bytes and their content type', async () => {
    await putObject(KEY, png(), 'image/png')
    const got = await getObject(KEY)
    expect(got?.contentType).toBe('image/png')
    expect(Array.from(got!.body)).toEqual(Array.from(png()))
  })

  it('overwrites, so re-skinning a demo does not accumulate old logos', async () => {
    await putObject(KEY, png(), 'image/png')
    await putObject(KEY, jpeg(), 'image/jpeg')
    const got = await getObject(KEY)
    expect(got?.contentType).toBe('image/jpeg')
  })

  it('answers null for a salon with no logo, rather than throwing', async () => {
    expect(await getObject(logoKey('stor_org_without'))).toBeNull()
  })

  it('keys per salon, so one prospect\'s re-skin cannot reach another\'s', () => {
    expect(logoKey('a')).not.toBe(logoKey('b'))
    expect(logoKey(ORG)).toContain(ORG)
  })
})
