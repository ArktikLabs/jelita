import type { Metadata } from 'next'
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google'
import './hallmark.css'

/**
 * The marketing route's own shell.
 *
 * Its own layout, and its own stylesheet, because the landing page is a
 * different design system from the product: Hallmark's cream-and-multi-accent
 * "Hum" theme, against the dashboard's shadcn theme. Next ships this CSS chunk
 * only for routes under this group, so the two never meet.
 *
 * The fonts load here rather than in the root layout for the same reason --
 * the app is Geist, this page is Plus Jakarta Sans, and neither should pay to
 * download the other's.
 */
const jakarta = Plus_Jakarta_Sans({
  variable: '--font-jakarta',
  subsets: ['latin'],
})

const mono = JetBrains_Mono({
  variable: '--font-jbmono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Jelita — software salon: booking, kasir, komisi, stok',
  description:
    'Satu aplikasi untuk booking online, kasir, komisi staf, stok, member dan '
    + 'laporan. Multi-cabang sejak hari pertama.',
}

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className={`hm ${jakarta.variable} ${mono.variable}`}>{children}</div>
  )
}
