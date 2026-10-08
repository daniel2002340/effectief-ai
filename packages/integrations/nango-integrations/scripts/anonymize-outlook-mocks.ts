// Anonymizes the mocks `nango dryrun --save` wrote for the Outlook sync
// (CLAUDE.md, "Externe accounts"; README.md). Keeps the structure Graph
// returned (fields, statuses, links, the shape and length of ids), replaces
// everything personal: names, addresses, subjects, text, file names. Ids,
// folder ids and delta tokens are replaced everywhere they occur, also inside
// links and mock keys, so the mocks still answer the sync's requests. The
// records Nango would save are dropped: the tests compute them.
//
//   node scripts/anonymize-outlook-mocks.ts <raw.json> <out.json>
//
// No imports from the functions: Node runs this file with type stripping.

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('usage: node scripts/anonymize-outlook-mocks.ts <raw.json> <out.json>\n');
  process.exit(1);
}

type Json = null | boolean | number | string | Json[] | JsonObject;
/** The keys this script reads are declared, so they can be read as properties. */
interface JsonObject {
  [key: string]: Json | undefined;
  address?: Json;
  api?: Json;
  body?: Json;
  content?: Json;
  emailAddress?: Json;
  error?: Json;
  get?: Json;
  id?: Json;
  innerError?: Json;
  internetMessageId?: Json;
  message?: Json;
  name?: Json;
  nango?: Json;
  response?: Json;
  subject?: Json;
  value?: Json;
}
const isObject = (value: Json | undefined): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Same real value → same replacement, numbered in order of appearance. */
function numbering(make: (n: number, real: string) => string) {
  const seen = new Map<string, string>();
  return (real: string) => {
    let value = seen.get(real);
    if (!value) {
      value = make(seen.size + 1, real);
      seen.set(real, value);
    }
    return value;
  };
}

/** An id of the same length and alphabet: "AAMk…" ids keep their "=" and "_". */
const opaque = (label: string) =>
  numbering((n, real) => {
    const head = `${label}${n}x`;
    const tail = real.endsWith('=') ? '=' : '';
    return (
      (head + 'A'.repeat(Math.max(0, real.length - head.length - tail.length))).slice(
        0,
        Math.max(head.length, real.length - tail.length),
      ) + tail
    );
  });

const ids = new Map<string, string>();
const messageIdOf = opaque('AAMkMsg');
const conversationIdOf = opaque('AAQkConv');
const attachmentIdOf = opaque('AAMkAtt');
const folderIdOf = opaque('AQMkFolder');
const tokenOf = numbering((n) => `token${n}`);

const addressOf = numbering((n) => `persoon${n}@voorbeeld.example`);
const nameOf = numbering((n) => `Persoon ${n}`);
const subjectOf = numbering((n) => `Onderwerp ${n}`);
const fileOf = numbering((n) => `bestand-${n}`);
const internetIdOf = numbering((n) => `<bericht-${n}@voorbeeld.example>`);

