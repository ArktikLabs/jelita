import { describe, expect, it } from 'vitest'
import {
  THEMES, DEFAULT_THEME, accentForeground, contrastRatio, isThemeKey,
  themeOf, themeScript, themeVars,
} from '../lib/theme'

/** The surface each mode paints behind the accent: globals.css --background. */
const SURFACE = { light: '#ffffff', dark: '#252525' } as const

describe('presets', () => {
  it('has exactly the five agreed keys, ivory first', () => {
    expect(THEMES.map((t) => t.key)).toEqual(['ivory', 'charcoal', 'rose-gold', 'sage', 'sapphire'])
    expect(DEFAULT_THEME).toBe('ivory')
  })

  it('every default accent clears 4.5:1 against its own surface', () => {
    for (const t of THEMES) {
      expect(contrastRatio(t.accent, SURFACE[t.mode]), t.key).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every default accent clears 4.5:1 against its computed foreground', () => {
    for (const t of THEMES) {
      expect(contrastRatio(t.accent, accentForeground(t.accent)), t.key).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('isThemeKey accepts the keys and nothing else', () => {
    expect(isThemeKey('rose-gold')).toBe(true)
    expect(isThemeKey('pink')).toBe(false)
    expect(isThemeKey(null)).toBe(false)
  })

  it('themeOf falls back to ivory for unknown or missing keys', () => {
    expect(themeOf('sage').key).toBe('sage')
    expect(themeOf('nope').key).toBe('ivory')
    expect(themeOf(null).key).toBe('ivory')
  })
})

describe('accentForeground', () => {
  it('is white on a dark accent and black on a pale one', () => {
    expect(accentForeground('#1a2b3c')).toBe('#ffffff')
    expect(accentForeground('#ffe066')).toBe('#000000')
  })

  it('picks whichever of black or white contrasts MORE, not a fixed luminance cut', () => {
    // A mid-blue: luminance sits under 0.5, yet black contrasts far better.
    expect(accentForeground('#7aa2f7')).toBe('#000000')
  })
})

describe('themeVars', () => {
  const sage = themeOf('sage')

  it('uses the preset accent when the salon has none', () => {
    const vars = themeVars(sage, null)
    expect(vars['--primary']).toBe(sage.accent)
    expect(vars['--primary-foreground']).toBe(accentForeground(sage.accent))
    expect(vars['--ring']).toBe(sage.accent)
    expect(vars['--sidebar-primary']).toBe(sage.accent)
    expect(vars['--sidebar-primary-foreground']).toBe(accentForeground(sage.accent))
  })

  it('lets the salon accent override the preset', () => {
    const vars = themeVars(sage, '#1a2b3c')
    expect(vars['--primary']).toBe('#1a2b3c')
    expect(vars['--primary-foreground']).toBe('#ffffff')
  })

  it('ignores an accent that is not #rrggbb rather than emitting it', () => {
    expect(themeVars(sage, 'red')['--primary']).toBe(sage.accent)
  })
})

describe('themeScript', () => {
  it('sets data-theme and each variable, and never emits a raw < character', () => {
    const js = themeScript('dark', { '--primary': '#7aa2f7' })
    expect(js).toContain('"dark"')
    expect(js).toContain('"--primary"')
    expect(js).toContain('"#7aa2f7"')
    expect(js).not.toMatch(/<\//)
  })
})
