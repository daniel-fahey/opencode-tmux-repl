import { test, expect } from "bun:test"
import fc from "fast-check"
import { deescape, OUT } from "../src/tmux.js"
import { Screen } from "../src/screen.js"

const N = { numRuns: 2000 }
const enc = (s: string) => new TextEncoder().encode(s)

// tmux escapes bytes <0x20 and `\` as \ooo (3-digit zero-padded octal); all
// else literal. This is the inverse of deescape.
const escapeForTmux = (s: string): string =>
  Array.from(s)
    .map((ch) => {
      const cp = ch.codePointAt(0)!
      return cp < 0x20 || ch === "\\" ? "\\" + cp.toString(8).padStart(3, "0") : ch
    })
    .join("")

// ── deescape properties ─────────────────────────────────────────────────────

test("deescape is the exact inverse of escape for all strings", () => {
  fc.assert(fc.property(fc.string({ maxLength: 100 }), (s) => {
    expect(deescape(escapeForTmux(s))).toBe(s)
  }), N)
})

test("deescape preserves literal bytes (>=0x20, ≠ backslash) without transformation", () => {
  fc.assert(fc.property(
    fc.string({ maxLength: 50 }).filter((s) => [...s].every((c) => c.charCodeAt(0) >= 0x20 && c !== "\\")),
    (s) => { expect(deescape(s)).toBe(s) },
  ), N)
})

// ── OUT regex properties ─────────────────────────────────────────────────────

test("OUT regex matches and correctly strips plain %output lines", () => {
  fc.assert(fc.property(fc.nat({ max: 9999 }), fc.string({ maxLength: 80 }), (id, payload) => {
    const line = `%output %${id} ${payload}`
    const m = line.match(OUT)
    expect(m).not.toBeNull()
    expect(m![0]).toBe(`%output %${id} `)
    expect(line.slice(m![0].length)).toBe(payload)
  }), N)
})

test("OUT regex matches and correctly strips %extended-output lines", () => {
  fc.assert(fc.property(fc.nat({ max: 9999 }), fc.nat({ max: 99999 }), fc.string({ maxLength: 80 }), (id, age, payload) => {
    const line = `%extended-output %${id} ${age} : ${payload}`
    const m = line.match(OUT)
    expect(m).not.toBeNull()
    expect(line.slice(m![0].length)).toBe(payload)
  }), N)
})

test("OUT regex rejects lines that are not %output or %extended-output", () => {
  fc.assert(fc.property(
    fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.startsWith("%output") && !s.startsWith("%extended-output")),
    (line) => { expect(line.match(OUT)).toBeNull() },
  ), N)
})

test("OUT regex does not strip a leading ': ' from plain %output payloads", () => {
  fc.assert(fc.property(
    fc.nat({ max: 99 }),
    fc.string({ minLength: 1, maxLength: 28 }),
    (id, rest) => {
      const payload = ": " + rest
      const line = `%output %${id} ${payload}`
      const m = line.match(OUT)
      expect(line.slice(m![0].length)).toBe(payload)
    }
  ), N)
})

// ── Phase 3: reader pipeline robustness fuzzing ──────────────────────────────
// The reader processes arbitrary escaped payloads from tmux %output. Any string
// could arrive as a payload; the pipeline (deescape → encode → Screen.apply →
// render) must never crash, hang, or produce non-string output.

test("reader pipeline: any escaped payload processes without crash", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 200 }), async (payload) => {
      const sc = new Screen(80, 10)
      await sc.apply(enc(deescape(payload)))
      expect(typeof sc.render()).toBe("string")
    }),
    { numRuns: 500 },
  )
})

test("reader pipeline: malformed escape sequences don't crash deescape", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 100 }).filter((s) => s.includes("\\")),
      (s) => {
        expect(typeof deescape(s)).toBe("string")
      },
    ),
    N,
  )
})
