// PostToolUse hook on the Agent tool, registered in .claude/settings.json. Off unless objectIds is true in config.json,
// and it needs repoCopies on too, since the card's repo copy is where it looks. When board-implementer returns
// in a board session, it finds object declarations with ID 0 in the card's repo copy and gives each a real ID:
// Ninja first (lowest range with a free slot), the manual scan when Ninja answers GRACE_EXPIRED. No model involved.
// Board sessions run in the board folder, where the per-repo Ninja MCP isn't loaded, so this script starts
// the Ninja MCP server itself and speaks MCP over stdio. Field and enum value IDs stay with the agent (Ninja only
// does objects).
//
// Manual picks go in ids.json and raise the floor for the next scan, because a picked ID that isn't pushed yet
// is invisible to git. Never a gap: first ID above the highest used.
//
// Output: nothing when there is nothing to do; otherwise {"decision":"block","reason":...} so the main session reads
// what was assigned and rebuilds. Env for testing: ASSIGN_IDS_LEDGER (other ledger file), ASSIGN_IDS_NO_COMMIT=1.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BOARD = path.resolve(__dirname, '..');
const config = require('./config.js');
const PROJECTS = config.projectsRoot;
const LEDGER = process.env.ASSIGN_IDS_LEDGER || path.join(BOARD, 'ids.json');
const AGENTS = ['board-implementer'];
const TYPES = ['tableextension', 'table', 'pageextension', 'page', 'codeunit', 'reportextension', 'report', 'query',
  'xmlport', 'enumextension', 'enum', 'permissionsetextension', 'permissionset'];
const DECL = new RegExp(`^(\\s*)(${TYPES.join('|')})(\\s+)0(?=\\s)`, 'im');
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
// For owners who run a protect-tests hook: the unit-test app is locked unless they ran Allow-TestEdits.ps1. Same
// marker and path test as ~/.claude/hooks/protect-tests.js, which can't see writes made from inside this script.
// Without ~/.claude/scripts/Allow-TestEdits.ps1 there is no lock.
const TEST_MARKER = path.join(require('os').homedir(), '.claude', 'state', 'tests-allowed-until');
const TEST_SCRIPT = path.join(require('os').homedir(), '.claude', 'scripts', 'Allow-TestEdits.ps1');
const TEST_PATH_RE = /core-bc-al-ext[\\/]+unit-tests([\\/]|$)|(^|[\s'"\\/])unit-tests[\\/]/i;
function testsUnlocked() {
  if (!fs.existsSync(TEST_SCRIPT)) return true;
  try {
    const until = Date.parse(fs.readFileSync(TEST_MARKER, 'utf8').trim());
    return !isNaN(until) && Date.now() < until;
  } catch (e) { return false; }
}
const T0 = Date.now();
const trace = msg => { if (process.env.ASSIGN_IDS_TRACE) process.stderr.write(`${((Date.now() - T0) / 1000).toFixed(1)}s ${msg}\n`); };

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: GIT_ENV });
  if (r.error) throw r.error;
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim(), status: r.status };
};

const readStdin = () => new Promise(res => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => (s += d)); process.stdin.on('end', () => res(s)); });

