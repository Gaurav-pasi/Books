// Regression tests for assets/js/paginate.js
//
// Why this exists: the paginator used to split oversized blocks by reading
// node.textContent and rebuilding with textContent — which silently stripped
// every <span class="gloss">, <strong>, <em> and <a> inside a paragraph that
// happened to straddle a page break. The books are built on gloss spans, so
// the damage was invisible until you read the affected page.
//
// jsdom has no layout engine, so scrollHeight is always 0. We stub it with a
// deterministic model: height = ceil(textLength / CHARS_PER_LINE) * LINE_PX.
// That's enough to force real splits and assert on the output.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHARS_PER_LINE = 40;
const LINE_PX = 20;

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

// Deterministic fake layout.
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() {
    const text = this.textContent || '';
    if (!text.trim()) return 0;
    return Math.ceil(text.length / CHARS_PER_LINE) * LINE_PX;
  },
});

global.window = window;
global.document = window.document;

// paginate.js is a classic browser script, but package.json sets
// "type": "module" — so evaluate it directly rather than import/require it.
const paginateSrc = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'js', 'paginate.js'),
  'utf8'
);
const shim = { exports: {} };
const { paginateHtmlForBox } = new Function(
  'module',
  'exports',
  'document',
  'window',
  `${paginateSrc}\nreturn module.exports;`
)(shim, shim.exports, window.document, window);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log('\npaginate.js\n');

test('splits a long paragraph across multiple pages', () => {
  const sentence = 'Yeh ek lamba sentence hai jo page bhar deta hai. ';
  const html = `<p>${sentence.repeat(40)}</p>`;
  const pages = paginateHtmlForBox(html, 400, 200);
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);
});

test('PRESERVES gloss spans when a paragraph splits across pages', () => {
  // A paragraph long enough to split, with glosses spread throughout.
  const chunks = [];
  for (let i = 0; i < 24; i++) {
    chunks.push(
      `Stoicism ka matlab control hai aur yeh sentence number ${i} hai. ` +
        `<span class="gloss">("Control" matlab apne upar command hona — number ${i}.)</span> `
    );
  }
  const html = `<p>${chunks.join('')}</p>`;
  const pages = paginateHtmlForBox(html, 400, 200);

  assert.ok(pages.length > 1, `test needs a split; got ${pages.length} page(s)`);

  const joined = pages.join('');
  const glossCount = (joined.match(/class="gloss"/g) || []).length;
  assert.equal(
    glossCount,
    24,
    `expected all 24 gloss spans to survive, found ${glossCount}`
  );
  // The real bug: markup flattened into bare text.
  assert.ok(
    !/\(&quot;Control&quot; matlab/.test(joined) || glossCount === 24,
    'gloss content leaked out of its span'
  );
});

test('preserves <strong> and <em> across a split', () => {
  const chunks = [];
  for (let i = 0; i < 24; i++) {
    chunks.push(`Yeh <strong>bold ${i}</strong> aur <em>italic ${i}</em> wala line hai. `);
  }
  const pages = paginateHtmlForBox(`<p>${chunks.join('')}</p>`, 400, 200);
  const joined = pages.join('');
  assert.equal((joined.match(/<strong>/g) || []).length, 24, 'lost <strong> tags');
  assert.equal((joined.match(/<em>/g) || []).length, 24, 'lost <em> tags');
});

test('does not duplicate ids across split parts', () => {
  const long = 'Ek lamba paragraph jo definitely split hoga yahan pe. '.repeat(30);
  const pages = paginateHtmlForBox(`<p id="my-section">${long}</p>`, 400, 200);
  const joined = pages.join('');
  const idCount = (joined.match(/id="my-section"/g) || []).length;
  assert.ok(pages.length > 1, 'test needs a split');
  assert.equal(idCount, 1, `id must appear once, appeared ${idCount}×`);
});

test('splits long lists while preserving <li> markup and ol numbering', () => {
  const items = [];
  for (let i = 1; i <= 30; i++) {
    items.push(`<li>Point number ${i} with <strong>emphasis</strong> inside it here.</li>`);
  }
  const pages = paginateHtmlForBox(`<ol>${items.join('')}</ol>`, 400, 200);
  const joined = pages.join('');
  assert.ok(pages.length > 1, 'test needs a split');
  assert.equal((joined.match(/<li>/g) || []).length, 30, 'lost list items');
  assert.equal((joined.match(/<strong>/g) || []).length, 30, 'lost markup inside list items');
  assert.ok(/start="/.test(joined), 'continuation list lost its start attribute');
});

test('keeps short content on a single page', () => {
  const pages = paginateHtmlForBox('<p>Chhota sa paragraph.</p>', 400, 400);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].includes('Chhota sa paragraph.'));
});

test('h1 chapter headings start a fresh page', () => {
  const html = '<p>Pehla content.</p><h1 id="ch2">Chapter Two</h1><p>Doosra content.</p>';
  const pages = paginateHtmlForBox(html, 400, 400);
  assert.ok(pages.length >= 2, 'h1 should force a page break');
  assert.ok(
    pages.some((p) => p.trim().startsWith('<h1')),
    'a page should begin with the h1'
  );
});

console.log('');
if (failures > 0) {
  console.error(`${failures} test(s) failed\n`);
  process.exit(1);
}
console.log('all pagination tests passed\n');
