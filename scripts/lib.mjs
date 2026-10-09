// Shared helpers for the codegraph kit: TS language service, declaration
// mapping, money-path matcher, import-graph cache. Plain ESM, no build step.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  .replaceAll('\\', '/');
export const CACHE_FILE = `${ROOT}/tools/codegraph/.cache/imports.json`;

// config.json: { projects: { name: { dir, extraRoots? } }, schemaFiles? }. dir "." = repo root.
const CONFIG = JSON.parse(fs.readFileSync(`${ROOT}/tools/codegraph/config.json`, 'utf8'));
export const PROJECTS = CONFIG.projects;
export const SCHEMA_FILES = CONFIG.schemaFiles ?? [];
const PROJECT_DIRS = Object.fromEntries(Object.entries(PROJECTS).map(([k, v]) => [k, v.dir]));
const projectRoot = (p) => (PROJECT_DIRS[p] === '.' ? ROOT : `${ROOT}/${PROJECT_DIRS[p]}`);
const projectPrefix = (p) => (PROJECT_DIRS[p] === '.' ? '' : `${PROJECT_DIRS[p]}/`);
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.open-next', 'dist', 'build', 'out', 'coverage',
  '.git', '.wrangler', 'anvil-db', 'migrations', '.cache',
]);

// ---------- paths ----------

export const toPosix = (p) => p.replaceAll('\\', '/');

/** Repo-relative forward-slash path (leaves non-repo paths posix-normalised). */
export function rel(p) {
  p = toPosix(p);
  if (p.toLowerCase().startsWith(`${ROOT.toLowerCase()}/`)) return p.slice(ROOT.length + 1);
  return p;
}

export function abs(p) {
  p = toPosix(p);
  return /^([a-zA-Z]:)?\//.test(p) ? p : `${ROOT}/${p}`;
}

/** Name of the config project containing p (longest dir prefix wins), or null. */
export function projectOf(p) {
  const r = rel(p);
  if (/^[a-zA-Z]:\//.test(r) || r.startsWith('/')) return null; // outside the repo
  let best = null;
  for (const name of Object.keys(PROJECT_DIRS)) {
    const pre = projectPrefix(name);
    if (r.startsWith(pre) && (best === null || pre.length > projectPrefix(best).length)) best = name;
  }
  return best;
}

export function isTest(p) {
  const r = rel(p);
  return /(^|\/)(tests?|__tests__|e2e)\//.test(r) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(r);
}

const isTsFile = (f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith('.d.ts');

// ---------- typescript ----------

let _ts;
export function loadTs() {
  if (_ts) return _ts;
  for (const p of [...Object.keys(PROJECT_DIRS).map(projectRoot), ROOT]) {
    try {
      _ts = createRequire(`${p}/noop.js`)('typescript');
      return _ts;
    } catch { /* try next */ }
  }
  throw new Error('typescript not found in any project node_modules (config.json projects) or the repo root');
}

/** Recursively list .ts/.tsx files (abs, posix), skipping noise dirs. */
export function walkTs(dir) {
  const out = [];
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(`${d}/${e.name}`);
      } else if (isTsFile(e.name)) out.push(`${d}/${e.name}`);
    }
  };
  visit(toPosix(dir));
  return out;
}

