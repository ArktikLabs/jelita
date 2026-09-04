import Script from 'next/script'

/**
 * The public booking page's own layout, which exists for one reason: PRD §7
 * puts Google Tag Manager HERE and nowhere else. The dashboard is a private
 * back office; tracking staff through their own shift is neither useful nor
 * something to hand a prospect.
 *
 * Renders NOTHING when NEXT_PUBLIC_GTM_ID is unset, so dev, CI and every test
 * run stay untracked without a conditional at each call site -- and a missing
 * id degrades to "no analytics" rather than to a broken page.
 */
const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID

export default function PublicBookingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      {GTM_ID && (
        <>
          <Script id="gtm" strategy="afterInteractive">
            {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`}
          </Script>
          {/* The no-JS half of GTM. Without it a visitor with scripts blocked
              is invisible to the funnel, which is the half of the audience a
              booking page most wants to know about. */}
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        </>
      )}
      {children}
    </>
  )
}
