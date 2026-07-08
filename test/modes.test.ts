import { test, expect } from "bun:test"
import fc from "fast-check"
import { resolveModes } from "../src/modes.js"

const BUILTIN_NAMES = ["guile", "python", "ipython", "nix", "bash", "r", "mit"]
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

// R built-in: command avoids the exit-time save prompt; continuation defined for
// multi-line forms (function bodies, control flow).
test("resolveModes includes r with no-save/no-restore flags and a continuation prompt", () => {
  const modes = resolveModes({})
  expect(modes.r).toBeDefined()
  expect(modes.r.command[0]).toBe("R")
  expect(modes.r.command).toContain("--no-save")
  expect(modes.r.command).toContain("--no-restore")
  expect(modes.r.continuation).toBeInstanceOf(RegExp)
})

// R's ready regex anchors only on the trailing `>` (optionally + space) — the
// shortest prompt of any built-in. Property: it matches exactly the lines R's
// prompt can produce (ending in `>` or `> `), and nothing else. This is the
// discriminating prediction of the regex; the form-anchor in findReady does the
// heavier disambiguation against stale echoes.
test("r ready regex matches lines ending in '>' with optional trailing space, rejects all others", () => {
  const m = resolveModes({}).r
  fc.assert(
    fc.property(
      fc.string({ maxLength: 20 }).filter((s) => !s.includes("\n")),
      (s) => {
        const expected = s.endsWith(">") || s.endsWith("> ")
        expect(m.ready.test(s)).toBe(expected)
      },
    ),
    { numRuns: 1000 },
  )
})

// R's continuation regex anchors at start-of-line `+` (optionally + space).
// findReady captures everything between echo and ready prompt without
// stripping, so the regex is informational only (used by findEchoLine's
// continuation fallback). Property: matches ⟺ line starts with `+`.
test("r continuation regex matches lines starting with '+' (with optional trailing space)", () => {
  const m = resolveModes({}).r
  fc.assert(
    fc.property(
      fc.string({ maxLength: 20 }).filter((s) => !s.includes("\n")),
      (s) => {
        // `^\+ ?` matches iff s starts with "+", possibly followed by one space.
        const startsWithPlus = s.startsWith("+")
        expect(m.continuation?.test(s)).toBe(startsWithPlus)
      },
    ),
    { numRuns: 1000 },
  )
})

// MIT Scheme built-in: command avoids loading user config; no continuation
// (MIT Scheme reads multi-line expressions silently, no continuation prompt).
test("resolveModes includes mit with mit-scheme command and no continuation", () => {
  const modes = resolveModes({})
  expect(modes.mit).toBeDefined()
  expect(modes.mit.command[0]).toBe("mit-scheme")
  expect(modes.mit.continuation).toBeUndefined()
})

// MIT Scheme's prompt is `<level> ]=> ` where level is a digit (1 normally,
// increments in debugger). The ready regex `\d+ \]=> ?$` must match this but
// NOT match MIT's `;Value: 3` output lines.
test("mit ready regex discriminates the N ]=> prompt from ;Value: output lines", () => {
  const m = resolveModes({}).mit
  for (const line of ["1 ]=> ", "1 ]=>", "2 ]=> ", "10 ]=> "]) {
    expect(m.ready.test(line)).toBe(true)
  }
  for (const line of [";Value: 3", "]=> ", "a ]=> ", "1]=> ", "1 ]=> x"]) {
    expect(m.ready.test(line)).toBe(false)
  }
})
