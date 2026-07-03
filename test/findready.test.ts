import { test, expect } from "bun:test"
import fc from "fast-check"
import { findReady } from "../src/tmux.js"
import { resolveModes } from "../src/modes.js"

const guile = resolveModes({}).guile
const bash = resolveModes({}).bash
const ipython = resolveModes({}).ipython
const PROMPT = "scheme@(guile-user)> "
const N = { numRuns: 5000 }

const formArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes("scheme@") && !s.includes("\n") && s.trim().length > 0)
const outputArb = fc.string({ maxLength: 50 }).filter((s) => !s.includes("scheme@") && !s.includes("\n"))

// SOUNDNESS: for any buffer ending in a ready prompt where the queried form is
// NOT exactly echoed at a prompt line, findReady returns not-ready. Subsumes:
// not-a-prompt, different-form-echoed, prefix-collision (substring ≠ exact).
test("SOUNDNESS: not ready when the queried form is not exactly echoed", () => {
  const bufArb = fc.array(
    fc.oneof(outputArb, formArb.map((f) => `${PROMPT}${f}`)),
    { minLength: 0, maxLength: 6 },
  ).map((lines) => [...lines, PROMPT].join("\n"))
  fc.assert(fc.property(bufArb, formArb, (text, form) => {
    const firstForm = form.trim().split("\n")[0].trim()
    const hasExactEcho = text.split("\n").some((l) =>
      guile.prompt.test(l) && l.replace(guile.prompt, "").trim() === firstForm)
    fc.pre(!hasExactEcho)
    expect(findReady(text, form, guile).ready).toBe(false)
  }), N)
})

// FAITHFULNESS: for any buffer where the queried form IS echoed, findReady
// returns ready with the result preserving all genuine output after the most
// recent echo (including continuation-shaped output). Subsumes: basic ready,
// most-recent-echo anchoring, continuation-output preservation.
test("FAITHFULNESS: ready + result preserves genuine output after the most recent echo", () => {
  const genuineOutput = fc.oneof(outputArb, fc.stringMatching(/^\.\.\. \S{1,30}$/))
  fc.assert(fc.property(
    formArb, genuineOutput, genuineOutput, fc.integer({ min: 0, max: 2 }),
    (form, oldOut, newOut, oldEchoCount) => {
      fc.pre(
        oldOut.trim() !== "" && newOut.trim() !== "" &&
        oldOut !== newOut &&
        !newOut.includes(oldOut) && !oldOut.includes(newOut) &&
        !oldOut.includes(form) && !newOut.includes(form) &&
        !form.includes(oldOut) && !form.includes(newOut) &&
        !(PROMPT + form).includes(oldOut) && !(PROMPT + form).includes(newOut),
      )
      const lines: string[] = []
      for (let i = 0; i < oldEchoCount; i++) { lines.push(`${PROMPT}${form}`, oldOut) }
      lines.push(`${PROMPT}${form}`, newOut, PROMPT)
      const r = findReady(lines.join("\n"), form, guile)
      expect(r.ready).toBe(true)
      expect(r.result).toContain(newOut)
      if (oldEchoCount > 0) expect(r.result).not.toContain(oldOut)
    }), N)
})

// A3: an intervening form (with content) between the anchor and the ready prompt
// means the anchor is stale — findReady must return not-ready.
test("not ready when an intervening form was evaluated after the anchored echo (stale slice)", () => {
  fc.assert(
    fc.property(formArb, outputArb, formArb, outputArb, (form1, out1, form2, out2) => {
      fc.pre(form1 !== form2 && !out1.includes(form2) && !out2.includes(form1))
      const text = `${PROMPT}${form1}\n${out1}\n${PROMPT}${form2}\n${out2}\n${PROMPT}`
      expect(findReady(text, form1, guile).ready).toBe(false)
    }),
    N,
  )
})

// Mode coverage: bash continuation-prompt echo anchors readiness
test("bash continuation-prompt echo anchors readiness", () => {
  fc.assert(fc.property(formArb, (form) => {
    expect(findReady(`bash-5.2$ if true; then\n> ${form}\nbash-5.2$ `, form, bash).ready).toBe(true)
  }), N)
})

// Multi-line coverage: ipython continuation echoes don't leak into result
test("no prompt or continuation lines leak into the result (no superfluous Enter artifacts)", () => {
  const idArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_ ]{0,20}$/)
  const outArb = fc.stringMatching(/^[-a-zA-Z0-9 .,!?"']{0,50}$/).filter((s) => s.trim().length > 0 && !(ipython.continuation?.test(s) ?? false))
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 99 }), idArb, fc.array(idArb, { maxLength: 5 }), fc.array(outArb, { maxLength: 5 }), fc.boolean(), fc.boolean(),
    (n, form, body, outputs, trailingCont, intermediatePrompt) => {
      const lines: string[] = [`In [${n}]: ${form}`]
      for (const b of body) lines.push(`   ...: ${b}`)
      if (trailingCont) lines.push(`   ...: `)
      if (intermediatePrompt) lines.push(`In [${n}]: `)
      for (const o of outputs) lines.push(o)
      lines.push(`In [${n + 1}]: `)
      const fullForm = body.length > 0 ? `${form}\n${body.join("\n")}` : form
      const r = findReady(lines.join("\n"), fullForm, ipython)
      expect(r.ready).toBe(true)
      for (const line of r.result.split("\n")) {
        expect(ipython.continuation?.test(line) ?? false).toBe(false)
      }
    }), N)
})
