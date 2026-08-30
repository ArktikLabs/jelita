import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

/**
 * better-auth owns GET /api/auth/verify-email — it validates the token and
 * redirects here. This page never touches the token. With
 * autoSignInAfterVerification the user arrives already signed in, so the
 * (auth) layout will normally bounce them to /dashboard before this renders;
 * it exists for the case where the session did not stick.
 */
export default function VerifyEmailPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email terverifikasi</CardTitle>
        <CardDescription>Akun Anda sudah aktif.</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/dashboard" className={buttonVariants({ className: 'w-full' })}>
          Lanjutkan
        </Link>
      </CardContent>
    </Card>
  )
}