/** Compiler options only (no file globbing): cheap, used for module resolution. */
function readOptions(ts, project) {
  const dir = projectRoot(project);
  const cfg = ts.readConfigFile(`${dir}/tsconfig.json`, ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(cfg.config?.compilerOptions ?? {}, dir);
  options.pathsBasePath ??= dir; // `paths` without baseUrl resolves from the tsconfig dir
  return options;
}

/**
 * Build a language-service context for one project.
 * ponytail: single-shot CLI, so versions are mtimes read once; a long-lived
 * watcher would need to re-stat. Upgrade path: tsserver or a persistent daemon.
 */
export function createService(project) {
  const ts = loadTs();
  const dir = projectRoot(project);
  const parsed = ts.getParsedCommandLineOfConfigFile(`${dir}/tsconfig.json`, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(d) {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  const options = { ...parsed.options, noEmit: true };
  const roots = new Set(parsed.fileNames.map(toPosix));
  // extraRoots: dirs the tsconfig excludes but whose references matter (e.g. tests)
  for (const extra of PROJECTS[project].extraRoots ?? []) for (const f of walkTs(`${dir}/${extra}`)) roots.add(f);

  const versions = new Map();
  const version = (f) => {
    let v = versions.get(f);
    if (v === undefined) {
      try { v = String(fs.statSync(f).mtimeMs); } catch { v = '0'; }
      versions.set(f, v);
    }
    return v;
  };
  // Constant project version: tells the service nothing changes mid-run, which skips a
  // ~1.3s program re-sync on every query (fe). Bumped by addRoots.
  let projectVersion = 1;
  const host = {
    getProjectVersion: () => String(projectVersion),
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...roots],
    getScriptVersion: version,
    getScriptSnapshot(f) {
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    ts, project, dir, options, ls,
    refCache: new Map(),
    /** Add files the tsconfig excludes (e.g. changed files) before the first query. */
    addRoots(files) { for (const f of files) roots.add(abs(f)); projectVersion++; },
    get program() { return ls.getProgram(); },
    sourceFile: (f) => ls.getProgram().getSourceFile(abs(f)),
    /** Own source of this project: not node_modules, not .d.ts. */
    isProjectSource(f) {
      const r = rel(f);
      return projectOf(r) === project && !r.startsWith('node_modules/') && !r.includes('/node_modules/') && !r.endsWith('.d.ts');
    },
  };
}

// ---------- money paths ----------

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

let _money;
export function isMoney(p) {
  _money ??= JSON.parse(fs.readFileSync(`${ROOT}/tools/codegraph/moneyPaths.json`, 'utf8')).map(globToRegex);
  const r = rel(p);
  return _money.some((re) => re.test(r));
}

// ---------- declarations ----------

function nodeAt(ts, sf, pos) {
  let n = sf;
  for (;;) {
    const next = ts.forEachChild(n, (c) => (c.pos <= pos && pos < c.end ? c : undefined));
    if (!next) return n;
    n = next;
  }
}

const unwrap = (ts, e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
  return e;
};
const isFn = (ts, e) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
const isScopeNode = (ts, p) => !!p && (ts.isSourceFile(p) || ts.isModuleBlock(p));

function varIsTopLevel(ts, v) {
  return ts.isVariableDeclarationList(v.parent) && ts.isVariableStatement(v.parent.parent)
    && isScopeNode(ts, v.parent.parent.parent);
}

/** Variable declaration that owns an object-literal/class expression, if any. */
function ownerVar(ts, node) {
  let n = node.parent;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n))) n = n.parent;
  return n && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n : null;
}

function classLabel(ts, cls) {
  if (cls.name) return { name: cls.name.text, top: isScopeNode(ts, cls.parent) };
  const v = ownerVar(ts, cls);
  return v ? { name: v.name.text, top: varIsTopLevel(ts, v) } : { name: '<anonymous>', top: false };
}

const TYPE_KINDS = new Set(['interface', 'type', 'enum']);

function mk(ts, sf, node, nameNode, name, kind, local) {
  const start = nameNode.getStart(sf);
  return {
    name, kind, local,
    file: rel(sf.fileName),
    pos: start,
    line: sf.getLineAndCharacterOfPosition(start).line + 1,
    isType: TYPE_KINDS.has(kind),
    node, nameNode,
  };
}

