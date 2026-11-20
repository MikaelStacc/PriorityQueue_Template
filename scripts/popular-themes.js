// Builds app/themes-popular.css and app/themes-popular.js from the most-installed colour themes on the VS Code Marketplace.
// Run: node scripts/popular-themes.js <work dir>   (the work dir holds the downloaded .vsix files; use an empty scratch folder)
// It takes extensions in install order, up to MAX_PER_EXT variants each, until it has COUNT themes, drops the SKIP ones,
// then adds the EXTRA ones. No packages needed. The app never calls the Marketplace; rerun this to refresh the list.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COUNT = 50;
const MAX_PER_EXT = 3;
// Near-copies of a theme that stays, or grey/white with a blue accent like the rest. Dropped after the install pass,
// so they still use up their place in COUNT and MAX_PER_EXT and the pass picks the same set as without them.
const SKIP = new Set([
  'One Dark Pro Flat', 'One Dark Pro Darker', 'Atom One Dark', 'One Monokai', 'Theme (tal7aouy)', 'Theme Flat (tal7aouy)', 'Theme Mix (tal7aouy)',
  'Andromeda Bordered', 'Palenight (Mild Contrast)', 'Bearded Theme Monokai Terra', 'Catppuccin Macchiato', 'Tokyo Night Storm',
  'Material Theme Darker', 'Monokai Pro (Filter Octagon)', 'Winter is Coming (Dark Black)', 'Dracula Theme Soft', 'GitHub Dark Dimmed',
  '2017 Dark (Visual Studio - C/C++)', 'GitHub Light Default', 'Material Theme Lighter', 'Ayu Light', 'Atom One Light',
]);
// Less-installed themes with a look of their own (a tinted background, a non-blue accent): [extension id, variant labels].
const EXTRA = [
  ['liviuschera.noctis', ['Noctis Bordo', 'Noctis Azureus', 'Noctis Lux']],
  ['jdinhlife.gruvbox', ['Gruvbox Dark Medium', 'Gruvbox Light Medium']],
  ['mvllow.rose-pine', ['Rosé Pine', 'Rosé Pine Dawn']],
  ['ryanolsonx.solarized', ['Solarized Dark+', 'Solarized Light+']],
  ['sainnhe.everforest', ['Everforest Dark', 'Everforest Light']],
  ['qufiwefefwoyn.kanagawa', ['Kanagawa']],
  ['alexandernanberg.horizon-theme-vscode', ['Horizon']],
  ['silofy.hackthebox', ['Hack The Box']],
  ['tinkertrain.theme-panda', ['Panda Syntax']],
  ['max-SS.cyberpunk', ['Cyberpunk']],
  ['UstymUkhman.matrix-theme', ['Matrix']],
  ['raunofreiberg.vesper', ['Vesper']],
  ['onecrayon.theme-quietlight-vsc', ['Quiet Light for VSC']],
];
// Themes the mapping turns into one colour: which of the theme's own keys to use instead. text: body text,
// muted: secondary text, warn: warnings. Cyberpunk's editor text, accent and warning are all
// neon green; in VS Code the code colours and the white UI text balance that, in the app nothing would.
const TWEAK = {
  Cyberpunk: { text: 'foreground', muted: 'sideBar.foreground', warn: 'gitDecoration.conflictingResourceForeground' },
};
const APP = path.join(__dirname, '..', 'app');
const WORK = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node scripts/popular-themes.js <work dir>'); process.exit(1); }
// Windows' own tar reads zip; Git Bash's GNU tar doesn't.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// ---- Marketplace ----------------------------------------------------------------------------------------------

