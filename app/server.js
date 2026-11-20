// Local app for the priority queue. Reads the cards, records decisions on them, commits and pushes the board.
// Start: node app\server.js, then open http://localhost:4747. No dependencies.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const { cardTime, tokenStats, cycleStats, windowCost, sessionCost, refresh: refreshTimes, JOBS: JOBS_FILE } = require('../scripts/card-time.js');
const config = require('../scripts/config.js');
const OWNER = config.owner;

const PORT = Number(process.env.QUEUE_PORT) || 4747;
const ROOT = path.resolve(__dirname, '..');
const CARDS = path.join(ROOT, 'cards');
const SCRIPT = path.join(ROOT, 'scripts', 'Get-Inbox.ps1');
const PAGE = path.join(__dirname, 'index.html');
// The page's theme colours, and what Edge reads to install the page as an app with its own name and icon.
// A fixed map, so no path from the URL reaches the disk.
const STATIC = {
  '/themes.css': ['themes.css', 'text/css; charset=utf-8'],
  '/themes-popular.css': ['themes-popular.css', 'text/css; charset=utf-8'],
  '/themes-popular.js': ['themes-popular.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};
const ADO_FILE = path.join(ROOT, 'ado.json');
// Pushes only when the board has an origin remote, so a new board commits locally until its owner adds one.
// QUEUE_NO_PUSH=1 turns pushing off either way.
const hasOrigin = (() => { try { return require('child_process').execFileSync('git', ['-C', ROOT, 'remote'], { encoding: 'utf8', windowsHide: true }).split(/\s+/).includes('origin'); } catch { return false; } })();
const PUSH = process.env.QUEUE_NO_PUSH !== '1' && hasOrigin;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.message += '\n' + stderr; reject(err); } else resolve(stdout);
    });
  });
}
const inbox = (...args) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args]);
const git = (...args) => run('git', ['-C', ROOT, ...args]);
// What jobs and the app write. Dirty checks look only here, so uncommitted work on app/, scripts/ or the docs
// doesn't block a job or fail a cycle (2026-11-18).
const BOARD = ['cards', 'attachments', 'INBOX.md', 'ado.json', 'ids.json', 'order.json'];
const boardStatus = (...args) => git('status', '--porcelain', ...args, '--', ...BOARD);

// ---- card parsing ----------------------------------------------------------

function cardPath(id) {
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw httpError(400, 'bad card id');
  const p = path.join(CARDS, id + '.md');
  if (!fs.existsSync(p)) throw httpError(404, 'no card ' + id);
  return p;
}

function readCard(id) { return parseCard(fs.readFileSync(cardPath(id), 'utf8')); }

// Also parses a card's text from git (Re-open reads the card as it was before a decision).
function parseCard(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw httpError(500, 'card has no frontmatter');
  const fmEnd = lines.indexOf('---', 1);
  const fm = {};
  for (let i = 1; i < fmEnd; i++) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2].trim();
  }
  // Sections: each "## " heading up to the next one. start/end are line indexes, end exclusive.
  const sections = [];
  for (let i = fmEnd + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      if (sections.length) sections[sections.length - 1].end = i;
      sections.push({ title: lines[i].slice(3).trim(), start: i, end: lines.length });
    }
  }
  for (const s of sections) s.body = lines.slice(s.start + 1, s.end).join('\n').trim();
  const waiting = sections.find(s => s.title === 'Waiting on you');
  const questions = waiting ? parseQuestions(lines, waiting) : [];
  return { fm, lines, eol, sections, questions };
}

// A question is "N. text" followed by indented lines. "   - A: text" lines are its options.
// It ends at the next numbered line, an unindented line, or the end of the section.
function parseQuestions(lines, section) {
  const qs = [];
  let q = null;
  for (let i = section.start + 1; i < section.end; i++) {
    const line = lines[i];
    const num = /^(\d+)\.\s+(.*)$/.exec(line);
    if (num) {
      q = { n: Number(num[1]), text: num[2], options: [], start: i, end: i + 1 };
      qs.push(q);
      continue;
    }
    if (!q) continue;
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) { q = null; continue; }
    const opt = /^\s+-\s+([A-Z]):\s*(.*)$/.exec(line);
    if (opt) q.options.push({ key: opt[1], text: opt[2] });
    else if (q.options.length) q.options[q.options.length - 1].text += ' ' + line.trim();
    else q.text += ' ' + line.trim();
    q.end = i + 1;
  }
  return qs;
}

// reopen: whether Re-open can run now, and why not; null on cards it doesn't apply to.
async function cardView(id) {
  const c = readCard(id);
  let reopen = null;
  if (c.fm.state === 'decided' || c.fm.state === 'agent') {
    try { await reopenPlan(id, c); reopen = { ok: true }; } catch (e) { reopen = { ok: false, why: e.message }; }
  }
  return {
    fm: c.fm,
    sections: c.sections.map(s => ({ title: s.title, body: s.body })),
    questions: c.questions.map(({ n, text, options }) => ({ n, text, options })),
    shots: listShots(id),
    reopen,
  };
}

// ---- screenshots -------------------------------------------------------------

// The owner pastes screenshots on a card. The page uploads each one as soon as it's pasted and the server holds it in
// memory under a token, so nothing lands on disk until a decision or a save names the token. A failed or abandoned
// decision leaves no stray file, and a job never finds the board dirty because of one. Saved files go in
// attachments/<id>/ and are committed with the card; the Decisions entry names each by its absolute path, so the
// cycle (and the agents it briefs) can open them with Read. A server restart drops what was staged.
const ATTACH = path.join(ROOT, 'attachments');
const SHOT_MAX = 10 * 1024 * 1024;
const SHOT_NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const staged = new Map(); // token -> { id, buf, at }

function listShots(id) {
  const dir = path.join(ATTACH, id);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => SHOT_NAME.test(f)).sort((x, y) => x.slice(0, -4).localeCompare(y.slice(0, -4))) : [];
}

function stageShot(id, buf) {
  cardPath(id);
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw httpError(415, 'only PNG screenshots');
  const now = Date.now();
  for (const [t, v] of staged) if (now - v.at > 2 * 3600 * 1000) staged.delete(t);
  const token = crypto.randomUUID();
  staged.set(token, { id, buf, at: now });
  return { token };
}

// shots: [{ token, caption }]. Checks every token before anything is written, and names the files, but writes
// nothing: the caller writes the card first, then calls write(). Returns the Decisions lines and the repo paths to commit.
function planShots(id, shots) {
  if (!Array.isArray(shots) || !shots.length) return { lines: [], files: [], write: () => {} };
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${today()}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dir = path.join(ATTACH, id);
  const taken = new Set(listShots(id));
  const out = [];
  for (const s of shots) {
    const v = staged.get(String(s && s.token));
    if (!v || v.id !== id) throw httpError(410, 'a screenshot is no longer staged (the server restarted?); paste it again');
    let name = stamp + '.png';
    for (let i = 2; taken.has(name); i++) name = `${stamp}-${i}.png`;
    taken.add(name);
    const caption = String(s.caption || '').trim().replace(/\s*\r?\n\s*/g, ' ');
    out.push({ token: s.token, buf: v.buf, name, caption });
  }
  return {
    lines: out.map(o => `- Screenshot: \`${path.join(LONG_ROOT, 'attachments', id, o.name)}\`` + (o.caption ? ` "${o.caption}"` : '')),
    files: out.map(o => `attachments/${id}/${o.name}`),
    write: () => {
      fs.mkdirSync(dir, { recursive: true });
      for (const o of out) { fs.writeFileSync(path.join(dir, o.name), o.buf); staged.delete(o.token); }
    },
  };
}

