/*
 * ai.js — in-group AI assistant.  STAGE 1: trigger + context + dry-run logging.
 *
 * Fires only on a LIVE group message that BOTH:
 *   1. @mentions the bot's own account, AND
 *   2. contains the keyword (default "#AI").
 * Gathers the group's recent history from DynamoDB as context.
 *
 * dryRun (default true): LOG the would-be reply instead of sending — for QA.
 * The LLM is a stub here; Stage 2 wires a real model. Sending is written but
 * gated behind dryRun, so going live is a one-line config change.
 *
 * Fully wrapped: any error is logged and swallowed (never affects forwarding).
 */
const OpenAI = require('openai');
const P = require('pino');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { jidNormalizedUser, downloadMediaMessage } = require('baileys');

let cfg = {};
let ddb = null;
let s3 = null;

function init(c) {
  cfg = c || {};
  if (cfg.enabled && !ddb) {
    ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region || 'ap-south-1' }));
    s3 = new S3Client({ region: cfg.region || 'ap-south-1' });
  }
  if (cfg.enabled) {
    console.log(`[ai] enabled — keyword="${cfg.keyword || '#AI'}" dryRun=${cfg.dryRun !== false} history=${cfg.historyMessages || 200} model=${cfg.model || 'gpt-5.5'} webSearch=${cfg.webSearch !== false} openaiKey=${process.env.OPENAI_API_KEY ? 'set' : 'MISSING'}`);
  }
}

