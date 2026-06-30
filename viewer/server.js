/*
 * server.js — local web UI backend for browsing the WhatsApp archive.
 *
 * Reads DynamoDB (table wa-messages) and presigns the private S3 media bucket,
 * using your local AWS profile (default: cli_user). Runs entirely on your machine.
 *
 *   npm start         # → http://localhost:5173
 *
 * Env overrides: PORT, AWS_PROFILE, WA_REGION, WA_TABLE, WA_BUCKET
 */
const path = require('path');
const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand, PutCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { fromIni } = require('@aws-sdk/credential-providers');
const { RekognitionClient, DetectFacesCommand, IndexFacesCommand, ListFacesCommand, DeleteFacesCommand } = require('@aws-sdk/client-rekognition');
const sharp = require('sharp');

const REGION = process.env.WA_REGION || 'ap-south-1';
const PROFILE = process.env.AWS_PROFILE || 'cli_user';
const TABLE = process.env.WA_TABLE || 'wa-messages';
const BUCKET = process.env.WA_BUCKET || 'wa-messages-media-315286220307';
const CONTACTS = process.env.WA_CONTACTS_TABLE || 'wa-contacts';
const COLLECTION = process.env.WA_FACES_COLLECTION || 'wa-faces';
const PORT = process.env.PORT || 5173;

const credentials = fromIni({ profile: PROFILE });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials }));
const s3 = new S3Client({ region: REGION, credentials });
const rekognition = new RekognitionClient({ region: REGION, credentials });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '30mb' })); // images for face enrollment arrive as base64

