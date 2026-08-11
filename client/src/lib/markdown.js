/**
 * Small markdown renderer. One copy, used everywhere.
 *
 * Escapes first, so model output can never inject HTML — the only tags in the
 * result are the ones this function emits.
 */
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[c]));

export function renderMarkdown(source = '') {
  let text = escapeHtml(source);

  /* Park code blocks behind sentinels so their contents survive inline passes. */
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(code);
    return `\n\n@@CB${blocks.length - 1}@@\n\n`;
  });

  text = text.replace(
    /^\|(.+)\|[ \t]*\n\|[ \t:\-|]+\|[ \t]*\n((?:\|.*\|[ \t]*\n?)+)/gm,
    (_m, head, rows) => {
      const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
      const th = cells(`|${head}|`).map((c) => `<th>${c}</th>`).join('');
      const tb = rows.trim().split('\n')
        .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
      return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>\n\n`;
    }
  );

  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^#{3,6}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  text = text.replace(/(?:^[-*+]\s+.+(?:\n|$))+/gm, (match) =>
    `<ul>${match.trim().split('\n').map((l) => `<li>${l.replace(/^[-*+]\s+/, '')}</li>`).join('')}</ul>`);

  text = text.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (match) =>
    `<ol>${match.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('')}</ol>`);

  text = text.split(/\n{2,}/).map((para) => {
    const trimmed = para.trim();
    if (!trimmed) return '';
    return /^<(h\d|ul|ol|pre|blockquote|table)/.test(trimmed)
      ? trimmed
      : `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return text
    .replace(/<p>\s*(@@CB\d+@@)\s*<\/p>/g, '$1')
    .replace(/@@CB(\d+)@@/g, (_m, i) => `<pre><code>${blocks[i].replace(/\n$/, '')}</code></pre>`);
}

export const timeAgo = (iso) => {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const shortModel = (slug = '') => {
  const tail = slug.split('/').pop().replace(/-(latest|preview)$/, '');
  return tail.length > 24 ? `${tail.slice(0, 23)}…` : tail;
};

export const initials = (slug = '?') =>
  slug.split('/').pop().replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();

export const countWords = (text = '') => text.split(/\s+/).filter(Boolean).length;

export const SEAT_COLORS = [
  '#007aff', '#ff9500', '#30b0c7', '#af52de',
  '#ff2d55', '#34c759', '#5856d6', '#a2845e'
];
export const seatColor = (i) => SEAT_COLORS[i % SEAT_COLORS.length];
