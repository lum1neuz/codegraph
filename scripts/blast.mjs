#!/usr/bin/env node
// what can this diff reach:  node tools/codegraph/blast.mjs [--base origin/main] [-d 2] [--json | --md] [--staged]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  ROOT, abs, projectOf, isTest, isMoney, createService, enclosingDecl, findCallers, declKey, loadTs, SCHEMA_FILES,
} from './lib.mjs';

const FAN_OUT_CAP = 40;

function parseArgs(argv) {
  const o = { base: 'origin/main', depth: 2, fmt: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '-d' || a === '--depth') o.depth = Number(argv[++i]);
    else if (a === '--json') o.fmt = 'json';
    else if (a === '--md') o.fmt = 'md';
    else if (a === '--staged') o.staged = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown arg ${a}`); process.exit(1); }
  }
  return o;
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Parse `git diff -U0` into { file -> [[startLine, endLine], ...] } (new side). */
function parseDiff(text) {
  const ranges = new Map();
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !ranges.has(file)) ranges.set(file, []);
    } else if (file && line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      // pure deletion: anchor on the line the deletion sits after
      ranges.get(file).push(count === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + count - 1]);
    }
  }
  return ranges;
}

function collectChanges(o) {
  let mb;
  try { mb = git(['merge-base', o.base, 'HEAD']).trim(); } catch {
    console.error(`cannot resolve merge-base for base "${o.base}" (try --base <rev>)`);
    process.exit(1);
  }
  const diffArgs = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', ...(o.staged ? ['--cached'] : []), mb, '--', '*.ts', '*.tsx', ...SCHEMA_FILES];
  const ranges = parseDiff(git(diffArgs));
  if (!o.staged) {
    for (const f of git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
      if (!/\.(ts|tsx)$/.test(f) || !projectOf(f)) continue;
      const lines = fs.readFileSync(abs(f), 'utf8').split('\n').length;
      ranges.set(f, [[1, lines]]);
    }
  }
  for (const f of [...ranges.keys()]) {
    const isSrc = /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts') && projectOf(f);
    if ((!isSrc && !SCHEMA_FILES.includes(f)) || !fs.existsSync(abs(f))) ranges.delete(f);
  }
  return { mb, ranges };
}

/** Map changed line ranges to enclosing declarations (one probe per non-blank line). */
function changedSymbols(ctx, file, fileRanges) {
  const { ts } = ctx;
  const sf = ctx.sourceFile(file);
  if (!sf) return [];
  const lines = sf.text.split('\n');
  const starts = sf.getLineStarts();
  const out = new Map();
  for (const [a, b] of fileRanges) {
    for (let ln = a; ln <= Math.min(b, lines.length); ln++) {
      const text = lines[ln - 1];
      if (!text || !text.trim()) continue;
      const pos = starts[ln - 1] + (text.length - text.trimStart().length);
      const d = enclosingDecl(ts, sf, pos);
      const key = d ? declKey(d) : `${file}#<module>`;
      if (!out.has(key)) out.set(key, d ?? { name: '<module>', file, line: ln, kind: 'module', decl: null });
    }
  }
  return [...out.values()];
}

