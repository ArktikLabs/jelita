import { redirect } from 'next/navigation'
import { requirePageSession } from '@/lib/session'
import { OnboardingForm } from './onboarding-form'

export default async function OnboardingPage() {
  const session = await requirePageSession()
  // Reverse guard: one salon per owner. A second organization would leave the
  // user with two memberships, and the session hook in lib/auth.ts resolves
  // the active org and active branch with two unordered single-row queries —
  // it could hand back an organizationId and a branchId from different
  // tenants. The real gate is in createSalonAction; this only saves the user
  // from a form that cannot succeed.
  if (session.session.activeOrganizationId) redirect('/dashboard')
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <OnboardingForm />
      </div>
    </div>
  )
}
