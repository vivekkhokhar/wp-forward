/*
 * store.js — archive every message to DynamoDB (+ media to S3).
 *
 * Fully decoupled from forwarding: persist() enqueues work and returns immediately;
 * a concurrency-limited worker writes to DynamoDB and streams media to S3. Any failure
 * is logged and swallowed — it can never block or crash the forwarder.
 *
 * Table key:  chatJid (PK) + sk = `${timestamp}#${messageId}` (idempotent → dedup).
 * Media:      streamed to s3://<bucket>/<chatJid>/<messageId>.<ext>, link stored on the item.
 */
const P = require('pino');
const { getContentType, downloadMediaMessage } = require('baileys');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

let cfg = {};
let ddb = null;
let s3 = null;

// ---- async worker pool (bounded concurrency) ---------------------------
const MAX = 4;
let active = 0;
const queue = [];
const seen = new Set(); // de-dupe by message id (avoids double media upload from append+notify)
const groupNames = new Map(); // jid -> subject (cached)

async function groupName(jid, sock) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  let name = jid;
  try {
    if (sock) { const meta = await sock.groupMetadata(jid); if (meta && meta.subject) name = meta.subject; }
  } catch (e) { /* keep jid as fallback */ }
  groupNames.set(jid, name);
  return name;
}

// DM display name. The chatJid is often an opaque @lid, so:
//   contact's pushName (only available from INCOMING messages — outgoing pushName is *you*),
//   remembered per chat; otherwise the contact's phone number.
const dmNames = new Map();
function dmName(msg, item) {
  const jid = item.chatJid;
  const phoneJid = jid.endsWith('@s.whatsapp.net') ? jid
    : (item.chatAlt && item.chatAlt.endsWith('@s.whatsapp.net')) ? item.chatAlt : null;
  const phone = '+' + (phoneJid ? phoneJid.split('@')[0] : jid.split('@')[0]);
  if (!item.fromMe && msg.pushName) { dmNames.set(jid, msg.pushName); return msg.pushName; }
  return dmNames.get(jid) || phone;
}

function drain() {
  while (active < MAX && queue.length) {
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job)
      .catch((e) => console.error('[store] job error:', e && e.message))
      .finally(() => { active--; drain(); });
  }
}

// ---- helpers -----------------------------------------------------------
function unwrap(m) {
  if (!m) return m;
  if (m.ephemeralMessage) return unwrap(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return unwrap(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return unwrap(m.viewOnceMessageV2.message);
  if (m.documentWithCaptionMessage) return unwrap(m.documentWithCaptionMessage.message);
  return m;
}

function messageText(m) {
  m = unwrap(m);
  if (!m) return '';
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    ''
  );
}

const MEDIA_EXT = {
  imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg',
  documentMessage: 'bin', stickerMessage: 'webp',
};
function mediaTypeOf(message) {
  const m = unwrap(message);
  if (!m) return null;
  return Object.keys(MEDIA_EXT).find((k) => m[k]) || null;
}
function extFromMime(mime) {
  if (!mime) return null;
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  if (map[mime]) return map[mime];
  const sub = mime.split('/')[1];
  return sub ? sub.split(';')[0] : null;
}

function buildItem(msg) {
  const k = msg.key;
  const jid = k.remoteJid;
  const altJid = k.remoteJidAlt;
  const isGroup = jid.endsWith('@g.us');
  const fromMe = !!k.fromMe;
  const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const m = unwrap(msg.message);
  const type = getContentType(msg.message) || 'unknown';
  let text = messageText(msg.message);

  // Reactions: capture the emoji and the id of the message being reacted to.
  let emoji, reactionTo;
  if (type === 'reactionMessage' && m && m.reactionMessage) {
    emoji = m.reactionMessage.text || undefined;          // empty string = reaction removed
    reactionTo = (m.reactionMessage.key && m.reactionMessage.key.id) || undefined;
    text = text || (emoji ? `reacted ${emoji}` : 'removed reaction');
  }

  const sender = fromMe ? 'me' : (isGroup ? (k.participantAlt || k.participant || '') : (altJid || jid));
  return {
    chatJid: jid,
    sk: `${ts}#${k.id}`,
    messageId: k.id,
    direction: fromMe ? 'out' : 'in',
    fromMe,
    isGroup,
    chatAlt: altJid || undefined,
    sender: sender || undefined,
    senderName: msg.pushName || undefined,
    type,
    text: text || undefined,
    emoji,
    reactionTo,
    timestamp: ts,
    isoTime: new Date(ts * 1000).toISOString(),
  };
}

async function uploadMedia(msg, sock, item) {
  const type = mediaTypeOf(msg.message);
  const node = unwrap(msg.message)[type];
  const mime = (node && node.mimetype) || '';
  const ext = extFromMime(mime) || MEDIA_EXT[type] || 'bin';
  const stream = await downloadMediaMessage(
    msg, 'stream', {},
    { logger: P({ level: 'silent' }), reuploadRequest: sock && sock.updateMediaMessage }
  );
  const Key = `${item.chatJid}/${item.messageId}.${ext}`;
  await new Upload({
    client: s3,
    params: { Bucket: cfg.mediaBucket, Key, Body: stream, ContentType: mime || 'application/octet-stream' },
  }).done();
  item.mediaKey = Key;
  item.mediaMime = mime || undefined;
  if (node && node.fileLength) item.mediaSize = Number(node.fileLength);
}

async function save(msg, sock, ctx) {
  const item = buildItem(msg);
  item.chatName = item.isGroup ? await groupName(item.chatJid, sock) : dmName(msg, item);
  const wantMedia = mediaTypeOf(msg.message) && (cfg.mediaScope === 'all' || ctx.watched);
  if (wantMedia) {
    try {
      await uploadMedia(msg, sock, item);
    } catch (e) {
      item.mediaError = String((e && e.message) || e).slice(0, 200);
      console.error('[store] media upload failed:', item.chatJid, item.mediaError);
    }
  }
  await ddb.send(new PutCommand({ TableName: cfg.tableName, Item: item }));
  if (cfg.verbose || item.mediaKey) {
    console.log(`[store] saved ${item.type} ${item.chatJid}${item.mediaKey ? ' +media' : ''}`);
  }
}

// ---- public API --------------------------------------------------------
function init(c) {
  cfg = c || {};
  if (cfg.enabled && !ddb) {
    ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: cfg.region }),
      { marshallOptions: { removeUndefinedValues: true } }
    );
    s3 = new S3Client({ region: cfg.region });
    console.log(`[store] enabled → table=${cfg.tableName} bucket=${cfg.mediaBucket} media=${cfg.mediaScope}`);
  }
}

function persist(msg, sock, ctx) {
  if (!cfg.enabled || !ddb) return;
  const id = msg.key && msg.key.id;
  if (!id || seen.has(id)) return;
  seen.add(id);
  if (seen.size > 10000) seen.clear();
  queue.push(() => save(msg, sock, ctx || {}));
  drain();
}

module.exports = { init, persist };
