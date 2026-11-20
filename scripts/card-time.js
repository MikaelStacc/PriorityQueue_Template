// Time spent on a card, read from the Claude Code transcripts in ~/.claude/projects.
// node scripts/card-time.js <id> [<id> ...] prints it; the app requires it and calls cardTime(id).
// node scripts/card-time.js --mark <id> start|end logs a cycle step, so it counts even if the transcript goes missing.
// node scripts/card-time.js --done [<line>] logs that an app-started cycle or step is over; the app then closes its window.
// node scripts/card-time.js --tokens prints past token use per board-* agent and per cycle main thread; the app's
// estimate before Cycle and Run next step is built from it.
//
// A transcript line counts for a card when:
// - its gitBranch is cr/<id>_..., so work in a repo copy on the card's branch counts line by line, or
// - the whole transcript is tagged with the card: a session started with /q <id>, /q cycle <id> or /q add <id>,
//   or an agent whose brief names cards\<id>.md (the cycle puts the card path in every brief).
// The time between two lines goes to whoever acted next: to the owner when the next line is their prompt, to Claude
// otherwise. A gap longer than IDLE counts for nobody. Overlaps (agents in parallel, two sessions at once) count once.
// A /q cycle over all cards is tagged with no card, so its main thread counts nowhere; its agents still do.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ROOT = path.resolve(__dirname, '..');
// Per transcript: size, mtime and the intervals found, so a refresh only reads new or grown files. Gitignored.
const CACHE = path.join(ROOT, 'app', 'time-cache.json');
// What the app and the cycle log about their own runs, one JSON line each:
// { kind: 'window', id, sessionId, started, finished }  a terminal window the app opened for a card
// { kind: 'mark', id, edge: 'start' | 'end', at, sessionId }  a cycle step on one card, from --mark
// { kind: 'done', at, sessionId, note }  the cycle's last action, from --done; app/server.js watches for it
// A run whose transcript is missing still counts, as time nobody can split between Claude and the owner.
// App-started cycle sessions have lost their transcripts, agents included; that is why this exists.
const JOBS = path.join(ROOT, 'app', 'jobs.jsonl');
const IDLE = 10 * 60 * 1000;
// 2: each transcript also keeps its token use per model, its agent type and whether it is a cycle's main thread.
// 4: also its first and last message time, the cards a cycle's main thread handled, and its
// dollars per minute (spend), so the app can price everything that ran while a cycle's limit readings were taken.
// spend is priced when the transcript is read, so a change to PRICES needs a new VERSION to take effect there.
const VERSION = 4;
// The estimate uses the newest runs of each kind only: the agents moved between Opus and Sonnet on 2026-11-13, and
// their prompts keep changing, so a run from October says little about the next one.
const RECENT = 20;
// A card path in this board, whatever the board's folder is called.
const BOARD_NAME = path.basename(ROOT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CARD_FILE = new RegExp(BOARD_NAME + '[\\\\/]+cards[\\\\/]+(\\d+)\\.md$', 'i');
const CARD_IN_BRIEF = new RegExp(BOARD_NAME + '[\\\\/]+cards[\\\\/]+(\\d+)\\.md', 'i');
const CARD_IN_COMMAND = /cards[\\/]+(\d+)\.md/gi;
// API prices in $ per million tokens: input, output, 5-minute and 1-hour cache writes, cache reads. From the
// claude-api skill's model table (cached 2026-11-03); writes are 1.25x and 2x input. Cache reads for Haiku 5.5,
// Opus 5 and Sonnet 5 are 0.1x input, assumed. Opus 5 and Sonnet 5 are here because the CLI the cycles ran on until
// 2026-11-13 (2.1.278) resolved `opus` to Opus 5. A model not listed counts in tokens but not in dollars.
const PRICES = {
  'claude-opus-5-5': { i: 4, o: 20, w5: 5, w1: 8, r: 0.2 },
  'claude-opus-5': { i: 5, o: 25, w5: 6.25, w1: 10, r: 0.5 },
  'claude-sonnet-5': { i: 2, o: 10, w5: 2.5, w1: 4, r: 0.2 },
  'claude-sonnet-5-5': { i: 2, o: 10, w5: 2.5, w1: 4, r: 0.1 },
  'claude-haiku-5-5': { i: 0.1, o: 0.5, w5: 0.125, w1: 0.2, r: 0.01 },
  'claude-fable-5-2': { i: 8, o: 40, w5: 10, w1: 16, r: 0.2 },
};

function listTranscripts(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tool-results') listTranscripts(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// The text of a prompt the owner typed, or null for tool results, meta lines and messages the harness injected.
function promptText(ev) {
  if (ev.type !== 'user' || ev.isMeta || !ev.message) return null;
  const c = ev.message.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return null;
    text = c.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  } else return null;
  text = text.trim();
  if (!text || /^<(task-notification|side-sessions-event|ci-monitor-event|local-command-stdout|system-reminder)/.test(text)) return null;
  return text;
}

// /q 8842, /q cycle 8842, /q add 8842 from-app, typed or in the <command-args> form a slash command is stored in.
function tagFromPrompt(text) {
  let m = /^\/q\s+(?:cycle\s+|add\s+)?(\d+)\b/.exec(text);
  if (m) return m[1];
  if (/<command-name>\/q<\/command-name>/.test(text)) {
    m = /<command-args>\s*(?:cycle\s+|add\s+)?(\d+)\b/.exec(text);
    if (m) return m[1];
  }
  return null;
}

// 'cycle' for /q cycle over all cards, 'step' for /q cycle <id>, else null. Same two prompt forms as tagFromPrompt.
function cycleKind(text) {
  let args = null;
  let m = /^\/q\s+(.*)$/s.exec(text);
  if (m) args = m[1];
  else if (/<command-name>\/q<\/command-name>/.test(text)) { m = /<command-args>([^<]*)/.exec(text); args = m ? m[1] : ''; }
  if (args === null || !/^\s*cycle\b/.test(args)) return null;
  return /^\s*cycle\s+\d+\b/.test(args) ? 'step' : 'cycle';
}

const tagFromBrief = text => { const m = CARD_IN_BRIEF.exec(text); return m ? m[1] : null; };

// Dollars at API prices for one model's token counts, 0 for a model not in PRICES.
function priced(model, s) {
  const p = PRICES[model];
  return p ? (s.i * p.i + s.o * p.o + s.w5 * p.w5 + s.w1 * p.w1 + s.r * p.r) / 1e6 : 0;
}

function merge(list) {
  if (!list.length) return list;
  list.sort((a, b) => a[0] - b[0]);
  const out = [list[0].slice()];
  for (const [s, e] of list.slice(1)) {
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

function summarize(file) {
  const isAgent = file.split(path.sep).includes('subagents');
  const text = fs.readFileSync(file, 'utf8');
  const byKey = {}; // key: card id from the branch, or '*' for the whole transcript
  const add = (key, who, s, e) => { ((byKey[key] = byKey[key] || { c: [], u: [] })[who]).push([s, e]); };
  let prev = null, tag = null, firstPrompt = true, sessionId = null, cycle = null, brief = null, first = null, last = null;
  const cards = new Set();
  // A streamed reply is written as several lines with the same message id; the last one carries its final usage.
  const usageById = new Map();
  for (const line of text.split('\n')) {
    if (!line || (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0)) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    const t = Date.parse(ev.timestamp);
    if (ev.type === 'assistant' && ev.message && ev.message.id && ev.message.usage) usageById.set(ev.message.id, { msg: ev.message, t });
    // The cards this transcript wrote or committed; for a cycle's main thread, the cards it handled. Until
    // 2026-11-18 cycles also wrote cards from the shell, so a git command naming the card counts too.
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        if (/^(Edit|Write|MultiEdit)$/.test(b.name)) {
          const m = CARD_FILE.exec(String((b.input && b.input.file_path) || ''));
          if (m) cards.add(m[1]);
        } else if (/^(Bash|PowerShell)$/.test(b.name)) {
          const cmd = String((b.input && b.input.command) || '');
          if (/\bgit\b/.test(cmd)) for (const m of cmd.matchAll(CARD_IN_COMMAND)) cards.add(m[1]);
        }
      }
    }
    if (isNaN(t)) continue;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
    sessionId = sessionId || ev.sessionId || null;
    const prompt = promptText(ev);
    if (prompt !== null && firstPrompt) {
      firstPrompt = false;
      tag = isAgent ? tagFromBrief(prompt) : tagFromPrompt(prompt);
      if (isAgent) brief = prompt;
      else cycle = cycleKind(prompt);
    }
    if (prev !== null && t > prev && t - prev <= IDLE) {
      const who = prompt !== null && !isAgent ? 'u' : 'c';
      add('*', who, prev, t);
      const m = /^cr\/(\d+)_/.exec(ev.gitBranch || '');
      if (m) add(m[1], who, prev, t);
    }
    if (prev === null || t > prev) prev = t;
  }
  for (const k of Object.keys(byKey)) { byKey[k].c = merge(byKey[k].c); byKey[k].u = merge(byKey[k].u); }
  if (!tag) delete byKey['*'];
  // Tokens per model: input, output, 5-minute and 1-hour cache writes, cache reads. spend: dollars per minute.
  const tokens = {}, perMinute = new Map();
  for (const { msg, t } of usageById.values()) {
    const u = msg.usage, model = String(msg.model || '?').replace(/\[.*\]$/, '');
    const cc = u.cache_creation || {};
    const w1 = cc.ephemeral_1h_input_tokens || 0;
    const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens || 0) - w1;
    const one = { i: u.input_tokens || 0, o: u.output_tokens || 0, w5, w1, r: u.cache_read_input_tokens || 0 };
    const s = tokens[model] = tokens[model] || { i: 0, o: 0, w5: 0, w1: 0, r: 0 };
    for (const k of Object.keys(one)) s[k] += one[k];
    const usd = priced(model, one);
    if (usd && !isNaN(t)) { const min = Math.floor(t / 60000); perMinute.set(min, (perMinute.get(min) || 0) + usd); }
  }
  const spend = [...perMinute].sort((a, b) => a[0] - b[0]).map(([min, usd]) => [min, Math.round(usd * 1e5) / 1e5]);
  let agentType = null;
  if (isAgent) { try { agentType = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || null; } catch { /* no meta */ } }
  return { tag, sessionId, byKey, tokens, agentType, cycle, first, last, cards: cycle ? [...cards] : undefined, spend };
}