/** Named-declaration view of a node, or null. `local` = nested inside a function. */
export function declFromNode(ts, sf, n) {
  if (ts.isFunctionDeclaration(n) && n.name) {
    return mk(ts, sf, n, n.name, n.name.text, 'function', !isScopeNode(ts, n.parent));
  }
  if (ts.isClassDeclaration(n) && n.name) {
    return mk(ts, sf, n, n.name, n.name.text, 'class', !isScopeNode(ts, n.parent));
  }
  if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) {
    const kind = ts.isInterfaceDeclaration(n) ? 'interface' : ts.isEnumDeclaration(n) ? 'enum' : 'type';
    return mk(ts, sf, n, n.name, n.name.text, kind, !isScopeNode(ts, n.parent));
  }
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
    if (!varIsTopLevel(ts, n)) return null;
    return mk(ts, sf, n, n.name, n.name.text, isFn(ts, unwrap(ts, n.initializer)) ? 'function' : 'variable', false);
  }
  const isMember = ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)
    || (ts.isPropertyDeclaration(n) && isFn(ts, unwrap(ts, n.initializer)))
    || (ts.isPropertyAssignment(n) && isFn(ts, unwrap(ts, n.initializer)));
  if (isMember && n.name) {
    const memberName = n.name.getText(sf);
    const owner = n.parent;
    if (ts.isClassLike(owner)) {
      const c = classLabel(ts, owner);
      return mk(ts, sf, n, n.name, `${c.name}.${memberName}`, 'method', !c.top);
    }
    if (ts.isObjectLiteralExpression(owner)) {
      const v = ownerVar(ts, owner);
      if (v) return mk(ts, sf, n, n.name, `${v.name.text}.${memberName}`, 'method', !varIsTopLevel(ts, v));
    }
  }
  return null;
}

/**
 * Innermost enclosing named declaration at pos. Nested (local) functions only
 * count when nothing outer is named. Returns null for top-level code (`<module>`).
 */
export function enclosingDecl(ts, sf, pos) {
  let fallback = null;
  for (let n = nodeAt(ts, sf, pos); n && !ts.isSourceFile(n); n = n.parent) {
    const d = declFromNode(ts, sf, n);
    if (!d) continue;
    if (!d.local) return d;
    fallback ??= d;
  }
  return fallback;
}

/** All non-local named declarations in a file (top-level + class/object members). */
export function collectDecls(ts, sf) {
  const out = [];
  const add = (n) => { const d = declFromNode(ts, sf, n); if (d && !d.local) out.push(d); return d; };
  const members = (container) => {
    const list = ts.isClassLike(container) ? container.members : container.properties;
    for (const m of list) add(m);
  };
  const visit = (stmts) => {
    for (const s of stmts) {
      if (ts.isVariableStatement(s)) {
        for (const v of s.declarationList.declarations) {
          add(v);
          const init = unwrap(ts, v.initializer);
          if (init && (ts.isObjectLiteralExpression(init) || ts.isClassExpression(init))) members(init);
        }
      } else if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body)) {
        visit(s.body.statements);
      } else {
        add(s);
        if (ts.isClassDeclaration(s)) members(s);
      }
    }
  };
  visit(sf.statements);
  return out;
}

/** Declarations matching `Name` or `Class.method`; optional file suffix hint. */
export function resolveSymbol(ctx, query, fileHint) {
  const { ts } = ctx;
  const base = query.split('.').pop();
  const hint = fileHint ? rel(fileHint) : null;
  const exact = [];
  const member = [];
  for (const sf of ctx.program.getSourceFiles()) {
    if (!ctx.isProjectSource(sf.fileName) || !sf.text.includes(base)) continue;
    if (hint && !rel(sf.fileName).endsWith(hint)) continue;
    for (const d of collectDecls(ts, sf)) {
      if (d.name === query) exact.push(d);
      else if (!query.includes('.') && d.name.endsWith(`.${query}`)) member.push(d);
    }
  }
  const found = exact.length ? exact : member;
  const nonTest = found.filter((d) => !isTest(d.file));
  return nonTest.length ? nonTest : found;
}

// ---------- references ----------

const ancestors = function* (n) { for (let p = n; p; p = p.parent) yield p; };

function isImportExportPos(ts, node) {
  for (const a of ancestors(node)) {
    if (ts.isImportDeclaration(a) || ts.isImportEqualsDeclaration(a) || ts.isExportDeclaration(a)) return true;
  }
  return !!node.parent && ts.isExportAssignment(node.parent);
}

