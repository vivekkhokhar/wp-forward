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
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { fromIni } = require('@aws-sdk/credential-providers');

const REGION = process.env.WA_REGION || 'ap-south-1';
const PROFILE = process.env.AWS_PROFILE || 'cli_user';
const TABLE = process.env.WA_TABLE || 'wa-messages';
const BUCKET = process.env.WA_BUCKET || 'wa-messages-media-315286220307';
const PORT = process.env.PORT || 5173;

const credentials = fromIni({ profile: PROFILE });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials }));
const s3 = new S3Client({ region: REGION, credentials });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, () => {
  console.log(`WA viewer → http://localhost:${PORT}`);
  console.log(`  table=${TABLE}  bucket=${BUCKET}  region=${REGION}  profile=${PROFILE}`);
});
