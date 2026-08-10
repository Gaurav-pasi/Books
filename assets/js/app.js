/* ============================================================
   Private Library — Client-side AES-256-GCM decryption + book reader
   ============================================================ */

const subtle = window.crypto.subtle;

// ------------------------------------------------------------
// Key persistence
//
// The password is NEVER stored. We derive a non-extractable AES CryptoKey and
// persist the key object itself in IndexedDB — CryptoKey is structured-
// cloneable, so it survives a browser restart while staying unreadable to any
// script (including anything that might get injected). This is both safer than
// the old sessionStorage-password approach and less friction: unlock once per
// device instead of once per tab.
// ------------------------------------------------------------
const IDB_NAME = 'private-library';
const IDB_STORE = 'keys';
const IDB_KEY_ID = 'library-key-v1';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(id, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* non-fatal: user just re-enters the password next time */
  }
}

async function idbGet(id) {
  try {
    const db = await idbOpen();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  } catch {
    return undefined;
  }
}

async function idbDelete(id) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {}
}

// ------------------------------------------------------------
// Crypto helpers
// ------------------------------------------------------------
function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function deriveKey(password, salt, iterations, hash) {
  const km = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Distinguishes "couldn't fetch the library" from "password was wrong" so the
// UI can stop blaming the password for network failures.
class LibraryLoadError extends Error {}

async function fetchLibraryMeta() {
  // version.json is tiny and always fetched fresh; the large encrypted blob is
  // content-addressed via ?v=<hash>, so the browser caches it until it changes.
  let version = '';
  try {
    const vres = await fetch('data/version.json', { cache: 'no-store' });
    if (vres.ok) version = (await vres.json()).hash || '';
  } catch {
    /* fall through to a cache-busted fetch */
  }

  let res;
  try {
    res = version
      ? await fetch(`data/library.json?v=${encodeURIComponent(version)}`)
      : await fetch(`data/library.json?ts=${Date.now()}`, { cache: 'no-store' });
  } catch {
    throw new LibraryLoadError('Network error');
  }
  if (!res.ok) throw new LibraryLoadError('Library file missing');
  return await res.json();
}

async function decryptWithKey(key, meta) {
  const iv = b64ToBuf(meta.library.iv);
  const ct = b64ToBuf(meta.library.data);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

// Unlock by typing the password. On success the derived (non-extractable) key
// is persisted so later visits skip this step; the password itself is discarded.
async function unlockWithPassword(password) {
  const meta = await fetchLibraryMeta();
  const key = await deriveKey(
    password,
    b64ToBuf(meta.salt),
    meta.iterations,
    meta.hash || 'SHA-256'
  );
  const lib = await decryptWithKey(key, meta);
  // Store the salt too: a rebuild generates a fresh salt, which invalidates
  // any previously derived key.
  await idbSet(IDB_KEY_ID, { key, salt: meta.salt });
  return lib;
}

// Unlock from the stored key. Returns null when there's nothing usable.
async function unlockWithStoredKey() {
  const stored = await idbGet(IDB_KEY_ID);
  if (!stored || !stored.key) return null;
  const meta = await fetchLibraryMeta();
  if (stored.salt !== meta.salt) {
    await idbDelete(IDB_KEY_ID); // library was rebuilt — key no longer applies
    return null;
  }
  return await decryptWithKey(stored.key, meta);
}

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let library = null;
let pageFlip = null;
let currentBook = null;
// Maps heading id (e.g. "1-the-bedrock--why-most-men-drift") → flipbook page index.
// Rebuilt on every (re)init of the flipbook because pagination is device-dependent.
let headingIdMap = {};
// Inverse lookup: flipbook page index → first element id on that page. Used to
// record a reflow-proof reading position.
let pageAnchors = [];
// anchor id → { text, level } for every heading, in document order. Drives the
// contents list and gives bookmarks/notes a human-readable label.
let anchorLabels = {};
let anchorOrder = [];

// ------------------------------------------------------------
// DOM refs
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const loginScreen = $('login-screen');
const libraryScreen = $('library-screen');
const readerScreen = $('reader-screen');
const loginForm = $('login-form');
const passwordInput = $('password');
const unlockBtn = $('unlock-btn');
const loginError = $('login-error');
const bookGrid = $('book-grid');
const libraryCount = $('library-count');
const logoutBtn = $('logout-btn');
const readerTitle = $('reader-title');
const flipbookEl = $('flipbook');
const pageIndicator = $('page-indicator');
const pageSlider = $('page-slider');
const prevBtn = $('prev-page');
const nextBtn = $('next-page');
const backBtn = $('back-to-library');
const loadingOverlay = $('loading-overlay');
const loadingText = $('loading-text');
const fontSmaller = $('font-smaller');
const fontLarger = $('font-larger');
const bookmarkBtn = $('bookmark-btn');
const panelBtn = $('panel-btn');
const panelClose = $('panel-close');
const panelBackdrop = $('panel-backdrop');
const sidePanel = $('side-panel');
const tabContents = $('tab-contents');
const tabMarks = $('tab-marks');
const tabSearch = $('tab-search');
const marksList = $('marks-list');
const noteText = $('note-text');
const noteSave = $('note-save');
const noteDelete = $('note-delete');
const noteSectionLabel = $('note-section-label');
const searchInput = $('search-input');
const searchResults = $('search-results');
const themeBtn = $('theme-btn');

// ------------------------------------------------------------
// Reading preferences + saved position (localStorage, per device)
// ------------------------------------------------------------
const PREFS_KEY = 'lib_prefs_v1';
const POS_KEY = 'lib_positions_v1';
const FONT_STEPS = [0.85, 0.925, 1, 1.1, 1.22, 1.35, 1.5];
const DEFAULT_FONT_STEP = 2; // 1.0×

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const prefs = loadJson(PREFS_KEY, {});
if (typeof prefs.fontStep !== 'number' || !FONT_STEPS[prefs.fontStep]) {
  prefs.fontStep = DEFAULT_FONT_STEP;
}

function applyFontScale() {
  document.documentElement.style.setProperty(
    '--reader-font-scale',
    String(FONT_STEPS[prefs.fontStep])
  );
  if (fontSmaller) fontSmaller.disabled = prefs.fontStep === 0;
  if (fontLarger) fontLarger.disabled = prefs.fontStep === FONT_STEPS.length - 1;
}

function applyPageTheme() {
  const night = prefs.pageTheme === 'night';
  document.documentElement.setAttribute('data-page-theme', night ? 'night' : 'day');
  if (themeBtn) themeBtn.textContent = night ? '☀ Day page' : '🌙 Night page';
}

// ------------------------------------------------------------
// Bookmarks + notes
//
// Everything is anchored to a heading id rather than a page number: page
// indices move whenever the book re-paginates (font size, rotation, a bigger
// screen), but heading ids are stable for the life of the text.
// ------------------------------------------------------------
const MARKS_KEY = 'lib_marks_v1';

function getMarks(bookId) {
  const all = loadJson(MARKS_KEY, {});
  const entry = all[bookId] || {};
  return { bookmarks: entry.bookmarks || [], notes: entry.notes || {} };
}
function setMarks(bookId, marks) {
  const all = loadJson(MARKS_KEY, {});
  all[bookId] = marks;
  saveJson(MARKS_KEY, all);
}

// Position is stored as {page, anchor}. Pagination depends on device size and
// font scale, so the raw page index is only a fallback — the anchor (id of the
// first element on that page) is what actually survives a reflow.
function savePosition(bookId, pageIndex) {
  if (!bookId) return;
  const all = loadJson(POS_KEY, {});
  all[bookId] = { page: pageIndex, anchor: pageAnchors[pageIndex] || null, at: Date.now() };
  saveJson(POS_KEY, all);
}
function getPosition(bookId) {
  return loadJson(POS_KEY, {})[bookId] || null;
}

// ------------------------------------------------------------
// Screen routing
// ------------------------------------------------------------
function showScreen(name) {
  loginScreen.hidden = name !== 'login';
  libraryScreen.hidden = name !== 'library';
  readerScreen.hidden = name !== 'reader';
}

function showLoading(text = 'Decrypting…') {
  loadingText.textContent = text;
  loadingOverlay.hidden = false;
}
function hideLoading() {
  loadingOverlay.hidden = true;
}

// ------------------------------------------------------------
// Login flow
// ------------------------------------------------------------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = passwordInput.value;
  if (!pwd) return;

  unlockBtn.disabled = true;
  unlockBtn.textContent = 'UNLOCKING…';
  loginError.textContent = '';
  showLoading('Decrypting library…');

  try {
    library = await unlockWithPassword(pwd);
    passwordInput.value = '';
    renderLibrary();
    showScreen('library');
  } catch (err) {
    loginError.textContent =
      err instanceof LibraryLoadError
        ? 'Could not load the library file. Check your connection and try again.'
        : 'Wrong password. Try again.';
    passwordInput.select();
  } finally {
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'UNLOCK';
    hideLoading();
  }
});