function cardField(text, name) {
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

// The brief names the card (README rule 4); the card names the copy. A brief without a card may still name a copy.
function findCopy(prompt) {
  const cm = /cards[\\/]([0-9A-Za-z-]+)\.md/.exec(prompt);
  if (cm) {
    const file = path.join(BOARD, 'cards', `${cm[1]}.md`);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      const repo = cardField(text, 'repo');
      if (repo && repo !== 'none') return { card: cm[1], copy: path.join(PROJECTS, repo), branch: cardField(text, 'branch') };
    }
  }
  // A copy named by path: a folder right under projectsRoot whose name the repoCopies pattern allows.
  const flat = prompt.replace(/\//g, '\\').toLowerCase(), root = PROJECTS.replace(/\\+$/, '').toLowerCase() + '\\';
  for (let at = flat.indexOf(root); at >= 0; at = flat.indexOf(root, at + 1)) {
    const name = (/^[\w.-]+/.exec(prompt.slice(at + root.length)) || [])[0];
    if (name && config.repoCopies.match.test(name)) return { card: cm ? cm[1] : null, copy: path.join(PROJECTS, name), branch: null };
  }
  return null;
}

function baseBranch() {
  try { return JSON.parse(fs.readFileSync(path.join(BOARD, 'ado.json'), 'utf8')).baseBranch || null; } catch { return null; }
}

// Uncommitted and untracked .al files, plus what the branch changed since the base branch.
function changedAlFiles(copy, branch) {
  const files = new Set();
  for (const line of git(copy, ['status', '--porcelain', '-uall']).out.split('\n')) {
    if (!line || line.startsWith(' D') || line.startsWith('D ')) continue;
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    p = p.replace(/^"|"$/g, '');
    if (p.toLowerCase().endsWith('.al')) files.add(p);
  }
  const base = baseBranch();
  if (base && branch && branch !== 'none' && branch !== base) {
    const d = git(copy, ['diff', '--name-only', '--diff-filter=AMR', `origin/${base}...HEAD`, '--', '*.al']);
    if (d.ok) d.out.split('\n').filter(Boolean).forEach(p => files.add(p));
  }
  return [...files].map(p => path.join(copy, p)).filter(f => fs.existsSync(f));
}

function appDir(file) {
  for (let d = path.dirname(file); d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, 'app.json'))) return d;
  return null;
}

// ---- Ninja over MCP stdio ----

function startNinja() {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npx -y @vjeko.com/al-object-id-ninja-mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buf = '', next = 1, dead = null;
  const failAll = e => { dead = e; for (const [, p] of pending) p.reject(e); pending.clear(); };
  child.on('error', failAll);
  child.on('exit', code => failAll(new Error(`Ninja MCP exited (${code})`)));
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = msg.id != null && pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params, ms = 60000) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = next++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`Ninja ${method} timed out`)); }, ms);
    pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
  trace('ninja spawned');
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'assign-ids', version: '1' } }, 180000)
    .then(() => { trace('ninja ready'); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); });
  const assign = async (objectType, targetFilePath, rangeName) => {
    await ready;
    const args = { objectType, targetFilePath };
    if (rangeName) args.rangeName = rangeName;
    trace(`ninja assign ${objectType} ${rangeName || ''}`);
    const r = await request('tools/call', { name: 'ninja_assignObjectId', arguments: args });
    return { text: (r.content || []).map(c => c.text).join('\n'), isError: !!r.isError };
  };
  const close = () => { try { child.stdin.end(); } catch {} spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); };
  return { assign, close };
}

// Lowest range with a free slot. Ninja wants rangeName when the app has several; its error lists them.
async function ninjaAssign(ninja, type, file) {
  let r = await ninja.assign(type, file);
  if (r.isError && /Multiple ranges available/.test(r.text)) {
    const ranges = [...r.text.matchAll(/^- (?:"([^"]+)": )?(\d+)-(\d+)\s*$/gm)]
      .map(m => ({ label: m[1] || `${m[2]}-${m[3]}`, from: +m[2] }))
      .sort((a, b) => a.from - b.from);
    for (const range of ranges) {
      r = await ninja.assign(type, file, range.label);
      if (!r.isError) return { id: +/ID: (\d+)/.exec(r.text)[1], how: `Ninja, range ${range.label}` };
      if (!/All IDs in this range have been consumed/.test(r.text)) break;
    }
  } else if (!r.isError) {
    return { id: +/ID: (\d+)/.exec(r.text)[1], how: 'Ninja' };
  }
  return { error: r.text };
}

// ---- Manual scan ----

function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { picks: [] }; }
}

