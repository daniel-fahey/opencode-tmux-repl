import { test, expect } from "bun:test"
import fc from "fast-check"
import { resolveModes } from "../src/modes.js"

const BUILTIN_NAMES = ["guile", "python", "ipython", "nix", "bash"]
const validRegexArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => {
  try { new RegExp(s); return true } catch { return false }
})

test("resolveModes always includes all built-in modes", () => {
  const modes = resolveModes({})
  for (const name of BUILTIN_NAMES) {
    expect(modes[name]).toBeDefined()
    expect(modes[name].command.length).toBeGreaterThan(0)
    expect(modes[name].prompt).toBeInstanceOf(RegExp)
    expect(modes[name].ready).toBeInstanceOf(RegExp)
  }
})

test("resolveModes user override replaces the specified field", () => {
  fc.assert(
    fc.property(validRegexArb, (overrideRegex) => {
      const modes = resolveModes({ guile: { prompt: overrideRegex } })
      expect(modes.guile.prompt.source).toBe(new RegExp(overrideRegex).source)
    }),
    { numRuns: 1000 },
  )
})

test("resolveModes keeps unspecified fields from built-ins", () => {
  const modes = resolveModes({ guile: { prompt: "x" } })
  const builtins = resolveModes({})
  expect(modes.guile.ready.source).toBe(builtins.guile.ready.source)
  expect(modes.guile.command).toEqual(builtins.guile.command)
})

test("resolveModes adds new user modes", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !BUILTIN_NAMES.includes(s)),
      fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
      validRegexArb,
      (name, command, ready) => {
        const modes = resolveModes({ [name]: { command, prompt: ready, ready } })
        expect(modes[name]).toBeDefined()
      },
    ),
    { numRuns: 1000 },
  )
})

test("resolveModes throws on invalid regex in a user mode", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 20 }).filter((s) => { try { new RegExp(s); return false } catch { return true } }),
      (invalidRegex) => {
        expect(() => resolveModes({ bad: { command: ["x"], prompt: invalidRegex, ready: "x" } })).toThrow()
      },
    ),
    { numRuns: 1000 },
  )
})
