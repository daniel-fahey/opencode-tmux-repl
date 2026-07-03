import { test, expect } from "bun:test"
import fc from "fast-check"
import { Screen } from "../src/screen.js"

const enc = (s: string) => new TextEncoder().encode(s)
const N = { numRuns: 1000 }
const cleanStr = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => [...s].every((c) => c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e))

test("autowrap: render joins wrapped rows, preserving all content", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 5, max: 20 }), cleanStr, async (width, s) => {
      const sc = new Screen(width, 5)
      await sc.apply(enc(s))
      expect(sc.render().trimEnd()).toBe(s)
    }),
    N,
  )
})

test("CSI @ inserts a char at col 0, shifting content right", async () => {
  await fc.assert(
    fc.asyncProperty(cleanStr, async (s) => {
      const sc = new Screen(80, 5)
      await sc.apply(enc(`${s}\x1b[1G\x1b[@x`))
      const r = sc.render().trimEnd()
      expect(r[0]).toBe("x")
      expect(r.slice(1)).toContain(s)
    }),
    N,
  )
})

test("CSI P deletes the char at col 0", async () => {
  await fc.assert(
    fc.asyncProperty(cleanStr.filter((s) => s.length >= 2), async (s) => {
      const sc = new Screen(80, 5)
      await sc.apply(enc(`${s}\x1b[1G\x1b[P`))
      expect(sc.render().trimEnd()).toBe(s.slice(1))
    }),
    N,
  )
})

test("cursor up then overwrite preserves content below the cursor", async () => {
  await fc.assert(
    fc.asyncProperty(cleanStr, cleanStr, async (line1, line2) => {
      const sc = new Screen(20, 5)
      await sc.apply(enc(`${line1}\r\n${line2}\x1b[1A\rXXX`))
      const lines = sc.render().trimEnd().split("\n")
      expect(lines[0].startsWith("XXX")).toBe(true)
      expect(lines[1]).toContain(line2)
    }),
    N,
  )
})

test("setFrom preserves multi-line text through a render round-trip", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(cleanStr, { minLength: 1, maxLength: 5 }), async (parts) => {
      const sc = new Screen(80, 10)
      const text = parts.join("\n")
      await sc.setFrom(text)
      expect(sc.render().trimEnd()).toBe(text)
    }),
    N,
  )
})

test("setFrom then apply appends at the cursor", async () => {
  await fc.assert(
    fc.asyncProperty(cleanStr, cleanStr, async (seed, appendage) => {
      const sc = new Screen(80, 10)
      await sc.setFrom(seed)
      await sc.apply(enc(appendage))
      const r = sc.render()
      expect(r).toContain(seed)
      expect(r).toContain(appendage)
    }),
    N,
  )
})

test("Screen output is invariant under byte chunking", async () => {
  await fc.assert(
    fc.asyncProperty(cleanStr, cleanStr, fc.integer({ min: 1, max: 10 }), async (a, b, chunkSize) => {
      const ref = new Screen(80, 10)
      await ref.apply(enc(a))
      await ref.apply(enc(b))
      const expected = ref.render()
      const chunked = new Screen(80, 10)
      for (const s of [a, b]) {
        const bytes = enc(s)
        for (let i = 0; i < bytes.length; i += chunkSize) await chunked.apply(bytes.subarray(i, i + chunkSize))
      }
      expect(chunked.render()).toBe(expected)
    }),
    { numRuns: 200 },
  )
})

type ConfluenceOp =
  | { kind: "apply"; s: string }
  | { kind: "setFrom"; s: string }
  | { kind: "reset" }
  | { kind: "resize"; c: number; r: number }

const opArb: fc.Arbitrary<ConfluenceOp> = fc.oneof(
  fc.record({ kind: fc.constant("apply" as const), s: cleanStr }),
  fc.record({ kind: fc.constant("setFrom" as const), s: cleanStr }),
  fc.constant({ kind: "reset" as const }),
  fc.record({ kind: fc.constant("resize" as const), c: fc.integer({ min: 5, max: 100 }), r: fc.integer({ min: 5, max: 30 }) }),
)

const runOp = async (sc: Screen, op: ConfluenceOp): Promise<void> => {
  if (op.kind === "apply") await sc.apply(enc(op.s))
  else if (op.kind === "setFrom") await sc.setFrom(op.s)
  else if (op.kind === "reset") await sc.reset()
  else await sc.resize(op.c, op.r)
}

test("Screen confluence: render is invariant under dispatch strategy over all mutation ops", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), async (ops) => {
      const seq = new Screen(80, 10)
      for (const op of ops) await runOp(seq, op)
      const con = new Screen(80, 10)
      await Promise.all(ops.map((op) => runOp(con, op)))
      expect(con.render()).toBe(seq.render())
    }),
    { numRuns: 300 },
  )
})
