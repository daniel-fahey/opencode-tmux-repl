import { test, expect } from "bun:test"
import fc from "fast-check"
import { findReady } from "../src/tmux.js"
import { resolveModes } from "../src/modes.js"

const guile = resolveModes({}).guile
const bash = resolveModes({}).bash
const ipython = resolveModes({}).ipython
const r = resolveModes({}).r
const PROMPT = "scheme@(guile-user)> "
const R_PROMPT = "> "
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

// RESULT COMPLETENESS (ipython): continuation echoes are part of the form
// echo and must appear in the result. findReady captures everything between
// the form echo and the ready prompt — no stripping.
test("RESULT COMPLETENESS (ipython): multi-line form result includes continuation echoes", () => {
  const idArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_ ]{0,20}$/)
  const bodyArb = fc.array(idArb, { minLength: 1, maxLength: 5 })
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 99 }), idArb, bodyArb,
    (n, form, body) => {
      const lines: string[] = [`In [${n}]: ${form}`]
      for (const b of body) lines.push(`   ...: ${b}`)
      lines.push(`[1] 42`, `In [${n + 1}]: `)
      const fullForm = `${form}\n${body.join("\n")}`
      const result = findReady(lines.join("\n"), fullForm, ipython)
      expect(result.ready).toBe(true)
      for (const b of body) {
        expect(result.result).toContain(`   ...: ${b}`)
      }
    }), N)
})

// ── R ───────────────────────────────────────────────────────────────────────
// R has the shortest prompt of any built-in (single `>`) and a `+`
// continuation. findReady captures everything between the form echo and the
// ready prompt without stripping — continuation echoes, `+`-prefixed output,
// and `+`-prefix forms all pass through unchanged. The `+` collision class
// (genuine `+` output vs continuation echoes) is designed out: nothing is
// stripped, so nothing collides.
const rFormArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) =>
  !s.includes(">") && !s.includes("\n") && s.trim().length > 0)
const rOutputArb = fc.string({ maxLength: 50 }).filter((s) =>
  !s.includes(">") && !s.includes("\n"))

// SOUNDNESS (R): for any buffer ending in a ready prompt where the queried form
// is NOT exactly echoed at a prompt line, findReady returns not-ready. Same
// shape as the guile Soundness property, exercised against R's short-prompt
// regex — the discriminating concern is that `[1] 5`-style output lines or
// arbitrary text don't false-match the form-anchor.
test("SOUNDNESS (R): not ready when the queried form is not exactly echoed", () => {
  const bufArb = fc.array(
    fc.oneof(rOutputArb, rFormArb.map((f) => `${R_PROMPT}${f}`)),
    { minLength: 0, maxLength: 6 },
  ).map((lines) => [...lines, R_PROMPT].join("\n"))
  fc.assert(fc.property(bufArb, rFormArb, (text, form) => {
    const firstForm = form.trim().split("\n")[0].trim()
    const hasExactEcho = text.split("\n").some((l) =>
      r.prompt.test(l) && l.replace(r.prompt, "").trim() === firstForm)
    fc.pre(!hasExactEcho)
    expect(findReady(text, form, r).ready).toBe(false)
  }), N)
})

// FAITHFULNESS (R): for any buffer where the queried form IS echoed, findReady
// returns ready with the result preserving all genuine output after the most
// recent echo.
test("FAITHFULNESS (R): ready + result preserves genuine output after the most recent echo", () => {
  const genuineOutput = fc.oneof(rOutputArb, fc.stringMatching(/^\+ \S{1,30}$/))
  fc.assert(fc.property(
    rFormArb, genuineOutput, genuineOutput, fc.integer({ min: 0, max: 2 }),
    (form, oldOut, newOut, oldEchoCount) => {
      fc.pre(
        oldOut.trim() !== "" && newOut.trim() !== "" &&
        oldOut !== newOut &&
        !newOut.includes(oldOut) && !oldOut.includes(newOut) &&
        !oldOut.includes(form) && !newOut.includes(form) &&
        !form.includes(oldOut) && !form.includes(newOut),
      )
      const lines: string[] = []
      for (let i = 0; i < oldEchoCount; i++) { lines.push(`${R_PROMPT}${form}`, oldOut) }
      lines.push(`${R_PROMPT}${form}`, newOut, R_PROMPT)
      const result = findReady(lines.join("\n"), form, r)
      expect(result.ready).toBe(true)
      expect(result.result).toContain(newOut)
      if (oldEchoCount > 0) expect(result.result).not.toContain(oldOut)
    }), N)
})

// PLUS-PREFIX OUTPUT (R): `+`-prefixed output (e.g. cat("+abc") → "+abc") is
// preserved — nothing is stripped between echo and ready prompt.
test("PLUS-PREFIX (R): single-line form's `+`-prefixed output is preserved", () => {
  const plusOutput = fc.stringMatching(/^\+\s*\S+$/).filter((s) => !s.includes("\n"))
  fc.assert(fc.property(
    rFormArb, plusOutput,
    (form, out) => {
      fc.pre(!form.includes(out) && !out.includes(form))
      const text = `${R_PROMPT}${form}\n${out}\n${R_PROMPT}`
      const result = findReady(text, form, r)
      expect(result.ready).toBe(true)
      expect(result.result).toContain(out)
    }), N)
})

// RESULT COMPLETENESS (R): continuation echoes are part of the form echo and
// must appear in the result. Same universal property as ipython — findReady
// captures everything between echo and ready prompt.
test("RESULT COMPLETENESS (R): multi-line form result includes continuation echoes", () => {
  const idArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_ ]{0,20}$/)
  const bodyArb = fc.array(idArb, { minLength: 1, maxLength: 5 })
  fc.assert(fc.property(
    idArb, bodyArb,
    (form, body) => {
      const lines: string[] = [`${R_PROMPT}function() {`]
      for (const b of body) lines.push(`+   ${b}`)
      lines.push(`+ }`, `[1] 42`, R_PROMPT)
      const fullForm = `function() {\n${body.join("\n")}\n}`
      const result = findReady(lines.join("\n"), fullForm, r)
      expect(result.ready).toBe(true)
      for (const b of body) {
        expect(result.result).toContain(`+   ${b}`)
      }
      expect(result.result).toContain(`+ }`)
    }), N)
})

// Forms starting with the continuation char (e.g. `+5`) must be matched —
// stripPrompt only strips the prompt, so `> +5` → `+5` = firstForm.
test("CONTINUATION-CHAR FORM (R): form starting with `+` is matched when echoed at a prompt", () => {
  const plusFormArb = fc.stringMatching(/^\+[^\n>]{1,29}$/).filter((s) => s.trim().length > 0)
  fc.assert(fc.property(plusFormArb, (form) => {
    const text = `${R_PROMPT}${form}\n[1] 42\n${R_PROMPT}`
    expect(findReady(text, form, r).ready).toBe(true)
  }), N)
})