function copies() {
  const seen = new Set(), out = [];
  for (const name of fs.readdirSync(PROJECTS)) {
    if (!config.repoCopies.match.test(name)) continue;
    const dir = path.join(PROJECTS, name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    let real; try { real = fs.realpathSync(dir).toLowerCase(); } catch { continue; }
    if (!seen.has(real)) { seen.add(real); out.push(dir); }
  }
  return out;
}

function grepPattern(type, from, to) {
  const a = String(from), b = String(to);
  if (a.length !== b.length) return `^\\s*${type}\\s+[0-9]+\\b`;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return `^\\s*${type}\\s+${a.slice(0, i)}[0-9]{${a.length - i}}\\b`;
}

// Folders of every app whose app.json range overlaps from..to. An app can only declare IDs inside its own ranges,
// so these are the only places an ID in this range can live.
function appsInRange(target, from, to) {
  const dirs = [];
  for (const f of git(target, ['ls-files', '--', '*app.json']).out.split('\n').filter(p => /(^|\/)app\.json$/.test(p))) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(target, f), 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const ranges = m.idRanges || (m.idRange ? [m.idRange] : []);
    if (ranges.some(r => r.from <= to && r.to >= from)) dirs.push(path.posix.dirname(f));
  }
  return dirs;
}

// IDs of this type in use on any ref of the target copy (after a fetch), on local branches and in the working tree
// of every BC25 copy (a branch that lives in one copy only is invisible from another), in every app whose range
// overlaps. Greps each distinct app subtree once: most of the ~900 refs share it, and grepping every ref's whole
// tree took two minutes.
function usedIds(type, from, to, target, notes) {
  const pat = grepPattern(type, from, to);
  const apps = appsInRange(target, from, to);
  const used = new Set();
  const collect = out => { for (const m of out.matchAll(/(\d+)/g)) { const n = +m[1]; if (n >= from && n <= to) used.add(n); } };
  for (const copy of copies()) {
    trace(`scan ${path.basename(copy)}`);
    const isTarget = path.resolve(copy).toLowerCase() === path.resolve(target).toLowerCase();
    const refs = [...new Set(git(copy, ['for-each-ref', '--format=%(objectname)', ...(isTarget ? ['refs/remotes', 'refs/heads'] : ['refs/heads'])]).out.split('\n').filter(Boolean))];
    const input = apps.flatMap(a => refs.map(r => `${r}:${a}`)).join('\n') + '\n';
    const check = spawnSync('git', ['cat-file', '--batch-check'], { cwd: copy, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: GIT_ENV });
    const trees = [...new Set((check.stdout || '').split('\n').map(l => /^([0-9a-f]{40}) tree /.exec(l)).filter(Boolean).map(m => m[1]))];
    for (let i = 0; i < trees.length; i += 400) {
      const r = git(copy, ['grep', '-h', '-i', '-o', '-E', pat, ...trees.slice(i, i + 400), '--', '*.al']);
      if (!r.ok && r.status !== 1) notes.push(`git grep failed in ${path.basename(copy)}: ${r.err.split('\n')[0]}`);
      collect(r.out);
    }
    collect(git(copy, ['grep', '--untracked', '-h', '-i', '-o', '-E', pat, '--', ...apps.map(a => `${a}/*.al`)]).out);
  }
  return used;
}

function manualPick(type, app, target, picked, notes, fetched) {
  if (!fetched.done) {
    trace('fetch');
    const f = git(target, ['fetch', '--quiet', '--prune']);
    if (!f.ok) notes.push(`git fetch failed in ${path.basename(target)}, scanned the refs it had: ${f.err.split('\n')[0]}`);
    fetched.done = true;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'app.json'), 'utf8').replace(/^\uFEFF/, ''));
  const ranges = (manifest.idRanges || (manifest.idRange ? [manifest.idRange] : [])).slice().sort((a, b) => a.from - b.from);
  const ledger = readLedger().picks.filter(p => p.type === type).map(p => p.id);
  for (const { from, to } of ranges) {
    const taken = [...usedIds(type, from, to, target, notes), ...ledger, ...picked.filter(p => p.type === type).map(p => p.id)]
      .filter(n => n >= from && n <= to);
    const id = taken.length ? Math.max(...taken) + 1 : from;
    if (id <= to) return { id, how: `manual scan, range ${from}-${to}` };
  }
  return { error: `no free ${type} ID above the highest used in ${ranges.map(r => `${r.from}-${r.to}`).join(', ')}` };
}