// ---- recording a decision ----------------------------------------------------

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// answers: [{ n, choice, note }], note: free text for the whole card.
// Answered questions move from "Waiting on you" into a dated Decisions entry, with the option text they chose,
// so /q cycle can act on them without the question still on the card. The card goes to state "decided".
// dry: check and count only, write nothing (a decision queued while a job runs).
function applyRuling(id, answers, note, shotLines = [], dry = false) {
  const c = readCard(id);
  if (c.fm.state !== 'you') throw httpError(409, `card ${id} is ${c.fm.state}, not waiting on you`);
  const byN = new Map(c.questions.map(q => [q.n, q]));
  const picked = [];
  for (const a of answers || []) {
    const q = byN.get(Number(a.n));
    if (!q) throw httpError(400, `card ${id} has no question ${a.n}`);
    const choice = (a.choice || '').trim();
    const text = (a.note || '').trim();
    if (!choice && !text) continue;
    const opt = q.options.find(o => o.key === choice);
    if (choice && !opt) throw httpError(400, `question ${a.n} has no option ${choice}`);
    picked.push({ q, opt, text });
  }
  note = (note || '').trim();
  if (!picked.length && !note) throw httpError(400, 'nothing to record');
  if (dry) return picked.length;

  const quote = s => '"' + s.replace(/\s*\r?\n\s*/g, ' ') + '"';
  const entry = [`### ${today()}, from the app`, ''];
  for (const { q, opt, text } of picked.sort((a, b) => a.q.n - b.q.n)) {
    entry.push(`${q.n}. ${q.text}`);
    if (opt) entry.push(`   - Decided ${opt.key}: ${opt.text}`);
    if (text) entry.push(`   - ${OWNER}: ${quote(text)}`);
  }
  if (note) { if (picked.length) entry.push(''); entry.push(`${OWNER}: ${quote(note)}`); }
  if (shotLines.length) entry.push('', ...shotLines);
  entry.push('');

  const lines = c.lines.slice();
  const drop = new Set();
  for (const { q } of picked) for (let i = q.start; i < q.end; i++) drop.add(i);

  // Decisions: append at the end of its section, or add the section at the end of the card.
  const decisions = c.sections.find(s => s.title === 'Decisions');
  let insertAt = decisions ? decisions.end : lines.length;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  const block = decisions ? ['', ...entry] : ['', '## Decisions', '', ...entry];

  const fmEnd = lines.indexOf('---', 1);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) out.push(...block);
    if (drop.has(i)) continue;
    let line = lines[i];
    if (i > 0 && i < fmEnd) {
      if (/^state:/.test(line)) line = 'state: decided';
      else if (/^updated:/.test(line)) line = 'updated: ' + today();
    }
    out.push(line);
  }
  if (insertAt >= lines.length) out.push(...block);

  // If every question was answered, say so instead of leaving an empty section.
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  text = text.replace(/(## Waiting on you\n\n)(?=## )/, `$1Nothing open. Decided ${today()}, waiting for /q cycle.\n\n`);
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(cardPath(id), text.replace(/\n/g, c.eol), 'utf8');
  return picked.length;
}

// One write at a time: card edit, inbox rebuild and commit must not interleave.
let queue = Promise.resolve();
function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

async function decide(id, body) {
  const shots = planShots(id, body.shots);
  const count = applyRuling(id, body.answers, body.note, shots.lines);
  shots.write();
  await inbox();
  // Only the card, the inbox and the screenshots, as finishHeadless does, so other work in the board stays out of this commit.
  const files = [`cards/${id}.md`, 'INBOX.md', ...shots.files];
  await git('add', '--', ...files);
  await git('commit', '-q', '-m', `${id}: decided ${count} in the app, to cycle`, '--', ...files);
  let pushed = false, pushError = null;
  if (PUSH) {
    try { await git('push', '-q', 'origin', 'main'); pushed = true; }
    catch (e) { pushError = e.message.trim().split('\n').pop(); }
  }
  return { ok: true, count, pushed, pushError };
}

// ---- queued decisions and edits ----------------------------------------------

// A decision sent while a job runs waits in app/pending.json, its screenshots in app/pending/, both gitignored. The
// board isn't touched until the job ends, so a cycle that writes and commits cards never meets a decision halfway.
// When the job ends, and at startup for any left from a stopped server, each one is recorded through decide() as if
// it came in then. One whose card moved on or got other questions in between is dropped, and the report lists its
// answers so the owner can give them again (it should be rare, the cycle leaves `you` cards alone).
// Card edits (park, done, back to you, fields, screenshots) queue the same way since 2026-11-18, as type 'edit', and
// run through editCard() in the order they came, mixed with the decisions. An edit that fails then is dropped and listed.
const PENDING = path.join(__dirname, 'pending.json');
const PENDING_DIR = path.join(__dirname, 'pending');
function readPending() { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return []; } }
function writePending(list) { if (list.length) fs.writeFileSync(PENDING, JSON.stringify(list, null, 2) + '\n', 'utf8'); else fs.rmSync(PENDING, { force: true }); }
const questionsKey = c => crypto.createHash('sha1').update(JSON.stringify(c.questions.map(({ n, text, options }) => ({ n, text, options })))).digest('hex');

// Staged screenshots live in memory and a restart drops them, so a queued write keeps its own copy in app/pending/.
function persistShots(id, shots) {
  const out = (Array.isArray(shots) ? shots : []).map(s => {
    const v = staged.get(String(s && s.token));
    if (!v || v.id !== id) throw httpError(410, 'a screenshot is no longer staged (the server restarted?); paste it again');
    return { token: String(s.token), caption: String(s.caption || '') };
  });
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  for (const s of out) fs.writeFileSync(path.join(PENDING_DIR, s.token + '.png'), staged.get(s.token).buf);
  return out;
}

function queueDecision(id, body) {
  const list = readPending();
  if (list.some(e => e.id === id && !e.type)) throw httpError(409, `card ${id} already has a decision queued for when ${job.label} ends`);
  const count = applyRuling(id, body.answers, body.note, [], true);
  const shots = persistShots(id, body.shots);
  list.push({ id, answers: body.answers, note: body.note, shots, key: questionsKey(readCard(id)), at: new Date().toISOString() });
  writePending(list);
  return { ok: true, queued: true, count, job: job.label };
}

// Checked now with a dry editCard, so a bad value fails at once instead of when the job ends.
async function queueEdit(id, body) {
  await editCard(id, body, true);
  const { shots: _, ...rest } = body;
  const shots = persistShots(id, body.shots);
  const list = readPending();
  list.push({ type: 'edit', id, body: rest, shots, at: new Date().toISOString() });
  writePending(list);
  return { ok: true, queued: true, job: job.label };
}

const editText = b => [b.action === 'park' ? `park until ${b.revisit}` : b.action === 'checks'
  ? `test list, ${(b.checks || []).length} tick${(b.checks || []).length === 1 ? '' : 's'}` : b.action === 'fields'
  ? 'set ' + Object.entries(b.fields || {}).map(([k, v]) => `${k} ${v}`).join(', ') : b.action,
  (b.note || '').trim() ? `note "${b.note.trim()}"` : ''].filter(Boolean).join('; ');

// Runs inside serial(), before job.running goes false, so a decision sent meanwhile still queues and is picked up
// by the loop. Returns report lines; empty when nothing waited.
async function drainPending() {
  const out = [];
  const recorded = [], edited = [];
  let list;
  while ((list = readPending()).length) {
    const e = list.shift();
    writePending(list);
    const files = e.shots.map(s => path.join(PENDING_DIR, s.token + '.png'));
    if (e.type === 'edit') {
      try {
        e.shots.forEach((s, i) => staged.set(s.token, { id: e.id, buf: fs.readFileSync(files[i]), at: Date.now() }));
        const r = await editCard(e.id, { ...e.body, shots: e.shots });
        edited.push(e.id);
        if (r.pushError) out.push(`Push failed after ${e.id}: ${r.pushError}`);
      } catch (err) {
        out.push(`Queued edit on ${e.id} dropped, ${err.message}. You asked: ${editText(e.body)}${e.shots.length ? ` (+${e.shots.length} screenshot)` : ''}.`);
      }
      for (const f of files) fs.rmSync(f, { force: true });
      continue;
    }
    try {
      const c = readCard(e.id);
      if (c.fm.state !== 'you' || questionsKey(c) !== e.key) throw new Error(c.fm.state === 'you' ? 'its questions changed' : `the card is ${c.fm.state} now`);
      e.shots.forEach((s, i) => staged.set(s.token, { id: e.id, buf: fs.readFileSync(files[i]), at: Date.now() }));
      const r = await decide(e.id, e);
      recorded.push(e.id);
      if (r.pushError) out.push(`Push failed after ${e.id}: ${r.pushError}`);
    } catch (err) {
      const said = (e.answers || []).filter(a => a.choice || (a.note || '').trim()).map(a => `${a.n}${a.choice ? ' ' + a.choice : ''}${(a.note || '').trim() ? ` "${a.note.trim()}"` : ''}`);
      if ((e.note || '').trim()) said.push(`note "${e.note.trim()}"`);
      out.push(`Queued decision on ${e.id} dropped, ${err.message}. You answered: ${said.join('; ') || 'nothing'}${e.shots.length ? ` (+${e.shots.length} screenshot)` : ''}.`);
    }
    for (const f of files) fs.rmSync(f, { force: true });
  }
  if (edited.length) out.unshift(`Queued edits recorded: ${edited.join(', ')}.`);
  if (recorded.length) out.unshift(`Queued decisions recorded: ${recorded.join(', ')}.`);
  return out;
}

// After a job: record the queue, add what happened to the job's message. Any dropped one turns the notice red.
async function finishWithQueue() {
  const lines = await drainPending();
  if (!lines.length) return;
  if (lines.some(l => l.includes('dropped') || l.startsWith('Push failed'))) job.ok = false;
  job.message = [job.message, ...lines].filter(Boolean).join(' ');
}

// ---- iteration and pull ----------------------------------------------------

// ado.json holds the current iteration and the iteration list. /q pull refreshes the list, the dropdown sets the iteration.
const readAdo = () => JSON.parse(fs.readFileSync(ADO_FILE, 'utf8').replace(/^﻿/, ''));
const leaf = p => String(p || '').split('\\').pop();

async function pushBoard() {
  if (!PUSH) return { pushed: false, pushError: null };
  try { await git('push', '-q', 'origin', 'main'); return { pushed: true, pushError: null }; }
  catch (e) { return { pushed: false, pushError: e.message.trim().split('\n').pop() }; }
}

