---
name: codegraph
description: Who-calls, diff blast radius, and money-path edit warnings for TypeScript repos, driven by the TS language service (no deps, no LLM). Use when (1) setting up a new or existing TS/TSX project for agent work ("install codegraph", "add blast radius"), (2) before changing a shared or risk-critical symbol and you need its callers, (3) at the end of a build to get the audit scope and tests to run for the one end-of-build auditor, or (4) a "MONEY-PATH edit" hook note appears.
---

# codegraph

Three scripts that give an agent what grep can't: compiler-accurate callers, the blast radius
of a diff, and an automatic note after editing risk-critical code. Bundled in `scripts/`
(canonical copy; fix bugs here, then re-copy into projects).

## Using it (project already has `tools/codegraph/`)

Run from the repo root. Read `tools/codegraph/README.md` for all flags.

| Need | Command |
|---|---|
| Who calls a symbol | `node tools/codegraph/callers.mjs <name \| file.ts:name> [-d 2]` |
| What a symbol calls | `node tools/codegraph/callers.mjs <name> --out callees` |
| What this branch can reach | `node tools/codegraph/blast.mjs --base origin/main -d 2` |
| Only uncommitted work | `node tools/codegraph/blast.mjs --base HEAD -d 1` |
| Auditor brief section | `node tools/codegraph/blast.mjs --base origin/main --md > <scratch>/blast.md` |

Workflow:
- **Before editing** a shared or money-path symbol: run `callers -d 2`. Every caller that
  depends on the old behaviour is in scope for the change, not only the file you opened.
- **On a "MONEY-PATH edit" hook note**: no need to stop. Finish the change, then run blast.
- **End of build**: run `blast --md` once. Section 4 = tests to run. Section 5 = audit scope,
  money-path files first; paste it into the single end-of-build read-only auditor brief
  instead of hand-listing files. Pass the scope file path to subagents rather than pasting
  hundreds of lines.
- Runs take 5-60s (language service build). Run blast once per build, not per edit.
- It does NOT see dynamic/string-keyed calls, deleted symbols, or non-TS code. Grep still
  covers those.

## Installing into a project

Requires: git repo, Node >= 18, `typescript` in some project's `node_modules` (or the repo
root), a `tsconfig.json` per project dir.

1. Copy `scripts/*.mjs` and `scripts/README.md` to `<repo>/tools/codegraph/`. Don't edit the
   copies; project-specific bits live only in the two JSON files.
2. Write `<repo>/tools/codegraph/config.json` (see `templates/config.example.json`). One entry
   per tsconfig dir; `"dir": "."` for a single-project repo; add `"extraRoots": ["tests"]` when
   the tsconfig excludes tests; list Prisma/SQL schema files under `schemaFiles`.
3. Write `<repo>/tools/codegraph/moneyPaths.json` (see `templates/moneyPaths.example.json`).
   Ask the user, or derive from the project's CLAUDE.md, which dirs are money/auth/ledger/
   settlement/webhooks. Be specific: a glob that matches half the repo makes the hook noise.
4. Append `tools/codegraph/.cache/` to `.gitignore`.
5. Register the hook in `<repo>/.claude/settings.json` (merge with existing `hooks`; don't
   clobber). Use the absolute repo path; `$CLAUDE_PROJECT_DIR` breaks when a session starts in
   a subdir:
   ```json
   {"hooks":{"PostToolUse":[{"matcher":"Edit|Write|MultiEdit","hooks":[
     {"type":"command","command":"node \"<ABS_REPO>/tools/codegraph/postEditHook.mjs\"","timeout":10}]}]}}
   ```
   If `.claude/` is committed, use a relative path or put the hook in
   `.claude/settings.local.json` instead, so other machines don't get a dead absolute path.
6. Add one anchor line to the project's CLAUDE.md (or AGENTS.md) pointing at
   `tools/codegraph/` and saying: run blast at end of build for audit scope.
7. Verify:
   - `node tools/codegraph/callers.mjs <some exported function> -d 2` gives sensible callers.
   - `node tools/codegraph/blast.mjs --base HEAD~1 -d 1` lists that commit's symbols and tests.
   - Hook: `printf '%s' '{"tool_input":{"file_path":"<ABS path of a money-path .ts>"}}' | node tools/codegraph/postEditHook.mjs`
     prints JSON with importers; a non-money file prints nothing. (Write the JSON with forward
     slashes; Git Bash mangles `\\`.)
   - The hook only loads in a new session; check the note appears on the first money-path edit.

## Updating

This skill dir is a git clone of `github.com/lum1neuz/codegraph`; commit and push fixes there.
Bug fix or feature: change `scripts/` here first, then copy the `.mjs` files over every
project's `tools/codegraph/` (known install: `D:\Github\taamn`). Configs are never
overwritten.

## Notes

- Origin: built 2026-10-09 in taamn as an in-house alternative to Graft (trailhq/Graft). It
  keeps Graft's callers and blast radius, drops its per-prompt injection, LLM summaries and
  cloud sync.
- Windows: everything normalises paths to forward slashes. Never run `taskkill /IM node.exe`
  to stop a hung run; it kills the user's dev servers too. Kill the specific PID.
