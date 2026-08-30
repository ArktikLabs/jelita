import { requirePageSession } from '@/lib/session'
import { OnboardingForm } from './onboarding-form'

export default async function OnboardingPage() {
  await requirePageSession()
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <OnboardingForm />
      </div>
    </div>
  )
}
