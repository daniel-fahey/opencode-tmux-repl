import { Terminal } from "@xterm/headless"

const SCROLLBACK = 4000

/** Terminal emulator backed by @xterm/headless. Replays tmux %output bytes
 *  onto an xterm.js grid so the model tracks the rendered pane. */
export class Screen {
  private term: Terminal
  // All mutations of the underlying Terminal (apply/setFrom/reset) are
  // serialized through this chain. xterm's write() is async (callback-based)
  // AND reset() does NOT clear the pending write buffer — so an apply() awaiting
  // its callback and a concurrent setFrom(reset+write) would interleave on the
  // shared Terminal and silently corrupt the model. The chain prevents that.
  private chain: Promise<unknown> = Promise.resolve()

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => {})
    return result
  }

  /** Feed raw %output bytes. xterm decodes UTF-8 itself — pass the deescaped
   *  payload as bytes, not a pre-decoded string (multi-byte sequences would split). */
  apply(bytes: Uint8Array): Promise<void> {
    return this.serialize(() => new Promise<void>((resolve) => this.term.write(bytes, resolve)))
  }

  /** Render logical lines (scrollback + visible grid, wrapped rows joined). */
  render(): string {
    const buf = this.term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    return out.join("\n")
  }

  /** Seed the model from capture-pane output. Normalizes \n→\r\n (xterm treats
   *  bare \n as column-preserving LF) AND strips trailing newlines so xterm's
   *  cursor lands at the end of the last content line — subsequent %output
   *  (the form echo) then appends to that line, not a blank line below it. */
  setFrom(text: string): Promise<void> {
    return this.serialize(async () => {
      this.term.reset()
      await new Promise<void>((resolve) => this.term.write(text.replace(/\r?\n/g, "\r\n").replace(/\r\n+$/, ""), resolve))
    })
  }

  /** Wipe the model. The REPL's own state (definitions, variables) persists. */
  reset(): Promise<void> {
    return this.serialize(() => {
      this.term.reset()
      return Promise.resolve()
    })
  }

  /** Track a pane resize. cols/rows should match the real pane for faithful replay. */
  resize(cols: number, rows: number): Promise<void> {
    return this.serialize(() => {
      try { this.term.resize(cols, rows) } catch (e) { void e }
      return Promise.resolve()
    })
  }
}
