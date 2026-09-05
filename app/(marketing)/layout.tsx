import type { Metadata } from 'next'
import './hallmark.css'

/**
 * The marketing route's own shell.
 *
 * Its own layout, and its own stylesheet, because the landing page is a
 * different design system from the product: Hallmark's cream-and-multi-accent
 * "Hum" theme, against the dashboard's shadcn theme. Next ships this CSS chunk
 * only for routes under this group, so the two never meet.
 *
 * No fonts of its own any more. The Coral theme is Geist, which the root
 * layout already puts on <html>, so this page and the product it sells share
 * one typeface -- and the landing page stops downloading two faces nothing
 * else uses.
 */
export const metadata: Metadata = {
  title: 'Jelita — aplikasi salon: booking, kasir, komisi, stok',
  description:
    'Booking online, kasir, komisi staf, stok, dan data pelanggan dalam satu '
    + 'tempat. Untuk satu cabang atau beberapa.',
}

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="hm">{children}</div>
  )
}