// Total tokens and dollars at API prices for one transcript's token use.
function tokenCost(tokens) {
  let n = 0, usd = 0;
  for (const [model, s] of Object.entries(tokens || {})) {
    n += s.i + s.o + s.w5 + s.w1 + s.r;
    usd += priced(model, s);
  }
  return { n, usd };
}

const quartiles = list => { const a = list.slice().sort((x, y) => x - y), q = p => a[Math.round(p * (a.length - 1))]; return [q(0.25), q(0.5), q(0.75)]; };

// The model a run spent most of its output on.
function runModel(tokens) {
  let best = null, most = -1;
  for (const [model, s] of Object.entries(tokens || {})) if (s.o > most) { best = model; most = s.o; }
  return best;
}

// Past runs per kind, newest first: each board-* agent by its type, 'cycle' for the main thread of /q cycle and 'step' for /q cycle <id>. Only runs on the model of the kind's newest
// run count, so a switch between Opus and Sonnet starts a fresh history with the first run on the new model; at most
// RECENT of them.
function pastRuns(cache = refresh()) {
  const byKind = {};
  for (const f of Object.values(cache.files)) {
    const agent = f.agentType && /^board-/.test(f.agentType) ? f.agentType : null;
    const kinds = agent ? [agent] : f.cycle ? [f.cycle] : [];
    if (!kinds.length) continue;
    const c = tokenCost(f.tokens);
    if (!c.n) continue;
    const run = { n: c.n, usd: c.usd, model: runModel(f.tokens), at: f.last || f.mtime, f };
    for (const k of kinds) (byKind[k] = byKind[k] || []).push(run);
  }
  for (const k of Object.keys(byKind)) {
    const list = byKind[k].sort((a, b) => b.at - a.at);
    byKind[k] = list.filter(r => r.model === list[0].model).slice(0, RECENT);
  }
  return byKind;
}

