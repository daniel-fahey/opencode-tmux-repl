import { Screen } from "./screen.js"
import type { Mode } from "./modes.js"

const POLL_MS = 50
const STALL_MS = 150
const TMUX_TIMEOUT_MS = 10_000
const ABORT_SETTLE_MS = 150
const TAIL_LINES = 40
const ENCODER = new TextEncoder()

type Repl = {
  key: string
  screen: Screen
  proc: Bun.Subprocess<"pipe", "pipe", "ignore">
  done: boolean
  lastUpdate: number
}

export const deescape = (s: string) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
// The extended-output separator (` <age> : `) is matched explicitly — a generic
// optional `:` greedily ate a leading ": " from plain %output payloads.
export const OUT = /^%(?:extended-output %\d+ \d+ : |output %\d+ )/
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const tail = (s: string, n: number) => s.split("\n").slice(-n).join("\n")
const killProc = (proc: Bun.Subprocess) => { try { proc.kill() } catch (e) { void e } }

function lastNonEmptyIdx(lines: string[]): number {
  let i = lines.length
  while (i > 0 && lines[i - 1].trim() === "") i--
  return i - 1
}

const stripPrompt = (line: string, m: Mode): string =>
  line.replace(m.prompt, "").replace(m.continuation ?? /$/g, "")

function stripEchoNoise(slice: string[], m: Mode, form: string): void {
  if (!m.continuation) return
  const multiLine = form.includes("\n")
  for (let i = 1; i < slice.length; i++) {
    if (!m.continuation.test(slice[i])) break
    if (!multiLine && stripPrompt(slice[i], m).trim() !== "") break
    slice.splice(i, 1)
    i--
  }
}

/** Detect readiness from rendered text. */
export function findReady(text: string, form: string, m: Mode): { ready: boolean; result: string } {
  const lines = text.split("\n")
  const last = lastNonEmptyIdx(lines)
  if (last < 0 || !m.ready.test(lines[last])) return { ready: false, result: "" }
  const fp = findEchoLine(lines, { form, mode: m }, last - 1)
  if (fp < 0) return { ready: false, result: "" }
  if (hasInterveningPrompt(lines, { m, from: fp + 1, to: last })) return { ready: false, result: "" }
  const slice = lines.slice(fp, last + 1)
  stripEchoNoise(slice, m, form)
  while (slice.length && slice[slice.length - 1].trim() === "") slice.pop()
  return { ready: true, result: slice.join("\n") }
}

function hasInterveningPrompt(lines: string[], q: { m: Mode; from: number; to: number }): boolean {
  for (let i = q.from; i < q.to; i++) {
    if (q.m.prompt.test(lines[i]) && stripPrompt(lines[i], q.m).trim() !== "") return true
  }
  return false
}

function findEchoLine(lines: string[], q: { form: string; mode: Mode }, from: number): number {
  const firstForm = q.form.trim().split("\n")[0].trim()
  const matchBy = (test: RegExp): number => {
    for (let i = from; i >= 0; i--) {
      if (test.test(lines[i]) && stripPrompt(lines[i], q.mode).trim() === firstForm) return i
    }
    return -1
  }
  const fp = matchBy(q.mode.prompt)
  return fp >= 0 ? fp : q.mode.continuation ? matchBy(q.mode.continuation) : -1
}

/** Drives tmux REPLs via control-mode %output + xterm Screen. Each mode gets
 *  its own tmux session and Screen; writes serialize per-mode. */
