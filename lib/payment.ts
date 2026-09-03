/**
 * PRD §5.10's `PaymentProvider` seam.
 *
 * One function, deliberately. A provider's whole job here is: given an intent,
 * say whether the money is settled and give a reference to quote.
 *
 * HOW FAR THIS GOES, stated rather than implied: `pending` is in the type
 * because a real gateway settles asynchronously and would return it -- but
 * nothing in the MVP can consume one. A transaction has no state between
 * `open` and `completed`, so a pending result would have nowhere to sit.
 * Adding that state now would mean shipping a lifecycle no test can exercise
 * to make the demo line sound bigger, which is worse than saying this.
 */
export type PaymentMethod = 'cash' | 'transfer' | 'qris' | 'debit' | 'credit'

export type PaymentIntent = {
  method: PaymentMethod
  /** Minor units, matching every other amount in the product. */
  amount: number
  currency: string
}

export type PaymentResult = {
  status: 'settled' | 'pending'
  provider: string
  ref?: string
}

export type PaymentProvider = {
  name: string
  record(intent: PaymentIntent): Promise<PaymentResult>
}

/**
 * The MVP's only provider: it records what the front desk says happened.
 *
 * Cash in a drawer and a QRIS scan on the customer's own phone are both
 * already settled by the time anyone types them in -- there is nothing to
 * authorize, which is exactly why "record-only" is honest here rather than a
 * stub.
 */
export const ManualPayment: PaymentProvider = {
  name: 'manual',
  async record() {
    return { status: 'settled', provider: 'manual' }
  },
}

export const PAYMENT_METHODS: PaymentMethod[] = [
  'cash', 'transfer', 'qris', 'debit', 'credit',
]

export const isPaymentMethod = (v: string): v is PaymentMethod =>
  (PAYMENT_METHODS as string[]).includes(v)