function isTypePos(ts, node) {
  for (const a of ancestors(node)) {
    if (ts.isExpressionWithTypeArguments(a)) {
      // `class A extends B` is a value dependency; `implements` is type-only.
      const h = a.parent;
      if (ts.isHeritageClause(h) && h.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(h.parent)) return false;
      return true;
    }
    if (ts.isTypeNode(a)) return true;
  }
  return false;
}

export const declKey = (d) => `${d.file}#${d.name}`;

/**
 * Declarations that reference `decl`, grouped by enclosing declaration.
 * Each entry: { file, symbol, line, lines[], test, money, decl|null }.
 * Type-only positions are dropped unless the target is itself a type or opts.includeTypes.
 */
export function findCallers(ctx, decl, opts = {}) {
  const { ts } = ctx;
  const includeTypes = opts.includeTypes || decl.isType;
  const cacheKey = `${declKey(decl)}|${includeTypes}`;
  const hit = ctx.refCache.get(cacheKey);
  if (hit) return hit;

  const t = Date.now();
  const refs = ctx.ls.findReferences(abs(decl.file), decl.pos) ?? [];
  if (process.env.CODEGRAPH_DEBUG) console.error(`[refs] ${declKey(decl)} ${Date.now() - t}ms`);
  const groups = new Map();
  for (const rs of refs) {
    for (const r of rs.references) {
      if (r.isDefinition || !ctx.isProjectSource(r.fileName)) continue;
      const sf = ctx.program.getSourceFile(r.fileName);
      if (!sf) continue;
      const start = r.textSpan.start;
      const node = nodeAt(ts, sf, start);
      if (isImportExportPos(ts, node)) continue;
      if (!includeTypes && isTypePos(ts, node)) continue;
      const owner = enclosingDecl(ts, sf, start);
      if (owner && declKey(owner) === declKey(decl)) continue; // recursion
      const file = rel(sf.fileName);
      const symbol = owner ? owner.name : '<module>';
      const key = `${file}#${symbol}`;
      const line = sf.getLineAndCharacterOfPosition(start).line + 1;
      let g = groups.get(key);
      if (!g) {
        g = { file, symbol, line, lines: [], test: isTest(file), money: isMoney(file), decl: owner };
        groups.set(key, g);
      }
      if (!g.lines.includes(line)) g.lines.push(line);
      g.line = Math.min(g.line, line);
    }
  }
  const result = [...groups.values()]
    .map((g) => ({ ...g, lines: g.lines.sort((a, b) => a - b) }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  ctx.refCache.set(cacheKey, result);
  return result;
}

/** Transitive caller tree to maxDepth, with a visited set across the whole walk. */
export function walkCallers(ctx, start, maxDepth, opts = {}) {
  const visited = new Set([declKey(start)]);
  const build = (decl, depth) => {
    if (depth > maxDepth) return [];
    return findCallers(ctx, decl, opts).map((c) => {
      const node = { ...c, depth, seen: false, children: [] };
      if (c.decl && !c.test) {
        const k = declKey(c.decl);
        if (visited.has(k)) node.seen = true;
        else {
          visited.add(k);
          node.children = build(c.decl, depth + 1);
        }
      }
      return node;
    });
  };
  return build(start, 1);
}

/** What `decl` references: definitions of identifiers in its body that live in project source. */
export function findCallees(ctx, decl) {
  const { ts } = ctx;
  const sf = ctx.sourceFile(decl.file);
  const out = new Map();
  const visit = (n) => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
      const at = n.getStart(sf);
      if (!isImportExportPos(ts, n) && !isTypePos(ts, n)) {
        for (const d of ctx.ls.getDefinitionAtPosition(sf.fileName, at) ?? []) {
          if (!ctx.isProjectSource(d.fileName)) continue;
          const dsf = ctx.program.getSourceFile(d.fileName);
          const inSelf = rel(d.fileName) === decl.file && d.textSpan.start >= decl.node.pos && d.textSpan.start < decl.node.end;
          if (!dsf || inSelf) continue;
          const owner = enclosingDecl(ts, dsf, d.textSpan.start);
          const file = rel(d.fileName);
          const symbol = owner ? owner.name : '<module>';
          const key = `${file}#${symbol}`;
          const line = dsf.getLineAndCharacterOfPosition(d.textSpan.start).line + 1;
          if (!out.has(key)) out.set(key, { file, symbol, line, test: isTest(file), money: isMoney(file), decl: owner, refs: 0 });
          out.get(key).refs++;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(decl.node);
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------- import graph ----------

let _opts = {};
let _resolutionCache = {};
function resolverFor(ts, project) {
  _opts[project] ??= readOptions(ts, project);
  _resolutionCache[project] ??= ts.createModuleResolutionCache(ROOT, (s) => s, _opts[project]);
  return { options: _opts[project], cache: _resolutionCache[project] };
}

const isLocalSpec = (s) => s.startsWith('.') || s.startsWith('@/') || s.startsWith('~/');

function scanFile(ts, file) {
  const project = projectOf(file);
  const { options, cache } = resolverFor(ts, project);
  const abspath = abs(file);
  const text = fs.readFileSync(abspath, 'utf8');
  const specs = [...new Set(ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName))];
  return specs.map((spec) => {
    const r = ts.resolveModuleName(spec, abspath, options, ts.sys, cache).resolvedModule;
    let target = null;
    if (r && !r.isExternalLibraryImport) {
      const t = rel(r.resolvedFileName);
      if (isTsFile(t) && !t.includes('/node_modules/') && !t.startsWith('..') && !/^[a-zA-Z]:/.test(t)) target = t;
    }
    return [spec, target];
  });
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return c.v === 1 ? c.files : {};
  } catch { return {}; }
}

function writeCache(files) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, files }));
  fs.renameSync(tmp, CACHE_FILE); // atomic enough that parallel hooks never read a torn file
}

