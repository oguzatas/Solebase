/**
 * Markdown preview helpers — marked (GFM) + wiki-links [[Note Title]].
 */

import { marked } from 'https://esm.sh/marked@15.0.4';

marked.setOptions({
  gfm: true,
  breaks: false,
});

const WIKI_RE = /\[\[([^\]]+)\]\]/g;
const TAG_RE = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * @param {string} str
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extract YAML-ish frontmatter tags + body.
 * Supports: tags: [a, b] | tags: a, b | tags:\n  - a
 * @param {string} raw
 * @returns {{ body: string, fmTags: string[], fm: Record<string, string> }}
 */
export function splitFrontmatter(raw) {
  const src = String(raw || '');
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { body: src, fmTags: [], fm: {} };

  const fm = {};
  const block = m[1];
  let currentKey = null;
  const listBuf = {};

  for (const line of block.split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && currentKey) {
      if (!listBuf[currentKey]) listBuf[currentKey] = [];
      listBuf[currentKey].push(listItem[1].trim());
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (val) {
        fm[currentKey] = val;
        currentKey = null;
      } else {
        listBuf[currentKey] = [];
      }
    }
  }

  for (const [k, arr] of Object.entries(listBuf)) {
    if (arr.length) fm[k] = arr.join(', ');
  }

  let fmTags = [];
  if (fm.tags) {
    const t = fm.tags;
    if (t.startsWith('[') && t.endsWith(']')) {
      fmTags = t
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fmTags = t
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }

  return {
    body: src.slice(m[0].length),
    fmTags: fmTags.map((t) => t.toLowerCase().replace(/^#/, '')),
    fm,
  };
}

/**
 * Inline #tags from body (not inside code fences).
 * @param {string} body
 */
export function extractInlineTags(body) {
  const text = stripCodeFences(String(body || ''));
  const tags = new Set();
  let m;
  const re = new RegExp(TAG_RE.source, 'g');
  while ((m = re.exec(text))) {
    tags.add(m[1].toLowerCase());
  }
  return [...tags];
}

/**
 * @param {string} body
 * @param {string[]} explicitTags
 */
export function collectTags(body, explicitTags = []) {
  const { body: rest, fmTags } = splitFrontmatter(body);
  const set = new Set(
    [...explicitTags, ...fmTags, ...extractInlineTags(rest)]
      .map((t) => String(t).toLowerCase().replace(/^#/, '').trim())
      .filter(Boolean),
  );
  return [...set].slice(0, 24);
}

/**
 * @param {string} src
 */
export function extractWikiLinks(src) {
  const { body } = splitFrontmatter(src);
  const text = stripCodeFences(body);
  const titles = [];
  const seen = new Set();
  let m;
  const re = new RegExp(WIKI_RE.source, 'g');
  while ((m = re.exec(text))) {
    const title = m[1].trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

/**
 * Heading outline from markdown body.
 * @param {string} src
 * @returns {{ level: number, text: string, id: string }[]}
 */
export function extractOutline(src) {
  const { body } = splitFrontmatter(src);
  const lines = body.split(/\r?\n/);
  const out = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!hm) continue;
    const level = hm[1].length;
    const text = hm[2].replace(/#+\s*$/, '').trim();
    const id = slugify(text);
    out.push({ level, text, id });
  }
  return out;
}

/**
 * @param {string} text
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function stripCodeFences(src) {
  return String(src).replace(/```[\s\S]*?```/g, '');
}

/**
 * Render markdown → HTML with wiki-links as navigable anchors.
 * @param {string} src
 * @param {{ noteTitles?: Set<string> }} [opts]
 */
export function renderMarkdown(src, opts = {}) {
  const { body } = splitFrontmatter(src);
  if (!body.trim()) {
    return '<p class="preview-empty">Nothing to preview.</p>';
  }

  const titleSet = opts.noteTitles || new Set();
  const withWiki = body.replace(WIKI_RE, (_, raw) => {
    const title = String(raw).trim();
    const exists = titleSet.has(title.toLowerCase());
    const cls = exists ? 'wiki-link' : 'wiki-link is-missing';
    return `<a class="${cls}" href="#wiki:${encodeURIComponent(title)}" data-wiki="${escapeHtml(title)}">${escapeHtml(title)}</a>`;
  });

  // Protect wiki HTML anchors from marked escaping by using placeholders
  const holders = [];
  const protectedSrc = withWiki.replace(/<a class="wiki-link[^"]*"[^>]*>[^<]*<\/a>/g, (html) => {
    const i = holders.length;
    holders.push(html);
    return `\u0000WIKI${i}\u0000`;
  });

  let html = marked.parse(protectedSrc, { async: false });
  html = String(html).replace(/\u0000WIKI(\d+)\u0000/g, (_, i) => holders[Number(i)] || '');

  // Task list polish — marked GFM emits checkboxes; ensure list class
  html = html.replace(/<ul>\s*<li><input /g, '<ul class="task-list"><li class="task-item"><input ');

  // Add ids to headings for outline jump
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    const text = String(inner).replace(/<[^>]+>/g, '');
    const id = slugify(text);
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });

  return html;
}