// Past token use per kind of run (pastRuns), for estimating the next one: the runs as samples of tokens (n) and
// dollars, their count, p25, median and p75 of each, and the model they ran on.
function tokenStats(cache = refresh()) {
  const out = {};
  for (const [kind, list] of Object.entries(pastRuns(cache))) {
    out[kind] = { runs: list.length, model: list[0].model, tokens: quartiles(list.map(r => r.n)), usd: quartiles(list.map(r => r.usd)), samples: list.map(r => ({ n: r.n, usd: r.usd })) };
  }
  return out;
}

// Past cycles and steps as whole runs (pastRuns 'cycle' and 'step'): how many cards the main thread handled (it
// writes or commits each one), its own tokens and dollars, and what the agents it started spent (they carry its
// session id). Also, for /q cycle, the least-squares line through the main thread's tokens and dollars against its
// card count ({ a, b }: a + b x cards): the more cards, the more the main thread reads and writes.
function cycleStats(cache = refresh()) {
  const runs = pastRuns(cache);
  const agents = {};
  for (const f of Object.values(cache.files)) {
    if (!f.agentType || !/^board-/.test(f.agentType) || !f.sessionId) continue;
    const c = tokenCost(f.tokens), a = agents[f.sessionId] = agents[f.sessionId] || { n: 0, usd: 0 };
    a.n += c.n; a.usd += c.usd;
  }
  const sessions = {};
  for (const kind of ['cycle', 'step']) {
    sessions[kind] = (runs[kind] || []).filter(r => r.f.cards).map(r => ({ cards: r.f.cards.length, main: { n: r.n, usd: r.usd }, agents: agents[r.f.sessionId] || { n: 0, usd: 0 } }));
  }
  const past = sessions.cycle;
  const line = key => {
    const k = past.length, mx = past.reduce((s, p) => s + p.cards, 0) / k, my = past.reduce((s, p) => s + p.main[key], 0) / k;
    const sxx = past.reduce((s, p) => s + (p.cards - mx) ** 2, 0), sxy = past.reduce((s, p) => s + (p.cards - mx) * (p.main[key] - my), 0);
    // Too little spread in card counts, or a line that falls with more cards: the mean, flat.
    const b = sxx > 0 && sxy > 0 ? sxy / sxx : 0;
    return { a: my - b * mx, b, min: Math.min(...past.map(p => p.main[key])) };
  };
  return { sessions, fit: past.length ? { n: line('n'), usd: line('usd') } : null };
}

