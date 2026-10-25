// A small Markdown renderer for model replies. Everything is escaped first, so no HTML from the model runs.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function renderMarkdown(src) {
  return blocks(escapeHtml(String(src).replace(/\r/g, '')).split('\n'));
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ROW = /^\s*\|.*\|\s*$/;
const DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*&gt;\s?/;
const ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) ||
    (ROW.test(l) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]));
}

function blocks(lines) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if (FENCE.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      html += `<pre><code>${code.join('\n')}</code></pre>`;
    } else if ((m = line.match(HEADING))) {
      const tag = m[1].length <= 2 ? 'h3' : 'h4';
      html += `<${tag}>${inline(m[2])}</${tag}>`;
      i++;
    } else if (RULE.test(line)) {
      html += '<hr>';
      i++;
    } else if (ROW.test(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && ROW.test(lines[i])) body.push(cells(lines[i++]));
      html += `<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ''));
      html += `<blockquote>${blocks(quoted)}</blockquote>`;
    } else if (ITEM.test(line)) {
      const r = list(lines, i);
      html += r.html;
      i = r.next;
    } else {
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
      html += `<p>${para.map(inline).join('<br>')}</p>`;
    }
  }
  return html;
}

function list(lines, start) {
  const indent = (l) => l.match(/^\s*/)[0].length;
  const base = indent(lines[start]);
  const first = lines[start].match(ITEM);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && ITEM.test(lines[j]) && indent(lines[j]) === base) { i = j; continue; }
      break;
    }
    const m = l.match(ITEM);
    const ind = indent(l);
    if (m && ind === base) {
      items.push({ text: m[3], sub: '' });
      i++;
    } else if (m && ind > base && items.length) {
      const r = list(lines, i);
      items[items.length - 1].sub += r.html;
      i = r.next;
    } else if (!m && ind > base && items.length) {
      items[items.length - 1].text += ` ${l.trim()}`;
      i++;
    } else {
      break;
    }
  }
  const startAt = ordered ? parseInt(first[2], 10) : 1;
  const open = ordered ? `<ol${startAt !== 1 ? ` start="${startAt}"` : ''}>` : '<ul>';
  return { html: `${open}${items.map((it) => `<li>${inline(it.text)}${it.sub}</li>`).join('')}${ordered ? '</ol>' : '</ul>'}`, next: i };
}

function inline(s) {
  const codes = [];
  let out = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[n]}</code>`);
}