async function setIteration(body) {
  const ado = readAdo();
  const it = ado.iterations.find(i => i.path === body.path);
  if (!it) throw httpError(400, 'not in the iteration list: ' + body.path);
  if (ado.iteration === it.path) return { ok: true, changed: false };
  ado.iteration = it.path;
  fs.writeFileSync(ADO_FILE, JSON.stringify(ado, null, 2) + '\n', 'utf8');
  await git('add', '--', 'ado.json');
  await git('commit', '-q', '-m', `iteration: ${leaf(it.path)}`, '--', 'ado.json');
  return { ok: true, changed: true, ...(await pushBoard()) };
}

// body: { ids: the Waiting on you list in the order the owner dragged it, moved: the card they dragged }.
// Get-Inbox sorts by order.json after the blocks-agent flag, so the inbox and /q follow it too. The cards are untouched.
const ORDER_FILE = path.join(ROOT, 'order.json');
async function setOrder(body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw httpError(400, 'ids must be a list of distinct card ids');
  ids.forEach(cardPath);
  const text = JSON.stringify(ids, null, 2) + '\n';
  if (fs.existsSync(ORDER_FILE) && fs.readFileSync(ORDER_FILE, 'utf8') === text) return { ok: true, changed: false };
  fs.writeFileSync(ORDER_FILE, text, 'utf8');
  await inbox();
  const moved = ids.includes(String(body.moved)) ? String(body.moved) : null;
  const files = ['order.json', 'INBOX.md'];
  await git('add', '--', ...files);
  await git('commit', '-q', '-m', moved ? `order: ${moved} to #${ids.indexOf(moved) + 1}` : 'order: reordered in the app', '--', ...files);
  return { ok: true, changed: true, ...(await pushBoard()) };
}

// ---- jobs: Claude Code runs started from the app ---------------------------

// One job at a time. While one runs, nothing else writes the board.
// Background jobs (pull, add, sync) run headless with a fixed tool list: ADO reads and edits to cards/ and ado.json,
// no shell, no git, and anything else is denied instead of prompting. The server commits what they wrote afterwards.
// Terminal jobs (cycle, step, open) open a Claude Code window where the owner answers prompts as usual. That session
// commits by the skill's rules; the server only waits for the window to close.
const CLAUDE = process.env.QUEUE_CLAUDE || 'claude';
// Edit rules need the absolute //c/... form with the long folder name; a relative cards/** was denied in a test run.
// One Edit rule covers the Write tool too.
// Jobs start in the same long path, so a short 8.3 name (MIKAEL~1) in ROOT can't make their paths miss the rules.
const LONG_ROOT = fs.realpathSync.native(ROOT);
const RULE_ROOT = '//' + LONG_ROOT[0].toLowerCase() + LONG_ROOT.slice(2).replace(/\\/g, '/');
const ADO_READ = ['mcp__azure-devops__work', 'mcp__azure-devops__wit_query', 'mcp__azure-devops__wit_work_item', 'mcp__azure-devops__repo_pull_request'];
// With harvest on in config.json, Sync reads the owner's Harvest entries to put the hours logged per work item on
// each card. Read only.
const HARVEST_READ = config.harvest ? ['mcp__harvest__list_time_entries'] : [];
// Model per job, by how hard the work is. Pull, Add and Sync read ADO and write cards in a fixed shape. Open is mostly
// rewording a card. Cycle and Step can do small BC fixes in the main session, so they get the strongest. The probe only
// reads the usage limits. The board-* agents set their own model in .claude/agents.
const MODELS = { pull: 'sonnet', add: 'sonnet', sync: 'sonnet', open: 'sonnet', cycle: 'opus', step: 'opus', probe: 'haiku' };
// stream-json, because only the stream carries rate_limit_event, the 5-hour and weekly usage.
const headless = (prompt, model) => [
  '-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'dontAsk',
  '--tools', 'Read,Edit,Write,Glob,Grep',
  '--allowedTools', 'Read', 'Glob', 'Grep', `Edit(${RULE_ROOT}/cards/**)`, `Edit(${RULE_ROOT}/ado.json)`, ...ADO_READ, ...HARVEST_READ,
];
// A server restarted from inside a Claude Code session inherits that session's variables. CLAUDE_CODE_CHILD_SESSION
// then makes every claude it starts skip saving its transcript, which card-time reads. Children get the env without them.
const SESSION_VAR = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$)/i;
const childEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VAR.test(k))), ...extra });
const JOB_TIMEOUT = 15 * 60 * 1000;
let job = { running: false };
const cardFile = id => path.join(CARDS, id + '.md');

async function assertClean() {
  const dirty = (await boardStatus()).trim();
  if (dirty) throw httpError(409, 'the board has uncommitted changes, so a job could mix them in:\n' + dirty);
}