function run(o) {
  const t0 = Date.now();
  const { mb, ranges } = collectChanges(o);
  const byProject = {};
  for (const f of ranges.keys()) if (!SCHEMA_FILES.includes(f)) (byProject[projectOf(f)] ??= []).push(f);
  const schemaChanged = SCHEMA_FILES.filter((f) => ranges.has(f));

  const changed = [];
  const ctxs = {};
  for (const p of Object.keys(byProject)) {
    if (!byProject[p].length) continue;
    const ctx = createService(p); // only the project(s) with changes
    ctx.addRoots(byProject[p]);
    ctxs[p] = ctx;
    for (const f of byProject[p]) {
      for (const d of changedSymbols(ctx, f, ranges.get(f))) {
        changed.push({ project: p, file: d.file, name: d.name, line: d.line, kind: d.kind, test: isTest(d.file), money: isMoney(d.file), decl: d.kind === 'module' ? null : d });
      }
    }
  }

  // BFS over callers: depth 1 = direct references.
  const seen = new Set(changed.map((c) => `${c.file}#${c.name}`));
  const impacted = [];
  const tests = new Map(); // file -> Set(via symbol)
  const hubs = [];
  for (const c of changed) {
    if (c.test && /\.(test|spec)\./.test(c.file)) tests.set(c.file, tests.get(c.file) ?? new Set());
  }
  let frontier = changed.filter((c) => c.decl);
  for (let depth = 1; depth <= o.depth && frontier.length; depth++) {
    const next = [];
    for (const c of frontier) {
      const callers = findCallers(ctxs[c.project], c.decl);
      if (callers.length > FAN_OUT_CAP) hubs.push({ file: c.file, name: c.name, count: callers.length, files: new Set(callers.map((x) => x.file)).size, depth });
      const isHub = callers.length > FAN_OUT_CAP;
      for (const r of callers) {
        if (r.test) {
          if (!tests.has(r.file)) tests.set(r.file, new Set());
          tests.get(r.file).add(`${c.name}`);
          continue;
        }
        // hubs are summarised as a count; only their money-path hits stay listed individually
        if (isHub && !r.money) continue;
        const key = `${r.file}#${r.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rec = { project: c.project, file: r.file, name: r.symbol, line: r.line, depth, via: c.name, money: r.money, test: false };
        impacted.push(rec);
        // hubs (>cap referencers) are listed but not expanded further: fan-out would drown the signal
        if (r.decl && callers.length <= FAN_OUT_CAP) next.push({ ...rec, decl: r.decl });
      }
    }
    frontier = next;
  }

  const moneyFiles = new Set([
    ...changed.filter((c) => c.money).map((c) => c.file),
    ...impacted.filter((i) => i.money).map((i) => i.file),
    ...schemaChanged,
  ]);
  const scope = new Set([...changed.map((c) => c.file), ...impacted.map((i) => i.file), ...schemaChanged]);
  const auditScope = [...scope].sort((a, b) => Number(isMoney(b)) - Number(isMoney(a)) || a.localeCompare(b));

  const strip = ({ decl, ...rest }) => rest;
  return {
    base: o.base, mergeBase: mb, depth: o.depth, staged: !!o.staged,
    changed: changed.map(strip),
    schemaChanged,
    impacted,
    hubs,
    moneyFiles: [...moneyFiles].sort(),
    tests: [...tests.entries()].map(([file, via]) => ({ file, via: [...via] })).sort((a, b) => a.file.localeCompare(b.file)),
    auditScope,
    elapsedMs: Date.now() - t0,
  };
}

// ---------- rendering ----------

const tag = (x) => [x.test && '[test]', x.money && '[money]'].filter(Boolean).join(' ');

function render(r, md) {
  const H = (t) => (md ? `\n## ${t}\n` : `\n=== ${t} ===`);
  const li = (s) => (md ? `- ${s}` : `  ${s}`);
  const code = (s) => (md ? `\`${s}\`` : s);
  const out = [];
  out.push(md
    ? `# Blast radius\nbase \`${r.base}\` (merge-base \`${r.mergeBase.slice(0, 10)}\`), vs ${r.staged ? 'index' : 'working tree'}, depth ${r.depth}, ${r.elapsedMs}ms`
    : `blast: base ${r.base} (merge-base ${r.mergeBase.slice(0, 10)}) vs ${r.staged ? 'index' : 'working tree'}, depth ${r.depth}, ${r.elapsedMs}ms`);

  out.push(H(`1. Changed symbols (${r.changed.length}${r.schemaChanged.length ? ` + ${r.schemaChanged.length} schema file(s)` : ''})`));
  for (const f of r.schemaChanged) out.push(li(`${code(f)}  ${md ? '**[MONEY-PATH]**' : '[MONEY-PATH]'} (schema change, no symbol analysis)`));
  for (const c of r.changed) out.push(li(`${code(`${c.file}:${c.line}`)}  ${c.name}  ${tag(c)}`.trimEnd()));

  out.push(H(`2. Impacted symbols (${r.impacted.length})`));
  for (let d = 1; d <= r.depth; d++) {
    const at = r.impacted.filter((i) => i.depth === d);
    if (!at.length) continue;
    out.push(md ? `\n**depth ${d}** (${at.length})` : `-- depth ${d} (${at.length})`);
    for (const i of at.slice(0, FAN_OUT_CAP)) out.push(li(`${code(`${i.file}:${i.line}`)}  ${i.name}  <- ${i.via}  ${tag(i)}`.trimEnd()));
    if (at.length > FAN_OUT_CAP) out.push(li(`... +${at.length - FAN_OUT_CAP} more (use --json)`));
  }
  for (const h of r.hubs) out.push(li(`high fan-out: ${h.name} (${h.file}) has ${h.count} referencing declarations in ${h.files} files at depth ${h.depth}; summarised (money-path hits listed above), not expanded further`));

  out.push(H('3. Money-path hits'));
  if (!r.moneyFiles.length) out.push(li('none'));
  for (const f of r.moneyFiles) {
    const kind = r.changed.some((c) => c.file === f) || r.schemaChanged.includes(f) ? 'CHANGED' : 'impacted';
    out.push(li(md ? `**MONEY-PATH ${kind}**  ${code(f)}` : `!!! MONEY-PATH ${kind}  ${f}`));
  }

  out.push(H(`4. Tests to run (${r.tests.length})`));
  if (!r.tests.length) out.push(li('none found'));
  for (const t of r.tests) out.push(li(`${code(t.file)}${t.via.length ? `  (refs: ${t.via.slice(0, 4).join(', ')}${t.via.length > 4 ? ', ...' : ''})` : ''}`));

  out.push(H(`5. Audit scope (${r.auditScope.length} files, money-path first)`));
  for (const f of r.auditScope) out.push(li(`${isMoney(f) ? '[money] ' : ''}${code(f)}`));
  return out.join('\n');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log('usage: node tools/codegraph/blast.mjs [--base origin/main] [-d 2] [--json | --md] [--staged]');
  if (!(o.depth >= 1 && o.depth <= 5)) { console.error('-d must be 1..5'); process.exit(1); }
  loadTs();
  const r = run(o);
  console.log(o.fmt === 'json' ? JSON.stringify(r, null, 2) : render(r, o.fmt === 'md'));
}

try { main(); } catch (e) { console.error(e.stack ?? String(e)); process.exit(1); }
