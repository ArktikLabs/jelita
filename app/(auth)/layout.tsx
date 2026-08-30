import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Already signed in? Nothing on these pages applies. A user with no
  // organization hops on to /onboarding via the (app) guard — two redirects,
  // by design.
  const session = await getSession()
  if (session?.user) redirect('/dashboard')

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
