// Mail text for a record (docs/integrations.md §3.1), shared by the Gmail
// and Outlook syncs: HTML becomes readable text, and stray tags in a plain
// text body are removed, so no HTML ever reaches a record.

const entities: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  euro: '€',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

/**
 * HTML to readable text: no tags, no styles or scripts, block elements as line
 * breaks, links as their text. Not a full HTML parser; enough for mail.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return normalizeWhitespace(decodeEntities(text));
}

/**
 * Some senders put HTML in their text/plain part. Removes whole tags only:
 * "<br>", "<a href=…>", "</a>"; "a < b" and "<https://…>" stay.
 */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;
function stripTags(text: string): string {
  return text.replace(TAG, '');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A text body as it may arrive: without stray tags, with tidy whitespace. */
export function plainText(text: string): string {
  return normalizeWhitespace(stripTags(text));
}
