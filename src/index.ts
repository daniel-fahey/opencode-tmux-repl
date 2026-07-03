import { tool, type Plugin } from "@opencode-ai/plugin"
import { resolveModes, type ModeConfig } from "./modes.js"
import { ReplManager } from "./tmux.js"

type ToolCtx = { manager: ReplManager; modeNames: string[]; socket: string; prefix: string }

function replDescription(c: ToolCtx): string {
  const a = (m: string) => `tmux -L${c.socket} attach -t ${c.prefix}-${m}`
  return `Drive a shared, persistent tmux REPL (socket -L${c.socket}, session ${c.prefix}-<mode>) that the operator can attach to and type alongside: \`${a("<mode>")}\`. \`mode\` selects the REPL: ${c.modeNames.join(", ")}.

WRITE: pass \`form\` to evaluate it. The form is sent visibly in the pane; a clean transcript (the form + its result) is returned, reconstructed from tmux's %output stream by a virtual terminal. On error, a REPL that drops into a debugger (guile) shows its debugger prompt — the tool returns there; send \`,q\` as a normal form to exit it. Other REPLs print a traceback and return to the prompt.

READ: omit \`form\` to get the incrementally-streamed model (the Screen holds the latest %output — no re-capture by default). Pass \`lines\` to limit the trailing lines, or \`resync\` to force a full capture-pane resync if you suspect drift.

Gotchas:
- Concurrent WRITE calls to the SAME mode queue safely (serialized); one-at-a-time returns each form's output cleanly. Concurrent writes to DIFFERENT modes run in parallel.
- Multi-line forms work (readiness anchors on the first line; the full result returns once the top-level prompt comes back).
- Async output (promises resolving, on-callbacks) may arrive AFTER the ready prompt — the tool may report "timed out" cosmetically; the form completed. Verify with a READ.
- If a form wedges (e.g. a deadlock), recover with \`session\` action=kill + a fresh call (recreates the session). \`session\` action=clear wipes screen + scrollback + model but does NOT reset the REPL's own memory (definitions persist).`
}

function makeReplTool(c: ToolCtx) {
  const attach = (mode: string) => `tmux -L${c.socket} attach -t ${c.prefix}-${mode}`
  return tool({
    description: replDescription(c),
    args: {
      mode: tool.schema.enum(c.modeNames).describe(`Which REPL to drive: ${c.modeNames.join(", ")}.`),
      form: tool.schema.string().optional().describe("Form to evaluate (write channel). Omit to read the model."),
      lines: tool.schema.number().int().positive().optional().describe("Read channel only: trailing lines to return. Omit for ~50."),
      resync: tool.schema.boolean().optional().describe("Read channel only: force a full capture-pane resync (default: streamed model)."),
    },
    async execute(args, ctx) {
      if (args.form === undefined) {
        const n = args.lines ?? 50
        ctx.metadata({ title: `repl ${args.mode} read (${n}) — attach: ${attach(args.mode)}` })
        return c.manager.read(args.mode, n, args.resync ?? false)
      }
      ctx.metadata({ title: `repl ${args.mode}: ${args.form.slice(0, 60)} — attach: ${attach(args.mode)}` })
      return c.manager.send(args.mode, args.form, ctx.abort)
    },
  })
}

function makeSessionTool(c: ToolCtx) {
  const attach = (mode: string) => `tmux -L${c.socket} attach -t ${c.prefix}-${mode}`
  return tool({
    description:
      `Lifecycle for a mode's shared REPL tmux session (socket -L${c.socket}, session ${c.prefix}-<mode>). \`create\` starts the REPL if absent (detached, model seeded from capture-pane, control-mode reader streams %output); \`kill\` tears it down (also drops the in-memory model); \`clear\` wipes screen + scrollback and resets the model (the REPL's own memory is NOT reset). Attach to watch/collaborate: \`${attach("<mode>")}\`.`,
    args: {
      mode: tool.schema.enum(c.modeNames).describe(`Which REPL's session: ${c.modeNames.join(", ")}.`),
      action: tool.schema.enum(["create", "kill", "clear"]).describe("create (start if absent) / kill / clear"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `session ${args.mode} ${args.action} — attach: ${attach(args.mode)}` })
      if (args.action === "kill") return c.manager.kill(args.mode)
      if (args.action === "clear") return c.manager.clear(args.mode)
      await c.manager.get(args.mode)
      return `session ${c.prefix}-${args.mode} up on -L${c.socket}. Attach: ${attach(args.mode)}`
    },
  })
}

export default (async (_input, options) => {
  const opts = (options ?? {}) as { modes?: Record<string, Partial<ModeConfig>>; socket?: string; sessionPrefix?: string }
  const socket = opts.socket ?? "opencode"
  const prefix = opts.sessionPrefix ?? "repl"
  const manager = new ReplManager(socket, resolveModes(opts.modes), prefix)
  const c: ToolCtx = { manager, modeNames: manager.availableModes(), socket, prefix }
  return { tool: { repl: makeReplTool(c), session: makeSessionTool(c) } }
}) satisfies Plugin