// kind: pull | add | sync. Each leaves a mark that proves it got to the end: lastPull, the new card, lastSync.
async function startHeadless(kind, id) {
  await assertClean();
  const ado = readAdo();
  let prompt, label;
  if (kind === 'pull') {
    // A new board has no iteration list yet: the first pull only fetches it, so the dropdown has something to pick.
    if (ado.iterations.length && !ado.iterations.some(i => i.path === ado.iteration)) throw httpError(409, 'pick an iteration first');
    prompt = '/q pull from-app'; label = ado.iteration ? 'Pull ' + leaf(ado.iteration) : 'Pull the iteration list';
  } else if (kind === 'add') {
    if (!/^\d+$/.test(id || '')) throw httpError(400, 'a work item id is digits only');
    if (fs.existsSync(cardFile(id))) throw httpError(409, `card ${id} already exists`);
    prompt = `/q add ${id} from-app`; label = 'Add ' + id;
  } else if (kind === 'sync') {
    prompt = '/q sync from-app'; label = 'Sync';
  } else throw httpError(400, 'unknown job ' + kind);
  job = { running: true, kind, id, label, iteration: ado.iteration, started: new Date().toISOString(), log: '', before: fs.readFileSync(ADO_FILE, 'utf8') };
  const child = spawn(CLAUDE, headless(prompt, MODELS[kind]), { cwd: LONG_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  const keep = d => { job.log = (job.log + d.toString('utf8')).slice(-40000); };
  child.stdout.on('data', streamLines(ev => {
    if (ev.type === 'rate_limit_event') recordUsage(ev.rate_limit_info, 'job');
    else if (ev.type === 'result') job.result = ev;
  }, keep));
  child.stderr.on('data', keep);
  const timer = setTimeout(() => { keep('\nStopped after 15 minutes.'); child.kill(); }, JOB_TIMEOUT);
  let done = false;
  const end = code => { if (done) return; done = true; clearTimeout(timer); serial(() => finishHeadless(code)); };
  child.on('error', e => { keep('\n' + e.message); end(-1); });
  child.on('close', end);
  return { ok: true, label };
}

async function finishHeadless(code) {
  const { kind, id } = job;
  try {
    // The stream ends with one result event; show its text, not the stream. job.log keeps stderr and anything not JSON.
    const r = job.result;
    if (r) {
      job.log = (r.result || '') + (r.permission_denials && r.permission_denials.length ? '\n\nDenied: ' + JSON.stringify(r.permission_denials) : '') + (job.log ? '\n\n' + job.log : '');
      if (r.is_error) code = code || 1;
      job.cost = costLine(r);
    }
    if (code !== 0) throw new Error(`Claude stopped with exit code ${code}. Nothing was committed.` + (job.cost ? ' ' + job.cost : ''));
    const after = readAdo();
    const marked = kind === 'add' ? fs.existsSync(cardFile(id)) : fs.readFileSync(ADO_FILE, 'utf8') !== job.before;
    if (!marked) throw new Error('The job wrote no result, so nothing was committed. Its output says why.');
    // A headless run has no shell, so no clock: it wrote 00:00 in a test. The server stamps the time.
    const mark = kind === 'pull' ? 'lastPull' : kind === 'sync' ? 'lastSync' : null;
    if (mark && after[mark]) {
      const d = new Date();
      after[mark].at = `${today()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      fs.writeFileSync(ADO_FILE, JSON.stringify(after, null, 2) + '\n', 'utf8');
    }

    const status = (await boardStatus('--untracked-files=all')).split('\n').filter(Boolean);
    const cards = [], other = [];
    for (const line of status) {
      const file = line.slice(3).replace(/^"|"$/g, '');
      const m = /^cards\/([0-9A-Za-z-]+)\.md$/.exec(file);
      if (m) cards.push({ id: m[1], isNew: line.startsWith('??') });
      else if (file !== 'ado.json') other.push(file);
    }
    const name = leaf(job.iteration);
    const msg = c => kind === 'pull' ? `${c.id}: pulled from ${name}, to you`
      : kind === 'add' ? `${c.id}: added from ado, to you`
      : `${c.id}: synced from ado${readCard(c.id).fm.state === 'done' ? ', to done' : ''}`;
    // One commit per card. The inbox and ado.json go with the last one, or alone when no card changed.
    await inbox();
    for (let i = 0; i < cards.length; i++) {
      const files = [`cards/${cards[i].id}.md`];
      if (i === cards.length - 1) files.push('ado.json', 'INBOX.md');
      await git('add', '--', ...files);
      await git('commit', '-q', '-m', msg(cards[i]), '--', ...files);
    }
    if (!cards.length) {
      await git('add', '--', 'ado.json', 'INBOX.md');
      await git('commit', '-q', '-m', `${kind}${kind === 'pull' ? ' ' + name : ''}: nothing changed`, '--', 'ado.json', 'INBOX.md');
    }
    const { pushed, pushError } = await pushBoard();

    const ids = cards.map(c => c.id).join(', ');
    let what;
    if (kind === 'pull' && !job.iteration) what = 'Fetched the iteration list. Pick the current iteration and pull again.';
    else if (kind === 'pull') {
      const left = ((after.lastPull || {}).left || []).map(l => `${l.id} (${l.state})`);
      what = `${name}: ${ids ? 'added ' + ids : 'nothing new'}.` + (left.length ? ` Left Development: ${left.join(', ')}.` : '');
    } else if (kind === 'add') what = `Added ${id}.`;
    else what = ids ? `Synced, changed ${ids}.` : 'Synced, nothing changed.';
    job.ok = !other.length && !pushError;
    job.message = [what,
      other.length ? `Changed but not committed, check them: ${other.join(', ')}.` : '',
      pushError ? `Push failed: ${pushError}` : pushed ? 'Committed and pushed.' : 'Committed, not pushed.',
      job.cost || '',
    ].filter(Boolean).join(' ');
  } catch (e) {
    job.ok = false;
    job.message = e.message.trim();
  }
  await finishWithQueue();
  job.running = false;
  job.before = null;
  job.result = null;
  job.finished = new Date().toISOString();
}

// Polls app/jobs.jsonl for the --done line of one session and calls back once, a few seconds after it appears, so
// the window can show its last words. Returns a function that stops the polling.
function watchDone(sessionId, cb) {
  let grace = null;
  const poll = setInterval(() => {
    let lines;
    try { lines = fs.readFileSync(JOBS_FILE, 'utf8').split('\n'); } catch { return; }
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.kind !== 'done' || j.sessionId !== sessionId) continue;
      clearInterval(poll);
      grace = setTimeout(() => cb(j.note), 5000);
      return;
    }
  }, 3000);
  return () => { clearInterval(poll); clearTimeout(grace); };
}

// kind: cycle | step | open. "start /wait" returns when the window closes, so the app knows when to unblock.
async function startTerminal(kind, id) {
  let prompt, label;
  if (kind === 'cycle') { prompt = '/q cycle'; label = 'Cycle'; }
  else {
    if (!/^[0-9A-Za-z-]+$/.test(id || '')) throw httpError(400, 'bad card id');
    const c = readCard(id);
    if (kind === 'step') {
      // A decided card settles first, then runs its step if it goes to the agent; /q cycle <id> does both.
      if (c.fm.state !== 'agent' && c.fm.state !== 'decided') throw httpError(409, `card ${id} is ${c.fm.state}, not decided or with the agent`);
      prompt = `/q cycle ${id}`; label = 'Step ' + id;
    } else if (kind === 'open') { prompt = `/q ${id}`; label = 'Claude on ' + id; }
    else throw httpError(400, 'unknown job ' + kind);
  }
  // A known session id ties the window to its transcript. The window's open time goes in app/jobs.jsonl, and the
  // cycle's --mark lines carry the same id through QUEUE_SESSION_ID, so time still counts if the transcript goes missing.
  const sessionId = crypto.randomUUID();
  job = { running: true, kind, id, label, terminal: true, started: new Date().toISOString(), log: '' };
  // Cycle and step read the limits right before the window opens and right after it closes, and log both in
  // app/jobs.jsonl next to the session id. Matched later with the session's tokens, the pairs show how many % of the
  // 5-hour window and the week a million tokens take, which nobody publishes. Other Claude use in the same minutes
  // and a window reset in between spoil a pair; whoever reads the log drops those.
  const measure = kind === 'cycle' || kind === 'step';
  const reading = () => (usage ? { five_hour: usage.five_hour, seven_day: usage.seven_day, at: new Date(usage.at).toISOString() } : null);
  let before = null;
  // The estimate's median at the start stands in for the run's cost when its transcripts go missing.
  let estUsd = null;
  if (measure) { try { estUsd = Math.round(estimate(kind, id).usd[1] * 100) / 100; } catch { /* no estimate, no stand-in */ } }
  (measure ? probeUsage().then(() => { before = reading(); }) : Promise.resolve()).then(launch).catch(e => {
    Object.assign(job, { running: false, ok: false, message: `${label} did not start: ${e.message}`, finished: new Date().toISOString() });
  });
  return { ok: true, label };

  function launch() {
    const cmd = `start "Queue: ${label}" /wait /d "${LONG_ROOT}" ${CLAUDE} --model ${MODELS[kind]} --session-id ${sessionId} "${prompt}"`;
    const child = spawn('cmd.exe', ['/c', cmd], { cwd: LONG_ROOT, windowsHide: true, windowsVerbatimArguments: true, env: childEnv({ QUEUE_SESSION_ID: sessionId }) });
    let done = false;
    // A cycle or step ends with card-time.js --done after its last board commit. Claude's window would otherwise sit
    // at its prompt until the owner closed it, with the app blocked. On that line, and only with a clean board, the
    // server closes the window; with changes left it stays open for him to look at.
    let closed = null;
    const stopWatch = measure ? watchDone(sessionId, note => serial(async () => {
      if (done || (await boardStatus()).trim()) return;
      closed = { note };
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    })) : () => {};
    const end = code => {
      if (done) return; done = true;
      stopWatch();
      if (closed) code = 0;
      const line = { kind: 'window', job: kind, id: id || null, sessionId, started: job.started, finished: new Date().toISOString() };
      try { fs.appendFileSync(JOBS_FILE, JSON.stringify(line) + '\n', 'utf8'); } catch { /* time only */ }
      if (measure) probeUsage().then(() => {
        const pair = { kind: 'usage', job: kind, id: id || null, sessionId, estUsd, before, after: reading() };
        try { fs.appendFileSync(JOBS_FILE, JSON.stringify(pair) + '\n', 'utf8'); } catch { /* the estimate still works */ }
      });
      serial(async () => {
        const dirty = (await boardStatus()).trim();
        job.ok = code === 0 && !dirty;
        job.message = code !== 0 ? `${label} ended with exit code ${code}.${job.log ? ' ' + job.log : ''}`
          : dirty ? `${label} closed, but the board has uncommitted changes: ${dirty.split('\n').map(l => l.replace(/^\s*\S+\s+/, '')).join(', ')}.`
          : closed ? `${label} finished, window closed by the app.${closed.note ? ' ' + closed.note : ''}`
          : `${label} closed.`;
        await finishWithQueue();
        job.running = false;
        job.finished = new Date().toISOString();
      });
    };
    child.on('error', e => { job.log = e.message; end(-1); });
    child.on('close', end);
  }
}

// What a cycle or one step will likely use, from past runs (scripts/card-time.js): p25, median and p75 of tokens and
// dollars. simulate() draws every part from its past runs, so the range is that of a whole run; adding the parts'
// percentiles up made it far too wide. The parts:
// - each agent card's step: the board-* agents its next_step names. A step that names none is main-session work,
//   which the main thread covers.
// - the main thread and each decided card's step, drawn together from one past cycle (or past step for /q cycle
//   <id>): its main thread scaled to this cycle's card count along the line through past cycles (cycleStats fit),
//   plus its agents' spend per card for each decided card. A decided card's step is only known once the cycle
//   settles it: often no agent, often an implementer or review round. Drawing one whole past run keeps a busy cycle
//   busy throughout; drawing main thread and cards apart caught 4 of 17 past cycles in p25-p75, whole runs 8.
// The dollars are never shown. They only weigh the tokens: models and cache reads cost very differently, and the
// limits follow that more closely than raw tokens (assumed). With a calibration they become points of the 5-hour
// window and of the week, which is what the confirm shows.
const AGENTS = ['board-planner', 'board-implementer', 'board-reviewer'];
// At most one planner per cycle: several planners at once broke alc.exe. The /q skill keeps the same cap; the oldest
// cards get the slot and the rest wait for the next cycle.
const CAPS = { 'board-planner': 1 };
function estimate(kind, id) {
  let ids;
  if (kind === 'step') { cardPath(id || ''); ids = [id]; }
  else if (kind === 'cycle') ids = fs.readdirSync(CARDS).filter(f => /^\d+\.md$/.test(f)).map(f => f.slice(0, -3));
  else throw httpError(400, 'no estimate for ' + kind);
  const cache = refreshTimes();
  const stats = tokenStats(cache), cyc = cycleStats(cache);
  const past = cyc.sessions[kind] || [];
  const parts = [], steps = [], used = {};
  let handled = 0, decided = 0;
  // Oldest change first, as the cycle runs them.
  const cards = ids.map(cid => ({ cid, fm: readCard(cid).fm })).sort((a, b) => (a.fm.updated || '').localeCompare(b.fm.updated || '') || a.cid.localeCompare(b.cid));
  for (const { cid, fm } of cards) {
    if (fm.state === 'decided') {
      handled++; decided++;
      steps.push({ id: cid, step: 'decided', runs: past.length });
      continue;
    }
    if (fm.state !== 'agent') continue;
    const agents = AGENTS.filter(a => (fm.next_step || '').includes(a));
    const full = agents.find(a => CAPS[a] && (used[a] || 0) >= CAPS[a]);
    if (full) { steps.push({ id: cid, step: agents.join(' + '), waits: full }); continue; }
    handled++;
    if (!agents.length) steps.push({ id: cid, step: 'main session', runs: null });
    for (const a of agents) {
      used[a] = (used[a] || 0) + 1;
      const s = stats[a];
      steps.push({ id: cid, step: a, runs: s ? s.runs : 0 });
      if (s) parts.push(s.samples);
    }
  }
  // The main thread with the decided cards, from one past run at a time. A scaled main thread never goes below the
  // cheapest one seen: even a cycle with nothing to do reads the board.
  if (past.length) {
    const at = (key, x) => Math.max(cyc.fit[key].a + cyc.fit[key].b * x, cyc.fit[key].min);
    const scale = (key, x) => (kind === 'cycle' && cyc.fit ? at(key, handled) / at(key, x) : 1);
    parts.push(past.map(p => {
      const each = p.cards ? decided / p.cards : 0;
      return { n: p.main.n * scale('n', p.cards) + each * p.agents.n, usd: p.main.usd * scale('usd', p.cards) + each * p.agents.usd };
    }));
  }
  const mainRuns = past.length;
  const { tokens, usd } = simulate(parts);
  const cal = calibration(cache);
  const left = usage && usage.five_hour ? Math.max(0, Math.round(100 - usage.five_hour.pct)) : null;
  const weekLeft = usage && usage.seven_day ? Math.max(0, Math.round(100 - usage.seven_day.pct)) : null;
  return {
    steps, mainRuns, tokens, usd, left, weekLeft,
    pct: cal.five === null ? null : usd.map(d => Math.round(d * cal.five)),
    weekPct: cal.week === null ? null : usd.map(d => Math.round(d * cal.week * 10) / 10),
  };
}

// p25, median and p75 of the sum of the parts, each part a list of past runs ({ n: tokens, usd }), from 2000 draws
// that take one past run of each part. Seeded (mulberry32), so the same board gives the same numbers every time.
function simulate(parts, draws = 2000) {
  if (!parts.length) return { tokens: [0, 0, 0], usd: [0, 0, 0] };
  let seed = 0x2545f491;
  const rand = () => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const n = [], usd = [];
  for (let d = 0; d < draws; d++) {
    let tn = 0, tu = 0;
    for (const p of parts) { const s = p[Math.floor(rand() * p.length)]; tn += s.n; tu += s.usd; }
    n.push(tn); usd.push(tu);
  }
  const q = a => { a.sort((x, y) => x - y); return [0.25, 0.5, 0.75].map(p => a[Math.round(p * (a.length - 1))]); };
  return { tokens: q(n), usd: q(usd) };
}

// Points of the 5-hour window and of the week per dollar at API prices, from the readings around past cycles and
// steps in app/jobs.jsonl. A run's cost is everything the transcripts show between its two readings (windowCost),
// other sessions included, since the limits count all of it: in 11 of the first 25 pairs other work was 16-41% of
// the spend. When a run's own transcripts are gone, the estimate logged at its start stands in for them. A pair is
// left out when its window reset in between, when the reading went down, or when it reached 100%, since the real use
// is then higher than the reading. The ratio of sums over the newest RECENT_PAIRS: readings are whole percents, so
// one small run's ratio is mostly rounding, and a sum over many evens that out. null while there is no pair.
const RECENT_PAIRS = 20;
function calibration(cache = refreshTimes()) {
  let lines;
  try { lines = fs.readFileSync(JOBS_FILE, 'utf8').split('\n').filter(Boolean); } catch { return { five: null, week: null }; }
  const five = [], week = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.kind !== 'usage' || !j.before || !j.after) continue;
    const all = windowCost(Date.parse(j.before.at), Date.parse(j.after.at), cache), own = sessionCost(j.sessionId, cache);
    const cost = own > 0 ? Math.max(all, own) : j.estUsd > 0 ? all + j.estUsd : 0;
    if (!(cost > 0)) continue;
    const pair = (b, a, out) => { if (b && a && b.resetsAt === a.resetsAt && a.pct >= b.pct && a.pct < 100) out.push({ d: a.pct - b.pct, cost }); };
    pair(j.before.five_hour, j.after.five_hour, five);
    pair(j.before.seven_day, j.after.seven_day, week);
  }
  const ratio = list => {
    const r = list.slice(-RECENT_PAIRS), cost = r.reduce((s, p) => s + p.cost, 0);
    return r.length && cost > 0 ? r.reduce((s, p) => s + p.d, 0) / cost : null;
  };
  return { five: ratio(five), week: ratio(week) };
}
const pointsPerDollar = () => calibration().five;

// Whether the cycle may start its next step; scripts/limit-check.js asks before each one, and on a stop the /q skill
// asks the owner whether to go on anyway. It says stop when the week is
// at 95% or more, or when the 5-hour window plus the step's median estimate would pass 95%. Without a calibration, or
// for a step with no past runs (main-session work), the window alone stops it at 85%. A missing or stale reading
// lets the step go: the gate guards the limits, it shouldn't block a cycle over a failed probe.
async function gate(agent) {
  await probeUsage();
  if (!usage || !usage.five_hour || Date.now() - usage.at > 5 * 60 * 1000) return { go: true, reason: 'no fresh limit reading, going on without the gate' };
  const f = usage.five_hour.pct, w = usage.seven_day ? usage.seven_day.pct : 0;
  if (w >= 95) return { go: false, reason: `the week is at ${w}%` };
  const ppd = pointsPerDollar(), s = agent ? tokenStats()[agent] : null;
  if (ppd !== null && s) {
    const need = Math.round(s.usd[1] * ppd);
    return f + need > 95
      ? { go: false, reason: `the 5-hour window is at ${f}% and ${agent} usually takes about ${need}%` }
      : { go: true, reason: `the 5-hour window is at ${f}%, ${agent} usually takes about ${need}%` };
  }
  return f >= 85
    ? { go: false, reason: `the 5-hour window is at ${f}%; the cap is 85% until there is a calibration` }
    : { go: true, reason: `the 5-hour window is at ${f}%, under 85%` };
}

function adoView() {
  const { running, kind, id, label, terminal, started, finished, ok, message, log } = job;
  return { ...readAdo(), job: { running, kind, id, label, terminal: !!terminal, started, finished, ok, message, log: (log || '').slice(-4000) } };
}

// ---- usage limits ----------------------------------------------------------

// Split a stream into lines and hand each JSON line to onEvent; anything else goes to other.
function streamLines(onEvent, other) {
  let buf = '';
  return d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { other(line + '\n'); continue; }
      onEvent(ev);
    }
  };
}

// "Used 1.2M tokens (14k out)." Cache reads count, since they are most of a session's tokens. Tokens only: the owner
// watches the usage limits, not dollars.
function costLine(r) {
  const u = r.usage || {};
  const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (!total) return '';
  const k = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
  return `Used ${k(total)} tokens (${k(u.output_tokens || 0)} out).`;
}

// The latest 5-hour and weekly use, from any headless run's rate_limit_event. Kept in app/usage.json (gitignored),
// so a restart still shows the last numbers.
const USAGE_FILE = path.join(__dirname, 'usage.json');
let usage = (() => { try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return null; } })();
let probing = false;
let probeRun = null; // the probe in flight, so a second caller waits for its numbers instead of taking older ones

function recordUsage(info, source) {
  const w = info && info.unifiedWindows;
  if (!w) return;
  const win = x => (x && typeof x.utilization === 'number' ? { pct: Math.round(x.utilization * 1000) / 10, resetsAt: x.resetsAt * 1000 } : null);
  usage = { five_hour: win(w.five_hour), seven_day: win(w.seven_day), status: info.status, at: Date.now(), source };
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8'); } catch { /* the numbers still show */ }
}

// A one-word Haiku run, only to read the limits. --restricted skips settings, so no plugin hooks or MCP servers
// load, and it runs outside the board so it never counts as a board session.
function probeUsage() {
  if (probing) return probeRun;
  probing = true;
  return probeRun = new Promise(resolve => {
    const child = spawn(CLAUDE, ['-p', 'Reply with OK.', '--model', MODELS.probe, '--output-format', 'stream-json', '--verbose',
      '--restricted', '--strict-mcp-config', '--tools', 'Read', '--permission-mode', 'dontAsk'],
    { cwd: require('os').tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });
    child.stdout.on('data', streamLines(ev => { if (ev.type === 'rate_limit_event') recordUsage(ev.rate_limit_info, 'probe'); }, () => {}));
    const timer = setTimeout(() => child.kill(), 2 * 60 * 1000);
    const end = () => { clearTimeout(timer); probing = false; resolve(usage); };
    child.on('error', end);
    child.on('close', end);
  });
}

const usageView = () => ({ usage, probing });

// ---- card edits from the app -----------------------------------------------

// Set frontmatter fields and append a dated entry to Decisions, so the card keeps the record of what changed.
// replaced: card lines to write instead of the card's own (checks, reopen), applied before the front matter. entry: null
// writes no Decisions entry.
function updateCard(id, set, entry, replaced) {
  const c = readCard(id);
  const lines = (replaced || c.lines).slice();
  const fmEnd = lines.indexOf('---', 1);
  for (let i = 1; i < fmEnd; i++) {
    const m = /^([a-z_]+):/.exec(lines[i]);
    if (m && Object.prototype.hasOwnProperty.call(set, m[1])) lines[i] = `${m[1]}: ${set[m[1]]}`;
  }
  // An optional field the card doesn't have yet (reviewer) goes in at the end of the front matter.
  const have = new Set(lines.slice(1, fmEnd).map(l => (/^([a-z_]+):/.exec(l) || [])[1]));
  const add = Object.keys(set).filter(k => !have.has(k)).map(k => `${k}: ${set[k]}`);
  lines.splice(fmEnd, 0, ...add);
  // The card's own sections place the entry, so only actions that keep the line count (checks) pass both.
  if (entry) {
    const decisions = c.sections.find(s => s.title === 'Decisions');
    let at = decisions ? decisions.end : lines.length;
    while (at > 0 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, ...(decisions ? ['', ...entry, ''] : ['', '## Decisions', '', ...entry, '']));
  }
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(cardPath(id), text.replace(/\n/g, c.eol), 'utf8');
}

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const oneLine = v => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);
const yesNo = v => v === 'yes' || v === 'no';
const EDITABLE = {
  title: oneLine,
  ado_prio: v => /^[1-4]$/.test(v),
  prod: yesNo,
  blocks_agent: yesNo,
  // Only names the repoCopies pattern in config.json allows, and none when copies are off.
  repo: v => v === 'none' || (config.repoCopies.enabled && config.repoCopies.match.test(v)),
  branch: v => v === 'none' || /^[\w./-]+$/.test(v),
  next_step: oneLine,
  revisit: v => v === 'none' || isDate(v),
};

// The workspace in VS Code's recent list for every copy. The name passes the repo field's own check, so no
// other path reaches the command line.
async function openVsCode(repo) {
  if (repo === 'none' || !EDITABLE.repo(repo)) throw httpError(400, 'bad repo copy');
  const ws = path.join(config.projectsRoot, repo, config.repoCopies.workspace);
  if (!fs.existsSync(ws)) throw httpError(404, 'no workspace at ' + ws);
  await run('cmd.exe', ['/c', 'code', ws]);
  return { ok: true, workspace: ws };
}

// Test edits: for owners who run a protect-tests hook with ~/.claude/scripts/Allow-TestEdits.ps1. The hook reads one
// marker per user, so one unlock covers every repo copy. The route name holds the hook's unlock text, so a Claude
// session that tries to call it from the shell is blocked. Without the script the page hides the button.
const HOME = require('os').homedir();
const TESTS_SCRIPT = path.join(HOME, '.claude', 'scripts', 'Allow-TestEdits.ps1');
const TESTS_MARKER = path.join(HOME, '.claude', 'state', 'tests-allowed-until');
function testEdits() {
  if (!fs.existsSync(TESTS_SCRIPT)) return { available: false, unlocked: false, until: null };
  let until = NaN;
  try { until = Date.parse(fs.readFileSync(TESTS_MARKER, 'utf8').trim()); } catch {}
  return { available: true, unlocked: !isNaN(until) && Date.now() < until, until: isNaN(until) ? null : new Date(until).toISOString() };
}
async function setTestEdits(on) {
  if (!fs.existsSync(TESTS_SCRIPT)) throw httpError(404, 'no ' + TESTS_SCRIPT);
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TESTS_SCRIPT, ...(on ? [] : ['-Off'])]);
  return testEdits();
}

// Hands a card to the Claude Code extension in VS Code: the prompt points at the card file, which is the record,
// so the agent needs no transcript. `wasRunning` lets the page wait for a cold start before it sends the prompt URI.
async function handoff(id) {
  const { fm } = readCard(id);
  const card = cardPath(id).replace(/\\/g, '/');
  const prompt = `Read ${card}. Work in the repo copy and on the branch it names. Start from Now and Waiting on you; ` +
    `read Decisions only when you need why. When you decide something or finish a step, add a dated entry under ` +
    `Decisions and update Now.`;
  const procs = await run('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/NH']);
  const wasRunning = /Code\.exe/i.test(procs);
  const opened = fm.repo && fm.repo !== 'none' ? await openVsCode(fm.repo) : null;
  return { prompt, wasRunning, workspace: opened ? opened.workspace : null,
    uri: 'vscode://anthropic.claude-code/open?prompt=' + encodeURIComponent(prompt) };
}

// The card's `## Test list`: "- [ ] text" lines, ticked in the app. i is the line's place among the check lines.
const CHECK = /^- \[( |x|X)\] (.*)$/;
function testChecks(c) {
  const s = c.sections.find(x => x.title === 'Test list');
  if (!s) return [];
  const out = [];
  for (let ln = s.start + 1; ln < s.end; ln++) {
    const m = CHECK.exec(c.lines[ln]);
    if (m) out.push({ i: out.length, ln, text: m[2].trim(), done: m[1] !== ' ' });
  }
  return out;
}

// ---- re-open -------------------------------------------------------------------

// A decision recorded in the app by mistake is taken back: the questions return to "Waiting on
// you" as they stood before it, its Decisions entry goes (with the cycle's "Means" line under it on an agent card), and
// state, action and next_step go back to what they were. The entry keeps only the picked option, so the questions come
// from git: the card in the commit before its newest "<id>: decided N in the app, to cycle".

// Why a cycle may be working on the card now, or null: a cycle, or a step on this card, started from the app; a
// --mark start in app/jobs.jsonl with no end and no --done after it, under 3 hours old (a cycle run in a terminal; a
// crashed one never writes its end); or uncommitted changes to the card, which a cycle has while it settles it or writes
// a step's result. A terminal cycle that has read the card but not written to it yet isn't seen.
const MARK_MAX_MS = 3 * 3600 * 1000;
async function cycleOn(id) {
  if (job.running && (job.kind === 'cycle' || (job.kind === 'step' && job.id === id))) return `${job.label} is running`;
  let lines = [];
  try { lines = fs.readFileSync(JOBS_FILE, 'utf8').split('\n').filter(Boolean); } catch { /* no marks yet */ }
  let open = null;
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.kind === 'mark' && j.id === id) open = j.edge === 'start' ? j : null;
    else if (j.kind === 'done' && open && j.sessionId && j.sessionId === open.sessionId) open = null;
  }
  if (open && Date.now() - Date.parse(open.at) < MARK_MAX_MS) return `a cycle step on ${id} started at ${new Date(open.at).toTimeString().slice(0, 5)} and hasn't ended`;
  if ((await git('status', '--porcelain', '--', `cards/${id}.md`)).trim()) return `cards/${id}.md has uncommitted changes`;
  return null;
}

// The card's new lines and front matter for a Re-open, or a 409 that says why it can't.
async function reopenPlan(id, c) {
  if (c.fm.state !== 'decided' && c.fm.state !== 'agent') throw httpError(409, `card ${id} is ${c.fm.state}; only decided and agent cards re-open`);
  const busy = await cycleOn(id);
  if (busy) throw httpError(409, busy);
  const file = `cards/${id}.md`;
  const subject = new RegExp(`^${id}: decided \\d+ in the app, to cycle$`);
  const hit = (await git('log', '--format=%H %s', '--', file)).split('\n').find(l => subject.test(l.slice(41)));
  if (!hit) throw httpError(409, `no decision from the app in ${id}'s history`);
  const sha = hit.slice(0, 40);
  // A card that came back to you since has had new questions; taking back the older decision would lose them.
  if (/^\+state: you\r?$/m.test(await git('log', '--format=', '-p', `${sha}..HEAD`, '--', file)))
    throw httpError(409, `${id} came back to you after its last decision from the app`);
  const before = parseCard(await git('show', `${sha}^:${file}`));
  const after = parseCard(await git('show', `${sha}:${file}`));

  // The entry that decision wrote: the last "### " entry under Decisions in the decision's own commit.
  const decisions = x => x.sections.find(s => s.title === 'Decisions');
  const da = decisions(after), dc = decisions(c);
  let k = da ? da.end - 1 : -1;
  while (da && k > da.start && !after.lines[k].startsWith('### ')) k--;
  if (!da || k <= da.start || !dc) throw httpError(409, `can't find the Decisions entry of ${sha.slice(0, 7)}`);
  const entry = after.lines.slice(k, da.end);
  while (entry.length && !entry[entry.length - 1].trim()) entry.pop();
  // Matched by its text, not as the newest entry: park, fields and screenshots write "from the app" entries too.
  let e0 = -1;
  for (let i = dc.end - entry.length; i > dc.start && e0 < 0; i--) if (entry.every((l, j) => c.lines[i + j] === l)) e0 = i;
  if (e0 < 0) throw httpError(409, `the Decisions entry of ${sha.slice(0, 7)} isn't on the card any more`);
  // Up to the next entry: the cycle's "Means" line on a settled card goes with it, later entries stay.
  let e1 = e0 + entry.length;
  while (e1 < dc.end && !c.lines[e1].startsWith('### ')) e1++;

  const wb = before.sections.find(s => s.title === 'Waiting on you');
  const wc = c.sections.find(s => s.title === 'Waiting on you');
  if (!wb || !wc) throw httpError(409, `no Waiting on you section on ${id} ${wb ? 'now' : 'before the decision'}`);
  const had = new Set(before.questions.map(q => `${q.n}. ${q.text}`));
  if (c.questions.some(q => !had.has(`${q.n}. ${q.text}`))) throw httpError(409, `${id} has questions that came after its last decision from the app`);

  const lines = c.lines.slice();
  const edits = [[wc.start + 1, wc.end, before.lines.slice(wb.start + 1, wb.end)], [e0, e1, []]].sort((x, y) => y[0] - x[0]);
  for (const [s, e, ins] of edits) lines.splice(s, e - s, ...ins);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push('');
  return { lines, set: { state: 'you', action: before.fm.action, next_step: before.fm.next_step } };
}

// body: { action: park | done | you | reopen | fields | shots | checks, revisit, note, fields: { name: value }, shots,
//         checks: [{ i, text, done }] }
// dry: check only, write nothing (an edit queued while a job runs).
async function editCard(id, body, dry = false) {
  const c = readCard(id);
  const note = String(body.note || '').trim().replace(/\s*\r?\n\s*/g, ' ');
  const head = `### ${today()}, from the app`;
  const said = note ? [`${OWNER}: "${note}"`] : [];
  let set, entry, msg, replaced, shots = planShots(id, []);
  if (body.action === 'checks') {
    // Ticks change the test list only, with no Decisions entry, so the log doesn't fill with them.
    const list = testChecks(c);
    replaced = c.lines.slice();
    let changed = 0;
    for (const k of Array.isArray(body.checks) ? body.checks : []) {
      const t = list[k.i];
      if (!t || t.text !== String(k.text).trim()) throw httpError(409, `the test list on ${id} changed since; reload the card and tick again`);
      if (t.done === !!k.done) continue;
      t.done = !!k.done; changed++;
      replaced[t.ln] = replaced[t.ln].replace(/^- \[( |x|X)\]/, `- [${t.done ? 'x' : ' '}]`);
    }
    if (!changed) throw httpError(400, 'nothing changed');
    set = {}; entry = null;
    msg = `${id}: test list, ${list.filter(t => t.done).length} of ${list.length} done`;
  } else if (body.action === 'shots') {
    shots = planShots(id, body.shots);
    if (!shots.files.length) throw httpError(400, 'no screenshots to save');
    set = {};
    entry = [head, '', ...said, ...(said.length ? [''] : []), ...shots.lines];
    msg = `${id}: ${shots.files.length} screenshot${shots.files.length === 1 ? '' : 's'} from the app`;
  } else if (body.action === 'park') {
    if (!isDate(body.revisit || '')) throw httpError(400, 'park needs a revisit date');
    set = { state: 'parked', action: 'none', revisit: body.revisit };
    entry = [head, '', `Parked until ${body.revisit}.`, ...said];
    msg = `${id}: parked until ${body.revisit} in the app`;
  } else if (body.action === 'review') {
    // Done on the owner's side, waiting on code review. Back to you or Done takes it out again.
    if (c.fm.state === 'review') throw httpError(409, `card ${id} is already in review`);
    const pr = String(body.pr || '').trim();
    if (!/^\d+$/.test(pr)) throw httpError(400, 'review needs the PR number');
    const reviewer = String(body.reviewer || '').trim() || 'none';
    if (/[\r\n]/.test(reviewer)) throw httpError(400, 'reviewer must be one line');
    set = { state: 'review', action: 'none', next_step: 'none', revisit: 'none', pr, reviewer };
    entry = [head, '', `Sent to code review, PR ${pr}${reviewer !== 'none' ? `, reviewed by ${reviewer}` : ''}.`, ...said];
    msg = `${id}: in review in the app`;
  } else if (body.action === 'done') {
    set = { state: 'done', action: 'none', next_step: 'none', revisit: 'none' };
    entry = [head, '', 'Marked done.', ...said];
    msg = `${id}: done in the app`;
  } else if (body.action === 'you') {
    if (c.fm.state === 'you') throw httpError(409, `card ${id} already waits on you`);
    // Back to you left a decided card with no question (2026-11-18); Re-open replaces it there.
    if (c.fm.state === 'decided' || c.fm.state === 'agent') throw httpError(409, `card ${id} is ${c.fm.state}; use Re-open`);
    set ={ state: 'you', action: c.fm.action === 'none' ? 'decide' : c.fm.action, revisit: 'none' };
    entry = [head, '', `Back to you from ${c.fm.state}.`, ...said];
    msg = `${id}: back to you in the app`;
  } else if (body.action === 'reopen') {
    // No Decisions entry: the commit is the record, and the card reads as if the decision never came.
    const r = await reopenPlan(id, c);
    replaced = r.lines; set = r.set; entry = null;
    msg = `${id}: re-opened in the app`;
  } else if (body.action === 'fields') {
    set = {}; const changed = [];
    for (const [k, v0] of Object.entries(body.fields || {})) {
      const v = String(v0).trim();
      if (!EDITABLE[k]) throw httpError(400, `field ${k} can't be edited here`);
      if (!EDITABLE[k](v)) throw httpError(400, `bad value for ${k}: ${v}`);
      if (c.fm[k] === v) continue;
      set[k] = v; changed.push(`${k} from ${c.fm[k]} to ${v}`);
    }
    if (!changed.length) throw httpError(400, 'nothing changed');
    entry = [head, '', `Changed ${changed.join(', ')}.`, ...said];
    msg = `${id}: ${Object.keys(set).join(', ')} edited in the app`;
  } else throw httpError(400, 'unknown action ' + body.action);
  if (dry) return { ok: true };
  set.updated = today();
  updateCard(id, set, entry, replaced);
  shots.write();
  await inbox();
  const files = [`cards/${id}.md`, 'INBOX.md', ...shots.files];
  await git('add', '--', ...files);
  await git('commit', '-q', '-m', msg, '--', ...files);
  return { ok: true, ...(await pushBoard()) };
}

// ---- code preview ----------------------------------------------------------

// Read-only, and only source and notes under projectsRoot in config.json. No .json, so settings files with
// credentials stay out of reach.
const SNIPPET_ROOT = path.join(config.projectsRoot, path.sep).toLowerCase();
const SNIPPET_EXT = new Set(['.al', '.md', '.diff', '.ps1', '.txt']);

function snippet(q) {
  let raw = q.get('path') || '';
  try { raw = decodeURIComponent(raw); } catch { /* keep as is */ }
  const file = path.resolve(raw);
  if (!file.toLowerCase().startsWith(SNIPPET_ROOT)) throw httpError(403, 'only files under ' + config.projectsRoot);
  const ext = path.extname(file).toLowerCase();
  if (!SNIPPET_EXT.has(ext)) throw httpError(403, 'not a previewable file type');
  if (!fs.existsSync(file)) throw httpError(404, 'file not found: ' + file);
  if (fs.statSync(file).size > 8 * 1024 * 1024) throw httpError(413, 'file too large');
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const total = lines.length;
  const line = Math.min(Math.max(Number(q.get('line')) || 0, 0), total);
  const md = ext === '.md';

  // For AL: the object and the procedure or trigger the line sits in, so the snippet says where it is
  // and shows only that procedure.
  let object = null, proc = null;
  if (ext === '.al') {
    const objRe = /^\s*(codeunit|table|page|report|query|xmlport|enum|interface|tableextension|pageextension|enumextension)\s+\d+\s+(.+?)\s*(extends\b.*)?$/i;
    const declRe = /^\s*(?:\[[^\]]*\]\s*)?(?:local\s+|internal\s+)?(procedure|trigger)\s+([^(;]+)/i;
    for (let i = 0; i < Math.min(total, 40) && !object; i++) { const m = objRe.exec(lines[i]); if (m) object = `${m[1]} ${m[2]}`; }
    for (let i = (line || 1) - 1; i >= 0 && !proc; i--) {
      const m = declRe.exec(lines[i]);
      if (m) proc = { kind: m[1].toLowerCase(), name: m[2].trim(), line: i + 1 };
    }
    if (proc) {
      // The body closes with the first `end;` at the declaration's indent; failing that, stop before the next declaration.
      const indent = /^\s*/.exec(lines[proc.line - 1])[0].length;
      let last = 0;
      for (let i = proc.line; i < total && !last; i++) {
        if (/^\s*end;/i.test(lines[i]) && /^\s*/.exec(lines[i])[0].length === indent) last = i + 1;
        else if (declRe.test(lines[i])) { last = i; while (last > proc.line && /^\s*(\[.*)?$/.test(lines[last - 1])) last--; }
      }
      let first = proc.line;
      while (first > 1 && /^\s*\[/.test(lines[first - 2])) first--;
      // A line between procedures or after the last one isn't in the procedure found above it.
      if ((line || 1) > (last || total)) proc = null;
      else Object.assign(proc, { start: first, end: last || total });
    }
  }

  // Whole procedure when it fits; otherwise the usual window around the line, never past the procedure's edges.
  const lo = proc ? proc.start : 1, hi = proc ? proc.end : total;
  let start, end;
  if (proc && !q.get('before') && !q.get('after') && hi - lo + 1 <= 120) { start = lo; end = hi; }
  else {
    const before = Math.min(Number(q.get('before')) || (md ? 0 : 12), 400);
    const after = Math.min(Number(q.get('after')) || (md ? 600 : 30), 1000);
    start = Math.max(lo, (line || 1) - before);
    end = Math.min(hi, (line || 1) + after);
  }
  return { file, name: path.basename(file), ext: ext.slice(1), total, line, start, end, object, proc, lines: lines.slice(start - 1, end) };
}

// ---- http ------------------------------------------------------------------

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Collect bytes and decode once, so an æ split across two chunks still decodes.
    const chunks = []; let size = 0;
    req.on('data', d => { chunks.push(d); size += d.length; if (size > 1e6) reject(httpError(413, 'too large')); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpError(400, 'bad json')); }
    });
  });
}

