// Coverage map — guarantees no knowledge is lost when the two legacy
// mega-books are distilled into the 14 topic books.
//
// Every h2 section of the legacy books becomes a row that must be assigned to
// a target topic book and marked absorbed. Nothing may be silently dropped:
// a section is either ABSORBED into a named book, or explicitly EXCLUDED with
// a stated reason (promotional content, a creator's personal anecdote, or a
// claim research disproved).
//
//   node scripts/coverage-map.mjs          -> rebuild _ledger/_coverage-master.md
//   node scripts/coverage-map.mjs --status -> progress report
//
// Assignments live in _ledger/_assignments.json so a rebuild never loses them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'source');
const LEDGER = path.join(ROOT, '_ledger');
const ASSIGN_FILE = path.join(LEDGER, '_assignments.json');

const LEGACY = ['become-ungovernable.md', 'become-best-version.md'];

export const TOPIC_BOOKS = [
  'stoicism',
  'nietzsche',
  'existentialism',
  'machiavelli-power',
  'jung-freud',
  'eastern-indian',
  'great-thinkers',
  'discipline-focus',
  'health-body',
  'meditation-peace',
  'practical-psychology',
  'masculinity',
  'relationships',
  'goals-belief',
  // Added after the coverage pass: the legacy books carry substantial money
  // and communication material that none of the original 14 topics could
  // house. Without these two, that knowledge would have been dropped.
  'money-wealth',
  'communication-charisma',
];

function extractSections(file) {
  const md = fs.readFileSync(path.join(SOURCE, file), 'utf8');
  const lines = md.split('\n');
  const sections = [];
  let current = null;

  lines.forEach((ln, i) => {
    const m = /^(#{1,3})\s+(.+)$/.exec(ln);
    if (m && m[1].length <= 2) {
      if (current) sections.push(current);
      current = {
        book: file.replace('.md', ''),
        level: m[1].length,
        title: m[2].replace(/\*\*/g, '').trim(),
        line: i + 1,
        subheads: [],
        chars: 0,
      };
    } else if (current) {
      if (m && m[1].length === 3) current.subheads.push(m[2].replace(/\*\*/g, '').trim());
      current.chars += ln.length;
    }
  });
  if (current) sections.push(current);
  // Drop pure navigation scaffolding.
  return sections.filter(
    (s) => !/^table of contents$/i.test(s.title) && s.chars > 0
  );
}

function key(s) {
  return `${s.book}::${s.title}`;
}

function loadAssignments() {
  if (!fs.existsSync(ASSIGN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ASSIGN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const sections = LEGACY.flatMap(extractSections);
const assignments = loadAssignments();

if (process.argv.includes('--status')) {
  const total = sections.length;
  const done = sections.filter((s) => {
    const a = assignments[key(s)];
    return a && (a.status === 'absorbed' || a.status === 'excluded');
  }).length;
  const byBook = {};
  let excluded = 0;
  for (const s of sections) {
    const a = assignments[key(s)];
    if (!a) continue;
    if (a.status === 'excluded') excluded++;
    else if (a.target) byBook[a.target] = (byBook[a.target] || 0) + 1;
  }
  console.log(`\nCoverage: ${done}/${total} legacy sections accounted for (${((done / total) * 100).toFixed(1)}%)`);
  console.log(`  absorbed: ${done - excluded}   excluded (with reason): ${excluded}   unassigned: ${total - done}\n`);
  for (const b of TOPIC_BOOKS) {
    if (byBook[b]) console.log(`  ${b.padEnd(22)} ${byBook[b]} sections`);
  }
  const missing = sections.filter((s) => !assignments[key(s)]);
  if (missing.length) {
    console.log(`\n  NOT YET ASSIGNED (${missing.length}) — first 15:`);
    for (const s of missing.slice(0, 15)) {
      console.log(`    [${s.book}] ${s.title.slice(0, 70)}`);
    }
  }
  console.log('');
  process.exit(0);
}

// Rebuild the human-readable map.
fs.mkdirSync(LEDGER, { recursive: true });
const out = [];
out.push('# Coverage Master — legacy knowledge -> 14 topic books\n');
out.push('Every section below must end up either **absorbed** into a topic book or');
out.push('**excluded** with a stated reason. This file is generated; edit');
out.push('`_ledger/_assignments.json` instead.\n');
out.push(`Generated: ${new Date().toISOString().slice(0, 10)}  |  ${sections.length} sections\n`);

for (const file of LEGACY) {
  const name = file.replace('.md', '');
  const mine = sections.filter((s) => s.book === name);
  out.push(`\n## ${name} — ${mine.length} sections\n`);
  out.push('| Line | Section | Sub-heads | Size | Target | Status |');
  out.push('|---|---|---|---|---|---|');
  for (const s of mine) {
    const a = assignments[key(s)] || {};
    out.push(
      `| ${s.line} | ${s.title.replace(/\|/g, '/').slice(0, 60)} | ${s.subheads.length} | ${(s.chars / 1024).toFixed(1)}K | ${a.target || '—'} | ${a.status || 'unassigned'} |`
    );
  }
}

fs.writeFileSync(path.join(LEDGER, '_coverage-master.md'), out.join('\n') + '\n');
console.log(`\nWrote _ledger/_coverage-master.md — ${sections.length} sections indexed`);
console.log(`Assignments so far: ${Object.keys(assignments).length}\n`);
