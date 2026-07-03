import { test, expect } from "bun:test"
import fc from "fast-check"
import { ReplManager } from "../src/tmux.js"
import { resolveModes } from "../src/modes.js"

// Integration tests: drive REAL REPLs through real tmux (control-mode %output
// reader, xterm Screen, readiness/debugger recovery, resize) — no OpenCode.
// Runs in the Nix sandbox (tmux + guile + python3/ipython + nix + bash in
// nativeBuildInputs). Each test gets an isolated ReplManager + session.

const SOCKET = "integration-test"
const PREFIX = "it"
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const tmux = (args: string[]) => Bun.spawnSync(["tmux", `-L${SOCKET}`, ...args])

const newManager = () => new ReplManager(SOCKET, resolveModes({}), PREFIX)
const ac = () => new AbortController()

const MODE_SYNTAX: Record<string, { arith: (a: number, b: number) => string; timeout?: number }> = {
  guile: { arith: (a, b) => `(+ ${a} ${b})` },
  python: { arith: (a, b) => `${a} + ${b}` },
  ipython: { arith: (a, b) => `${a} + ${b}`, timeout: 60000 },
  nix: { arith: (a, b) => `${a} + ${b}` },
  bash: { arith: (a, b) => `echo $(( ${a} + ${b} ))` },
}

const assertArithProperty = async (mgr: ReplManager, mode: string, arith: (a: number, b: number) => string, numRuns: number) => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 100, max: 999 }),
      fc.integer({ min: 100, max: 999 }),
      async (a, b) => {
        const out = await mgr.send(mode, arith(a, b), ac().signal)
        if (out.includes("⏱")) throw new Error("send timed out")
        const expected = String(a + b)
        if (!out.includes(expected)) throw new Error(`send missing ${expected}: ${out}`)
        const buf = await mgr.read(mode, 20)
        if (!buf.includes(expected)) throw new Error(`read missing ${expected}: ${buf}`)
      },
    ),
    { numRuns },
  )
}

for (const [mode, syntax] of Object.entries(MODE_SYNTAX)) {
  test(
    `property: ${mode} send→result + read→buffer for random arithmetic`,
    async () => {
      const mgr = newManager()
      try {
        await assertArithProperty(mgr, mode, syntax.arith, 10)
      } finally {
        await mgr.kill(mode)
      }
    },
    syntax.timeout ?? 30000,
  )
}

test(
  "property: guile state persists across random sends",
  async () => {
    const mgr = newManager()
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 100, max: 999 }), async (v) => {
          await mgr.send("guile", `(define sv ${v})`, ac().signal)
          const out = await mgr.send("guile", "sv", ac().signal)
          if (!out.includes(String(v))) throw new Error(`expected ${v}: ${out}`)
        }),
        { numRuns: 5 },
      )
    } finally {
      await mgr.kill("guile")
    }
  },
  30000,
)

