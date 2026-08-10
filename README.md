# 📚 Private Library

A password-protected, AES-256-GCM encrypted book library hosted on GitHub Pages — with a vintage book reader UI and realistic page-turn animation.

**Live demo (after deploy):** https://gaurav-pasi.github.io/Books/

---

## How it works

- Source markdown files live in `source/` (gitignored — they never enter the public repo).
- The build script renders each MD into HTML, paginates it, and encrypts the entire library with **AES-256-GCM** using a key derived from your master password via **PBKDF2-SHA256 × 310,000 iterations** (OWASP 2024+ recommended).
- The encrypted blob is written to `data/library.json`. Only this encrypted file is committed.
- The static site (HTML/CSS/JS) at the repo root prompts visitors for the password, derives the same key in their browser via the **Web Crypto API**, and decrypts the library locally.
- Without the password, the public encrypted file is computationally infeasible to brute-force.
- The reader uses **StPageFlip** for realistic two-page-spread page turning on desktop and single-page swipe on mobile.

### Honest security note
GitHub Pages is a **public** host. The encrypted blob and JS source code are visible to anyone. Security depends entirely on:
1. **Strong password.** PBKDF2 × 310k iterations makes brute-force impractical for strong passwords.
2. **You never committing `source/` or `.env`** (both are gitignored).
3. **Anyone with the password can decrypt and copy the content** — the encryption protects against unauthorized *access*, not against authorized users sharing what they read.

---

## Setup

```bash
# 1) Install dependencies (only needed for the build script)
npm install

# 2) Create your local password file
cp .env.example .env
# Edit .env if you want a different password

# 3) Encrypt the library
npm run encrypt

# 4) Preview locally
npm run serve
# Open http://localhost:8080 — enter the password
```

## Adding new books

1. Drop a new markdown file in `source/`, e.g. `source/my-second-book.md`.
2. Add an entry in `source/books-meta.json`:
   ```json
   {
     "id": "my-second-book",
     "file": "my-second-book.md",
     "title": "My Second Book",
     "subtitle": "A subtitle",
     "author": "Your Name",
     "cover": "linear-gradient(135deg, #1a3a52, #2c5e8e)"
   }
   ```
3. Re-run `npm run encrypt`.
4. Commit `data/library.json` and push.

## Deploying to GitHub Pages

```bash
# First-time setup (only if not already a git repo)
git init
git add -A
git commit -m "Initial library"

git remote add origin https://github.com/Gaurav-pasi/Books.git
git branch -M main
git push -u origin main
```

Then in your GitHub repo:
- Go to **Settings → Pages**
- Source: **Deploy from a branch**
- Branch: **main** / folder: **/ (root)**
- Save. Site goes live at `https://gaurav-pasi.github.io/Books/` in ~1 minute.

## Reader features

- **Resume where you left off** — per book, anchored to a heading id so it survives re-pagination.
- **Text size** (A− / A+) — seven steps; the book re-flows and keeps your place.
- **Contents / Bookmarks / Notes / Search** in a slide-in panel (`☰`).
- **Bookmarks** (`☆`) and **per-section notes** — anchored to headings, stored per device.
- **Night page** — dark paper, not just a dark surround.
- **Works offline** — installable PWA; the encrypted blob is cached by content hash.
- Keyboard: `←` `→` to turn, `Esc` to close the panel then leave the reader.

## File structure

```
Books/
├── index.html              # Login + library + reader (single-page app)
├── manifest.webmanifest    # PWA manifest (installable)
├── sw.js                   # Service worker — offline caching
├── assets/
│   ├── css/style.css       # Vintage book aesthetic + night theme
│   ├── css/fonts.css       # Self-hosted @font-face declarations
│   ├── fonts/              # Cinzel + Crimson Text woff2 files
│   ├── vendor/             # page-flip.browser.js (self-hosted, no CDN)
│   ├── js/paginate.js      # Height-measuring paginator (unit-tested)
│   └── js/app.js           # Decryption + library + reader + panel
├── data/
│   ├── library.json        # Encrypted library (committed, public)
│   └── version.json        # Content hash — enables long-lived caching
├── scripts/
│   ├── encrypt.mjs         # Build script (Node 18+)
│   ├── test-paginate.mjs   # Pagination regression tests
│   └── test-app-smoke.mjs  # Reader integration tests (jsdom)
├── source/                 # GITIGNORED — your private MD files
│   ├── books-meta.json
│   └── *.md
├── _ledger/                # GITIGNORED — research + audit notes
├── package.json
├── .env                    # GITIGNORED — contains LIBRARY_PASSWORD
├── .env.example
└── .gitignore
```

## Tests

```bash
npm test
```

Covers the paginator (markup must survive a page break — a regression here
silently strips gloss spans from the books) and the reader wiring end to end.

## Password

Set your own password in `.env` (see `.env.example`). Never commit `.env` or write the real password anywhere in a tracked file — re-run `npm run encrypt` whenever you rotate it.

## Tech

- Web Crypto API (no crypto libraries — browser-native)
- StPageFlip for page-turn animation — **self-hosted**, no CDN
- Fonts self-hosted — no Google Fonts request, so nothing external sees who reads what
- marked.js for MD → HTML at build time
- Plain HTML/CSS/JS — no framework, no build step beyond encryption

### How the key is stored

The password is **never** stored. On unlock it derives a **non-extractable**
AES-GCM key, and the `CryptoKey` object itself is kept in IndexedDB — readable
by no script, including anything injected. That means you unlock once per
device rather than once per tab, and a compromised page cannot read the
password back out. The stored key is discarded automatically when the library
is rebuilt (a new salt invalidates it) and on **Lock**.

## Browser support

Chrome, Firefox, Safari, Edge — all modern versions. Mobile-friendly (responsive + touch swipe). Requires JS enabled.

## Cosmetic shortcuts

- Edit `book.cover` in `books-meta.json` to change book card colors. Use any CSS background value (gradient, solid color, or `url(...)`).
- Edit colors in `assets/css/style.css` (search for `#e8c97a`, `#5a2818`, `#c89060` for the gold/burgundy/tan palette).
