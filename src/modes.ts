/** User-facing mode configuration (regexes as strings for JSON serialisability). */
export type ModeConfig = {
  /** passed RAW — no shell quoting. */
  command: string[]
  prompt: string
  ready: string
  continuation?: string
  /** Per-form; default 30_000 ms. */
  readyTimeoutMs?: number
  /** Wait for the first ready prompt after a detached create, ms. ipython
   *  cold-boots slowly (~10s under nix); default 10_000, raise for slow REPLs. */
  bootTimeoutMs?: number
}

/** Compiled mode (regexes compiled from ModeConfig strings). */
export type Mode = {
  command: string[]
  prompt: RegExp
  ready: RegExp
  continuation?: RegExp
  readyTimeoutMs: number
  bootTimeoutMs: number
}

const DEFAULTS = { readyTimeoutMs: 30_000, bootTimeoutMs: 10_000 } as const

// `ready` matches the prompt at END of the last line (un-anchored from ^) so it
// also catches a prompt that follows no-newline output — e.g. guile `(display ...)`
// with no \n leaves the prompt mid-line. findReady's form-anchor (walk back to the
// echoed form) still disambiguates stale prompts, so dropping ^ is safe.
const BUILTINS: Record<string, ModeConfig> = {
  guile: {
    command: ["guile", "--no-auto-compile"],
    prompt: String.raw`scheme@\([\w-]+\)(?: \[\d+\])?> `,
    ready: String.raw`scheme@\([\w-]+\)(?: \[\d+\])?> ?$`,
    continuation: String.raw`^\.\.\. *`,
  },
  python: {
    command: ["python3", "-i"],
    prompt: String.raw`>>> `,
    ready: String.raw`>>> ?$`,
    continuation: String.raw`^\.\.\. ?`,
  },
  ipython: {
    command: ["ipython", "--no-confirm-exit", "--no-banner"],
    prompt: String.raw`In \[\d+\]: `,
    ready: String.raw`In \[\d+\]: ?$`,
    continuation: String.raw`^\s*\.\.\.: ?`,
    bootTimeoutMs: 20_000,
  },
  nix: {
    command: ["nix", "repl"],
    prompt: String.raw`nix-repl> `,
    ready: String.raw`nix-repl> ?$`,
  },
  bash: {
    command: ["bash", "--noprofile", "--norc"],
    prompt: String.raw`bash-\d+\.\d+\$ `,
    ready: String.raw`bash-\d+\.\d+\$ ?$`,
    continuation: String.raw`^> ?`,
  },
}

function compileMode(name: string, cfg: Partial<ModeConfig>): Mode {
  const build = (src: string, label: string): RegExp => {
    try {
      return new RegExp(src)
    } catch (e) {
      throw new Error(`mode "${name}": invalid ${label} regex /${src}/: ${(e as Error).message}`)
    }
  }
  const requireRegex = (src: string | undefined, label: string): RegExp => {
    if (!src) throw new Error(`mode "${name}": missing required field "${label}"`)
    return build(src, label)
  }
  const command = cfg.command
  if (!command || command.length === 0) {
    throw new Error(`mode "${name}": missing required field "command"`)
  }
  return {
    command,
    prompt: requireRegex(cfg.prompt, "prompt"),
    ready: requireRegex(cfg.ready, "ready"),
    continuation: cfg.continuation ? build(cfg.continuation, "continuation") : undefined,
    readyTimeoutMs: cfg.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
    bootTimeoutMs: cfg.bootTimeoutMs ?? DEFAULTS.bootTimeoutMs,
  }
}

/** Merge built-in modes with user overrides (field-by-field) and compile to
 *  regexes.
 *  @throws on invalid regex or missing required fields. */
export function resolveModes(user?: Record<string, Partial<ModeConfig>>): Record<string, Mode> {
  const merged: Record<string, Partial<ModeConfig>> = { ...BUILTINS }
  if (user) {
    for (const [name, partial] of Object.entries(user)) {
      merged[name] = { ...(merged[name] ?? {}), ...partial }
    }
  }
  const out: Record<string, Mode> = {}
  for (const [name, cfg] of Object.entries(merged)) {
    out[name] = compileMode(name, cfg)
  }
  return out
}
