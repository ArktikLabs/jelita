import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { salonSettings, listServices } from '@/lib/service'
import { BrandingCard, CurrencyCard, SlotGridCard } from './settings-forms'

/**
 * Salon-wide settings. Guarded by settings:['update'] -- owner and admin
 * only; front desk and stylists hold no `settings` statement at all.
 */
export default async function SettingsPage() {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()
  const [salon, services] = await Promise.all([
    salonSettings(organizationId),
    listServices(organizationId),
  ])
  const { currency, slotMinutes } = salon
  const { rows } = await db.execute(sql`
    select slug from organizations where id = ${organizationId}`)
  const slug = (rows[0] as { slug: string }).slug

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-medium">Pengaturan</h1>
      <CurrencyCard currency={currency} hasServices={services.length > 0} />
      <SlotGridCard slotMinutes={slotMinutes} />
      <BrandingCard
        slug={slug}
        hasLogo={salon.hasLogo}
        logoVersion={salon.logoVersion}
        brandColor={salon.brandColor}
      />
    </div>
  )
}
