/* ============================================================
   Pagination — measures rendered height and splits a book's HTML into
   page-sized chunks. Extracted from app.js so it can be unit-tested: a
   regression here silently strips inline markup (gloss spans) from the
   books, which is invisible until you read the affected page.
   Loaded as a classic script before app.js; also require()-able in tests.
   ============================================================ */

// Dynamically paginate raw HTML by measuring rendered height into chunks
// that exactly fill page-content boxes — like a real book.
function paginateHtmlForBox(html, contentW, contentH) {
  // Hidden measurement container styled like a real .page-content
  const pageWrap = document.createElement('div');
  pageWrap.className = 'page';
  pageWrap.style.cssText = `position:fixed;left:-99999px;top:0;width:${contentW + 80}px;visibility:hidden;`;
  const probe = document.createElement('div');
  probe.className = 'page-content';
  probe.style.cssText = `width:${contentW}px;height:auto;overflow:visible;`;
  pageWrap.appendChild(probe);
  document.body.appendChild(pageWrap);

  // Parse source HTML into block-level nodes
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const blocks = Array.from(tmp.childNodes).filter(
    (n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())
  );

  const pages = [];
  let buffer = document.createElement('div');

  const measure = () => {
    probe.replaceChildren(...Array.from(buffer.cloneNode(true).childNodes));
    return probe.scrollHeight;
  };

  const flushPage = () => {
    if (buffer.children.length === 0 && !buffer.textContent.trim()) return;
    pages.push(buffer.innerHTML);
    buffer = document.createElement('div');
  };

  const tryAdd = (node) => {
    buffer.appendChild(node);
    if (measure() <= contentH) return true;
    buffer.removeChild(node);
    return false;
  };

  // Split a block element internally if too tall.
  const splitBlock = (node) => {
    // Lists: split items across pages, preserving OL numbering across pages
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      const items = Array.from(node.children);
      const isOl = node.tagName === 'OL';
      const baseStart = isOl ? parseInt(node.getAttribute('start') || '1', 10) : 1;
      const result = [];
      let processed = 0;
      let part = node.cloneNode(false);
      if (isOl) part.setAttribute('start', String(baseStart));
      for (const it of items) {
        const trial = part.cloneNode(true);
        trial.appendChild(it.cloneNode(true));
        const tBuf = buffer.cloneNode(true);
        tBuf.appendChild(trial);
        probe.replaceChildren(...Array.from(tBuf.cloneNode(true).childNodes));
        if (probe.scrollHeight <= contentH || part.children.length === 0) {
          part.appendChild(it.cloneNode(true));
          processed++;
        } else {
          result.push(part);
          part = node.cloneNode(false);
          if (isOl) part.setAttribute('start', String(baseStart + processed));
          part.appendChild(it.cloneNode(true));
          processed++;
        }
      }
      if (part.children.length > 0) result.push(part);
      return result;
    }

    // Text blocks: split at sentence boundaries WITHOUT flattening to text.
    // Walking childNodes (rather than reading textContent) is what preserves
    // inline markup — gloss spans, <strong>, <em>, links — across a page break.
    if (!(node.textContent || '').trim()) return [node];

    // Atoms = sentence-sized text pieces + whole inline elements.
    const atoms = [];
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const pieces =
          child.textContent.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [child.textContent];
        for (const p of pieces) if (p) atoms.push(document.createTextNode(p));
      } else {
        atoms.push(child.cloneNode(true));
      }
    }
    if (atoms.length === 0) return [node];

    const result = [];
    let part = node.cloneNode(false);
    const partFits = () => {
      const tBuf = buffer.cloneNode(true);
      tBuf.appendChild(part.cloneNode(true));
      probe.replaceChildren(...Array.from(tBuf.cloneNode(true).childNodes));
      return probe.scrollHeight <= contentH;
    };

    for (const atom of atoms) {
      part.appendChild(atom);
      // Keep at least one atom per part, else an oversized atom loops forever.
      if (!partFits() && part.childNodes.length > 1) {
        part.removeChild(atom);
        result.push(part);
        part = node.cloneNode(false);
        part.appendChild(atom);
      }
    }
    if (part.childNodes.length > 0) result.push(part);

    // Only the first part keeps the id — duplicate ids break anchor navigation.
    for (let i = 1; i < result.length; i++) result[i].removeAttribute('id');
    return result.length > 0 ? result : [node];
  };

  // Whether the last element in buffer is one we don't want orphaned at the
  // end of a page (real heading, or a short bold-only lead-in like
  // "**The Bigger Diagnosis:**" which is structurally <p><strong>…</strong></p>).
  const isOrphanCandidate = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (/^H[1-6]$/.test(el.tagName)) return true;
    if (el.tagName === 'P') {
      const kids = el.children;
      const text = (el.textContent || '').trim();
      if (kids.length === 1 && kids[0].tagName === 'STRONG' && text.length < 100) return true;
    }
    return false;
  };

  // True chapter headings (h1) start on a fresh page like a real book.
  // h2/h3 remain inline so we don't bloat the page count with hundreds of
  // half-empty section-break pages.
  const isChapterHeading = (el) => el && el.nodeType === 1 && el.tagName === 'H1';

  // Test if [orphan + nextBlock] fit together on a fresh empty page.
  const orphanPlusFits = (orphanEl, nextEl) => {
    const test = document.createElement('div');
    test.appendChild(orphanEl.cloneNode(true));
    test.appendChild(nextEl.cloneNode(true));
    probe.replaceChildren(...Array.from(test.cloneNode(true).childNodes));
    return probe.scrollHeight <= contentH;
  };

  for (const block of blocks) {
    if (block.nodeType === 3) {
      const wrap = document.createElement('p');
      wrap.textContent = block.textContent;
      if (tryAdd(wrap)) continue;
      flushPage();
      if (!tryAdd(wrap)) {
        for (const piece of splitBlock(wrap)) {
          if (!tryAdd(piece.cloneNode(true))) {
            flushPage();
            tryAdd(piece.cloneNode(true));
          }
        }
      }
      continue;
    }

    const cloned = block.cloneNode(true);

    // Chapter-level headings always start a fresh page.
    if (isChapterHeading(cloned) && buffer.children.length > 0) {
      flushPage();
    }

    if (tryAdd(cloned)) continue;

    // Block doesn't fit on current page. If buffer ends with an orphan
    // candidate (heading / lead-in) AND moving it together with the next
    // block would actually fit on a fresh page, demote the orphan. Otherwise
    // leave it where it is — orphan-with-content beats orphan-on-empty-page.
    let pendingOrphan = null;
    const lastEl = buffer.lastElementChild;
    if (isOrphanCandidate(lastEl) && orphanPlusFits(lastEl, cloned)) {
      pendingOrphan = buffer.removeChild(lastEl);
    }
    flushPage();
    if (pendingOrphan) buffer.appendChild(pendingOrphan);
    if (tryAdd(cloned)) continue;

    // Block alone still exceeds an empty page — split it.
    const parts = splitBlock(block);
    for (const part of parts) {
      const partClone = part.cloneNode(true);
      if (!tryAdd(partClone)) {
        flushPage();
        tryAdd(partClone);
      }
    }
  }

  flushPage();
  pageWrap.remove();
  return pages.length > 0 ? pages : [html];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { paginateHtmlForBox };
}
