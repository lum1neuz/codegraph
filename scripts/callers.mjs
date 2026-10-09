#!/usr/bin/env node
// who calls X:  node tools/codegraph/callers.mjs <symbol | path/to/file.ts:symbol> [--project <name from config.json>] [-d N] [--out callees] [--json] [--types] [--max N]
import {
  PROJECTS, createService, findCallers, findCallees, walkCallers, resolveSymbol, projectOf,
} from './lib.mjs';

function parseArgs(argv) {
  const o = { depth: 1, max: 100 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') o.project = argv[++i];
    else if (a === '-d' || a === '--depth') o.depth = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--max') o.max = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--types') o.types = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.query = rest[0];
  return o;
}

const usage = 'usage: node tools/codegraph/callers.mjs <symbol | path/to/file.ts:symbol> [--project <name from config.json>] [-d N] [--out callees] [--json] [--types] [--max N]';

/** Split `path/file.ts:symbol` (drive-letter colons stay in the path). */
function splitQuery(q) {
  const i = q.lastIndexOf(':');
  if (i > 0 && /\.(ts|tsx|mts|cts)$/.test(q.slice(0, i))) return { file: q.slice(0, i), symbol: q.slice(i + 1) };
  return { file: null, symbol: q };
}

const flags = (c) => [c.test && '[test]', c.money && '[money]'].filter(Boolean).join(' ');

function lineRef(c) {
  const extra = c.lines && c.lines.length > 1 ? `  (+${c.lines.length - 1} more refs)` : '';
  return `${c.file}:${c.line}  ${c.symbol}${extra}`;
}

function printTree(nodes, indent, max) {
  nodes.slice(0, max).forEach((n) => {
    const seen = n.seen ? '  (seen)' : '';
    console.log(`${'  '.repeat(indent)}${lineRef(n)}  ${flags(n)}${seen}`.trimEnd());
    printTree(n.children, indent + 1, max);
  });
  if (nodes.length > max) console.log(`${'  '.repeat(indent)}... +${nodes.length - max} more`);
}

const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children)]);
const plain = (n) => ({
  file: n.file, line: n.line, lines: n.lines, symbol: n.symbol, test: n.test, money: n.money,
  seen: n.seen, children: n.children?.map(plain),
});

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.query) { console.log(usage); process.exit(o.help ? 0 : 1); }
  if (!(o.depth >= 1 && o.depth <= 5)) { console.error('-d must be 1..5'); process.exit(1); }
  const t0 = Date.now();
  const { file, symbol } = splitQuery(o.query);
  const guess = o.project ?? (file ? projectOf(file) : null);
  const order = guess ? [guess] : Object.keys(PROJECTS);

  let ctx; let cands = [];
  for (const p of order) {
    ctx = createService(p);
    cands = resolveSymbol(ctx, symbol, file);
    if (cands.length) break;
  }
  if (!cands.length) {
    console.error(`no declaration named "${symbol}" in project source (${order.join('/')})`);
    process.exit(1);
  }
  if (cands.length > 1) {
    console.error(`ambiguous: ${cands.length} declarations match "${symbol}". Re-run with path/to/file.ts:${symbol}`);
    for (const d of cands) console.error(`  ${d.file}:${d.line}  ${d.name}  (${d.kind})`);
    process.exit(2);
  }
  const decl = cands[0];
  const where = `${decl.file}:${decl.line}`;

  if (o.out === 'callees') {
    const callees = findCallees(ctx, decl);
    if (o.json) return console.log(JSON.stringify({ symbol: decl.name, decl: where, callees: callees.map(({ decl: _d, ...c }) => c) }, null, 2));
    console.log(`${decl.name} (${where}, ${decl.kind}) calls/references ${callees.length} declarations, ${callees.filter((c) => c.money).length} money, ${Date.now() - t0}ms`);
    for (const c of callees) console.log(`${c.file}:${c.line}  ${c.symbol}  ${flags(c)}`.trimEnd());
    return;
  }

  const tree = o.depth === 1
    ? findCallers(ctx, decl, { includeTypes: o.types }).map((c) => ({ ...c, depth: 1, seen: false, children: [] }))
    : walkCallers(ctx, decl, o.depth, { includeTypes: o.types });
  const all = flatten(tree);
  if (o.json) {
    return console.log(JSON.stringify({ symbol: decl.name, decl: where, depth: o.depth, ms: Date.now() - t0, callers: tree.map(plain) }, null, 2));
  }
  const tests = all.filter((c) => c.test).length;
  const money = all.filter((c) => c.money).length;
  console.log(`${decl.name} (${where}, ${decl.kind}) -- ${all.length} referencing declarations to depth ${o.depth} (${tests} test, ${money} money), ${Date.now() - t0}ms`);
  printTree(tree, 0, o.max);
}

main().catch((e) => { console.error(e.stack ?? String(e)); process.exit(1); });