test(
  "guile error → debugger prompt (send returns) → agent sends ,q → recover",
  async () => {
    const mgr = newManager()
    try {
      await mgr.send("guile", "(car 5)", ac().signal)
      await mgr.send("guile", ",q", ac().signal)
      const ok = await mgr.send("guile", "(* 6 7)", ac().signal)
      expect(ok).toContain("42")
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "display without trailing newline still reaches readiness",
  async () => {
    const mgr = newManager()
    try {
      const out = await mgr.send("guile", '(display "no-newline-here")', ac().signal)
      expect(out).toContain("no-newline-here")
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "resync read (capture-pane reconcile) returns the pane content",
  async () => {
    const mgr = newManager()
    try {
      await mgr.send("guile", "(+ 1 2)", ac().signal)
      const buf = await mgr.read("guile", 50, true)
      expect(buf).toContain("$1 = 3")
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "read does not resurrect a killed session",
  async () => {
    const mgr = newManager()
    try {
      await mgr.get("guile")
      await mgr.kill("guile")
      const out = await mgr.read("guile", 50)
      expect(out).toMatch(/no session/i)
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "display output starting with ': ' is not stripped by the OUT regex",
  async () => {
    const mgr = newManager()
    try {
      const out = await mgr.send("guile", '(display ": colon-space")', ac().signal)
      expect(out).toContain(": colon-space")
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "clear wipes the screen so prior output is no longer readable",
  async () => {
    const mgr = newManager()
    try {
      await mgr.send("guile", '(display "sentinel-ZZZ")', ac().signal)
      const before = await mgr.read("guile", 50)
      expect(before).toContain("sentinel-ZZZ")
      await mgr.clear("guile")
      const after = await mgr.read("guile", 50)
      expect(after).not.toContain("sentinel-ZZZ")
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "plugin works after a pane resize (%layout-change tracked)",
  async () => {
    const mgr = newManager()
    try {
      await mgr.send("guile", "(+ 1 2)", ac().signal)
      tmux(["resize-window", "-t", `${PREFIX}-guile`, "-x", "100", "-y", "30"])
      await sleep(500)
      const out = await mgr.send("guile", "(* 3 4)", ac().signal)
      expect(out).toContain("12")
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "paste-buffer of a multi-line form tracks cleanly (no trailing-blank-cursor desync)",
  async () => {
    const mgr = newManager()
    try {
      await mgr.get("guile")
      tmux(["set-buffer", "(define (sq x)\n  (* x x))\n(sq 9)"])
      tmux(["paste-buffer", "-t", `${PREFIX}-guile`])
      await sleep(500)
      const buf = await mgr.read("guile", 50)
      expect(buf).toContain("(define (sq x)")
      expect(buf).toContain("(sq 9)")
      let maxRun = 0
      let cur = 0
      for (const line of buf.split("\n")) {
        if (line.trim() === "") {
          cur++
          if (cur > maxRun) maxRun = cur
        } else cur = 0
      }
      expect(maxRun).toBeLessThan(5)
    } finally {
      await mgr.kill("guile")
    }
  },
  20000,
)

test(
  "property: concurrent sends to the same mode serialize (no garbling)",
  async () => {
    const mgr = newManager()
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 999 }),
          fc.integer({ min: 100, max: 999 }),
          async (a, b) => {
            const [out1, out2] = await Promise.all([
              mgr.send("guile", `(* ${a} 13)`, ac().signal),
              mgr.send("guile", `(* ${b} 17)`, ac().signal),
            ])
            const exp1 = String(a * 13)
            const exp2 = String(b * 17)
            if (!out1.includes(exp1)) throw new Error(`out1 missing ${exp1}`)
            if (!out2.includes(exp2)) throw new Error(`out2 missing ${exp2}`)
          },
        ),
        { numRuns: 3 },
      )
    } finally {
      await mgr.kill("guile")
    }
  },
  30000,
)

test(
  "invariant: read() output contains no prompt/continuation echo lines",
  async () => {
    const m = resolveModes({}).ipython
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 9999 }), async (n) => {
        const mgr = newManager()
        try {
          await mgr.send("ipython", `x = ${n}\nprint(x)`, ac().signal)
          const buf = await mgr.read("ipython", 50)
          for (const line of buf.split("\n")) {
            if (m.continuation?.test(line) ?? false) throw new Error(`continuation leaked: "${line}"`)
          }
        } finally {
          await mgr.kill("ipython")
        }
      }),
      { numRuns: 3 },
    )
  },
  60000,
)

test(
  "continuation-Enter fires at most once (incomplete form → ⏳, not a second Enter)",
  async () => {
    const mgr = newManager()
    try {
      const out = await mgr.send("python", "x = [", ac().signal)
      expect(out).toContain("⏳")
    } finally {
      await mgr.kill("python")
    }
  },
  30000,
)

test(
  "subprocess timeout: hanging tmux command resolves via Promise.race, not forever",
  async () => {
    Bun.spawnSync(["tmux", "-Ltimeout-test", "new", "-d", "-s", "t"])
    const proc = Bun.spawn(["tmux", "-Ltimeout-test", "wait-for", "never"], {
      stdout: "pipe", stderr: "pipe",
    })
    const code = await Promise.race([proc.exited, sleep(1000).then(() => null as null | number)])
    try { proc.kill() } catch (e) { void e }
    Bun.spawnSync(["tmux", "-Ltimeout-test", "kill-server"])
    expect(code).toBeNull()
  },
  5000,
)

test(
  "property: large multi-line IPython form returns result (not timeout from model corruption)",
  async () => {
    const mgr = newManager()
    try {
      const form = [
        "def stats(data):",
        "    n = len(data)",
        "    mean = sum(data) / n",
        "    variance = sum((x - mean) ** 2 for x in data) / n",
        "    stdev = variance ** 0.5",
        "",
        "    def describe():",
        "        return f'n={n} mean={mean:.1f} stdev={stdev:.1f}'",
        "",
        "    return describe()",
        "",
        "data = [10, 20, 30, 40, 50]",
        "result = stats(data)",
        "print(result)",
      ].join("\n")
      const out = await mgr.send("ipython", form, ac().signal)
      expect(out).toContain("n=5")
      expect(out).not.toContain("⏱")
    } finally {
      await mgr.kill("ipython")
    }
  },
  60000,
)