// ---- Main ----

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  const ti = input.tool_input || {};
  if (!config.objectIds || !config.repoCopies.enabled || !AGENTS.includes(ti.subagent_type)) return;
  const where = findCopy(String(ti.prompt || ''));
  if (!where || !fs.existsSync(where.copy)) return;

  const todo = [];
  for (const file of changedAlFiles(where.copy, where.branch)) {
    const text = fs.readFileSync(file, 'utf8');
    const m = DECL.exec(text);
    if (m) todo.push({ file, type: m[2].toLowerCase() });
  }
  if (!todo.length) return;

  const notes = [], done = [], failed = [], picked = [], fetched = {};
  let ninja = null;
  try {
    for (const t of todo) {
      const app = appDir(t.file);
      const rel = path.relative(where.copy, t.file);
      if (!app) { failed.push(`${rel}: no app.json above it`); continue; }
      if (TEST_PATH_RE.test(t.file) && !testsUnlocked()) { failed.push(`${rel}: ${t.type} left at 0, test edits are locked. Once they are unlocked with Allow-TestEdits.ps1, the hook assigns it after the next board-implementer step on this card`); continue; }
      let r;
      try {
        ninja = ninja || startNinja();
        r = await ninjaAssign(ninja, t.type, t.file);
      } catch (e) { r = { error: e.message }; }
      if (r.error && /GRACE_EXPIRED/.test(r.error)) r = manualPick(t.type, app, where.copy, picked, notes, fetched);
      if (r.error) { failed.push(`${rel}: ${t.type} left at 0. ${r.error.split('\n')[0]}`); continue; }
      const text = fs.readFileSync(t.file, 'utf8');
      fs.writeFileSync(t.file, text.replace(DECL, `$1$2$3${r.id}`), 'utf8');
      picked.push({ type: t.type, id: r.id, app: path.relative(where.copy, app).replace(/\\/g, '/'), manual: r.how.startsWith('manual') });
      done.push(`${rel}: ${t.type} ${r.id} (${r.how})`);
    }
  } finally { trace('closing ninja'); if (ninja) ninja.close(); trace('closed'); }

  const manual = picked.filter(p => p.manual);
  if (manual.length) {
    const ledger = readLedger();
    const today = new Date().toISOString().slice(0, 10);
    for (const p of manual) ledger.picks.push({ type: p.type, id: p.id, app: p.app, card: where.card, date: today });
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    if (!process.env.ASSIGN_IDS_NO_COMMIT && LEDGER === path.join(BOARD, 'ids.json')) {
      const c = git(BOARD, ['commit', '-q', '-m', `${where.card || 'ids'}: manual object IDs ${manual.map(p => p.id).join(', ')}`, '--', 'ids.json']);
      if (!c.ok) notes.push(`ids.json not committed: ${c.err.split('\n')[0]}`);
    }
  }

  const lines = [`assign-ids hook, ${path.basename(where.copy)}${where.card ? `, card ${where.card}` : ''}:`];
  if (done.length) lines.push('Assigned:', ...done.map(d => `- ${d}`));
  if (failed.length) lines.push('Not assigned, list under "Needs your attention" on the card:', ...failed.map(f => `- ${f}`));
  notes.forEach(n => lines.push(`Note: ${n}`));
  if (done.length) lines.push('The agent built with ID 0, so rebuild this copy with the build skill now, then put these IDs under Evidence on the card.');
  if (manual.length) lines.push('Manual picks are in ids.json in the board repo.');
  process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `assign-ids hook failed: ${e.message}. Any object declared with ID 0 is still 0; list it under "Needs your attention" on the card.` }));
});
