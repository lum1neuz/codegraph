# codegraph

A Claude Code skill for TypeScript repos. It gives coding agents compiler-accurate
**who-calls**, the **blast radius** of a diff (impacted symbols, money-path hits, tests to run,
audit scope), and a **post-edit hook** that flags edits to risk-critical files. It drives the
TypeScript language service already in your `node_modules`: no dependencies, no LLM, no network.

## Install the skill

```bash
git clone https://github.com/lum1neuz/codegraph ~/.claude/skills/codegraph
```

Update later with `git -C ~/.claude/skills/codegraph pull`.

## Add it to a project

In a Claude Code session inside the repo, ask: "install codegraph". The agent follows
[SKILL.md](SKILL.md): it copies `scripts/` to `tools/codegraph/`, writes `config.json` and
`moneyPaths.json` (examples in `templates/`), gitignores the cache, registers the hook and adds
an anchor line to CLAUDE.md.

## Use

```bash
node tools/codegraph/callers.mjs <symbol | file.ts:symbol> -d 2
node tools/codegraph/blast.mjs --base origin/main --md
```

Full flags, config format and limits: [scripts/README.md](scripts/README.md).