// ---- message helpers ---------------------------------------------------
function unwrap(m) {
  if (!m) return m;
  if (m.ephemeralMessage) return unwrap(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return unwrap(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return unwrap(m.viewOnceMessageV2.message);
  return m;
}
function textOf(message) {
  const m = unwrap(message);
  if (!m) return '';
  return m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
}
function norm(j) { try { return jidNormalizedUser(j); } catch (e) { return j; } }
function myIdentities(sock) {
  const s = new Set();
  if (sock && sock.user) {
    if (sock.user.id) s.add(norm(sock.user.id));
    if (sock.user.lid) s.add(norm(sock.user.lid));
  }
  return s;
}
function contextInfoOf(message) {
  const m = unwrap(message);
  if (!m) return null;
  const c = m.extendedTextMessage || m.imageMessage || m.videoMessage || m.documentMessage;
  return (c && c.contextInfo) || null;
}
function mentionsMe(message, sock) {
  const ci = contextInfoOf(message);
  const mentioned = (ci && ci.mentionedJid) || [];
  if (!mentioned.length) return false;
  const mine = myIdentities(sock);
  return mentioned.some((j) => mine.has(norm(j)));
}
function quotedTextOf(message) {
  const ci = contextInfoOf(message);
  return ci && ci.quotedMessage ? textOf(ci.quotedMessage) : '';
}

// ---- cooldown / caps ---------------------------------------------------
const lastGroupAt = new Map();
const lastUserAt = new Map();
const dailyCount = new Map();
function gateReason(groupJid, userKey) {
  const now = Date.now();
  if (now - (lastGroupAt.get(groupJid) || 0) < (cfg.cooldownSec ?? 15) * 1000) return 'group cooldown';
  if (userKey && now - (lastUserAt.get(userKey) || 0) < (cfg.perUserCooldownSec ?? 60) * 1000) return 'user cooldown';
  const day = new Date().toISOString().slice(0, 10);
  if ((dailyCount.get(groupJid + '|' + day) || 0) >= (cfg.dailyCapPerGroup ?? 100)) return 'daily cap';
  return null;
}
function markAnswered(groupJid, userKey) {
  const now = Date.now();
  lastGroupAt.set(groupJid, now);
  if (userKey) lastUserAt.set(userKey, now);
  const day = new Date().toISOString().slice(0, 10);
  const k = groupJid + '|' + day;
  dailyCount.set(k, (dailyCount.get(k) || 0) + 1);
}

// ---- context -----------------------------------------------------------
async function fetchHistory(groupJid, limit) {
  const r = await ddb.send(new QueryCommand({
    TableName: cfg.tableName || 'wa-messages',
    KeyConditionExpression: 'chatJid = :c',
    ExpressionAttributeValues: { ':c': groupJid },
    ScanIndexForward: false, // newest first
    Limit: limit,
  }));
  return (r.Items || []).reverse(); // back to chronological order
}
function numberOf(jid) {
  if (!jid || jid === 'me') return null;
  const n = String(jid).split('@')[0].replace(/\D/g, '');
  return n || null;
}
function fmtTs(ts, tz) {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString('en-GB', {
      timeZone: tz || 'Asia/Kolkata',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch (e) {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}
// number -> display name, from the senders seen in this history
function buildRoster(items) {
  const roster = {};
  for (const it of items) {
    const num = numberOf(it.sender);
    if (num && it.senderName && !roster[num]) roster[num] = it.senderName;
  }
  return roster;
}
// rewrite @<number> mentions in text to @<name> when we know the person
function resolveMentions(text, roster) {
  if (!text) return text || '';
  return String(text).replace(/@(\d{6,})/g, (m, num) => (roster[num] ? '@' + roster[num] : m));
}
// "Participants: …" header + timestamped, mention-resolved lines
function formatTranscript(items, roster, tz) {
  const rosterLine = Object.entries(roster).map(([num, name]) => `${name} (+${num})`).join(', ');
  const header = rosterLine ? `Participants: ${rosterLine}\n\n` : '';
  const lines = items.map((it) => {
    const who = it.senderName || (numberOf(it.sender) ? '+' + numberOf(it.sender) : (it.sender || '?'));
    const body = it.text ? resolveMentions(it.text, roster) : `[${it.type || 'media'}]`;
    return `[${fmtTs(it.timestamp, tz)}] ${who}: ${body}`;
  });
  return header + lines.join('\n');
}

// ---- images (vision) ---------------------------------------------------
// Attach images so the model can SEE them. Prefer presigned S3 URLs (same token
// cost as base64, lighter request payload); fall back to a direct WhatsApp download
// (base64) for a just-replied image not yet archived to S3.
async function collectImages(msg, items, sock) {
  if (cfg.vision === false) return [];
  const max = cfg.maxImages ?? 4;
  if (max <= 0) return [];
  const out = [];
  const presign = (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.mediaBucket, Key: key }), { expiresIn: 600 });
  const isImg = (it) => it.mediaKey && /^image\//.test(it.mediaMime || '');

  const ci = contextInfoOf(msg.message);
  const qm = ci && ci.quotedMessage;
  const qImg = qm && unwrap(qm).imageMessage;

  if (qImg) {
    // Reply-to-image: the precise target. Use the archived S3 copy if present, else
    // download from WhatsApp (covers a just-sent image not yet archived).
    const archived = items.find((it) => it.messageId === ci.stanzaId && isImg(it));
    if (s3 && cfg.mediaBucket && archived) {
      try { out.push(await presign(archived.mediaKey)); } catch (e) { console.error('[ai] presign failed:', e && e.message); }
    }
    if (!out.length) {
      try {
        const fake = { key: { remoteJid: msg.key.remoteJid, fromMe: false, id: ci.stanzaId, participant: ci.participant }, message: qm };
        const buf = await downloadMediaMessage(fake, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock && sock.updateMediaMessage });
        out.push(`data:${qImg.mimetype || 'image/jpeg'};base64,${buf.toString('base64')}`);
      } catch (e) { console.error('[ai] quoted image download failed:', e && e.message); }
    }
    return out.slice(0, max);
  }

  // No quoted image → attach the most recent images from history (presigned S3 URLs).
  if (s3 && cfg.mediaBucket) {
    for (const it of items.filter(isImg).slice(-max)) {
      try { out.push(await presign(it.mediaKey)); } catch (e) { console.error('[ai] presign failed:', e && e.message); }
    }
  }
  return out.slice(0, max);
}

// Convert any Markdown the model emits into WhatsApp formatting (WhatsApp uses
// *bold*, _italic_, ~strike~ — and renders **double asterisks** / # headings literally).
function toWhatsApp(s) {
  if (!s) return s;
  return String(s)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                            // drop "#"/"##" headings
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')                         // **bold** -> *bold*
    .replace(/__([^_\n]+)__/g, '*$1*')                             // __bold__ -> *bold*
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')   // [text](url) -> text (url)
    .replace(/\n{3,}/g, '\n\n')                                    // collapse big gaps
    .trim();
}

// ---- LLM (OpenAI) ------------------------------------------------------
let openai = null;
function getClient() {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) return null; // key not configured
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const DEFAULT_SYSTEM =
  'You are a helpful assistant embedded in a WhatsApp chat. Use the conversation transcript to answer ' +
  'questions about this chat/group. Relevant images from the chat may be attached to your input — look ' +
  'at them when the question is about a picture. For general knowledge, current events, or facts NOT ' +
  'present in the transcript, use the web_search tool. Be concise and direct — a few sentences, no ' +
  'preamble. Answer in the same language as the question. If you used the web, cite the source briefly. ' +
  'Format for WhatsApp: use *single asterisks* for bold and _underscores_ for italic. Do NOT use ' +
  'Markdown — no **double asterisks**, no # headings, no [text](url) links. Keep it to short plain ' +
  'paragraphs; use simple "- " bullets only if genuinely needed.';

async function generateAnswer({ question, transcript, quoted, chatTitle, senderName, images }) {
  const client = getClient();
  if (!client) return null; // no OPENAI_API_KEY → caller logs a hint
  const parts = [`Conversation in "${chatTitle}" (oldest to newest):\n${transcript || '(no earlier messages)'}`];
  if (quoted) parts.push(`\nThe question refers to this quoted message:\n"${quoted}"`);
  parts.push(`\nQuestion from ${senderName}: ${question}`);
  const userText = parts.join('\n');
  const req = {
    model: cfg.model || 'gpt-5.5',
    instructions: cfg.systemPrompt || DEFAULT_SYSTEM,
    max_output_tokens: cfg.maxTokens ?? 600,
  };
  if (images && images.length) {
    const detail = cfg.imageDetail || 'auto';
    req.input = [{ role: 'user', content: [
      { type: 'input_text', text: userText },
      ...images.map((u) => ({ type: 'input_image', image_url: u, detail })),
    ] }];
  } else {
    req.input = userText;
  }
  // Hosted web search (Responses API). Model decides when to search (tool_choice: auto).
  if (cfg.webSearch !== false) req.tools = [{ type: 'web_search' }];
  const resp = await client.responses.create(req);
  return (resp.output_text || '').trim() || null;
}

// ---- entry -------------------------------------------------------------
async function handle(msg, sock) {
  if (!cfg.enabled || !ddb) return;
  try {
    const jid = msg.key && msg.key.remoteJid;
    if (!jid) return;
    const isGroup = jid.endsWith('@g.us');
    const isDM = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
    if (!isGroup && !isDM) return;                 // ignore status/broadcast/newsletter
    if (isGroup && cfg.groups === false) return;
    if (isDM && cfg.dms === false) return;

    const text = textOf(msg.message);
    const kw = cfg.keyword || '#AI';
    if (!text || !text.toLowerCase().includes(kw.toLowerCase())) return;

    if (isGroup) {
      // Group: the message must @mention the bot's own account.
      if (!mentionsMe(msg.message, sock)) {
        const ci = contextInfoOf(msg.message);
        console.log(`[ai] keyword seen but not tagged in ${jid} — mentioned=${JSON.stringify((ci && ci.mentionedJid) || [])} me=${JSON.stringify([...myIdentities(sock)])}`);
        return;
      }
    } else {
      // DM: it's already 1:1, so the keyword alone triggers — but only from the
      // other party (an incoming message), never the bot's own outgoing messages.
      if (msg.key.fromMe) return;
    }

    const sender = isGroup
      ? (msg.key.participantAlt || msg.key.participant || 'unknown')
      : (msg.key.remoteJidAlt || jid);
    const senderName = msg.pushName || sender;
    const reason = gateReason(jid, sender);
    if (reason) { console.log(`[ai] skip (${reason}) in ${jid} from ${senderName}`); return; }

    const escKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const question = text.replace(new RegExp(escKw, 'ig'), '').replace(/\s+/g, ' ').trim() || '(no question text)';
    const items = await fetchHistory(jid, cfg.historyMessages || 200);
    const roster = buildRoster(items);
    const transcript = formatTranscript(items, roster, cfg.timezone);
    const quoted = resolveMentions(quotedTextOf(msg.message), roster);
    const chatTitle = (items.find((i) => i.chatName) || {}).chatName || jid;
    const cleanQuestion = resolveMentions(question, roster);
    const images = await collectImages(msg, items, sock);

    let answer;
    try {
      answer = await generateAnswer({ question: cleanQuestion, transcript, quoted, chatTitle, senderName, images });
    } catch (e) {
      console.error('[ai] OpenAI error:', e && e.message);
      return; // transient — allow a retry on the next trigger
    }
    if (!answer) { console.error('[ai] no answer — is OPENAI_API_KEY set and the model valid?'); return; }
    answer = toWhatsApp(answer);
    markAnswered(jid, sender);

    if (cfg.dryRun !== false) {
      const preview = transcript.split('\n').filter(Boolean).slice(-2).join(' | ');
      console.log(
        `[ai] DRY-RUN — would reply in "${chatTitle}" to ${senderName}\n` +
        `      Q: ${question}` + (quoted ? `\n      quoted: ${quoted.slice(0, 80)}` : '') + '\n' +
        `      context: ${items.length} msgs (recent: ${preview})\n` +
        `      → ${answer}`
      );
    } else {
      await sock.sendMessage(jid, { text: answer }, { quoted: msg });
      console.log(`[ai] replied in "${chatTitle}" to ${senderName}${images.length ? ` (imgs: ${images.length})` : ''}`);
    }
  } catch (e) {
    console.error('[ai] error:', e && e.message);
  }
}

module.exports = { init, handle };