// List chats: scan the table once and aggregate by chatJid.
// (Fine at personal volume; if the archive grows large, add a GSI later.)
app.get('/api/chats', async (_req, res) => {
  try {
    const chats = new Map();
    let ExclusiveStartKey;
    do {
      const r = await ddb.send(new ScanCommand({
        TableName: TABLE,
        ProjectionExpression: 'chatJid, isGroup, chatName, senderName, sender, chatAlt, #t, #ts, fromMe, #x',
        ExpressionAttributeNames: { '#t': 'text', '#ts': 'timestamp', '#x': 'type' },
        ExclusiveStartKey,
      }));
      for (const it of r.Items || []) {
        if (it.chatJid === '__selftest__') continue;
        let c = chats.get(it.chatJid);
        if (!c) c = chats.set(it.chatJid, { chatJid: it.chatJid, isGroup: !!it.isGroup, name: null, phone: null, count: 0, lastTs: 0, lastText: '' }).get(it.chatJid);
        c.count++;
        if (it.isGroup) {
          if (it.chatName) c.name = it.chatName;
        } else {
          // DM: prefer a stored real name, then the contact's pushName (from an incoming message)…
          if (it.chatName && !/^\+\d+$/.test(it.chatName) && !c.name) c.name = it.chatName;
          if (!it.fromMe && it.senderName && !c.name) c.name = it.senderName;
          // …and capture their real phone number (PN), since the chatJid is an opaque @lid.
          if (!c.phone) {
            const pn = (it.chatAlt && it.chatAlt.endsWith('@s.whatsapp.net')) ? it.chatAlt
              : (!it.fromMe && it.sender && it.sender.endsWith('@s.whatsapp.net')) ? it.sender : null;
            if (pn) c.phone = pn.split('@')[0];
          }
        }
        const ts = Number(it.timestamp) || 0;
        if (ts >= c.lastTs) { c.lastTs = ts; c.lastText = it.text || `[${it.type || 'media'}]`; }
      }
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const list = [...chats.values()]
      .map((c) => ({
        ...c,
        name: c.name || (c.isGroup ? c.chatJid : (c.phone ? '+' + c.phone : '+' + c.chatJid.split('@')[0])),
      }))
      .sort((a, b) => b.lastTs - a.lastTs);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Messages for one chat, chronological.
app.get('/api/messages', async (req, res) => {
  try {
    const chatJid = req.query.chat;
    if (!chatJid) return res.status(400).json({ error: 'chat required' });
    // Incremental poll: ?after=<timestamp> returns messages from that second onward
    // (sk = `${ts}#${id}`, so sk >= `${after}#`). The client de-dups by messageId.
    const after = req.query.after;
    const values = { ':c': chatJid };
    let kce = 'chatJid = :c';
    if (after) { kce += ' AND sk >= :after'; values[':after'] = `${after}#`; }
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: kce,
        ExpressionAttributeValues: values,
        ScanIndexForward: true,
        ExclusiveStartKey,
      }));
      items.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < 5000);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Presigned URL for a media object (private bucket).
app.get('/api/media', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'key required' });
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Contacts admin (table wa-contacts: number -> name) ------------------
function normContactNumber(input, cc) {
  let d = String(input || '').replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.length === 10) d = (cc || '91') + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
// List all contacts, sorted by name.
app.get('/api/contacts', async (_req, res) => {
  try {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await ddb.send(new ScanCommand({ TableName: CONTACTS, ExclusiveStartKey }));
      items.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Upsert name for a number. Sets the name and KEEPS the existing contactId
// (assigns a fresh one only if the row has none) — never clobbers face links.
async function upsertName(number, name) {
  await ddb.send(new UpdateCommand({
    TableName: CONTACTS,
    Key: { number },
    UpdateExpression: 'SET #n = :name, updatedAt = :ts, contactId = if_not_exists(contactId, :cid)',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':name': name, ':ts': new Date().toISOString(), ':cid': 'c_' + randomUUID().replace(/-/g, '').slice(0, 12) },
  }));
}
// Add a contact (normalizes the number; +91 added to bare 10-digit numbers).
app.post('/api/contacts', async (req, res) => {
  try {
    const number = normContactNumber(req.body && req.body.number);
    const name = String((req.body && req.body.name) || '').trim();
    if (!number) return res.status(400).json({ error: 'invalid phone number' });
    if (!name) return res.status(400).json({ error: 'name is required' });
    await upsertName(number, name);
    res.json({ number, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Rename an existing contact (number is the key; edits the name only — contactId preserved).
app.put('/api/contacts/:number', async (req, res) => {
  try {
    const number = String(req.params.number).replace(/\D/g, '');
    const name = String((req.body && req.body.name) || '').trim();
    if (!number || !name) return res.status(400).json({ error: 'number and name required' });
    await upsertName(number, name);
    res.json({ number, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Delete a contact.
app.delete('/api/contacts/:number', async (req, res) => {
  try {
    const number = String(req.params.number).replace(/\D/g, '');
    await ddb.send(new DeleteCommand({ TableName: CONTACTS, Key: { number } }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Face enrollment (Rekognition collection wa-faces) -------------------
function dataUrlToBuffer(s) {
  const m = /^data:[^;]+;base64,(.+)$/.exec(String(s || ''));
  return Buffer.from(m ? m[1] : String(s || ''), 'base64');
}
// Auto-orient (EXIF) and downscale so DetectFaces stays well under the 5MB byte limit.
async function workingImage(buf) {
  let img = sharp(buf).rotate();
  const meta = await img.metadata();
  if (Math.max(meta.width || 0, meta.height || 0) > 2048) img = img.resize({ width: 2048, height: 2048, fit: 'inside' });
  const buffer = await img.jpeg({ quality: 90 }).toBuffer();
  const m2 = await sharp(buffer).metadata();
  return { buffer, width: m2.width, height: m2.height };
}
async function cropFace(buffer, W, H, box) {
  const mx = box.Width * 0.25, my = box.Height * 0.25; // margin so Rekognition re-detects the face
  let left = Math.max(0, Math.round((box.Left - mx) * W));
  let top = Math.max(0, Math.round((box.Top - my) * H));
  let w = Math.min(Math.round((box.Width + 2 * mx) * W), W - left);
  let h = Math.min(Math.round((box.Height + 2 * my) * H), H - top);
  if (w < 1 || h < 1) return null;
  const out = await sharp(buffer).extract({ left, top, width: w, height: h }).jpeg({ quality: 88 }).toBuffer();
  return 'data:image/jpeg;base64,' + out.toString('base64');
}
// Detect faces in an uploaded photo → return cropped thumbnails.
app.post('/api/faces/detect', async (req, res) => {
  try {
    const buf = dataUrlToBuffer(req.body && req.body.image);
    if (!buf.length) return res.status(400).json({ error: 'no image' });
    const { buffer, width, height } = await workingImage(buf);
    const r = await rekognition.send(new DetectFacesCommand({ Image: { Bytes: buffer }, Attributes: ['DEFAULT'] }));
    const faces = [];
    for (const fd of (r.FaceDetails || [])) {
      if ((fd.Confidence || 0) < 80) continue;
      const thumb = await cropFace(buffer, width, height, fd.BoundingBox);
      if (thumb) faces.push({ thumb });
    }
    res.json({ count: faces.length, faces });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Enroll one cropped face under a contactId (a person, who may have many numbers).
app.post('/api/faces/enroll', async (req, res) => {
  try {
    const contactId = String((req.body && req.body.contactId) || '').trim();
    const crop = dataUrlToBuffer(req.body && req.body.crop);
    if (!/^[\w.\-:]+$/.test(contactId)) return res.status(400).json({ error: 'contactId required' });
    if (!crop.length) return res.status(400).json({ error: 'crop required' });
    const r = await rekognition.send(new IndexFacesCommand({
      CollectionId: COLLECTION, Image: { Bytes: crop }, ExternalImageId: contactId,
      MaxFaces: 1, QualityFilter: 'LOW', DetectionAttributes: [],
    }));
    const rec = (r.FaceRecords || [])[0];
    if (!rec) return res.status(422).json({ error: 'No clear face found in that crop — try a sharper/closer photo.' });
    res.json({ faceId: rec.Face.FaceId, contactId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// List enrolled faces, grouped by person (contactId → name from wa-contacts).
app.get('/api/faces', async (_req, res) => {
  try {
    const names = {}; // contactId -> name
    let ek;
    do {
      const r = await ddb.send(new ScanCommand({ TableName: CONTACTS, ExclusiveStartKey: ek }));
      for (const it of r.Items || []) if (it.contactId && it.name && !names[it.contactId]) names[it.contactId] = it.name;
      ek = r.LastEvaluatedKey;
    } while (ek);
    const byId = new Map();
    let NextToken;
    do {
      const r = await rekognition.send(new ListFacesCommand({ CollectionId: COLLECTION, MaxResults: 1000, NextToken }));
      for (const f of (r.Faces || [])) {
        const cid = f.ExternalImageId || '?';
        if (!byId.has(cid)) byId.set(cid, { contactId: cid, name: names[cid] || cid, faceIds: [] });
        byId.get(cid).faceIds.push(f.FaceId);
      }
      NextToken = r.NextToken;
    } while (NextToken);
    const list = [...byId.values()].map((p) => ({ ...p, count: p.faceIds.length }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Merge several contacts (by contactId) into one: reassign all their number-rows
// to one surviving contactId + chosen name. Refuses if it would orphan faces.
app.post('/api/contacts/merge', async (req, res) => {
  try {
    const ids = [...new Set(((req.body && req.body.contactIds) || []).map(String).filter(Boolean))];
    const name = String((req.body && req.body.name) || '').trim();
    if (ids.length < 2) return res.status(400).json({ error: 'select at least 2 contacts' });
    if (!name) return res.status(400).json({ error: 'choose a name to keep' });
    // rows belonging to the selected contacts
    const rows = [];
    let ek;
    do {
      const r = await ddb.send(new ScanCommand({ TableName: CONTACTS, ExclusiveStartKey: ek }));
      for (const it of r.Items || []) if (it.contactId && ids.includes(String(it.contactId))) rows.push(it);
      ek = r.LastEvaluatedKey;
    } while (ek);
    if (!rows.length) return res.status(404).json({ error: 'no matching contacts' });
    // which selected contacts have enrolled faces? (survivor must keep them valid)
    const faceCids = new Set();
    let NextToken;
    do {
      const r = await rekognition.send(new ListFacesCommand({ CollectionId: COLLECTION, MaxResults: 1000, NextToken }));
      for (const f of r.Faces || []) if (ids.includes(String(f.ExternalImageId))) faceCids.add(String(f.ExternalImageId));
      NextToken = r.NextToken;
    } while (NextToken);
    if (faceCids.size > 1) return res.status(409).json({ error: 'Two or more of these contacts have enrolled faces — merging would lose face data. Remove faces from all but one first, then merge.' });
    const requested = String((req.body && req.body.survivorContactId) || '');
    const survivor = faceCids.size === 1 ? [...faceCids][0] : (ids.includes(requested) ? requested : ids[0]);
    let moved = 0;
    for (const it of rows) {
      await ddb.send(new UpdateCommand({
        TableName: CONTACTS, Key: { number: it.number },
        UpdateExpression: 'SET contactId = :c, #n = :name, updatedAt = :ts',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':c': survivor, ':name': name, ':ts': new Date().toISOString() },
      }));
      moved++;
    }
    res.json({ survivorContactId: survivor, name, mergedPeople: ids.length, mergedNumbers: moved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Delete a single enrolled face vector.
app.delete('/api/faces/:faceId', async (req, res) => {
  try {
    await rekognition.send(new DeleteFacesCommand({ CollectionId: COLLECTION, FaceIds: [req.params.faceId] }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`WA viewer  → http://localhost:${PORT}`);
  console.log(`contacts   → http://localhost:${PORT}/contacts.html  (table ${CONTACTS})`);
  console.log(`faces      → http://localhost:${PORT}/faces.html  (collection ${COLLECTION})`);
  console.log(`  table=${TABLE}  bucket=${BUCKET}  region=${REGION}  profile=${PROFILE}`);
});
