# opencode-tmux-repl

Persistent tmux REPL tools for [OpenCode](https://opencode.ai).
A test drive of GLM-5.2's coding capability through OpenCode
that grew into a publishable plugin.

Drive any prompt-shaped REPL (guile, python, ipython, nix, bash, R, or your own)
in a tmux session you can attach to and type alongside.
The design uses [@xterm/headless](https://github.com/xtermjs/xterm.js) as the
terminal emulator (replaying tmux's `%output` byte stream),
verified by [fast-check](https://fast-check.dev/) property-based tests,
integration tests in a Nix sandbox,
and static-analysis gates (complexity, dead-code, duplication, circular-dependency).

## Install

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["github:daniel-fahey/opencode-tmux-repl", {}]]
}
```

OpenCode loads `.ts` directly (Bun). Requires `tmux` and the REPL binary.

## Modes

Each mode has a `command`, a `ready` regex (prompt at end of last line),
a `prompt` regex, and optionally a `continuation` regex.
Configure via `[plugin, { modes: { ... } }]` — field-by-field merge over built-ins.

| mode    | command                                           | ready                                | notes                                             |
| ------- | ------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| guile   | `["guile", "--no-auto-compile"]`                  | `scheme@\([\w-]+\)(?: \[\d+\])>? ?$` | debugger `[N]>` counts as ready; agent sends `,q` |
| python  | `["python3", "-i"]`                               | `>>> ?$`                             | continuation: `... `                              |
| ipython | `["ipython", "--no-confirm-exit", "--no-banner"]` | `In \[\d+\]: ?$`                     | ~20s boot; continuation: `...: `                  |
| nix     | `["nix", "repl"]`                                 | `nix-repl> ?$`                       |                                                   |
| bash    | `["bash", "--noprofile", "--norc"]`               | `bash-\d+\.\d+\$ ?$`                 | continuation: `> `; version-coupled prompt      |
| r       | `["R", "--no-save", "--no-restore", "--quiet"]`   | `> ?$`                               | continuation: `+ `; `--no-save` avoids exit prompt |

## Attach

```
tmux -Lopencode attach -t repl-guile
```

Add `-r` for read-only.

## License

MIT