const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'tekst', 'voorbeeld', 'regel'];
/** Neutral words, as many as there were, so lines keep their shape. */
function neutral(text: string): string {
  let i = 0;
  return text.replace(
    /[\p{L}\p{N}][\p{L}\p{N}'’.@_:/-]*/gu,
    () => WORDS[i++ % WORDS.length] ?? 'tekst',
  );
}

function fileName(real: string): string {
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(real)?.[1];
  return `${fileOf(real)}${extension ? `.${extension.toLowerCase()}` : ''}`;
}

const raw = JSON.parse(readFileSync(input, 'utf8')) as JsonObject;
delete raw.nango;

/** A token appears decoded in params and encoded in links: one fake for both. */
function addToken(token: string) {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {}
  const fake = tokenOf(decoded);
  ids.set(token, fake);
  ids.set(decoded, fake);
}

/** Pass 1: every id and token, so pass 3 can replace them everywhere. */
function collect(value: Json, key = ''): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key);
    return;
  }
  if (isObject(value)) {
    for (const [k, nested] of Object.entries(value)) collect(nested ?? null, k);
    return;
  }
  if (typeof value !== 'string') return;
  if (key === 'id' && value.length > 40) ids.set(value, messageIdOf(value));
  if (key === 'conversationId') ids.set(value, conversationIdOf(value));
  if (key === 'parentFolderId') ids.set(value, folderIdOf(value));
  if (key === '$deltatoken' || key === '$skiptoken') addToken(value);
  for (const match of value.matchAll(/\$(?:deltatoken|skiptoken)=([^&"]+)/g)) {
    if (match[1]) addToken(match[1]);
  }
  for (const match of value.matchAll(/request token '([^']+)'/g)) {
    const token = match[1];
    if (token) ids.set(token, tokenOf(token));
  }
}

/** Folder ids and attachment ids: known by where they are, not by their key. */
function collectFolders(api: Json): void {
  if (!isObject(api) || !isObject(api.get)) return;
  for (const [endpoint, mock] of Object.entries(api.get)) {
    for (const entry of Array.isArray(mock) ? mock : [mock]) {
      if (!isObject(entry) || !isObject(entry.response)) continue;
      const id = entry.response.id;
      if (endpoint.startsWith('/v1.0/me/mailFolders/') && typeof id === 'string') {
        ids.set(id, folderIdOf(id));
      }
      const list = entry.response.value;
      if (endpoint.endsWith('/attachments') && Array.isArray(list)) {
        for (const attachment of list) {
          if (isObject(attachment) && typeof attachment.id === 'string') {
            ids.set(attachment.id, attachmentIdOf(attachment.id));
          }
        }
      }
    }
  }
}

/** Pass 2: personal content by field. */
function scrub(value: Json, key = ''): Json {
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (isObject(value)) {
    if (isObject(value.emailAddress)) {
      const email = value.emailAddress;
      value.emailAddress = {
        ...(typeof email.name === 'string' ? { name: nameOf(email.name) } : {}),
        ...(typeof email.address === 'string'
          ? { address: addressOf(email.address.toLowerCase()) }
          : {}),
      };
    }
    const out: JsonObject = {};
    for (const [k, nested] of Object.entries(value)) {
      if (k === 'hash' || k === 'contentBytes') continue;
      out[k] = k === 'emailAddress' ? nested : scrub(nested ?? null, k);
    }
    if (typeof out.subject === 'string') out.subject = subjectOf(out.subject);
    if (isObject(out.body) && typeof out.body.content === 'string') {
      out.body = { ...out.body, content: neutral(out.body.content) };
    }
    if (typeof out.internetMessageId === 'string') {
      out.internetMessageId = internetIdOf(out.internetMessageId);
    }
    if (typeof out['@odata.etag'] === 'string') out['@odata.etag'] = 'W/"etag"';
    if (typeof out['@odata.context'] === 'string') {
      out['@odata.context'] = 'https://graph.microsoft.com/v1.0/$metadata#voorbeeld';
    }
    if (typeof out.name === 'string' && 'contentType' in out) out.name = fileName(out.name);
    if (isObject(out.error) && typeof out.error.message === 'string') {
      out.error = { ...out.error, message: out.error.message.replace(/'[^']*'/g, "'…'") };
      if (isObject(out.error.innerError)) out.error.innerError = {};
    }
    return out;
  }
  return value;
}

collect(raw);
collectFolders(raw.api ?? null);
let text = JSON.stringify(scrub(raw));

/** Pass 3: every id and token, also URL-encoded inside links and mock keys. */
const longestFirst = [...ids.entries()].sort((a, b) => b[0].length - a[0].length);
for (const [real, fake] of longestFirst) {
  for (const [from, to] of [
    [real, fake],
    [encodeURIComponent(real), encodeURIComponent(fake)],
  ] as const) {
    text = text.split(from).join(to);
  }
}

writeFileSync(output, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
process.stdout.write(`wrote ${output}: ${ids.size} ids and tokens replaced\n`);
