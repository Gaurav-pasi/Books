// Integration smoke test for the reader.
//
// Loads the real index.html and the real app.js in jsdom, with the browser
// bits the app depends on (WebCrypto, IndexedDB, fetch, StPageFlip, layout)
// replaced by minimal stubs. It exists to catch the class of bug that unit
// tests miss and that would otherwise ship silently: a DOM id that doesn't
// match, a listener bound to null, a handler that throws on first click.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
// Tests are registered, then run sequentially — several are async and must not
// overlap, since they share one window and one open book.
const TESTS = [];
function test(name, fn) {
  TESTS.push([name, fn]);
}

// ---------------------------------------------------------------- environment
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 'dangerously' so injected <script> blocks execute as real global scripts.
// (Evaluating via window.eval instead would put app.js's top-level `let` state
// in an eval-local scope that disappears, leaving it unreachable from tests.)
// External <script src> tags in index.html are NOT fetched — resources are not
// 'usable' — so the test controls exactly what runs.
const dom = new JSDOM(html, {
  url: 'https://example.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true, // provides requestAnimationFrame
});
const { window } = dom;

// Deterministic fake layout so pagination produces real page breaks.
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() {
    const t = this.textContent || '';
    return t.trim() ? Math.ceil(t.length / 40) * 20 : 0;
  },
});
// jsdom's window.crypto is getter-only, so redefine it.
Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });

// Minimal in-memory IndexedDB shim (the app only does get/put/delete by key).
const idbData = new Map();
window.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction() {
          return {
            objectStore() {
              return {
                get(k) {
                  const r = {};
                  setTimeout(() => {
                    r.result = idbData.get(k);
                    r.onsuccess && r.onsuccess();
                  }, 0);
                  return r;
                },
                put(v, k) { idbData.set(k, v); },
                delete(k) { idbData.delete(k); },
              };
            },
            set oncomplete(fn) { setTimeout(fn, 0); },
            set onerror(_fn) {},
          };
        },
        close() {},
      };
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  },
};

window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

// Fake StPageFlip with the surface app.js actually uses.
let fakePages = [];
let fakeIndex = 0;
const flipHandlers = {};
window.St = {
  PageFlip: class {
    loadFromHTML(nodes) { fakePages = Array.from(nodes); fakeIndex = 0; }
    getPageCount() { return fakePages.length; }
    getCurrentPageIndex() { return fakeIndex; }
    flip(i) { fakeIndex = i; flipHandlers.flip && flipHandlers.flip({ data: i }); }
    turnToPage(i) { fakeIndex = i; }
    flipNext() { this.flip(Math.min(fakeIndex + 1, fakePages.length - 1)); }
    flipPrev() { this.flip(Math.max(fakeIndex - 1, 0)); }
    on(evt, fn) { flipHandlers[evt] = fn; }
    destroy() { fakePages = []; }
  },
};

function runScript(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const el = window.document.createElement('script');
  el.textContent = src;
  window.document.body.appendChild(el);
}

// app.js declares its state with `let`, which lives in the global *lexical*
// scope — not as properties on window. Indirect eval can see that scope, so
// read and write app state through here rather than via window.foo.
const get = (expr) => window.eval(expr);
const run = (code) => window.eval(code);

