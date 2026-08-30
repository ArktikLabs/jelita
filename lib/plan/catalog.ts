/**
 * Single source of truth for what a tier can grant. The `features` table
 * must match FEATURE_KEYS exactly in both directions — scripts/plan-check.mjs
 * asserts it. The FK on plan_features stops a bad key entering the database;
 * only this assertion stops `requireFeature('payrol')` in application code.
 */
export const FEATURE_KEYS = [
  'online_booking',
  'commissions',
  'whatsapp',
  'inventory',
  'report_export',
  'payroll',
] as const

export const CAPPED_RESOURCES = [
  'branches',
  'staff',
  'services',
  'products',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]
export type CappedResource = (typeof CAPPED_RESOURCES)[number]
