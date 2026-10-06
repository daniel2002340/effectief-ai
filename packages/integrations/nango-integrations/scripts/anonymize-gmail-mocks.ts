// Anonymizes the mocks `nango dryrun --save` wrote for a Gmail function
// (CLAUDE.md, "Externe accounts"; README.md). Keeps the structure Gmail
// returned (MIME tree, labels, ids, sizes), replaces everything personal:
// names, addresses, subjects, text, file names, link targets, image data. Only
// the headers the function reads stay. The records Nango would save
// (`nango.batchSave`/`batchDelete`) are dropped: the tests compute them from
// the anonymized responses.
//
//   node scripts/anonymize-gmail-mocks.ts <raw.json> <out.test.json>
//
// No imports from the functions: Node runs this file with type stripping.

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('usage: node scripts/anonymize-gmail-mocks.ts <raw.json> <out.test.json>\n');
  process.exit(1);
}

const OWN_ADDRESS = 'info@bedrijf.example';
const keptHeaders = new Set([
  'from',
  'to',
  'cc',
  'subject',
  'message-id',
  'date',
  'content-type',
  'content-disposition',
  'content-transfer-encoding',
  'mime-version',
]);

/** Same real value → same replacement, numbered in order of appearance. */
function numbering(make: (n: number) => string) {
  const seen = new Map<string, string>();
  return (real: string) => {
    const key = real.trim().toLowerCase();
    let value = seen.get(key);
    if (!value) {
      value = make(seen.size + 1);
      seen.set(key, value);
    }
    return value;
  };
}

let ownAddress = '';
const addressOf = numbering((n) => `persoon${n}@voorbeeld.example`);
const nameOf = numbering((n) => `Persoon ${n}`);
const subjectOf = numbering((n) => `Onderwerp ${n}`);
const fileOf = numbering((n) => `bestand-${n}`);
const attachmentIdOf = numbering((n) => `attachment-${n}`);
const messageIdOf = numbering((n) => `<bericht-${n}@voorbeeld.example>`);

function address(real: string): string {
  if (ownAddress && real.trim().toLowerCase() === ownAddress) return OWN_ADDRESS;
  return addressOf(real);
}

/** "Name <addr>, addr" with every name and address replaced. */
function addressHeader(value: string): string {
  return value.replace(
    /(?:"((?:[^"\\]|\\.)*)"|([^,<>"]*?))\s*<([^<>]+)>|([^\s,<>"]+@[^\s,<>"]+)/g,
    (
      _match,
      quoted: string | undefined,
      plain: string | undefined,
      bracketed: string | undefined,
      bare: string | undefined,
    ) => {
      if (bare) return address(bare);
      const name = (quoted ?? plain ?? '').trim();
      const replaced = address(bracketed ?? '');
      return name ? `"${nameOf(name)}" <${replaced}>` : `<${replaced}>`;
    },
  );
}

function fileName(real: string): string {
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(real)?.[1];
  return `${fileOf(real)}${extension ? `.${extension.toLowerCase()}` : ''}`;
}

const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'tekst', 'voorbeeld', 'regel'];
/** Neutral words, as many as there were, so lines keep their shape. */
function neutral(text: string): string {
  let i = 0;
  return text.replace(
    /[\p{L}\p{N}][\p{L}\p{N}'’.@_-]*/gu,
    () => WORDS[i++ % WORDS.length] ?? 'tekst',
  );
}

function neutralHtml(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(<(?:script|style)\b[^>]*>)[\s\S]*?(<\/(?:script|style)\s*>)/gi, '$1$2')
      .replace(
        /\s(href|src|alt|title)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
        (_m, name: string, value: string) =>
          ` ${name}="${/^["']?cid:/i.test(value) ? 'cid:afbeelding' : 'https://voorbeeld.example/'}"`,
      )
      // Text between tags, and before the first and after the last tag.
      .replace(
        /(^|>)([^<]+)(?=<|$)/g,
        (_m, open: string, text: string) => `${open}${neutral(text)}`,
      )
  );
}

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
/** A 1×1 transparent PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII';

type Json = null | boolean | number | string | Json[] | JsonObject;
/** The keys this script reads are declared, so they can be read as properties. */
interface JsonObject {
  [key: string]: Json | undefined;
  api?: Json;
  attachmentId?: Json;
  batchDelete?: Json;
  batchSave?: Json;
  body?: Json;
  data?: Json;
  emailAddress?: Json;
  filename?: Json;
  getConnection?: Json;
  headers?: Json;
  mimeType?: Json;
  name?: Json;
  nango?: Json;
  output?: Json;
  size?: Json;
  snippet?: Json;
  value?: Json;
}

