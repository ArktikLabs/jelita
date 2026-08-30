import { requirePageOrg } from '@/lib/session'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePageOrg()
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-medium">Jelita</span>
        <span className="text-sm text-muted-foreground">
          {session.user.name}
        </span>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
