// Build script: reads source MD files, renders to HTML, paginates, encrypts with AES-256-GCM
// using PBKDF2-derived key, writes data/library.json (the encrypted blob served publicly).
//
// Run with: npm run encrypt
// Requires: .env file with LIBRARY_PASSWORD

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'source');
const DATA_DIR = path.join(ROOT, 'data');

const PASSWORD = process.env.LIBRARY_PASSWORD;
if (!PASSWORD) {
  console.error('❌ LIBRARY_PASSWORD missing. Create a .env file (see .env.example).');
  process.exit(1);
}

const ITERATIONS = 310000;          // OWASP-recommended for PBKDF2-SHA256 (2024+)
const SALT_BYTES = 16;
const IV_BYTES = 12;

const subtle = globalThis.crypto.subtle;

function bufToB64(buf) {
  return Buffer.from(buf).toString('base64');
}

async function deriveKey(password, salt) {
  const km = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptString(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { iv: bufToB64(iv), data: bufToB64(new Uint8Array(ct)) };
}

// GFM-compatible slugify: matches the format used by GitHub-style anchor links
// in the source MD's TOC (e.g., "1. The Bedrock — Why" → "1-the-bedrock--why").
// Single \s (not \s+) is intentional so consecutive spaces from stripped
// punctuation (em-dashes, periods) produce double hyphens like GFM.
function addHeadingIds(html) {
  const seen = Object.create(null);
  return html.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/g, (_m, tag, inner) => {
    const text = inner.replace(/<[^>]+>/g, '');
    let slug = text.toLowerCase().trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s/g, '-');
    if (!slug) slug = 'section';
    if (seen[slug] !== undefined) {
      seen[slug]++;
      slug = `${slug}-${seen[slug]}`;
    } else {
      seen[slug] = 0;
    }
    return `<${tag} id="${slug}">${inner}</${tag}>`;
  });
}

// Pre-process MD-rendered HTML into a clean stream the client can paginate.
// We do NOT pre-split into fixed pages here — the client paginates dynamically
// based on actual rendered height per device, so content reflows like a real book.
function preparePages(html) {
  return addHeadingIds(html.trim());
}

async function main() {
  console.log('📖 Building encrypted library...\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const metaPath = path.join(SOURCE_DIR, 'books-meta.json');
  if (!fs.existsSync(metaPath)) {
    console.error(`❌ books-meta.json not found at ${metaPath}`);
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

  marked.setOptions({ gfm: true, breaks: false });

  const books = [];
  for (const bookMeta of meta.books) {
    const mdPath = path.join(SOURCE_DIR, bookMeta.file);
    if (!fs.existsSync(mdPath)) {
      console.warn(`⚠ Skipping ${bookMeta.id}: source file missing (${mdPath})`);
      continue;
    }

    const md = fs.readFileSync(mdPath, 'utf-8');
    const html = marked.parse(md);
    const bookHtml = preparePages(html);

    books.push({
      id: bookMeta.id,
      title: bookMeta.title,
      subtitle: bookMeta.subtitle || '',
      author: bookMeta.author || '',
      cover: bookMeta.cover || 'linear-gradient(135deg, #2c1810, #6b3410)',
      html: bookHtml,
    });

    const kb = (bookHtml.length / 1024).toFixed(1);
    console.log(`  ✓ ${bookMeta.title} → ${kb} KB of HTML (paginated client-side)`);
  }

  if (books.length === 0) {
    console.error('❌ No books built. Check source/books-meta.json and source/*.md.');
    process.exit(1);
  }

  // Encrypt the entire library as a single payload
  const library = JSON.stringify({ books });
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(PASSWORD, salt);
  const encrypted = await encryptString(library, key);

  const output = {
    v: 1,
    kdf: 'PBKDF2',
    iterations: ITERATIONS,
    hash: 'SHA-256',
    cipher: 'AES-GCM',
    saltBytes: SALT_BYTES,
    ivBytes: IV_BYTES,
    salt: bufToB64(salt),
    library: encrypted,
  };

  const outPath = path.join(DATA_DIR, 'library.json');
  const payload = JSON.stringify(output);
  fs.writeFileSync(outPath, payload);

  // Content hash lets the client request library.json?v=<hash> and cache the
  // (large, growing) blob indefinitely, instead of re-downloading it on every
  // unlock. Only this tiny file needs to be fetched fresh.
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  fs.writeFileSync(
    path.join(DATA_DIR, 'version.json'),
    JSON.stringify({ hash, builtAt: new Date().toISOString() })
  );

  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n🔒 Encrypted library written to data/library.json (${sizeKB} KB)`);
  console.log(`   Content hash: ${hash}`);
  console.log(`   Cipher: AES-256-GCM | KDF: PBKDF2-SHA256 × ${ITERATIONS.toLocaleString()} iterations`);
  console.log(`   ${books.length} book(s) packed.\n`);
}

main().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
