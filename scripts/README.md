# codegraph

Agent tooling: who-calls, diff blast radius, and a post-edit warning for risk-path files.
Plain Node ESM (>= 18), no build step, no dependencies of its own: it drives the TypeScript
language service already installed in a project's `node_modules`. Run from the repo root.
It complements the CLAUDE.md anchors; it does not replace them. Anchors say where to look,
these say what a change actually touches.

Installed from the `codegraph` skill (`~/.claude/skills/codegraph/`). That copy is canonical;
fix bugs there and re-copy.

## Config

`config.json`: which TS projects exist and where.

    { "projects": { "<name>": { "dir": "<repo-relative dir or .>", "extraRoots": ["tests"] } },
      "schemaFiles": ["prisma/schema.prisma"] }

- `dir` must hold a `tsconfig.json`. `"."` = repo root (single-project repo). Nested dirs:
  the longest match wins.
- `extraRoots`: dirs the tsconfig excludes whose references still matter (usually tests).
- `schemaFiles`: non-TS files reported as changed risk-path files by blast (no analysis).

`moneyPaths.json`: array of repo-relative globs (`**` crosses dirs, `*` stays in one segment)
for risk-critical code (money, auth, ledger, settlement). Edits there trigger the hook and are
flagged `[money]` everywhere.

## Tools

**`callers.mjs`: who calls X**

    node tools/codegraph/callers.mjs <symbol | path/to/file.ts:symbol> [--project <name>] [-d N] [--out callees] [--json] [--types] [--max N]

- `Class.method` and `obj.method` (object literal on a top-level const) work. Ambiguous name: lists candidates, exit 2.
- `-d N` (1..5) walks callers transitively as an indented tree. `--out callees` lists what the symbol references.
- Hits read `file:line  enclosingSymbol  [test] [money]`. Type-only positions are dropped unless `--types` (or the target is itself a type).
- Without `--project` it tries each config project in order.

**`blast.mjs`: what can this diff reach**

    node tools/codegraph/blast.mjs [--base origin/main] [-d 2] [--json | --md] [--staged]

Diffs the merge-base of `--base` and HEAD against the working tree (uncommitted edits and
untracked .ts/.tsx count; `--staged` diffs the index instead). Prints changed symbols, impacted
symbols by depth, money-path hits, tests to run, and an audit scope (money-path files first).
`--md` is paste-ready for an auditor brief. Symbols with more than 40 referencing declarations
are summarised as a count. `--base HEAD` = only uncommitted work.

**`postEditHook.mjs`: PostToolUse hook.** After an Edit/Write/MultiEdit of a money-path .ts/.tsx
file it injects "MONEY-PATH edit ... Imported by N files ... run blast.mjs". Import graph only,
silent on anything else, never blocks.

## Cache and speed

`tools/codegraph/.cache/imports.json` (gitignore it) holds the import graph, keyed by file
mtime, refreshed incrementally. Delete it to force a rebuild. A language service takes ~5-15s
per project to build once per run (more on a loaded machine); later queries in the same run
are ~0.1s. Hook: ~0.2-0.7s warm.

## Limits

mtime-only cache invalidation; deleted symbols in a diff are not analysed (only the new tree);
dynamic dispatch and string-keyed calls are invisible; tests are matched by symbol reference,
not import; TypeScript/TSX only.
