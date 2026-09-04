import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every environment variable the app reads must be documented in
 * .env.example.
 *
 * This exists because the file shipped WITHOUT BETTER_AUTH_SECRET and
 * BETTER_AUTH_URL, and the omission surfaced as a failed deploy: better-auth
 * booted on its default secret -- every session forgeable -- and derived its
 * origin from the request. A deployment checklist is only useful if it is
 * complete, and "remember to update the example file" is not a mechanism.
 */
const ROOTS = ['app', 'lib', 'components', 'scripts', 'next.config.ts']

/**
 * Read by a LIBRARY rather than by our own code, so no `process.env.X` appears
 * anywhere to scan for. They are the two that were missing.
 */
const READ_BY_DEPENDENCIES = ['BETTER_AUTH_SECRET']

/** Build/test plumbing, not deployment configuration. */
const NOT_DEPLOYMENT_CONFIG = ['NEXT_DIST_DIR']

function walk(path: string): string[] {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)))
}

describe('.env.example', () => {
  it('documents every variable the app reads', () => {
    const referenced = new Set<string>(READ_BY_DEPENDENCIES)
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (!/\.(ts|tsx|mts|mjs)$/.test(file)) continue
        for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
          referenced.add(m[1])
        }
      }
    }
    for (const skip of NOT_DEPLOYMENT_CONFIG) referenced.delete(skip)

    const documented = new Set(
      [...readFileSync('.env.example', 'utf8').matchAll(/^#?\s*([A-Z0-9_]+)=/gm)]
        .map((m) => m[1]))

    const missing = [...referenced].filter((v) => !documented.has(v)).sort()
    expect(missing, 'undocumented environment variables').toEqual([])
  })
})