/**
 * Incremental import graph. Cache entry per file: [mtimeMs, [[spec, resolvedRel|null], ...]].
 * Only changed/new files are re-scanned; when files appear or vanish, importers with
 * unresolved local specs or edges into the vanished file are re-scanned too.
 * ponytail: mtime-only invalidation (no content hash) and no tsconfig-change detection;
 * delete .cache/imports.json to force a rebuild.
 */
export function refreshImportGraph() {
  const cached = readCache();
  const current = new Map();
  for (const project of Object.keys(PROJECT_DIRS)) {
    for (const f of walkTs(projectRoot(project))) {
      if (projectOf(f) !== project) continue; // nested project owns it
      try { current.set(rel(f), fs.statSync(f).mtimeMs); } catch { /* raced with delete */ }
    }
  }
  const deleted = Object.keys(cached).filter((f) => !current.has(f));
  const added = [...current.keys()].filter((f) => !cached[f]);
  const dirty = new Set([...current.keys()].filter((f) => cached[f]?.[0] !== current.get(f)));
  if (deleted.length || added.length) {
    const gone = new Set(deleted);
    for (const [f, [, edges]] of Object.entries(cached)) {
      if (!current.has(f)) continue;
      if (edges.some(([spec, t]) => (t === null && isLocalSpec(spec) && added.length) || (t && gone.has(t)))) dirty.add(f);
    }
  }

  const files = {};
  for (const f of current.keys()) if (!dirty.has(f)) files[f] = cached[f];
  if (dirty.size) {
    const ts = loadTs();
    for (const f of dirty) {
      try { files[f] = [current.get(f), scanFile(ts, f)]; } catch { files[f] = [current.get(f), []]; }
    }
  }
  if (dirty.size || deleted.length) writeCache(files);

  const importers = new Map();
  for (const [f, [, edges]] of Object.entries(files)) {
    for (const [, t] of edges) {
      if (!t || t === f) continue;
      if (!importers.has(t)) importers.set(t, new Set());
      importers.get(t).add(f);
    }
  }
  return { files, importers, scanned: dirty.size, deleted: deleted.length };
}
