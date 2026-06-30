#!/usr/bin/env node
/*
 * import-contacts.js — load a phone contacts export into the wa-contacts table.
 *
 * Run LOCALLY with your admin profile (the raw export never leaves your Mac):
 *   AWS_PROFILE=cli_user node baileys/import-contacts.js <file.vcf|file.csv> [defaultCC]
 *
 * Supports vCard (.vcf — iPhone/Android export) and Google Contacts CSV.
 * Numbers are normalized to the WhatsApp JID form (countrycode + number) and
 * written to DynamoDB "wa-contacts" as { number, name, contactId } (a stable
 * per-person id; one person's many numbers share it).
 *
 * RE-IMPORT IS EDIT-SAFE: by default existing rows are PRESERVED (your renames,
 * merges, and manual adds are kept) — only NEW numbers get added. Pass --overwrite
 * to force the source file's names back onto existing rows.
 *
 * defaultCC (default "91" = India) is prepended to bare 10-digit national numbers.
 */
const fs = require('fs');
const { randomUUID } = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const file = process.argv[2];
const CC = (process.argv[3] || '91').replace(/\D/g, '');
const REGION = process.env.AWS_REGION || 'ap-south-1';
const TABLE = process.env.WA_CONTACTS_TABLE || 'wa-contacts';
if (!file) {
  console.error('usage: AWS_PROFILE=cli_user node baileys/import-contacts.js <file.vcf|file.csv> [defaultCC]');
  process.exit(1);
}
const raw = fs.readFileSync(file, 'utf8');

// --- phone normalization → digits with country code (null if too short) -----
function normNumber(input) {
  let d = String(input).replace(/[^\d+]/g, '');
  d = d.replace(/^\+/, '').replace(/^00/, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.length === 10) d = CC + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

// --- vCard -------------------------------------------------------------------
function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function parseVCard(text) {
  const out = [];
  const cards = text.replace(/\r\n/g, '\n').split(/BEGIN:VCARD/i).slice(1);
  for (const card of cards) {
    const unfolded = card.replace(/\n[ \t]/g, '');
    let name = '', struct = '';
    const numbers = [];
    for (const line of unfolded.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const head = line.slice(0, i);
      let val = line.slice(i + 1).trim();
      const prop = head.split(';')[0].toUpperCase();
      if (/ENCODING=QUOTED-PRINTABLE/i.test(head)) { try { val = decodeQP(val); } catch (e) {} }
      if (prop === 'FN') name = val;
      else if (prop === 'N' && !struct) struct = val.split(';').filter(Boolean).join(' ').trim();
      else if (prop === 'TEL') { const n = normNumber(val); if (n) numbers.push(n); }
    }
    const display = (name || struct || '').trim();
    if (display && numbers.length) out.push({ name: display, numbers });
  }
  return out;
}

// --- CSV (Google Contacts) ---------------------------------------------------
// Quote-aware CSV tokenizer — parses the WHOLE text into rows so quoted fields
// with embedded commas OR newlines (common in Google exports) stay intact.
function parseCsvRows(text) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idxName = header.findIndex((h) => h === 'name');
  const idxFirst = header.indexOf('first name');
  const idxLast = header.indexOf('last name');
  const phoneCols = header.map((h, i) => (/phone.*value/.test(h) ? i : -1)).filter((i) => i >= 0);
  const out = [];
  for (const c of rows.slice(1)) {
    if (!c.some((v) => v && v.trim())) continue; // skip blank rows
    const name = (idxName >= 0 ? c[idxName] : [c[idxFirst], c[idxLast]].filter(Boolean).join(' ')).trim();
    const numbers = [];
    for (const pc of phoneCols)
      for (const part of String(c[pc] || '').split(/ ::: |[;/]/)) { const n = normNumber(part); if (n) numbers.push(n); }
    if (name && numbers.length) out.push({ name, numbers });
  }
  return out;
}

// --- run ---------------------------------------------------------------------
(async () => {
  const isVcf = /^﻿?BEGIN:VCARD/i.test(raw) || /\.vcf$/i.test(file);
  const contacts = isVcf ? parseVCard(raw) : parseCsv(raw);
  if (!contacts.length) { console.error('no usable contacts found — check the file format'); process.exit(1); }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const overwrite = process.argv.includes('--overwrite');

  // Existing rows: by default we PRESERVE them (manual renames/merges/adds), and
  // only add NEW numbers — so re-importing never clobbers your edits.
  const existing = {};    // number -> { name, contactId }
  const cidByNumber = {}; // number -> contactId
  const cidName = {};     // contactId -> existing name
  let ek;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: ek }));
    for (const it of r.Items || []) {
      existing[String(it.number)] = { name: it.name, contactId: it.contactId };
      if (it.contactId) { cidByNumber[String(it.number)] = it.contactId; if (it.name && !cidName[it.contactId]) cidName[it.contactId] = it.name; }
    }
    ek = r.LastEvaluatedKey;
  } while (ek);

  const newId = () => 'c_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const toWrite = {}; // number -> { name, contactId }
  let preserved = 0;
  for (const { name, numbers } of contacts) {
    // reuse a contactId already on any of this contact's numbers (existing table,
    // or assigned earlier in this run); otherwise mint a new one.
    let cid = null;
    for (const n of numbers) { if (toWrite[n]) { cid = toWrite[n].contactId; break; } if (cidByNumber[n]) { cid = cidByNumber[n]; break; } }
    if (!cid) cid = newId();
    const personName = cidName[cid] || name; // keep an existing person's (possibly edited) name
    for (const n of numbers) {
      if (existing[n] && !overwrite) { preserved++; cidByNumber[n] = existing[n].contactId || cid; continue; } // don't touch edited rows
      toWrite[n] = { name: overwrite ? name : personName, contactId: cid };
      cidByNumber[n] = cid;
      if (!cidName[cid]) cidName[cid] = toWrite[n].name;
    }
  }
  const entries = Object.entries(toWrite);
  console.log(`parsed ${contacts.length} contacts (${isVcf ? 'vCard' : 'CSV'}, CC=+${CC}); ${overwrite ? 'OVERWRITE' : 'preserve'} mode → ${entries.length} new/updated numbers, ${preserved} existing preserved`);
  if (!entries.length) { console.log('nothing to write — all numbers already present.'); return; }

  const now = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < entries.length; i += 25) {
    let items = entries.slice(i, i + 25).map(([number, v]) => ({ PutRequest: { Item: { number, name: v.name, contactId: v.contactId, updatedAt: now } } }));
    for (let attempt = 0; attempt < 5 && items.length; attempt++) {
      const r = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items } }));
      const un = (r.UnprocessedItems && r.UnprocessedItems[TABLE]) || [];
      written += items.length - un.length;
      items = un;
      if (items.length) await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
    }
  }
  console.log(`→ wrote ${written}/${entries.length} numbers to ${TABLE} (${REGION})`);
})().catch((e) => { console.error('import failed:', e && e.message); process.exit(1); });
