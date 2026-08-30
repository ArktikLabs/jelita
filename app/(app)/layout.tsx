import Link from 'next/link'
import { requirePageOrg } from '@/lib/session'
import { buttonVariants } from '@/components/ui/button'
import { signOutAction } from './actions'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePageOrg()
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Link href="/dashboard" className="font-medium">Jelita</Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/profile" className="underline">{session.user.name}</Link>
          {/* The (auth) layout bounces a signed-in user away from /login, so
              this is the only reachable way out of the app. */}
          <form action={signOutAction}>
            <button
              type="submit"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Keluar
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
