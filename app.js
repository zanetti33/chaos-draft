// Chaos Draft: build a pool of packs (one per expansion) and draw them without replacement.
// All data comes from the public Scryfall API (https://scryfall.com/docs/api).

const API = 'https://api.scryfall.com';
const STORAGE_KEY = 'chaos-draft:v1';
const SUMMARY_CACHE_KEY = 'chaos-draft:summaries:v1';
const SUMMARY_TTL_MS = 1000 * 60 * 60 * 24 * 3;

// Set types that make sense as draft boosters by default.
const DRAFT_TYPES = new Set(['core', 'expansion', 'draft_innovation', 'masters']);
const EXTRA_TYPES = new Set(['funny', 'masterpiece', 'starter', 'alchemy', 'remastered']);

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  sets: [],          // all Scryfall sets usable as packs
  byCode: new Map(),
  pool: [],          // set codes in the pool
  drawn: [],         // set codes drawn, in order
  spinning: false,
};

// ---------- storage ----------

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.pool = Array.isArray(raw.pool) ? raw.pool : [];
    state.drawn = Array.isArray(raw.drawn) ? raw.drawn.filter((c) => state.pool.includes(c)) : [];
  } catch { /* storage unavailable or corrupt: start empty */ }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pool: state.pool, drawn: state.drawn }));
  } catch { /* ignore */ }
}

function readSummaryCache() {
  try { return JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || '{}'); } catch { return {}; }
}

function writeSummaryCache(code, data) {
  try {
    const cache = readSummaryCache();
    cache[code] = { at: Date.now(), data };
    // keep the cache small
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 40);
    localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* ignore */ }
}

// ---------- Scryfall ----------

