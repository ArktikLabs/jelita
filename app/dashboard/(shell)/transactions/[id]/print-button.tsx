'use client'

import { Button } from '@/components/ui/button'

/** window.print() is the whole PDF story: the browser's own print-to-PDF
 *  covers §5.2's "printable/PDF" without a library, an embedded font set, or a
 *  second rendering path that can drift from the screen. */
export function PrintButton() {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()}>
      Cetak
    </Button>
  )
}