// Auto-unlock using the stored key, if this device has one.
async function tryAutoUnlock() {
  const stored = await idbGet(IDB_KEY_ID);
  if (!stored || !stored.key) return;

  showLoading('Decrypting library…');
  try {
    const lib = await unlockWithStoredKey();
    if (!lib) return;
    library = lib;
    renderLibrary();
    showScreen('library');
  } catch {
    await idbDelete(IDB_KEY_ID);
  } finally {
    hideLoading();
  }
}

// ------------------------------------------------------------
// Library rendering
// ------------------------------------------------------------
function renderLibrary() {
  bookGrid.innerHTML = '';
  for (const book of library.books) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.style.background = book.cover;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${book.title}`);
    card.innerHTML = `
      <div class="book-cover-content">
        <h3>${escapeHtml(book.title)}</h3>
        ${book.subtitle ? `<p class="book-subtitle">${escapeHtml(book.subtitle)}</p>` : ''}
      </div>
      <p class="book-author">${escapeHtml(book.author || '')}</p>
    `;
    const open = () => openBook(book);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    bookGrid.appendChild(card);
  }
  libraryCount.textContent =
    library.books.length === 1
      ? '1 volume in the library'
      : `${library.books.length} volumes in the library`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// Reader
// ------------------------------------------------------------
async function openBook(book) {
  currentBook = book;
  readerTitle.textContent = book.title;
  showScreen('reader');
  // Pagination is synchronous and can take a moment on a large book, so show
  // the loader and let the browser actually paint it before we block.
  showLoading('Laying out pages…');
  await nextPaint();
  try {
    initFlipbook(book, getPosition(book.id));
  } catch (err) {
    console.error(err);
    readerTitle.textContent = book.title;
    flipbookEl && (flipbookEl.innerHTML = '');
    alert('Could not open this book. Try reloading the page.');
    showScreen('library');
  } finally {
    hideLoading();
  }
}

// Resolves after the browser has had a chance to paint.
function nextPaint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))
  );
}

// Re-lay-out the current book (font-size change, resize, orientation) while
// holding the reader's place. Capture `restoreTo` before calling.
async function repaginate(restoreTo) {
  if (!currentBook) return;
  showLoading('Laying out pages…');
  await nextPaint();
  try {
    initFlipbook(currentBook, restoreTo);
  } catch (err) {
    console.error(err);
  } finally {
    hideLoading();
  }
}

// Snapshot of where the reader currently is, in a form that survives
// re-pagination (font-size change, resize, orientation flip).
function currentAnchorState() {
  if (!pageFlip) return null;
  const page = pageFlip.getCurrentPageIndex();
  return { page, anchor: pageAnchors[page] || null };
}

// Compute target page dimensions based on stage size.
function computePageSize(stage) {
  const stageW = Math.max(stage.clientWidth - 12, 280);
  const stageH = Math.max(stage.clientHeight - 12, 380);
  const aspect = 2 / 3; // page aspect

  // Spread (two-page) when stage is wide enough for ~760px+
  const wide = stageW >= 760;
  let pageW, pageH;
  if (wide) {
    const reservedForArrows = 100;
    const availW = stageW - reservedForArrows;
    if (stageH * (2 * aspect) <= availW) {
      pageH = stageH;
      pageW = pageH * aspect;
    } else {
      pageW = availW / 2;
      pageH = pageW / aspect;
    }
  } else {
    // Single-page mode (mobile)
    if (stageH * aspect <= stageW) {
      pageH = stageH;
      pageW = pageH * aspect;
    } else {
      pageW = stageW;
      pageH = pageW / aspect;
    }
  }
  return { pageW: Math.floor(pageW), pageH: Math.floor(pageH) };
}

// paginateHtmlForBox() lives in assets/js/paginate.js (loaded before this
// file) so it can be unit-tested — see scripts/test-paginate.mjs.

function initFlipbook(book, restoreTo) {
  if (typeof St === 'undefined' || !St.PageFlip) {
    throw new Error('Page-flip library failed to load (assets/vendor/page-flip.browser.js)');
  }
  if (pageFlip) {
    try { pageFlip.destroy(); } catch {}
    pageFlip = null;
  }
  let fb = document.getElementById('flipbook');
  if (!fb) {
    fb = document.createElement('div');
    fb.id = 'flipbook';
    fb.className = 'flipbook';
    fb.setAttribute('role', 'document');
    const stage = document.querySelector('.flipbook-stage');
    const nextBtnEl = document.getElementById('next-page');
    stage.insertBefore(fb, nextBtnEl);
  }
  fb.innerHTML = '';

  const stage = document.querySelector('.flipbook-stage');
  const { pageW, pageH } = computePageSize(stage);

  // Read padding from CSS by inspecting a temporary .page element
  const sample = document.createElement('div');
  sample.className = 'page';
  sample.style.cssText = `position:fixed;left:-99999px;top:0;width:${pageW}px;height:${pageH}px;visibility:hidden;`;
  const sampleC = document.createElement('div');
  sampleC.className = 'page-content';
  sample.appendChild(sampleC);
  document.body.appendChild(sample);
  const sStyle = getComputedStyle(sample);
  const padTop = parseFloat(sStyle.paddingTop) || 24;
  const padBottom = parseFloat(sStyle.paddingBottom) || 24;
  const padLeft = parseFloat(sStyle.paddingLeft) || 22;
  const padRight = parseFloat(sStyle.paddingRight) || 22;
  sample.remove();

  const contentW = Math.max(pageW - padLeft - padRight, 200);
  const contentH = Math.max(pageH - padTop - padBottom, 300);

  // Dynamically paginate. The caller is responsible for showing the loader and
  // yielding to paint first — this call blocks the main thread.
  const pageHtml = paginateHtmlForBox(book.html || '', contentW, contentH);

  // Build page DOM nodes + heading-id → flipbook-page-index map for TOC navigation.
  // Cover sits at flipbook index 0, so content page i lives at index i+1.
  headingIdMap = {};
  pageAnchors = [];
  anchorLabels = {};
  anchorOrder = [];
  const frag = document.createDocumentFragment();

  const front = document.createElement('div');
  front.className = 'page page-cover page-cover-top';
  front.dataset.density = 'hard';
  front.innerHTML = `
    <div class="page-content">
      <h1>${escapeHtml(book.title)}</h1>
      ${book.subtitle ? `<p class="cover-subtitle">${escapeHtml(book.subtitle)}</p>` : ''}
      ${book.author ? `<p class="cover-author">— ${escapeHtml(book.author)}</p>` : ''}
    </div>
  `;
  frag.appendChild(front);

  for (let i = 0; i < pageHtml.length; i++) {
    const p = document.createElement('div');
    p.className = 'page';
    p.innerHTML = `<div class="page-content">${pageHtml[i]}</div>`;
    // Index every element with an id on this page → its flipbook page index
    const flipIndex = i + 1;
    p.querySelectorAll('[id]').forEach((el) => {
      const id = el.getAttribute('id');
      if (!id) return;
      if (headingIdMap[id] === undefined) headingIdMap[id] = flipIndex;
      if (!pageAnchors[flipIndex]) pageAnchors[flipIndex] = id;
      const m = /^H([1-6])$/.exec(el.tagName);
      if (m && !anchorLabels[id]) {
        anchorLabels[id] = {
          text: (el.textContent || '').trim(),
          level: Number(m[1]),
        };
        anchorOrder.push(id);
      }
    });
    frag.appendChild(p);
  }

  const back = document.createElement('div');
  back.className = 'page page-cover page-cover-bottom';
  back.dataset.density = 'hard';
  back.innerHTML = `
    <div class="page-content">
      <h1>~ Fin ~</h1>
      <p class="cover-subtitle">Job is not done. Especially when you start winning.</p>
    </div>
  `;
  frag.appendChild(back);

  fb.appendChild(frag);

  // Single-page on narrow viewports, spread on tablet+
  const wantSpread = stage.clientWidth >= 760;

  pageFlip = new St.PageFlip(fb, {
    width: pageW,
    height: pageH,
    size: 'fixed',
    minWidth: 240,
    maxWidth: 900,
    minHeight: 380,
    maxHeight: 1300,
    drawShadow: true,
    flippingTime: 700,
    showCover: true,
    mobileScrollSupport: false,
    swipeDistance: 30,
    usePortrait: !wantSpread,
    autoSize: false,
    maxShadowOpacity: 0.6,
    showPageCorners: true,
    disableFlipByClick: false,
  });

  pageFlip.loadFromHTML(fb.querySelectorAll('.page'));

  const total = pageFlip.getPageCount();
  pageSlider.min = 0;
  pageSlider.max = total - 1;

  // Resume: the anchor is authoritative because page indices shift whenever
  // the book is re-paginated. Fall back to the stored index, clamped.
  let startPage = 0;
  if (restoreTo) {
    if (restoreTo.anchor && typeof headingIdMap[restoreTo.anchor] === 'number') {
      startPage = headingIdMap[restoreTo.anchor];
    } else if (typeof restoreTo.page === 'number') {
      startPage = restoreTo.page;
    }
  }
  startPage = Math.min(Math.max(startPage, 0), Math.max(total - 1, 0));

  if (startPage > 0) {
    // Jump without animating through every intervening page.
    if (typeof pageFlip.turnToPage === 'function') pageFlip.turnToPage(startPage);
    else pageFlip.flip(startPage);
  }
  pageSlider.value = startPage;
  updatePageIndicator(startPage, total);

  pageFlip.on('flip', (e) => {
    pageSlider.value = e.data;
    updatePageIndicator(e.data, total);
    if (currentBook) savePosition(currentBook.id, e.data);
    updateBookmarkButton();
    if (!sidePanel.hidden) renderActiveTab();
  });

  updateBookmarkButton();
}

function updatePageIndicator(current, total) {
  pageIndicator.textContent = `Page ${current + 1} / ${total}`;
}

backBtn.addEventListener('click', () => {
  closePanel();
  if (pageFlip) {
    try { pageFlip.destroy(); } catch {}
    pageFlip = null;
  }
  showScreen('library');
});

// Intercept TOC / in-book anchor clicks → flip to the target page instead of
// letting the browser try (and fail) to scroll to a hidden, paginated heading.
// Delegated at document level because StPageFlip can replace the #flipbook node
// during resize, which would orphan a listener bound to the old element.
document.addEventListener('click', (e) => {
  if (readerScreen.hidden) return;
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (!a || !pageFlip) return;
  // Only handle clicks originating inside the flipbook stage
  if (!a.closest('.flipbook-stage')) return;
  const href = a.getAttribute('href') || '';
  const id = decodeURIComponent(href.slice(1));
  if (!id) return;
  const target = headingIdMap[id];
  if (typeof target === 'number') {
    e.preventDefault();
    e.stopPropagation();
    pageFlip.flip(target);
  }
}, true);

prevBtn.addEventListener('click', () => pageFlip && pageFlip.flipPrev());
nextBtn.addEventListener('click', () => pageFlip && pageFlip.flipNext());

// ------------------------------------------------------------
// Side panel — contents, bookmarks/notes, search
// ------------------------------------------------------------

// The section a page belongs to. Continuation pages carry no id of their own,
// so walk back to the nearest preceding heading.
function sectionAnchorForPage(pageIdx) {
  for (let i = pageIdx; i >= 0; i--) {
    const a = pageAnchors[i];
    if (a && anchorLabels[a]) return a;
  }
  return anchorOrder[0] || null;
}

function currentSectionAnchor() {
  if (!pageFlip) return null;
  return sectionAnchorForPage(pageFlip.getCurrentPageIndex());
}

function labelFor(anchor) {
  return (anchorLabels[anchor] && anchorLabels[anchor].text) || anchor || 'Section';
}

function goToAnchor(anchor) {
  const target = headingIdMap[anchor];
  if (typeof target === 'number' && pageFlip) {
    pageFlip.flip(target);
    closePanel();
  }
}

function openPanel(tab) {
  if (!currentBook) return;
  sidePanel.hidden = false;
  panelBackdrop.hidden = false;
  if (tab) selectTab(tab);
  else renderActiveTab();
}
function closePanel() {
  sidePanel.hidden = true;
  panelBackdrop.hidden = true;
}

function activeTab() {
  const el = document.querySelector('.panel-tab.is-active');
  return el ? el.dataset.tab : 'contents';
}
function selectTab(name) {
  document.querySelectorAll('.panel-tab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === name);
  });
  tabContents.hidden = name !== 'contents';
  tabMarks.hidden = name !== 'marks';
  tabSearch.hidden = name !== 'search';
  renderActiveTab();
}
function renderActiveTab() {
  const name = activeTab();
  if (name === 'contents') renderContents();
  else if (name === 'marks') renderMarks();
  else if (name === 'search') renderSearch();
}

function entryButton(label, sub, onClick, extraClass) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'panel-entry' + (extraClass ? ' ' + extraClass : '');
  b.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'entry-sub';
    s.textContent = sub;
    b.appendChild(s);
  }
  b.addEventListener('click', onClick);
  return b;
}

function renderContents() {
  tabContents.innerHTML = '';
  if (anchorOrder.length === 0) {
    tabContents.innerHTML = '<p class="panel-empty">No headings found in this book.</p>';
    return;
  }
  const here = currentSectionAnchor();
  for (const id of anchorOrder) {
    const { text, level } = anchorLabels[id];
    if (level > 3) continue; // keep the list navigable
    const btn = entryButton(text, id === here ? 'you are here' : '', () => goToAnchor(id), `lvl-${level}`);
    tabContents.appendChild(btn);
  }
}

function renderMarks() {
  const bookId = currentBook && currentBook.id;
  if (!bookId) return;
  const here = currentSectionAnchor();
  const marks = getMarks(bookId);

  // Note editor targets the section you're currently reading.
  noteSectionLabel.textContent = here ? `Note on: ${labelFor(here)}` : 'Note on this section';
  noteText.value = (marks.notes[here] && marks.notes[here].text) || '';

  marksList.innerHTML = '';

  const bm = marks.bookmarks.filter((b) => anchorLabels[b.anchor]);
  const noteEntries = Object.entries(marks.notes).filter(([a]) => anchorLabels[a]);

  if (bm.length) {
    const t = document.createElement('p');
    t.className = 'marks-group-title';
    t.textContent = `Bookmarks (${bm.length})`;
    marksList.appendChild(t);
    for (const b of bm) {
      marksList.appendChild(entryButton(labelFor(b.anchor), '☆ bookmarked', () => goToAnchor(b.anchor)));
    }
  }

  if (noteEntries.length) {
    const t = document.createElement('p');
    t.className = 'marks-group-title';
    t.textContent = `Notes (${noteEntries.length})`;
    marksList.appendChild(t);
    for (const [anchor, note] of noteEntries) {
      const preview = note.text.length > 90 ? note.text.slice(0, 90) + '…' : note.text;
      marksList.appendChild(entryButton(labelFor(anchor), preview, () => goToAnchor(anchor)));
    }
  }

  if (!bm.length && !noteEntries.length) {
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = 'No bookmarks or notes yet. Use ☆ in the header to bookmark, or write a note above.';
    marksList.appendChild(p);
  }
}

function updateBookmarkButton() {
  if (!currentBook) return;
  const here = currentSectionAnchor();
  const marks = getMarks(currentBook.id);
  const on = !!here && marks.bookmarks.some((b) => b.anchor === here);
  bookmarkBtn.textContent = on ? '★' : '☆';
  bookmarkBtn.classList.toggle('is-marked', on);
  bookmarkBtn.title = on ? 'Remove bookmark' : 'Bookmark this section';
}

bookmarkBtn.addEventListener('click', () => {
  if (!currentBook) return;
  const here = currentSectionAnchor();
  if (!here) return;
  const marks = getMarks(currentBook.id);
  const idx = marks.bookmarks.findIndex((b) => b.anchor === here);
  if (idx >= 0) marks.bookmarks.splice(idx, 1);
  else marks.bookmarks.push({ anchor: here, at: Date.now() });
  setMarks(currentBook.id, marks);
  updateBookmarkButton();
  if (!sidePanel.hidden && activeTab() === 'marks') renderMarks();
});

noteSave.addEventListener('click', () => {
  if (!currentBook) return;
  const here = currentSectionAnchor();
  if (!here) return;
  const marks = getMarks(currentBook.id);
  const text = noteText.value.trim();
  if (text) marks.notes[here] = { text, at: Date.now() };
  else delete marks.notes[here];
  setMarks(currentBook.id, marks);
  renderMarks();
});

noteDelete.addEventListener('click', () => {
  if (!currentBook) return;
  const here = currentSectionAnchor();
  if (!here) return;
  const marks = getMarks(currentBook.id);
  delete marks.notes[here];
  setMarks(currentBook.id, marks);
  noteText.value = '';
  renderMarks();
});

// Search runs over the decrypted HTML of every book, section by section, so a
// hit can be turned into a jump target.
function bookSections(book) {
  const doc = document.createElement('div');
  doc.innerHTML = book.html || '';
  const sections = [];
  let current = { anchor: null, title: book.title, text: '' };
  for (const node of Array.from(doc.childNodes)) {
    if (node.nodeType === 1 && /^H[1-6]$/.test(node.tagName)) {
      if (current.text.trim()) sections.push(current);
      current = {
        anchor: node.getAttribute('id'),
        title: (node.textContent || '').trim(),
        text: '',
      };
    } else {
      current.text += ' ' + (node.textContent || '');
    }
  }
  if (current.text.trim()) sections.push(current);
  return sections;
}

const sectionCache = new Map();
function sectionsFor(book) {
  if (!sectionCache.has(book.id)) sectionCache.set(book.id, bookSections(book));
  return sectionCache.get(book.id);
}

function renderSearch() {
  const q = (searchInput.value || '').trim();
  searchResults.innerHTML = '';
  if (q.length < 2) {
    searchResults.innerHTML = '<p class="panel-hint">Type at least 2 characters.</p>';
    return;
  }
  const needle = q.toLowerCase();
  let total = 0;

  for (const book of library.books) {
    const hits = [];
    for (const sec of sectionsFor(book)) {
      const hay = (sec.title + ' ' + sec.text).toLowerCase();
      const at = hay.indexOf(needle);
      if (at === -1) continue;
      const raw = (sec.title + ' ' + sec.text).replace(/\s+/g, ' ');
      const start = Math.max(0, at - 45);
      hits.push({
        anchor: sec.anchor,
        title: sec.title,
        snippet: (start > 0 ? '…' : '') + raw.slice(start, at + needle.length + 60).trim() + '…',
      });
      if (hits.length >= 25) break;
    }
    if (!hits.length) continue;
    total += hits.length;

    const t = document.createElement('p');
    t.className = 'marks-group-title';
    t.textContent = `${book.title} (${hits.length})`;
    searchResults.appendChild(t);

    for (const h of hits) {
      const sameBook = currentBook && currentBook.id === book.id;
      const btn = entryButton(h.title || '(untitled section)', h.snippet, () => {
        if (sameBook && h.anchor) goToAnchor(h.anchor);
        else if (h.anchor) {
          closePanel();
          openBook(book).then(() => setTimeout(() => goToAnchor(h.anchor), 60));
        }
      });
      searchResults.appendChild(btn);
    }
  }

  if (!total) {
    searchResults.innerHTML = `<p class="panel-empty">Nothing found for “${escapeHtml(q)}”.</p>`;
  }
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 180);
});

panelBtn.addEventListener('click', () => (sidePanel.hidden ? openPanel() : closePanel()));
panelClose.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);
document.querySelectorAll('.panel-tab').forEach((b) => {
  b.addEventListener('click', () => selectTab(b.dataset.tab));
});

themeBtn.addEventListener('click', () => {
  prefs.pageTheme = prefs.pageTheme === 'night' ? 'day' : 'night';
  saveJson(PREFS_KEY, prefs);
  applyPageTheme();
});

// Text size. Re-paginates at the new scale, holding the reader's place.
function changeFontStep(delta) {
  const next = prefs.fontStep + delta;
  if (next < 0 || next >= FONT_STEPS.length) return;
  prefs.fontStep = next;
  saveJson(PREFS_KEY, prefs);
  applyFontScale();
  if (currentBook && pageFlip) repaginate(currentAnchorState());
}
fontSmaller.addEventListener('click', () => changeFontStep(-1));
fontLarger.addEventListener('click', () => changeFontStep(1));

pageSlider.addEventListener('input', (e) => {
  if (!pageFlip) return;
  const target = parseInt(e.target.value, 10);
  pageFlip.flip(target);
});

document.addEventListener('keydown', (e) => {
  if (readerScreen.hidden) return;
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  if (e.key === 'Escape') {
    // Escape backs out one layer at a time: panel first, then the reader.
    if (!sidePanel.hidden) closePanel();
    else backBtn.click();
    return;
  }
  if (typing || !sidePanel.hidden) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); pageFlip && pageFlip.flipPrev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); pageFlip && pageFlip.flipNext(); }
});

// Reflow page-flip on resize / orientation
let resizeTimer;
window.addEventListener('resize', () => {
  if (!pageFlip || !currentBook) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    repaginate(currentAnchorState());
  }, 250);
});

// Logout
logoutBtn.addEventListener('click', async () => {
  await idbDelete(IDB_KEY_ID);
  library = null;
  if (pageFlip) {
    try { pageFlip.destroy(); } catch {}
    pageFlip = null;
  }
  passwordInput.value = '';
  showScreen('login');
  passwordInput.focus();
});

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
showScreen('login');
applyFontScale();
applyPageTheme();

// Offline support. Fails harmlessly on file:// or any non-secure origin.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

if (typeof St !== 'undefined') {
  tryAutoUnlock();
} else {
  // Wait for StPageFlip script to load
  window.addEventListener('load', tryAutoUnlock);
}

// Focus password on load
passwordInput.focus();
