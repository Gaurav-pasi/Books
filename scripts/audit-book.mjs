// Book audit — runs the locked content rules against a source/*.md file.
//
// Usage:  node scripts/audit-book.mjs [stoicism]      (omit to audit all)
//
// These rules came from real mistakes, so each check pins a specific one:
//   - a single stray Devanagari character survived a hand review
//   - the legacy books state fabricated quotes as fact
//   - the legacy books still carry the source creator's branding and voice
//   - "on point, not long" is the agreed bar; padding is a regression
//
// Exits non-zero if any ERROR fires. Warnings are advisory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, '..', 'source');

// Idioms and loanwords the user explicitly rejected as unclear.
const BANNED_IDIOMS = [
  'toot gaya', 'sab kuch khoya', 'ujad gayi', 'duniya hi badal gayi',
  'kangal', 'bechara', 'sar pe haath', 'swaha', 'akaal', 'vinaash',
  'tirohit', 'khaaq', 'nasheb',
];

// Quotes neither man wrote. Allowed ONLY inside an unverified caveat that
// says so — never presented as genuine.
const FABRICATED_QUOTES = [
  { text: 'not what happens to you', who: 'Epictetus' },
  { text: 'power over your mind', who: 'Marcus Aurelius' },
];

const SIZE_WARN_KB = 45; // "on point, not long"

function auditBook(file) {
  const name = path.basename(file);
  const md = fs.readFileSync(file, 'utf8');
  const errors = [];
  const warnings = [];
  const lines = md.split('\n');

  // --- language integrity ------------------------------------------------
  lines.forEach((ln, i) => {
    if (/[ऀ-ॿ]/.test(ln)) {
      errors.push(`line ${i + 1}: Devanagari characters (books are Hinglish in Latin script)`);
    }
  });

  const lower = md.toLowerCase();
  for (const idiom of BANNED_IDIOMS) {
    if (lower.includes(idiom)) warnings.push(`banned idiom/loanword: "${idiom}"`);
  }

  // --- provenance --------------------------------------------------------
  // "Speaker's X" is the residue pattern from transcript-derived text.
  // Plain "speaker" (an orator) is fine.
  const residue = md.match(/Speaker['’]s|Speaker\s*\(|Desi Philosopher|is video mein/gi);
  if (residue) errors.push(`creator-derived residue: ${[...new Set(residue)].join(', ')}`);

  const promo = md.match(/masterclass|₹\s?\d|buy now|enroll now|lifetime access/gi);
  if (promo) errors.push(`promotional content: ${[...new Set(promo)].join(', ')}`);

  // --- factual guardrails ------------------------------------------------
  for (const q of FABRICATED_QUOTES) {
    let idx = lower.indexOf(q.text);
    while (idx !== -1) {
      // Must sit inside/next to an unverified caveat explaining it is fake.
      const window = md.slice(Math.max(0, idx - 700), idx + 700);
      if (!window.includes('gloss unverified')) {
        errors.push(
          `fabricated quote presented as genuine ("${q.text}" — ${q.who} never wrote it)`
        );
        break;
      }
      idx = lower.indexOf(q.text, idx + 1);
    }
  }

  // --- structure ---------------------------------------------------------
  const ids = new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, h]) =>
    h.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s/g, '-')
  ));
  const tocLinks = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  const broken = tocLinks.filter((l) => !ids.has(l));
  if (broken.length) errors.push(`broken TOC links: ${broken.slice(0, 5).join(', ')}`);

  // Unbalanced spans render as visible raw markup mid-sentence.
  const opens = (md.match(/<span/g) || []).length;
  const closes = (md.match(/<\/span>/g) || []).length;
  if (opens !== closes) errors.push(`unbalanced <span>: ${opens} open vs ${closes} close`);

  // --- size / density ----------------------------------------------------
  const kb = Buffer.byteLength(md, 'utf8') / 1024;
  if (kb > SIZE_WARN_KB) {
    warnings.push(`${kb.toFixed(1)} KB — over the ${SIZE_WARN_KB} KB "on point" guideline`);
  }
  const glosses = (md.match(/class="gloss"/g) || []).length;
  const unverified = (md.match(/class="gloss unverified"/g) || []).length;
  if (glosses === 0) warnings.push('no gloss spans — hard terms should be explained inline');

  return { name, kb, glosses, unverified, tocLinks: tocLinks.length, errors, warnings };
}

const arg = process.argv[2];
const files = arg
  ? [path.join(SOURCE, arg.endsWith('.md') ? arg : `${arg}.md`)]
  : fs.readdirSync(SOURCE).filter((f) => f.endsWith('.md')).map((f) => path.join(SOURCE, f));

let failed = 0;
console.log('');
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`  ! not found: ${f}`);
    failed++;
    continue;
  }
  const r = auditBook(f);
  const status = r.errors.length ? 'FAIL' : 'pass';
  console.log(
    `${status}  ${r.name}  —  ${r.kb.toFixed(1)} KB, ${r.glosses} glosses, ` +
      `${r.unverified} caveats, ${r.tocLinks} TOC links`
  );
  for (const e of r.errors) console.log(`        ERROR  ${e}`);
  for (const w of r.warnings) console.log(`        warn   ${w}`);
  if (r.errors.length) failed++;
}
console.log('');
process.exit(failed ? 1 : 0);
