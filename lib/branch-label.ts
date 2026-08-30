import type { BranchRow } from './branch'

/**
 * State lives in the label, not a badge, so it survives being read out of a
 * closed-branch history view: "Cabang Lama — Nonaktif" tells an admin where
 * they are standing without a second UI element to notice.
 *
 * Its own module, with no `./db` import: the layout renders it on the server
 * for roles that cannot switch, and the switcher renders it in the browser.
 * Importing it from `./branch` would drag drizzle into the client bundle;
 * exporting it from the 'use client' switcher would hand the layout a client
 * reference it cannot call.
 */
export function branchLabel(b: Pick<BranchRow, 'name' | 'active' | 'withinCap'>) {
  if (!b.active) return `${b.name} — Nonaktif`
  if (!b.withinCap) return `${b.name} — Terkunci`
  return b.name
}
