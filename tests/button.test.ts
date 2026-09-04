import { describe, expect, it } from 'vitest'
import { buttonVariants } from '../components/ui/button'

/**
 * The class list contradicts itself before tailwind-merge runs: the base sets
 * `border-transparent`, the outline variant sets `border-border`, and CSS
 * source order picks the transparent one when both survive.
 *
 * That shipped as an invisible border on every outline button on every page --
 * 39 call sites passing buttonVariants(...) straight into a className, which
 * skipped the merge <Button> was doing internally. Caught by looking at the
 * public booking page on a phone and asking why the primary call to action
 * rendered as plain text.
 */
describe('buttonVariants', () => {
  it('resolves the border to ONE class, not two that fight', () => {
    const cls = buttonVariants({ variant: 'outline' })
    expect(cls).toContain('border-border')
    expect(cls, 'the base border-transparent must lose').not.toContain('border-transparent')
  })

  it('keeps the transparent border where no variant overrides it', () => {
    // The default variant has no border colour of its own, so the base's
    // transparent border is correct there -- the fix must not paint a border
    // on every button in the product.
    expect(buttonVariants({ variant: 'default' })).toContain('border-transparent')
  })
})
