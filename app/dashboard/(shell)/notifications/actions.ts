'use server'

import { revalidatePath } from 'next/cache'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { processDue, setTemplate } from '@/lib/notify'
import { type FormState } from '@/lib/form-state'

/**
 * Send everything that has come due.
 *
 * ponytail: a button, not a scheduler. Production replaces the trigger with a
 * cron calling lib/notify.processDue -- this action adds the permission check
 * and nothing else, which is why the work is not inlined here.
 *
 * notification:['send'] -- owner, admin and front desk. A stylist reaches
 * neither this nor the page.
 */
export async function processDueAction(): Promise<FormState> {
  await requirePagePermission({ notification: ['send'] })
  const { organizationId } = await requirePageOrg()
  await processDue(organizationId)
  revalidatePath('/dashboard/notifications')
  return { done: true }
}

/**
 * Rewrite one template. Guarded by notification:['template:update'], which
 * front desk does NOT hold -- they may read the Center and press send, but the
 * wording a salon puts its name to is the owner's.
 */
export async function setTemplateAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ notification: ['template:update'] })
  const { organizationId } = await requirePageOrg()
  const kind = String(formData.get('kind') ?? '')
  const body = String(formData.get('body') ?? '').trim()
  if (!body) return { error: 'Pesan tidak boleh kosong.' }

  try {
    await setTemplate(organizationId, kind, body)
  } catch {
    return { error: 'Jenis pesan tidak dikenali.' }
  }
  revalidatePath('/dashboard/notifications')
  return { done: true }
}
