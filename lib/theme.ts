/**
 * A salon's look is a PRESET plus an optional ACCENT.
 *
 * The preset decides the surface (which of the two token sets in globals.css
 * applies) and a default accent. The accent, when the salon has set
 * brand_color, overrides the preset's default -- one brand colour drives the
 * dashboard, the receipt and the booking page.
 *
 * Everything here is pure: the layout calls themeVars() on the server and the
 * settings page renders THEMES as swatches. No DOM, no React.
 */
export type ThemeKey = 'ivory' | 'charcoal' | 'rose-gold' | 'sage' | 'sapphire'
export type ThemeMode = 'light' | 'dark'
export type ThemePreset = { key: ThemeKey; label: string; mode: ThemeMode; accent: string }

export const HEX_RE = /^#[0-9a-fA-F]{6}$/

// Accents were checked against their surface (#ffffff light, #252525 dark)
// and against their computed foreground; tests/theme.test.ts keeps them
// honest. A prettier rose that fails 4.5:1 is not an option.
export const THEMES: readonly ThemePreset[] = [
  { key: 'ivory', label: 'Ivory', mode: 'light', accent: '#2a2622' },
  { key: 'charcoal', label: 'Charcoal', mode: 'dark', accent: '#f3f1ee' },
  { key: 'rose-gold', label: 'Rose Gold', mode: 'light', accent: '#a04e5b' },
  { key: 'sage', label: 'Sage', mode: 'light', accent: '#4f6b52' },
  { key: 'sapphire', label: 'Sapphire', mode: 'dark', accent: '#7aa2f7' },
]

export const DEFAULT_THEME: ThemeKey = 'ivory'

export function isThemeKey(v: unknown): v is ThemeKey {
  return typeof v === 'string' && THEMES.some((t) => t.key === v)
}

export function themeOf(key: string | null | undefined): ThemePreset {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]
}

function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2 contrast ratio between two #rrggbb colours, always >= 1. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Black or white, whichever reads better on the accent. Chosen by contrast
 * rather than a luminance threshold: a mid-blue sits under 0.5 luminance and
 * still needs black text (white on it is 2.5:1).
 */
export function accentForeground(hex: string): '#000000' | '#ffffff' {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff'
}

/** The CSS custom properties the accent drives. Keys include the `--`. */
export function themeVars(preset: ThemePreset, accent: string | null): Record<string, string> {
  const colour = accent && HEX_RE.test(accent) ? accent : preset.accent
  const fg = accentForeground(colour)
  return {
    '--primary': colour,
    '--primary-foreground': fg,
    '--ring': colour,
    '--sidebar-primary': colour,
    '--sidebar-primary-foreground': fg,
  }
}

/**
 * The inline script the shell layout emits before any content, so the theme
 * is on <html> before first paint and before anything portals to <body>.
 * Values are JSON-encoded, never interpolated raw, and `<` is escaped so a
 * value can never close the script tag.
 */
export function themeScript(mode: ThemeMode, vars: Record<string, string>): string {
  const json = JSON.stringify({ mode, vars }).replace(/</g, '\\u003c')
  return `(function(t){var d=document.documentElement;d.dataset.theme=t.mode;` +
    `for(var k in t.vars)d.style.setProperty(k,t.vars[k]);})(${json})`
}