function anonymizePart(part: JsonObject) {
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
  if (Array.isArray(part.headers)) {
    part.headers = part.headers.flatMap((header) => {
      if (!header || typeof header !== 'object' || Array.isArray(header)) return [];
      const name = String(header.name ?? '');
      const value = String(header.value ?? '');
      const lower = name.toLowerCase();
      if (!keptHeaders.has(lower)) return [];
      if (lower === 'from' || lower === 'to' || lower === 'cc')
        return [{ name, value: addressHeader(value) }];
      if (lower === 'subject') return [{ name, value: subjectOf(value) }];
      if (lower === 'message-id') return [{ name, value: messageIdOf(value) }];
      if (lower === 'content-type' || lower === 'content-disposition') {
        return [
          {
            name,
            value: value.replace(
              /(name)="?([^";]+)"?/gi,
              (_m, key: string, file: string) => `${key}="${fileName(file)}"`,
            ),
          },
        ];
      }
      return [{ name, value }];
    });
  }
  if (typeof part.filename === 'string' && part.filename) part.filename = fileName(part.filename);
  const body = part.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (typeof body.attachmentId === 'string')
      body.attachmentId = attachmentIdOf(body.attachmentId);
    if (typeof body.data === 'string') {
      if (mimeType === 'text/plain') body.data = encode(neutral(decode(body.data)));
      else if (mimeType === 'text/html') body.data = encode(neutralHtml(decode(body.data)));
      else body.data = PIXEL;
      if (mimeType.startsWith('text/')) body.size = decode(body.data).length;
    }
  }
}

function walk(value: Json): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if ('mimeType' in value || 'headers' in value) anonymizePart(value);
  if (typeof value.snippet === 'string') value.snippet = neutral(value.snippet);
  if (typeof value.emailAddress === 'string') value.emailAddress = OWN_ADDRESS;
  for (const nested of Object.values(value)) walk(nested ?? null);
}

/** The mailbox's own address, from the profile response, maps to OWN_ADDRESS. */
function findOwnAddress(value: Json): string | undefined {
  if (Array.isArray(value)) return value.map(findOwnAddress).find(Boolean);
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.emailAddress === 'string') return value.emailAddress.toLowerCase();
  return Object.values(value)
    .map((nested) => findOwnAddress(nested ?? null))
    .find(Boolean);
}

const mocks = JSON.parse(readFileSync(input, 'utf8')) as JsonObject;
ownAddress = findOwnAddress(mocks.api ?? null) ?? '';
walk(mocks.api ?? null);
if (mocks.nango && typeof mocks.nango === 'object' && !Array.isArray(mocks.nango)) {
  delete mocks.nango.batchSave;
  delete mocks.nango.batchDelete;
  delete mocks.nango.getConnection;
}
if ('output' in mocks) delete mocks.output;

const text = `${JSON.stringify(mocks, null, 2)}\n`;
const leftovers = [ownAddress].filter((real) => real && text.toLowerCase().includes(real));
if (leftovers.length > 0) {
  process.stderr.write('The mailbox address is still in the output; not written.\n');
  process.exit(1);
}
writeFileSync(output, text);
process.stdout.write(`Written: ${output}\n`);
