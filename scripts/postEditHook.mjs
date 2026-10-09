#!/usr/bin/env node
// Claude Code PostToolUse hook: after an edit to a money-path .ts/.tsx file, tell the
// agent who imports it. Import graph only (no LanguageService). Never blocks: any
// error or non-match prints nothing and exits 0.
import fs from 'node:fs';
import { rel, projectOf, isMoney, refreshImportGraph } from './lib.mjs';

const MAX_LISTED = 15;

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const raw = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (!raw) return;
  const file = rel(raw);
  if (!/\.(ts|tsx)$/.test(file) || file.endsWith('.d.ts') || !projectOf(file)) return;
  if (!isMoney(file)) return;

  const { importers } = refreshImportGraph();
  const list = [...(importers.get(file) ?? [])].sort(
    (a, b) => Number(isMoney(b)) - Number(isMoney(a)) || a.localeCompare(b),
  );
  const shown = list.slice(0, MAX_LISTED);
  const more = list.length - shown.length;
  const detail = list.length ? `: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}` : '';
  const text = `MONEY-PATH edit: ${file}. Imported by ${list.length} files${detail}. Run node tools/codegraph/blast.mjs before finishing.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
}

try { main(); } catch (e) { if (process.env.CODEGRAPH_DEBUG) console.error(e); /* never block the agent */ }
process.exit(0);
