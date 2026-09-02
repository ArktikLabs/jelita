import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { salonSettings, listServices } from '@/lib/service'
import { CurrencyCard, SlotGridCard } from './settings-forms'

/**
 * Salon-wide settings. Guarded by settings:['update'] -- owner and admin
 * only; front desk and stylists hold no `settings` statement at all.
 */
export default async function SettingsPage() {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()
  const [{ currency, slotMinutes }, services] = await Promise.all([
    salonSettings(organizationId),
    listServices(organizationId),
  ])

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-medium">Pengaturan</h1>
      <CurrencyCard currency={currency} hasServices={services.length > 0} />
      <SlotGridCard slotMinutes={slotMinutes} />
    </div>
  )
}
