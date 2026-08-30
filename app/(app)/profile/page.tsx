import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { requirePageOrg } from '@/lib/session'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { ProfileNameForm, ChangePasswordForm, RevokeSessionForm } from './profile-forms'

export default async function ProfilePage() {
  const session = await requirePageOrg()
  const sessions = await auth.api.listSessions({ headers: await headers() })
  const currentToken = session.session.token

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profil</CardTitle>
          <CardDescription>Nama yang tampil untuk tim Anda.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileNameForm key={session.user.name} name={session.user.name} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ubah kata sandi</CardTitle>
          <CardDescription>
            Sesi lain akan keluar otomatis setelah ini.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sesi aktif</CardTitle>
          <CardDescription>Perangkat yang sedang masuk ke akun Anda.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {s.userAgent ?? 'Perangkat tidak dikenal'}
                    {s.token === currentToken && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (sesi ini)
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground">
                    {s.ipAddress ?? '—'}
                  </p>
                </div>
                {s.token !== currentToken && (
                  <RevokeSessionForm token={s.token} />
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