const topThemeExtensions = pageSize => queryExtensions([
  { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
  { filterType: 5, value: 'Themes' },
  { filterType: 12, value: '4096' }, // leave out unpublished
], pageSize);
// filterType 7 is the extension's full name, publisher.extension.
const extensionsById = ids => queryExtensions(ids.map(value => ({ filterType: 7, value })), ids.length);

async function queryExtensions(criteria, pageSize) {
  const body = {
    filters: [{ criteria, pageNumber: 1, pageSize, sortBy: 4 /* installs */, sortOrder: 0 }],
    flags: 914, // files, version properties, asset URI, statistics, latest version only
  };
  const r = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Marketplace query failed: ' + r.status);
  const j = await r.json();
  return j.results[0].extensions.map(e => ({
    id: `${e.publisher.publisherName}.${e.extensionName}`,
    name: e.displayName,
    installs: (e.statistics.find(s => s.statisticName === 'install') || {}).value || 0,
    vsix: e.versions[0].files.find(f => f.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage').source,
  }));
}

async function unpack(ext) {
  const dir = path.join(WORK, ext.id);
  if (!fs.existsSync(path.join(dir, 'extension', 'package.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    const r = await fetch(ext.vsix);
    if (!r.ok) throw new Error(`${ext.id}: download failed ${r.status}`);
    const file = path.join(dir, 'ext.vsix');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    // Only the JSON: package.json and the theme files. In tar patterns * also crosses folders.
    execFileSync(TAR, ['-xf', file, '-C', dir, 'extension/*.json'], { stdio: 'ignore' });
  }
  return path.join(dir, 'extension');
}

// ---- theme files ----------------------------------------------------------------------------------------------

// Theme files are JSON with comments and trailing commas. Strip both outside strings.
function parseJsonc(text) {
  let out = '', i = 0, inStr = false;
  text = text.replace(/^\uFEFF/, '');
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Follows "include" so a variant that extends a base theme gets the base's colours first.
function loadTheme(file, depth = 0) {
  const t = parseJsonc(fs.readFileSync(file, 'utf8'));
  let colors = {}, tokens = [];
  if (t.include && depth < 5) {
    const base = loadTheme(path.join(path.dirname(file), t.include), depth + 1);
    colors = base.colors; tokens = base.tokens;
  }
  Object.assign(colors, t.colors || {});
  if (Array.isArray(t.tokenColors)) tokens = tokens.concat(t.tokenColors);
  return { colors, tokens, type: t.type };
}

// The colour a theme gives a TextMate scope: the rule with the longest selector that is the scope or a parent of it.
function scopeColor(tokens, scope) {
  let best = null, bestLen = -1;
  for (const r of tokens) {
    const fg = r.settings && r.settings.foreground;
    if (!fg) continue;
    const sels = (Array.isArray(r.scope) ? r.scope : String(r.scope || '').split(',')).map(s => s.trim()).filter(s => s && !s.includes(' '));
    for (const s of sels) if ((scope === s || scope.startsWith(s + '.')) && s.length >= bestLen) { best = fg; bestLen = s.length; }
  }
  return best;
}

// ---- colour helpers -------------------------------------------------------------------------------------------

const hexRe = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ok = v => typeof v === 'string' && hexRe.test(v.trim());
function rgb(hex) {
  let h = hex.slice(1);
  if (h.length <= 4) h = h.split('').map(x => x + x).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const opaque = v => ok(v) && !(v.length === 9 && parseInt(v.slice(7), 16) < 0xf0) && !(v.length === 5 && parseInt(v[4], 16) < 0xf);
function lum(hex) {
  const [r, g, b] = rgb(hex).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// A colour as OKLab [lightness, a, b], where equal distances look about equally different.
function oklab(hex) {
  const [r, g, b] = rgb(hex).map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
// How colourful a colour is: OKLab chroma, 0 for greys, about 0.1 and up for a clear hue.
const chroma = hex => { const [, a, b] = oklab(hex); return Math.hypot(a, b); };
// Under 0.08 two colours read as the same one at chip size.
const apart = (v, others) => others.every(o => { const [x, y] = [oklab(v), oklab(o)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) >= 0.08; });
const pick = (...v) => v.find(ok);
const pickOpaque = (...v) => v.find(opaque);
const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
// The same mix as a hex, for colours whose contrast the script has to check.
const hexMix = (a, pct, b) => '#' + rgb(a).map((x, i) => Math.round(x * pct / 100 + rgb(b)[i] * (1 - pct / 100)).toString(16).padStart(2, '0')).join('');
// Text for a filled colour: the theme's own if it reads, else whichever of the two candidates reads better.
const textOn = (fill, own, ...cands) => (opaque(own) && contrast(own, fill) >= 3) ? own : cands.sort((a, b) => contrast(b, fill) - contrast(a, fill))[0];

// ---- mapping a VS Code theme onto the app's tokens --------------------------------------------------------------

function toTokens(theme, uiTheme, tweak = {}) {
  const c = theme.colors, t = theme.tokens;
  const dark = uiTheme ? /dark|black/i.test(uiTheme) : theme.type !== 'light';
  const bg = pickOpaque(c['editor.background']) || (dark ? '#1e1e1e' : '#ffffff');
  const fg = pickOpaque(c[tweak.text], c['editor.foreground'], c.foreground) || (dark ? '#d4d4d4' : '#1f1f1f');
  const side = pickOpaque(c['sideBar.background'], c['activityBar.background']) || bg;
  const head = pickOpaque(c['titleBar.activeBackground'], c['activityBar.background'], c['sideBar.background']) || side;
  // Each app colour comes from the VS Code key with the same job, so the theme looks the way its maker set it.
  // When that colour doesn't read on the background it is lightened (dark theme) or darkened (light theme) until it does,
  // keeping its hue; the VS Code default only comes in when the theme sets none of the keys.
  const tone = (v, min = 3.5) => {
    if (!opaque(v)) return null;
    for (let p = 100; p > 0; p -= 5) { const m = p === 100 ? v : hexMix(v, p, dark ? '#ffffff' : '#000000'); if (contrast(m, bg) >= min) return m; }
    return dark ? '#ffffff' : '#000000';
  };
  const first = (...v) => tone(v.find(opaque));
  const kw = scopeColor(t, 'keyword.control') || scopeColor(t, 'keyword') || scopeColor(t, 'storage.type');
  // The app's accent marks what is selected, active or counted: in VS Code that is the badge and the active-tab or
  // activity-bar border. Links get their own token below. Greys are passed over: the app fills selected items and
  // badges with the accent, so a grey one would leave the app with no colour at all.
  const accentKeys = [c['activityBarBadge.background'], c['tab.activeBorder'], c['activityBar.activeBorder'], c['list.highlightForeground'],
    c['focusBorder'], c['button.background'], c['textLink.foreground'], kw];
  const accent = tone(accentKeys.find(v => opaque(v) && chroma(v) >= 0.06)) || first(...accentKeys) || (dark ? '#4daafc' : '#005fb8');
  const link = first(c['textLink.foreground']) || accent;
  const brand = pickOpaque(c['button.background']) || accent;
  const onBrand = textOn(brand, c['button.foreground'], '#ffffff', '#000000', bg, fg);
  // Muted text: the theme's description colour if it is opaque and reads, else the text faded until it still reads.
  let muted = [c[tweak.muted], c.descriptionForeground].find(v => opaque(v) && contrast(v, bg) >= 3.2) || null;
  for (let p = 65; !muted; p += 5) { const m = hexMix(fg, Math.min(p, 100), bg); if (p >= 100 || contrast(m, bg) >= 3.2) muted = m; }
  // Error, warning and OK must look like red, yellow-orange and green (OKLab hue, degrees), and different from the accent
  // and from each other, or the chips all read as one colour. Each takes the first of its keys that does, else the
  // VS Code default, else a second default of a nearby hue; when nothing does, its first key in the hue range, else its first key as before.
  const signal = (keys, fallbacks, [lo, hi], others) => {
    const cands = [...keys.filter(opaque), ...fallbacks].map(v => tone(v));
    const inHue = v => { const [, a, b] = oklab(v); let h = Math.atan2(b, a) * 180 / Math.PI; if (h < lo) h += 360; return h <= hi; };
    return cands.find(v => inHue(v) && apart(v, others)) || cands.find(inHue) || cands[0];
  };
  const bad = signal([c['editorError.foreground'], c['terminal.ansiRed'], c['errorForeground'], c['terminal.ansiBrightRed'],
    c['gitDecoration.deletedResourceForeground']], dark ? ['#f14c4c', '#ff7a45'] : ['#e51400', '#c2410c'], [-25, 45], [accent]);
  const warn = signal([c[tweak.warn], c['editorWarning.foreground'], c['terminal.ansiYellow'], c['list.warningForeground'],
    c['terminal.ansiBrightYellow'], c['gitDecoration.modifiedResourceForeground']], dark ? ['#cca700', '#f0883e'] : ['#bf8803', '#c25e00'], [35, 115], [accent, bad]);
  const good = signal([c['gitDecoration.addedResourceForeground'], c['terminal.ansiGreen'], c['editorGutter.addedBackground'],
    c['terminal.ansiBrightGreen'], c['gitDecoration.untrackedResourceForeground']], dark ? ['#73c991', '#4ec9b0'] : ['#388a34', '#0f7b6c'], [100, 200], [accent, bad, warn]);
  const magenta = first(c['terminal.ansiMagenta'], c['terminal.ansiBrightMagenta']);
  const cyan = first(c['terminal.ansiCyan'], c['terminal.ansiBrightCyan']);
  // The usage bar along the bottom is the app's status bar. Its text is what VS Code shows there: the theme's status bar
  // text, or VS Code's default white when the theme colours the bar but not its text. The bar is small and the maker
  // chose the pair, so 2.5 is enough; below that the app's muted text, else the best of the text colour, white or black.
  const statusBg = pickOpaque(c['statusBar.background']) || head;
  const statusOwn = pickOpaque(c['statusBar.foreground']) || (opaque(c['statusBar.background']) ? '#ffffff' : null);
  const statusFg = [[statusOwn, 2.5], [muted, 3]].filter(([v, min]) => v && contrast(v, statusBg) >= min).map(([v]) => v)[0]
    || [fg, '#ffffff', '#000000'].sort((a, b) => contrast(b, statusBg) - contrast(a, statusBg))[0];
  const tk = {
    kw: kw || accent,
    str: scopeColor(t, 'string.quoted.double') || scopeColor(t, 'string') || good,
    id: scopeColor(t, 'variable.other') || scopeColor(t, 'variable') || scopeColor(t, 'entity.name.type') || fg,
    cm: scopeColor(t, 'comment.line') || scopeColor(t, 'comment') || mix(fg, 50, bg),
    num: scopeColor(t, 'constant.numeric') || warn,
    fn: scopeColor(t, 'entity.name.function') || scopeColor(t, 'support.function') || accent,
  };
  const soft = v => mix(v, 16, bg);
  // The Test and Explain chips sit side by side: Explain takes the first of its colours that differs from Test's.
  const test = magenta || tk.kw;
  const explain = [cyan, tk.fn, tk.str, link].find(v => ok(v) && apart(v, [test])) || cyan || tk.fn;
  const out = {
    'color-scheme': dark ? 'dark' : 'light',
    '--serif': 'var(--sans)',
    '--head-bg': head, '--nav-bg': side, '--pane-bg': side,
    '--bg': bg, '--panel': mix(fg, dark ? 5 : 3, bg), '--panel-2': mix(fg, dark ? 9 : 6, bg),
    // Titles (card heading, header counts) in the accent, at body-text contrast.
    '--text': fg, '--title': tone(accent, 4.5), '--muted': muted,
    '--faint': mix(fg, 42, bg), '--line': mix(fg, 16, bg), '--line-2': mix(fg, 10, bg),
    '--accent': accent, '--accent-2': mix(accent, 80, fg), '--accent-soft': soft(accent), '--accent-line': mix(accent, 45, bg),
    '--on-accent': textOn(accent, c['activityBarBadge.foreground'], bg, '#ffffff', '#000000'), '--sel-bar': accent, '--link': link,
    '--status-bg': statusBg, '--status-fg': statusFg, '--status-strong': statusFg, '--status-faint': mix(statusFg, 70, statusBg),
    '--brand': brand, '--brand-2': mix(brand, 85, fg), '--on-brand': onBrand,
    '--warn': warn, '--warn-soft': soft(warn), '--bad': bad, '--bad-soft': soft(bad), '--ok': good, '--ok-soft': soft(good),
    '--code-bg': bg, '--code-line': mix(warn, dark ? 14 : 20, bg), '--code-num': pickOpaque(c['editorLineNumber.foreground']) || mix(fg, 40, bg),
    '--tk-kw': tk.kw, '--tk-str': tk.str, '--tk-id': tk.id, '--tk-cm': tk.cm, '--tk-num': tk.num, '--tk-fn': tk.fn,
    '--agent': test,
    '--act-test': test, '--act-test-soft': soft(test),
    '--act-explain': explain, '--act-explain-soft': soft(explain),
    '--shadow': dark ? '0 1px 2px rgba(0, 0, 0, .3), 0 2px 10px rgba(0, 0, 0, .25)' : '0 1px 2px rgba(0, 0, 0, .05), 0 2px 8px rgba(0, 0, 0, .04)',
  };
  return { dark, out };
}

// ---- main -----------------------------------------------------------------------------------------------------

// An extension's colour theme variants (the JSON ones), or null when it has none.
async function variants(ext) {
  let dir;
  try { dir = await unpack(ext); } catch (e) { console.log(`skip ${ext.id}: ${e.message}`); return null; }
  const pkg = parseJsonc(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const list = ((pkg.contributes || {}).themes || []).filter(x => /\.json$/i.test(x.path || ''));
  if (!list.length) { console.log(`skip ${ext.id}: no colour themes (icon pack or .tmTheme)`); return null; }
  return { dir, list };
}

const themes = [], seen = new Set();

// Maps one variant and adds it to themes. False when it is skipped (same name or colours as one already in, no colours).
function addVariant(ext, dir, v) {
  let label = String(v.label || v.id || ext.name);
  if (label.startsWith('%')) label = ext.name;
  if (/^theme\b/i.test(label)) label += ` (${ext.id.split('.')[0]})`; // a pack literally called "Theme"
  if (seen.has(label.toLowerCase())) return false;
  let theme;
  try { theme = loadTheme(path.join(dir, v.path)); } catch (e) { console.log(`skip ${label}: ${e.message}`); return false; }
  if (!theme.colors['editor.background'] && !theme.tokens.length) { console.log(`skip ${label}: no colours`); return false; }
  const mapped = toTokens(theme, v.uiTheme, TWEAK[label]);
  const sig = JSON.stringify(mapped.out);
  if (seen.has(sig)) { console.log(`skip ${label}: same colours as another variant`); return false; }
  const id = 'p-' + label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  seen.add(label.toLowerCase()); seen.add(sig);
  themes.push({ id, label, ext: ext.id, installs: ext.installs, ...mapped });
  return true;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const exts = await topThemeExtensions(120);
  for (const ext of exts) {
    if (themes.length >= COUNT) break;
    const found = await variants(ext);
    if (!found) continue;
    const { dir, list } = found;
    // Within a pack: the first dark and first light variant, then the rest in the pack's order.
    // Accessibility and font-style variants (high contrast, colourblind, italics, borders) go last.
    const niche = v => /high contrast|colou?rblind|tritanopia|deuteranopia|italic|bordered|operator|\(beta\)/i.test(v.label || '');
    const isDark = v => /dark|black/i.test(v.uiTheme || '');
    const main = list.filter(v => !niche(v)), firsts = [main.find(isDark), main.find(v => !isDark(v))].filter(Boolean);
    const ordered = [...firsts, ...main.filter(v => !firsts.includes(v)), ...list.filter(niche)];
    let taken = 0;
    for (const v of ordered) {
      if (themes.length >= COUNT || taken >= MAX_PER_EXT) break;
      if (addVariant(ext, dir, v)) taken++;
    }
  }
  for (let i = themes.length - 1; i >= 0; i--) if (SKIP.has(themes[i].label)) themes.splice(i, 1);
  const skipped = [...SKIP].filter(l => !seen.has(l.toLowerCase()));
  if (skipped.length) console.log(`SKIP labels not in the install pass (rename or remove them): ${skipped.join(', ')}`);

  const extra = await extensionsById(EXTRA.map(([id]) => id));
  for (const [id, labels] of EXTRA) {
    const ext = extra.find(e => e.id.toLowerCase() === id.toLowerCase());
    const found = ext && await variants(ext);
    if (!found) { console.log(`EXTRA ${id}: not found on the Marketplace`); continue; }
    for (const label of labels) {
      const v = found.list.find(x => x.label === label);
      if (!v) console.log(`EXTRA ${id}: no variant "${label}"`);
      else addVariant(ext, found.dir, v);
    }
  }

  const head = `/* Generated by scripts/popular-themes.js from the most-installed VS Code colour themes. Don't edit by hand; rerun the script.\n   ${new Date().toISOString().slice(0, 10)}: ${themes.length} themes. */\n`;
  const css = themes.map(t => `/* ${t.label} (${t.ext}, ${t.installs.toLocaleString('en')} installs) */\n:root[data-theme="${t.id}"] {\n` +
    Object.entries(t.out).map(([k, v]) => `  ${k}: ${v};`).join('\n') + '\n}\n').join('\n');
  fs.writeFileSync(path.join(APP, 'themes-popular.css'), head + '\n' + css);
  const list = themes.map(t => [t.id, t.label, t.dark ? 'Popular dark' : 'Popular light']);
  fs.writeFileSync(path.join(APP, 'themes-popular.js'), `// Generated by scripts/popular-themes.js. The picker list for themes-popular.css.\nconst POPULAR_THEMES = ${JSON.stringify(list, null, 0).replace(/\],\[/g, '],\n  [').replace(/^\[\[/, '[\n  [').replace(/\]\]$/, '],\n]')};\n`);
  for (const t of themes) console.log(`${t.dark ? 'dark ' : 'light'}  ${t.label}  (${t.ext})`);
  console.log(`${themes.length} themes written to app/themes-popular.css and app/themes-popular.js`);
})().catch(e => { console.error(e); process.exit(1); });