// Dollars at API prices of everything in the transcripts between two times, whatever session it belongs to: a
// cycle's limit readings move with all Claude use in those minutes, not only the cycle's own.
function windowCost(from, to, cache = refresh()) {
  const a = Math.floor(from / 60000), b = Math.floor(to / 60000);
  let usd = 0;
  for (const f of Object.values(cache.files)) {
    if (!f.spend || !f.spend.length || f.spend[0][0] > b || f.spend[f.spend.length - 1][0] < a) continue;
    for (const [min, d] of f.spend) if (min >= a && min <= b) usd += d;
  }
  return usd;
}

function loadCache() {
  try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.version === VERSION) return c; } catch { /* rebuild */ }
  return { version: VERSION, files: {} };
}

// Reads new and changed transcripts, drops deleted ones, and saves the cache when anything changed.
function refresh() {
  const cache = loadCache();
  const seen = new Set();
  let changed = false;
  for (const file of listTranscripts(PROJECTS)) {
    seen.add(file);
    let st; try { st = fs.statSync(file); } catch { continue; }
    const hit = cache.files[file];
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) continue;
    try { cache.files[file] = { size: st.size, mtime: st.mtimeMs, ...summarize(file) }; changed = true; }
    catch { /* a file being written; next refresh */ }
  }
  for (const f of Object.keys(cache.files)) if (!seen.has(f)) { delete cache.files[f]; changed = true; }
  if (changed) fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
  return cache;
}