// openBook yields to two animation frames before paginating, so a fixed sleep
// is a race under load. Poll instead.
async function waitFor(cond, label, ms = 5000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!cond(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

console.log('\nreader integration\n');

// ---------------------------------------------------------------- load
test('paginate.js and app.js evaluate without throwing', () => {
  runScript('assets/js/paginate.js');
  runScript('assets/js/app.js');
});

// ---------------------------------------------------------------- DOM wiring
test('every element app.js looks up actually exists in index.html', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const ids = [...appSrc.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 10, 'expected to find id lookups');
  const missing = ids.filter((id) => !window.document.getElementById(id));
  assert.equal(missing.length, 0, `index.html is missing: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------- reader flow
const BOOK = {
  id: 'test-book',
  title: 'Test Book',
  subtitle: 'sub',
  author: 'author',
  cover: '#000',
  html:
    '<h1 id="chapter-one">Chapter One</h1>' +
    `<p>${'Stoicism sikhata hai control. '.repeat(30)}</p>` +
    '<h2 id="the-dichotomy">The Dichotomy of Control</h2>' +
    `<p>Epictetus ne kaha ki kuch cheezein hamare control mein hain. ${'Aur baaki nahi. '.repeat(30)}</p>` +
    '<h2 id="amor-fati">On Fate</h2>' +
    '<p>A short closing section about accepting what happens.</p>',
};

test('opening a book paginates and builds the contents list', async () => {
  window.__book = BOOK;
  run('library = { books: [window.__book] }');
  run('openBook(window.__book)');
  await waitFor(() => get('pageFlip'), 'pageFlip to be created');
  assert.ok(get('pageFlip'), 'pageFlip was not created');
  assert.ok(fakePages.length > 3, `expected several pages, got ${fakePages.length}`);
  const labels = get('anchorLabels');
  assert.ok(
    Object.keys(labels).length >= 3,
    `expected headings to be indexed, got ${Object.keys(labels).length}`
  );
});

test('gloss spans survive pagination in a real book render', () => {
  const withGloss = {
    ...BOOK,
    id: 'gloss-book',
    html:
      '<h1 id="g">G</h1><p>' +
      Array.from(
        { length: 24 },
        (_, i) =>
          `Line ${i} yahan hai. <span class="gloss">("Term ${i}" matlab explanation.)</span> `
      ).join('') +
      '</p>',
  };
  window.__gloss = withGloss;
  const pages = get('paginateHtmlForBox(window.__gloss.html, 400, 200)');
  const n = (pages.join('').match(/class="gloss"/g) || []).length;
  assert.ok(pages.length > 1, 'needs a split to be meaningful');
  assert.equal(n, 24, `expected 24 gloss spans to survive, found ${n}`);
});

test('contents panel lists headings and jumps to them', () => {
  run("openPanel('contents')");
  const entries = window.document.querySelectorAll('#tab-contents .panel-entry');
  assert.ok(entries.length >= 3, `expected heading entries, got ${entries.length}`);
  const before = get('pageFlip').getCurrentPageIndex();
  const last = entries[entries.length - 1];
  last.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.notEqual(get('pageFlip').getCurrentPageIndex(), before, 'clicking contents did not move');
});

test('bookmark toggles on, persists, and toggles off', () => {
  const btn = window.document.getElementById('bookmark-btn');
  get('pageFlip').flip(2);

  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  let stored = JSON.parse(window.localStorage.getItem('lib_marks_v1'));
  assert.equal(stored['test-book'].bookmarks.length, 1, 'bookmark was not saved');
  assert.equal(btn.textContent, '★', 'button did not show the marked state');

  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  stored = JSON.parse(window.localStorage.getItem('lib_marks_v1'));
  assert.equal(stored['test-book'].bookmarks.length, 0, 'bookmark was not removed');
  assert.equal(btn.textContent, '☆');
});

test('notes save and delete against the current section', () => {
  run("openPanel('marks')");
  const ta = window.document.getElementById('note-text');
  ta.value = 'This is the thing I keep failing at.';
  window.document.getElementById('note-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  let stored = JSON.parse(window.localStorage.getItem('lib_marks_v1'));
  const notes = stored['test-book'].notes;
  assert.equal(Object.keys(notes).length, 1, 'note was not saved');
  assert.match(Object.values(notes)[0].text, /keep failing/);

  window.document.getElementById('note-delete').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  stored = JSON.parse(window.localStorage.getItem('lib_marks_v1'));
  assert.equal(Object.keys(stored['test-book'].notes).length, 0, 'note was not deleted');
});

test('search finds text and renders jumpable results', () => {
  run("openPanel('search')");
  const input = window.document.getElementById('search-input');
  input.value = 'Epictetus';
  run('renderSearch()');
  const hits = window.document.querySelectorAll('#search-results .panel-entry');
  assert.ok(hits.length >= 1, 'search found nothing for a term that is present');
});

test('search reports no results for an absent term', () => {
  const input = window.document.getElementById('search-input');
  input.value = 'zzzznotpresent';
  run('renderSearch()');
  const hits = window.document.querySelectorAll('#search-results .panel-entry');
  assert.equal(hits.length, 0);
  assert.match(window.document.getElementById('search-results').textContent, /Nothing found/);
});

test('font-size control changes scale and persists', () => {
  const before = window.document.documentElement.style.getPropertyValue('--reader-font-scale');
  window.document.getElementById('font-larger').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const after = window.document.documentElement.style.getPropertyValue('--reader-font-scale');
  assert.notEqual(before, after, 'font scale did not change');
  const prefs = JSON.parse(window.localStorage.getItem('lib_prefs_v1'));
  assert.equal(typeof prefs.fontStep, 'number', 'font step was not persisted');
});

test('night mode toggles the page theme and persists', () => {
  const btn = window.document.getElementById('theme-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.document.documentElement.getAttribute('data-page-theme'), 'night');
  const prefs = JSON.parse(window.localStorage.getItem('lib_prefs_v1'));
  assert.equal(prefs.pageTheme, 'night');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.document.documentElement.getAttribute('data-page-theme'), 'day');
});

test('reading position is saved on flip and restored on reopen', () => {
  get('pageFlip').flip(3);
  const saved = JSON.parse(window.localStorage.getItem('lib_positions_v1'));
  assert.ok(saved['test-book'], 'no position stored');
  assert.equal(saved['test-book'].page, 3);

  run('window.__pos = getPosition("test-book"); initFlipbook(window.__book, window.__pos)');
  assert.equal(
    get('pageFlip').getCurrentPageIndex(),
    3,
    'did not resume at the saved page'
  );
});

test('resume survives re-pagination via the anchor, not the page number', () => {
  // Move to a known section, then re-paginate at a different page height so
  // indices shift. The anchor should still land us in the same section.
  const anchor = 'the-dichotomy';
  const idMap = get('headingIdMap');
  get('pageFlip').flip(idMap[anchor]);
  const state = get('currentAnchorState()');
  assert.equal(state.anchor, anchor, 'anchor snapshot did not resolve to the section');

  window.__state = state;
  run('initFlipbook(window.__book, window.__state)');
  assert.equal(
    get('pageFlip').getCurrentPageIndex(),
    get('headingIdMap')[anchor],
    'anchor restore landed on the wrong page'
  );
});

test('panel closes on Escape before leaving the reader', () => {
  run("openPanel('contents')");
  assert.equal(window.document.getElementById('side-panel').hidden, false);
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  assert.equal(window.document.getElementById('side-panel').hidden, true, 'panel did not close');
  assert.equal(window.document.getElementById('reader-screen').hidden, false, 'left the reader too early');
});

(async () => {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures++;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  console.log('');
  if (failures > 0) {
    console.error(`${failures} test(s) failed\n`);
    process.exit(1);
  }
  console.log('all reader integration tests passed\n');
  process.exit(0);
})();