// Scryfall asks for 50-100ms between requests; serialise calls through a small queue.
let lastCall = 0;
let queue = Promise.resolve();
function scryfall(path) {
  const run = async () => {
    const wait = Math.max(0, lastCall + 110 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      headers: { Accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.details || `Scryfall error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function searchCards(q, order, dir = 'auto') {
  const params = new URLSearchParams({ q, order, dir, unique: 'cards' });
  try {
    return (await scryfall(`/cards/search?${params}`)).data || [];
  } catch (e) {
    if (e.status === 404) return []; // no matches
    throw e;
  }
}

async function loadSets() {
  const { data } = await scryfall('/sets');
  const today = new Date().toISOString().slice(0, 10);
  state.sets = data
    .filter((s) => !s.digital && !s.parent_set_code && s.card_count >= 60)
    .filter((s) => DRAFT_TYPES.has(s.set_type) || EXTRA_TYPES.has(s.set_type))
    .filter((s) => !s.released_at || s.released_at <= today)
    .map((s) => ({
      code: s.code,
      name: s.name,
      type: s.set_type,
      released: s.released_at || '',
      count: s.card_count,
      icon: s.icon_svg_uri,
      uri: s.scryfall_uri,
    }));
  state.byCode = new Map(state.sets.map((s) => [s.code, s]));
}

function cardImage(card, size = 'normal') {
  return card.image_uris?.[size] || card.card_faces?.[0]?.image_uris?.[size] || '';
}

function cardPrice(card) {
  const p = card.prices || {};
  const v = parseFloat(p.usd || p.usd_foil || p.eur || '');
  return Number.isFinite(v) ? v : null;
}

function slimCard(c) {
  return {
    name: c.name,
    rarity: c.rarity,
    price: cardPrice(c),
    img: cardImage(c, 'normal'),
    uri: c.scryfall_uri,
    type: c.type_line || c.card_faces?.[0]?.type_line || '',
    colors: c.colors || c.card_faces?.[0]?.colors || [],
    keywords: c.keywords || [],
    edhrec: c.edhrec_rank ?? null,
  };
}

async function fetchSummary(code) {
  const cached = readSummaryCache()[code];
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.data;

  // Prefer cards that actually appear in boosters; older sets can lack that flag, so fall back.
  const booster = async (q, order, dir) => {
    const withBooster = await searchCards(`e:${code} is:booster ${q}`, order, dir);
    return withBooster.length ? withBooster : searchCards(`e:${code} ${q}`, order, dir);
  };

  const chase = (await booster('(r:r or r:m) usd>0', 'usd', 'desc')).slice(0, 6).map(slimCard);
  const commonsUncommons = (await booster('(r:c or r:u) -t:basic', 'edhrec', 'asc')).map(slimCard);
  const bombs = (await booster('(r:r or r:m) -t:basic', 'edhrec', 'asc')).slice(0, 4).map(slimCard);

  const data = {
    chase,
    topUncommons: commonsUncommons.filter((c) => c.rarity === 'uncommon').slice(0, 5),
    topCommons: commonsUncommons.filter((c) => c.rarity === 'common').slice(0, 5),
    bombs,
    keywords: topKeywords(commonsUncommons, 6),
    colors: colorSpread(commonsUncommons),
  };
  writeSummaryCache(code, data);
  return data;
}

function topKeywords(cards, n) {
  const counts = new Map();
  for (const c of cards) for (const k of c.keywords) counts.set(k, (counts.get(k) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function colorSpread(cards) {
  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0, M: 0, C: 0 };
  for (const c of cards) {
    if (c.colors.length > 1) counts.M++;
    else if (c.colors.length === 1) counts[c.colors[0]]++;
    else counts.C++;
  }
  return counts;
}

// ---------- helpers ----------

function randomInt(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setIcon(set, cls = 'set-icon') {
  return set?.icon ? el('img', { class: cls, src: set.icon, alt: '', loading: 'lazy' }) : el('span', { class: cls });
}

function setLabel(code) {
  const s = state.byCode.get(code);
  return s ? s.name : code.toUpperCase();
}

const TYPE_LABELS = {
  core: 'Core set', expansion: 'Expansion', draft_innovation: 'Draft innovation', masters: 'Masters',
  funny: 'Un-set', masterpiece: 'Masterpiece', starter: 'Starter', alchemy: 'Alchemy', remastered: 'Remastered',
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function remaining() {
  return state.pool.filter((c) => !state.drawn.includes(c));
}

function availableSets() {
  const all = $('#include-all-types').checked;
  return state.sets.filter((s) => all || DRAFT_TYPES.has(s.type));
}

// ---------- pool ----------

function addToPool(code) {
  if (state.pool.includes(code)) { toast(`${setLabel(code)} is already in the pool`); return false; }
  state.pool.push(code);
  save();
  render();
  return true;
}

function removeFromPool(code) {
  state.pool = state.pool.filter((c) => c !== code);
  state.drawn = state.drawn.filter((c) => c !== code);
  save();
  render();
}

function addRandom(n) {
  const candidates = shuffle(availableSets().filter((s) => !state.pool.includes(s.code)));
  const picked = candidates.slice(0, n);
  for (const s of picked) state.pool.push(s.code);
  save();
  render();
  toast(picked.length ? `Added ${picked.length} random pack${picked.length === 1 ? '' : 's'}` : 'No more sets to add');
}

// ---------- rendering ----------

function render() {
  const rem = remaining();
  $('#pool-count').textContent = `${state.pool.length} pack${state.pool.length === 1 ? '' : 's'}`;
  $('#remaining-count').textContent = `${rem.length} left`;
  $('#pool-empty').hidden = state.pool.length > 0;
  $('#draw').disabled = state.spinning || rem.length === 0;
  $('#draw').textContent = state.pool.length && !rem.length ? 'Pool empty' : 'Pull the lever';

  const list = $('#pool-list');
  list.replaceChildren(...state.pool.map((code) => {
    const s = state.byCode.get(code);
    const drawn = state.drawn.includes(code);
    return el('li', { class: drawn ? 'drawn' : '' },
      setIcon(s),
      el('span', { class: 'pool-name' }, setLabel(code),
        el('small', {}, ` ${code.toUpperCase()}${s?.released ? ' · ' + s.released.slice(0, 4) : ''}`)),
      drawn ? el('span', { class: 'tag' }, 'drawn') : null,
      el('button', {
        class: 'icon-btn', 'aria-label': `Remove ${setLabel(code)}`, title: 'Remove',
        disabled: state.spinning || null, onclick: () => removeFromPool(code),
      }, '×'),
    );
  }));

  $('#draw-pool-chips').replaceChildren(...state.pool.map((code) => {
    const drawn = state.drawn.includes(code);
    return el('li', { class: `chip${drawn ? ' drawn' : ''}`, title: drawn ? `${setLabel(code)} (drawn)` : setLabel(code) },
      setIcon(state.byCode.get(code)), code.toUpperCase());
  }));
  const goDraw = $('#go-draw');
  goDraw.classList.toggle('disabled', !state.pool.length);
  goDraw.setAttribute('aria-disabled', String(!state.pool.length));
  goDraw.textContent = state.pool.length
    ? `Start drawing (${state.pool.length} pack${state.pool.length === 1 ? '' : 's'}) →`
    : 'Add packs to start drawing';

  const hist = $('#history-list');
  hist.replaceChildren(...state.drawn.map((code) => el('li', {},
    el('button', { class: 'link', onclick: () => showSummary(code) }, setIcon(state.byCode.get(code)), setLabel(code)),
  )));
  $('#history-empty').hidden = state.drawn.length > 0;

  if (!state.spinning) renderIdleReel();
}

function reelItem(code) {
  const s = state.byCode.get(code);
  return el('div', { class: 'reel-item' }, setIcon(s, 'reel-icon'),
    el('div', { class: 'reel-text' }, el('strong', {}, setLabel(code)), el('span', {}, code.toUpperCase())));
}

function renderIdleReel() {
  const reel = $('#reel');
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0)';
  const last = state.drawn[state.drawn.length - 1];
  if (last) reel.replaceChildren(reelItem(last));
  else if (state.pool.length) reel.replaceChildren(el('div', { class: 'reel-item placeholder' }, '🎰 Ready to roll'));
  else reel.replaceChildren(el('div', { class: 'reel-item placeholder' }, 'Add packs to start'));
}

// ---------- slot machine ----------

async function draw() {
  const rem = remaining();
  if (!rem.length || state.spinning) return;
  state.spinning = true;
  $('#summary').hidden = true;
  render();

  const winner = rem[randomInt(rem.length)];

  // Build a long strip of shuffled remaining sets that ends on the winner.
  const strip = [];
  const spins = reducedMotion ? 1 : Math.max(4, Math.ceil(36 / rem.length));
  for (let i = 0; i < spins; i++) strip.push(...shuffle(rem));
  if (strip.length > 60) strip.splice(0, strip.length - 60);
  strip.push(winner);

  const reel = $('#reel');
  const machine = document.querySelector('.machine');
  reel.replaceChildren(...strip.map(reelItem));
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0)';
  machine.classList.add('spinning');

  const itemH = reel.firstElementChild.getBoundingClientRect().height;
  const distance = itemH * (strip.length - 1);
  const duration = reducedMotion ? 300 : 3800;

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  reel.style.transition = `transform ${duration}ms cubic-bezier(0.12, 0.72, 0.18, 1.02)`;
  reel.style.transform = `translateY(-${distance}px)`;
  await new Promise((r) => {
    const done = () => { reel.removeEventListener('transitionend', done); r(); };
    reel.addEventListener('transitionend', done);
    setTimeout(done, duration + 200);
  });

  machine.classList.remove('spinning');
  machine.classList.add('win');
  setTimeout(() => machine.classList.remove('win'), 1600);

  // Collapse the strip to just the winner so resizing does not misalign it.
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0)';
  reel.replaceChildren(reelItem(winner));

  state.drawn.push(winner);
  state.spinning = false;
  save();
  render();
  showSummary(winner);
}

// ---------- set summary ----------

function cardTile(c, extra) {
  return el('a', { class: 'card', href: c.uri, target: '_blank', rel: 'noopener', title: c.name },
    c.img ? el('img', { src: c.img, alt: c.name, loading: 'lazy' }) : el('div', { class: 'card-fallback' }, c.name),
    el('span', { class: 'card-meta' }, extra ?? c.name),
  );
}

function cardRow(title, note, cards, extraFn) {
  if (!cards.length) return null;
  return el('div', { class: 'card-section' },
    el('h4', {}, title, note ? el('small', {}, ` ${note}`) : null),
    el('div', { class: 'card-row' }, cards.map((c) => cardTile(c, extraFn?.(c)))),
  );
}

const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', M: 'Multicolor', C: 'Colorless' };

function colorBar(colors) {
  const total = Object.values(colors).reduce((a, b) => a + b, 0);
  if (!total) return null;
  return el('div', { class: 'card-section' },
    el('h4', {}, 'Color spread', el('small', {}, ' commons and uncommons')),
    el('div', { class: 'color-bar', role: 'img', 'aria-label': Object.entries(colors).filter(([, v]) => v).map(([k, v]) => `${COLOR_NAMES[k]} ${v}`).join(', ') },
      Object.entries(colors).filter(([, v]) => v).map(([k, v]) =>
        el('span', { class: `seg c-${k}`, style: `flex:${v}`, title: `${COLOR_NAMES[k]}: ${v}` }, v / total > 0.07 ? k : ''))),
  );
}

let summaryToken = 0;
async function showSummary(code) {
  const box = $('#summary');
  const s = state.byCode.get(code);
  const token = ++summaryToken;
  box.hidden = false;

  const head = el('div', { class: 'summary-head' },
    setIcon(s, 'summary-icon'),
    el('div', {},
      el('h3', {}, setLabel(code)),
      el('p', { class: 'muted' }, [
        code.toUpperCase(),
        s ? TYPE_LABELS[s.type] || s.type : null,
        s?.released ? `Released ${s.released}` : null,
        s ? `${s.count} cards` : null,
      ].filter(Boolean).join(' · ')),
    ),
    s ? el('a', { class: 'btn ghost small', href: s.uri, target: '_blank', rel: 'noopener' }, 'Open on Scryfall') : null,
  );
  box.replaceChildren(head, el('p', { class: 'muted loading' }, 'Loading set summary…'));
  box.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });

  try {
    const d = await fetchSummary(code);
    if (token !== summaryToken) return;
    const usd = (c) => (c.price != null ? `$${c.price.toFixed(2)}` : c.name);
    box.replaceChildren(head,
      cardRow('Chase cards', 'highest market price (USD)', d.chase, usd),
      cardRow('Bombs', 'rares and mythics most played on EDHREC', d.bombs),
      cardRow('Top uncommons', 'by EDHREC popularity', d.topUncommons),
      cardRow('Top commons', 'by EDHREC popularity', d.topCommons),
      d.keywords.length ? el('div', { class: 'card-section' },
        el('h4', {}, 'Key mechanics', el('small', {}, ' most common keywords at common and uncommon')),
        el('div', { class: 'chips' }, d.keywords.map(([k, n]) => el('span', { class: 'chip' }, k, el('small', {}, ` ×${n}`))))) : null,
      colorBar(d.colors),
      el('p', { class: 'muted small' },
        'Draft picks are a heuristic: Scryfall has no limited ratings, so commons, uncommons and bombs are ranked by EDHREC popularity. Prices are Scryfall’s daily market data.'),
    );
  } catch (e) {
    if (token !== summaryToken) return;
    box.replaceChildren(head, el('p', { class: 'error' }, `Could not load the summary: ${e.message}`),
      el('button', { class: 'btn small', onclick: () => showSummary(code) }, 'Retry'));
  }
}

// ---------- search ----------

function setupSearch() {
  const input = $('#set-search');
  const results = $('#search-results');
  let active = -1;
  let matches = [];

  const close = () => { results.hidden = true; active = -1; };

  const update = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    matches = availableSets()
      .filter((s) => s.name.toLowerCase().includes(q) || s.code === q)
      .sort((a, b) => (b.code === q) - (a.code === q) || b.released.localeCompare(a.released))
      .slice(0, 12);
    active = matches.length ? 0 : -1;
    results.replaceChildren(...(matches.length ? matches.map((s, i) => {
      const inPool = state.pool.includes(s.code);
      return el('li', {
        role: 'option', class: `${i === active ? 'active' : ''} ${inPool ? 'in-pool' : ''}`,
        onmousedown: (e) => { e.preventDefault(); pick(s); },
      }, setIcon(s), el('span', {}, s.name), el('small', {}, `${s.code.toUpperCase()} · ${s.released.slice(0, 4)}${inPool ? ' · in pool' : ''}`));
    }) : [el('li', { class: 'none' }, 'No matching expansions')]));
    results.hidden = false;
  };

  const highlight = () => [...results.children].forEach((li, i) => li.classList.toggle('active', i === active));

  const pick = (s) => {
    if (addToPool(s.code)) toast(`Added ${s.name}`);
    input.value = '';
    close();
    input.focus();
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (results.hidden || !matches.length) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % matches.length; highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + matches.length) % matches.length; highlight(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { pick(matches[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
}

// ---------- share links ----------

function importSharedPool() {
  const m = (location.search + location.hash).match(/pool=([a-z0-9,]+)/i);
  if (!m) return;
  const codes = [...new Set(m[1].toLowerCase().split(',').filter((c) => state.byCode.has(c)))];
  if (codes.length && confirm(`Load a shared pool of ${codes.length} packs? This replaces your current pool.`)) {
    state.pool = codes;
    state.drawn = [];
    save();
  }
  history.replaceState(null, '', location.pathname + (state.pool.length ? '#/draw' : '#/pool'));
}

async function sharePool() {
  if (!state.pool.length) { toast('Add some packs first'); return; }
  const url = `${location.origin}${location.pathname}?pool=${state.pool.join(',')}`;
  try { await navigator.clipboard.writeText(url); toast('Share link copied'); }
  catch { prompt('Copy this link:', url); }
}

// ---------- pages ----------

const PAGES = ['pool', 'draw'];

function route() {
  let page = location.hash.replace(/^#\/?/, '');
  if (!PAGES.includes(page)) {
    page = state.pool.length ? 'draw' : 'pool';
    history.replaceState(null, '', `${location.pathname}${location.search}#/${page}`);
  }
  if (page === 'draw' && !state.pool.length) {
    toast('Add some packs to the pool first');
    page = 'pool';
    history.replaceState(null, '', `${location.pathname}${location.search}#/pool`);
  }
  document.body.dataset.page = page;
  for (const s of document.querySelectorAll('[data-page]')) s.hidden = s.dataset.page !== page;
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = page === 'draw' ? 'Draw packs · Chaos Draft' : 'Build the pool · Chaos Draft';
  window.scrollTo(0, 0);
}

// ---------- init ----------

async function init() {
  load();
  setupSearch();
  render();
  route();
  window.addEventListener('hashchange', route);
  $('#go-draw').addEventListener('click', (e) => {
    if (!state.pool.length) { e.preventDefault(); $('#set-search').focus(); }
  });

  $('#draw').addEventListener('click', draw);
  $('#add-random').addEventListener('click', () => {
    const n = Math.min(50, Math.max(1, parseInt($('#random-n').value, 10) || 1));
    addRandom(n);
  });
  $('#clear-pool').addEventListener('click', () => {
    if (!state.pool.length || state.spinning) return;
    if (confirm('Remove every pack from the pool?')) { state.pool = []; state.drawn = []; save(); render(); $('#summary').hidden = true; }
  });
  $('#reset-draws').addEventListener('click', () => {
    if (!state.drawn.length || state.spinning) return;
    if (confirm('Put every drawn pack back into the pool?')) { state.drawn = []; save(); render(); $('#summary').hidden = true; }
  });
  $('#share-pool').addEventListener('click', sharePool);
  $('#include-all-types').addEventListener('change', () => $('#set-search').dispatchEvent(new Event('input')));

  try {
    await loadSets();
    $('#sets-status').textContent = `${state.sets.length} sets available from Scryfall.`;
    $('#set-search').disabled = false;
    importSharedPool();
    render();
    route();
  } catch (e) {
    $('#sets-status').textContent = `Could not load sets from Scryfall (${e.message}). Reload to try again.`;
    $('#sets-status').classList.add('error');
  }
}

init();