export class ReplManager {
  private repls = new Map<string, Repl>()
  private writeChains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly socket: string,
    private readonly modes: Record<string, Mode>,
    private readonly sessionPrefix = "repl",
  ) {}

  private session(mode: string) { return `${this.sessionPrefix}-${mode}` }
  availableModes(): string[] { return Object.keys(this.modes) }

  private async tmux(args: string[], stdin?: string): Promise<string> {
    const proc = Bun.spawn(["tmux", `-L${this.socket}`, ...args], {
      stdout: "pipe", stderr: "pipe", stdin: stdin ? "pipe" : undefined,
    })
    if (stdin) { proc.stdin.write(stdin); proc.stdin.end() }
    try {
      const code = await Promise.race([proc.exited, sleep(TMUX_TIMEOUT_MS).then(() => null as null | number)])
      if (code === null) throw new Error(`tmux ${args.join(" ")} timed out after ${TMUX_TIMEOUT_MS}ms`)
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      if (code !== 0) throw new Error(`tmux ${args.join(" ")} failed (exit ${code}): ${err.trim()}`)
      return out
    } finally { killProc(proc) }
  }

  private async has(mode: string): Promise<boolean> {
    const p = Bun.spawn(["tmux", `-L${this.socket}`, "has-session", "-t", this.session(mode)], {
      stdout: "ignore", stderr: "ignore",
    })
    await p.exited
    return p.exitCode === 0
  }

  private async sendLine(mode: string, t: string) {
    const s = this.session(mode)
    await this.tmux(["load-buffer", "-"], t)
    await this.tmux(["paste-buffer", "-p", "-t", s])
    await this.tmux(["send-keys", "-t", s, "Enter"])
    await this.tmux(["delete-buffer"])
  }

  private async cursorY(mode: string): Promise<number> {
    const out = await this.tmux(["display", "-t", this.session(mode), "-p", "#{cursor_y}"])
    const n = parseInt(out, 10)
    if (!Number.isFinite(n)) throw new Error(`unexpected cursor_y for ${mode}: ${out.trim()}`)
    return n
  }

  // -E cursor_y: capture up to the cursor row, not the full grid (avoids
  // trailing blank rows that park xterm's cursor at the bottom).
  private async capture(mode: string): Promise<string> {
    const cy = await this.cursorY(mode)
    return this.tmux(["capture-pane", "-t", this.session(mode), "-p", "-J", "-S", "-", "-E", String(cy)])
  }

  private async paneSize(mode: string): Promise<[number, number]> {
    const out = await this.tmux(["display", "-t", this.session(mode), "-p", "#{pane_width} #{pane_height}"])
    const [c, r] = out.split(/\s+/).map(Number)
    if (!(c > 0 && r > 0)) throw new Error(`invalid pane size for ${mode}: ${out.trim()}`)
    return [c, r]
  }

  private async waitBoot(mode: string, m: Mode) {
    const dl = Date.now() + m.bootTimeoutMs
    while (Date.now() < dl) {
      try {
        const lines = (await this.capture(mode)).split("\n")
        const ln = lastNonEmptyIdx(lines)
        if (ln >= 0 && m.ready.test(lines[ln])) return
      } catch (e) { void e }
      await sleep(POLL_MS)
    }
  }

  private async ensureSession(mode: string, m: Mode, create: boolean) {
    if (await this.has(mode)) return
    if (!create) throw new Error(`no session ${this.session(mode)} on -L${this.socket}`)
    await this.tmux(["new", "-d", "-s", this.session(mode), ...m.command])
    await this.waitBoot(mode, m)
  }

  private async processReaderLine(repl: Repl, line: string) {
    const m = line.match(OUT)
    if (m) {
      await repl.screen.apply(ENCODER.encode(deescape(line.slice(m[0].length))))
      repl.lastUpdate = Date.now()
    } else if (line.startsWith("%layout-change")) {
      const [c, r] = await this.paneSize(repl.key)
      await repl.screen.resize(c, r)
    }
  }

  private async startReader(repl: Repl) {
    const dec = new TextDecoder()
    const reader = repl.proc.stdout.getReader()
    let buf = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          await this.processReaderLine(repl, line)
        }
      }
    } catch (e) { void e } finally { repl.done = true }
  }

  /** Get or create the Repl for a mode. Lazy: if the tmux session is absent and
   *  create=true, creates and boots it. If create=false, throws on missing session.
   *  @throws if create=false and no session exists, or if mode is unknown. */
  async get(mode: string, create = true): Promise<Repl> {
    const existing = this.repls.get(mode)
    if (existing && !existing.done) return existing
    const m = this.modes[mode]
    if (!m) throw new Error(`unknown mode "${mode}"; available: ${this.availableModes().join(", ")}`)
    await this.ensureSession(mode, m, create)
    const proc = Bun.spawn(["tmux", `-L${this.socket}`, "-C", "attach", "-t", this.session(mode)], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    })
    try {
      const [cols, rows] = await this.paneSize(mode)
      const screen = new Screen(cols, rows)
      await screen.setFrom(await this.capture(mode))
      const repl: Repl = { key: mode, screen, proc, done: false, lastUpdate: Date.now() }
      this.repls.set(mode, repl)
      void this.startReader(repl)
      return repl
    } catch (e) { killProc(proc); throw e }
  }

  private async reconcile(repl: Repl) {
    if (repl.done) return
    try { await repl.screen.setFrom(await this.capture(repl.key)); repl.lastUpdate = Date.now() } catch (e) { void e }
  }

  private isContinuation(rendered: string, m: Mode): boolean {
    if (!m.continuation) return false
    const lines = rendered.split("\n")
    const last = lastNonEmptyIdx(lines)
    return last >= 0 && m.continuation.test(lines[last])
  }

  /** Kill the tmux session and drop the in-memory model. */
  async kill(mode: string): Promise<string> {
    const r = this.repls.get(mode)
    if (r) { killProc(r.proc); this.repls.delete(mode) }
    this.writeChains.delete(mode)
    if (await this.has(mode)) await this.tmux(["kill-session", "-t", this.session(mode)])
    return `killed ${this.session(mode)} on -L${this.socket}`
  }

  /** Clear tmux scrollback and reset the model. REPL memory persists. */
  async clear(mode: string): Promise<string> {
    const s = this.session(mode)
    if (!(await this.has(mode))) return `no session ${s} on -L${this.socket} to clear`
    await this.tmux(["clear-history", "-t", s])
    const r = this.repls.get(mode)
    if (r) { await r.screen.reset(); r.lastUpdate = Date.now() }
    return `cleared ${s} on -L${this.socket} (scrollback + model)`
  }

  /** Read the model. resync=false (default): streamed model. resync=true:
   *  force a capture-pane reconcile first. */
  async read(mode: string, lines: number, resync = false): Promise<string> {
    let repl: Repl
    try { repl = await this.get(mode, false) } catch (e) { void e; return `no session ${this.session(mode)} on -L${this.socket}` }
    if (resync) await this.reconcile(repl)
    const m = this.modes[mode]
    const all = repl.screen.render()
      .split("\n")
      .filter((line) => line.trim().length > 0 && !(m.continuation?.test(line) ?? false))
    return all.slice(-lines).join("\n")
  }

  private async waitForReady(repl: Repl, q: { form: string; mode: Mode }, signal: AbortSignal): Promise<string | null> {
    const deadline = Date.now() + q.mode.readyTimeoutMs
    let sentFinishEnter = false
    while (Date.now() < deadline && !signal.aborted) {
      if (repl.done) return null
      const { ready, result } = findReady(repl.screen.render(), q.form, q.mode)
      if (ready) return result
      const cont = await this.checkContinuation(repl, q.mode, sentFinishEnter)
      if (cont === true) { sentFinishEnter = true; continue }
      if (cont) return cont
      await sleep(POLL_MS)
    }
    return null
  }

  /** Returns true if Enter was sent (continue polling), a string for the ⏳ message, or null. */
  private async checkContinuation(repl: Repl, m: Mode, sentFinishEnter: boolean): Promise<boolean | string | null> {
    if (!this.isStalledContinuation(repl, m)) return null
    if (!sentFinishEnter) { await this.tmux(["send-keys", "-t", this.session(repl.key), "Enter"]); return true }
    return `⏳ ${repl.key} is waiting for more input (continuation prompt) — the form looks incomplete. Send the rest or interrupt (session action=kill). Model tail:\n${tail(repl.screen.render(), TAIL_LINES)}`
  }

  private isStalledContinuation(repl: Repl, m: Mode): boolean {
    return Date.now() - repl.lastUpdate > STALL_MS && this.isContinuation(repl.screen.render(), m)
  }

  private async handleAbort(mode: string, repl: Repl): Promise<string> {
    let ok = false
    try { await this.tmux(["send-keys", "-t", this.session(mode), "C-c"]); ok = true } catch (e) { void e }
    await sleep(ABORT_SETTLE_MS)
    return `⏹ aborted — interrupted the form${ok ? "" : " (C-c failed)"}; model tail:\n${tail(repl.screen.render(), TAIL_LINES)}`
  }

  /** Send a form and wait for readiness. Serialized per-mode (concurrent sends
   *  queue). Returns the transcript, or a continuation/abort/timeout message. */
  async send(mode: string, form: string, signal: AbortSignal): Promise<string> {
    const m = this.modes[mode]
    if (!m) throw new Error(`unknown mode "${mode}"; available: ${this.availableModes().join(", ")}`)
    return this.withWriteLock(mode, async () => {
      const repl = await this.get(mode)
      await this.sendLine(mode, form)
      const result = await this.waitForReady(repl, { form, mode: m }, signal)
      if (result !== null) return result
      if (signal.aborted) return this.handleAbort(mode, repl)
      return `⏱ timed out waiting for readiness; model tail:\n${tail(repl.screen.render(), TAIL_LINES)}`
    })
  }

  private withWriteLock<T>(mode: string, fn: () => Promise<T>): Promise<T> {
    const chain = this.writeChains.get(mode) ?? Promise.resolve()
    const run = chain.then(fn)
    this.writeChains.set(mode, run.then(() => undefined, () => undefined))
    return run
  }
}
