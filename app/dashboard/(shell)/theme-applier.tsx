// app/dashboard/(shell)/theme-applier.tsx
'use client'

import { useLayoutEffect } from 'react'
import type { ThemeMode } from '@/lib/theme'

/**
 * Keeps <html> in step with the salon's theme AFTER first paint.
 *
 * The inline script in the layout handles the first paint. React does not
 * re-run an inline script when the layout re-renders, so when the owner saves
 * a new preset the changed props land here and this effect applies them. On
 * unmount (sign out lands on /login, a soft navigation) it removes everything
 * so the marketing and auth pages are not left dark.
 */
export function ThemeApplier({ mode, vars }: { mode: ThemeMode; vars: Record<string, string> }) {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = mode
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    return () => {
      delete root.dataset.theme
      for (const k of Object.keys(vars)) root.style.removeProperty(k)
    }
  }, [mode, vars])
  return null
}