// A pasted screenshot comes as raw PNG bytes, not JSON, so it has its own reader and its own size limit.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', d => { if (over) return; size += d.length; if (size > limit) { over = true; reject(httpError(413, `larger than ${limit / 1024 / 1024} MB`)); } else chunks.push(d); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this machine's browser: a page on another site can't reach a Host it doesn't own (DNS rebinding),
    // and a cross-site POST with a JSON content type needs a CORS preflight, which this server never answers.
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1') throw httpError(403, 'wrong host');
    const url = new URL(req.url, 'http://localhost');
    let m;
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && STATIC[url.pathname]) { const [file, type] = STATIC[url.pathname]; return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type); }
    if (req.method === 'GET' && url.pathname === '/api/board') {
      const out = JSON.parse((await inbox('-Json')).replace(/^﻿/, ''));
      const pending = readPending();
      out.queued = pending.filter(e => !e.type).map(e => ({ id: e.id, at: e.at }));
      out.queuedEdits = pending.filter(e => e.type === 'edit').map(e => ({ id: e.id, at: e.at, what: editText(e.body) + (e.shots.length ? ` (+${e.shots.length} screenshot)` : '') }));
      // Started is the card's first transcript day (card-time.js), the same date as the card's Time panel.
      // One refresh() for the whole board: cardTime(id) alone re-reads the transcript index on every call.
      let cache = null;
      try { cache = refreshTimes(); } catch { }
      for (const c of ['you', 'decided', 'agent', 'review', 'parked'].flatMap(k => out[k] || [])) {
        try { const t = cardTime(c.Id, cache || undefined); c.Started = t.first; } catch { c.Started = null; }
      }
      return send(res, 200, out);
    }
    if (req.method === 'GET' && (m = /^\/api\/card\/([^/]+)$/.exec(url.pathname))) return send(res, 200, await cardView(m[1]));
    if (req.method === 'GET' && (m = /^\/api\/time\/([^/]+)$/.exec(url.pathname))) { cardPath(m[1]); return send(res, 200, cardTime(m[1])); }
    if (req.method === 'GET' && url.pathname === '/api/snippet')return send(res, 200, snippet(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/ado') return send(res, 200, adoView());
    if (req.method === 'GET' && url.pathname === '/api/faq') return send(res, 200, { text: fs.readFileSync(path.join(ROOT, 'FAQ.md'), 'utf8').replace(/^﻿/, '') });
    if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, usageView());
    // What the page shows and hides: the owner's name and the optional parts switched on in config.json.
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { owner: OWNER, harvest: config.harvest, repoCopies: config.repoCopies.enabled, testEdits: fs.existsSync(TESTS_SCRIPT) });
    if (req.method === 'GET' && url.pathname === '/api/estimate') return send(res, 200, estimate(url.searchParams.get('kind'), url.searchParams.get('id')));
    if (req.method === 'GET' && (m = /^\/api\/attachment\/([0-9A-Za-z-]+)\/([^/]+)$/.exec(url.pathname))) {
      if (!SHOT_NAME.test(m[2])) throw httpError(400, 'bad file name');
      const f = path.join(ATTACH, m[1], m[2]);
      if (!fs.existsSync(f)) throw httpError(404, 'no such screenshot');
      return send(res, 200, fs.readFileSync(f), 'image/png');
    }
    // image/png isn't a CORS-safelisted type, so a cross-site page can't send this without a preflight either.
    // Staging writes nothing on the board, so it skips the job lock.
    if (req.method === 'POST' && (m = /^\/api\/card\/([^/]+)\/shot$/.exec(url.pathname))) {
      if (req.headers['content-type'] !== 'image/png') throw httpError(415, 'png only');
      return send(res, 200, stageShot(m[1], await readRaw(req, SHOT_MAX)));
    }
    if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'json only');
    // A job commits when it ends, or its window does, so nothing else writes the board while one runs. Checked
    // inside the serial queue, so a write that was waiting behind a job's start sees it too.
    const write = fn => serial(() => { if (job.running) throw httpError(409, `${job.label} is running; wait for it to finish`); return fn(); });
    // The probe writes nothing on the board, so it runs beside a job instead of waiting for one.
    // The cycle's gate (scripts/limit-check.js); it only reads the limits, so it runs beside the cycle's own job.
    if (req.method === 'POST' && url.pathname === '/api/gate') {
      const body = await readBody(req);
      const agent = body && AGENTS.includes(body.agent) ? body.agent : null;
      return send(res, 200, await gate(agent));
    }
    if (req.method === 'POST' && url.pathname === '/api/usage/refresh') {
      await readBody(req);
      await probeUsage();
      return send(res, 200, usageView());
    }
    // Opens a repo copy's AL workspace in VS Code. Writes nothing on the board, so it skips the job lock too.
    if (req.method === 'POST' && url.pathname === '/api/vscode') {
      const body = await readBody(req);
      return send(res, 200, await openVsCode(body.repo));
    }
    // Unlocks (the script's 4 hours) or locks test edits. Writes nothing on the board, so it skips the job lock too.
    if (req.method === 'GET' && url.pathname === '/api/allow-testedits') return send(res, 200, testEdits());
    if (req.method === 'POST' && url.pathname === '/api/allow-testedits') {
      const body = await readBody(req);
      return send(res, 200, await setTestEdits(body.on === true));
    }
    if (req.method === 'POST' && (m = /^\/api\/card\/([^/]+)\/handoff$/.exec(url.pathname))) {
      await readBody(req);
      return send(res, 200, await handoff(m[1]));
    }
    if (req.method === 'POST' && url.pathname === '/api/iteration') {
      const body = await readBody(req);
      return send(res, 200, await write(() => setIteration(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/order') {
      const body = await readBody(req);
      return send(res, 200, await write(() => setOrder(body)));
    }
    if (req.method === 'POST' && (m = /^\/api\/job\/(pull|add|sync|cycle|step|open)$/.exec(url.pathname))) {
      const body = await readBody(req);
      const kind = m[1], id = body.id === undefined ? undefined : String(body.id).trim();
      return send(res, 200, await write(() => (['cycle', 'step', 'open'].includes(kind) ? startTerminal(kind, id) : startHeadless(kind, id))));
    }
    if (req.method === 'POST' && (m = /^\/api\/card\/([^/]+)\/edit$/.exec(url.pathname))) {
      const body = await readBody(req);
      // Like a decision, an edit sent while a job runs waits in the queue instead of being refused.
      return send(res, 200, await serial(() => (job.running ? queueEdit(m[1], body) : editCard(m[1], body))));
    }
    if (req.method === 'POST' && (m = /^\/api\/card\/([^/]+)\/decision$/.exec(url.pathname))) {
      const body = await readBody(req);
      // While a job runs the decision waits in the queue instead of being refused. Checked inside serial(), so one
      // sent while a job is ending lands in the queue before the drain or is recorded after it, never in between.
      return send(res, 200, await serial(() => (job.running ? queueDecision(m[1], body) : decide(m[1], body))));
    }
    throw httpError(404, 'not found');
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

// --open starts the app window once listening. If the app already runs, it opens that one instead of failing.
// With edgeAppId set in config.json it launches the Edge app installed from this page (edge://apps), so the window
// groups under its taskbar pin. The id is Edge's for that install; reinstalling the app gives a new one. Without it,
// the page opens in the default browser.
const EDGE_APP_ID = config.edgeAppId;
const OPEN = process.argv.includes('--open');
const openBrowser = () => execFile('cmd.exe', EDGE_APP_ID
  ? ['/c', 'start', '', 'msedge', '--profile-directory=Default', `--app-id=${EDGE_APP_ID}`]
  : ['/c', 'start', '', `http://localhost:${PORT}`], { windowsHide: true }, () => {});
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && OPEN) { openBrowser(); console.log('Already running, opened it.'); setTimeout(() => process.exit(0), 500); }
  else { console.error(e.message); process.exit(1); }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Queue on http://localhost:${PORT}${PUSH ? '' : ' (no push)'}. Ctrl+C stops it.`);
  // Decisions queued before a restart: no job runs now, so record them.
  if (readPending().length) serial(drainPending).then(lines => console.log(lines.join('\n')), e => console.error('Queued decisions: ' + e.message));
  if (OPEN) openBrowser();
});
