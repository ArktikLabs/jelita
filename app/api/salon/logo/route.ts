import { NextResponse } from 'next/server'
import { getObject, logoKey } from '@/lib/storage'
import { resolveSalon } from '@/lib/salon'

/**
 * The salon's logo, served by the app rather than from a bucket URL.
 *
 * Keeps the bucket private, leaves no CORS or bucket policy to get right, and
 * gives dev and production one URL shape. A CDN can front this route later
 * without any page knowing -- which is the point of never putting a storage
 * URL in the markup.
 *
 * Keyed by SLUG, not by session: the public booking page shows the logo too,
 * and it has no session at all.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get('salon') ?? ''
  const salon = await resolveSalon(slug)
  if (!salon) return new NextResponse(null, { status: 404 })

  const object = await getObject(logoKey(salon.organizationId))
  if (!object) return new NextResponse(null, { status: 404 })

  return new NextResponse(Buffer.from(object.body), {
    headers: {
      'content-type': object.contentType,
      // Immutable because callers append ?v=<logo_updated_at>: a new upload is
      // a new URL, so a long cache never serves a stale logo.
      'cache-control': 'public, max-age=31536000, immutable',
      // Belt and braces on top of refusing SVG at upload: even if something
      // else ever writes here, the browser must not render it as a document.
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}
