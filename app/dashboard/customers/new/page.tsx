import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { CustomerCreateForm } from './customer-form'

export default async function NewCustomerPage() {
  await requirePagePermission({ customer: ['create'] })
  await requirePageOrg()

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-xl font-medium">Tambah pelanggan</h1>
      <CustomerCreateForm />
    </div>
  )
}
