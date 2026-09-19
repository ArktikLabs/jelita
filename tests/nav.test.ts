import { describe, expect, it } from 'vitest'
import { NAV, groupedNav, visibleNav } from '../lib/nav'

/**
 * Which links which role sees, and how they are grouped. Pure: the role
 * table in lib/permissions.ts decides, no database.
 */
const labels = (sections: ReturnType<typeof groupedNav>) =>
  sections.map((s) => [s.label, s.items.map((i) => i.label)])

describe('groupedNav', () => {
  it('gives the owner every group in the agreed order', () => {
    expect(labels(groupedNav('owner'))).toEqual([
      [null, ['Dasbor']],
      ['Operasional', ['Kasir', 'Janji temu', 'Pelanggan']],
      ['Keuangan', ['Transaksi', 'Komisi', 'Penggajian']],
      ['Katalog', ['Layanan', 'Produk']],
      ['Pengelolaan', ['Staf', 'Cabang', 'Notifikasi', 'Pengaturan']],
    ])
  })

  it('drops a group with no visible items: a stylist sees four links in two groups', () => {
    expect(labels(groupedNav('stylist'))).toEqual([
      [null, ['Dasbor']],
      ['Operasional', ['Janji temu', 'Pelanggan']],
      ['Keuangan', ['Komisi']],
    ])
  })

  it('shows Kasir to a role holding pos:checkout and hides it otherwise', () => {
    const has = (role: string) => groupedNav(role).some((s) => s.items.some((i) => i.href === '/dashboard/pos'))
    expect(has('frontdesk')).toBe(true)
    expect(has('stylist')).toBe(false)
  })

  it('hands the client only href, label and icon', () => {
    for (const s of groupedNav('owner')) {
      for (const item of s.items) expect(Object.keys(item).sort()).toEqual(['href', 'icon', 'label'])
    }
  })

  it('unions roles from a comma-separated list', () => {
    const only = (csv: string) => visibleNav(csv).map((i) => i.label)
    expect(only('stylist, frontdesk')).toEqual(
      expect.arrayContaining([...only('stylist'), ...only('frontdesk')]))
  })

  it('every item has an icon', () => {
    for (const item of NAV) expect(item.icon).toBeTruthy()
  })
})