function readJobs() {
  try {
    return fs.readFileSync(JOBS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const total = list => merge(list).reduce((n, [s, e]) => n + (e - s), 0);

// Hours in half-hour steps the way Harvest is logged: one card on one local day is one entry, so the minutes are
// summed per day and each day rounded on its own. Whole half hours count as they are; what is left over counts as
// another half hour from 10 minutes, and not at all below that (8 min 0, 12 min 0.5, 35 min 0.5, 42 min 1.0).
// A stretch past midnight is split so each side counts on its own day. Asked for on 2026-11-12.
function halfHours(list) {
  const byDay = new Map();
  for (const [s0, e] of merge(list)) {
    let s = s0;
    while (s < e) {
      const d = new Date(s);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const end = Math.min(e, next);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      byDay.set(key, (byDay.get(key) || 0) + (end - s));
      s = end;
    }
  }
  let h = 0;
  for (const ms of byDay.values()) {
    const min = ms / 60000;
    h += Math.floor(min / 30) * 0.5 + (min % 30 >= 10 ? 0.5 : 0);
  }
  return h;
}

// { claudeMs, youMs, windowMs, claudeH, youH, windowH, sessions, first, last } for one card. The *Ms values are the
// measured time, the *H values the same in half-hour steps (halfHours). windowMs is the time of app-started windows
// and cycle steps for this card whose transcript is missing, so neither Claude's nor the owner's share is known.
function cardTime(id, cache = refresh()) {
  const c = [], u = [], sessions = new Set(), withTranscript = new Set();
  for (const f of Object.values(cache.files)) {
    if (f.sessionId) withTranscript.add(f.sessionId);
    const parts = [];
    if (f.tag === id && f.byKey['*']) parts.push(f.byKey['*']);
    else if (f.byKey[id]) parts.push(f.byKey[id]);
    for (const p of parts) {
      c.push(...p.c); u.push(...p.u);
      if (p.c.length || p.u.length) sessions.add(f.sessionId);
    }
  }
  const win = [], open = new Map();
  for (const j of readJobs()) {
    if (j.id !== id || (j.sessionId && withTranscript.has(j.sessionId))) continue;
    if (j.kind === 'window' && j.started && j.finished) win.push([Date.parse(j.started), Date.parse(j.finished)]);
    else if (j.kind === 'mark' && j.edge === 'start') open.set(j.sessionId || '', Date.parse(j.at));
    else if (j.kind === 'mark' && j.edge === 'end' && open.has(j.sessionId || '')) {
      win.push([open.get(j.sessionId || ''), Date.parse(j.at)]);
      open.delete(j.sessionId || '');
    }
  }
  const all = merge([...c, ...u]);
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  return {
    claudeMs: total(c),
    youMs: total(u),
    windowMs: total(win),
    claudeH: halfHours(c),
    youH: halfHours(u),
    windowH: halfHours(win),
    sessions: sessions.size,
    first: all.length ? day(all[0][0]) : null,
    last: all.length ? day(all[all.length - 1][1]) : null,
  };
}

function mark(id, edge) {
  if (!/^\d+$/.test(id || '') || !['start', 'end'].includes(edge)) throw new Error('usage: --mark <id> start|end');
  const line = { kind: 'mark', id, edge, at: new Date().toISOString(), sessionId: process.env.QUEUE_SESSION_ID || null };
  fs.appendFileSync(JOBS, JSON.stringify(line) + '\n', 'utf8');
}

// Without QUEUE_SESSION_ID the cycle runs in a window the app didn't open, so there is nothing to close.
function markDone(note) {
  const sessionId = process.env.QUEUE_SESSION_ID;
  if (!sessionId) return;
  const line = { kind: 'done', at: new Date().toISOString(), sessionId, note: note || null };
  fs.appendFileSync(JOBS, JSON.stringify(line) + '\n', 'utf8');
}

// Dollars at API prices for one Claude Code session, main thread and agents together (an agent's lines carry its
// parent's session id). 0 when its transcripts are gone.
function sessionCost(sessionId, cache = refresh()) {
  let usd = 0;
  for (const f of Object.values(cache.files)) if (f.sessionId === sessionId) usd += tokenCost(f.tokens).usd;
  return usd;
}

module.exports = { cardTime, tokenStats, cycleStats, windowCost, sessionCost, refresh, JOBS };

if (require.main === module && process.argv[2] === '--mark') {
  mark(process.argv[3], process.argv[4]);
} else if (require.main === module && process.argv[2] === '--done') {
  markDone(process.argv.slice(3).join(' '));
} else if (require.main === module && process.argv[2] === '--tokens') {
  const k = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k');
  const cache = refresh();
  for (const [kind, s] of Object.entries(tokenStats(cache)).sort()) {
    console.log(`${kind}: ${s.runs} runs on ${s.model}, tokens ${s.tokens.map(k).join(' / ')} (p25 / median / p75)`);
  }
  const c = cycleStats(cache);
  if (c.fit) console.log(`cycle main thread: ${k(Math.max(c.fit.n.a, 0))} + ${k(c.fit.n.b)} per card, from ${c.sessions.cycle.length} cycles`);
  const rate = c.sessions.cycle.filter(s => s.cards).map(s => s.agents.n / s.cards);
  if (rate.length) console.log(`agents per card a cycle handled: tokens ${quartiles(rate).map(k).join(' / ')}`);
} else if (require.main === module) {
  const t0 = Date.now();
  const cache = refresh();
  const h = (hours, ms) => `${hours.toFixed(1)} h (${Math.round(ms / 60000)} min)`;
  for (const id of process.argv.slice(2)) {
    const r = cardTime(id, cache);
    console.log(`${id}: Claude ${h(r.claudeH, r.claudeMs)}, you ${h(r.youH, r.youMs)}${r.windowMs ? `, window without transcript ${h(r.windowH, r.windowMs)}` : ''}, ${r.sessions} sessions, ${r.first || '-'} to ${r.last || '-'}`);
  }
  console.error(`(${Object.keys(cache.files).length} transcripts, ${Date.now() - t0} ms)`);
}
