/*
 * poll.js — WhatsApp poll support (creation capture + vote decryption/tally).
 *
 * Creation: store.js calls computeDeadline() (title-derived → 12h fallback → 14d
 * cap) and register(), which saves the poll + its encryption secret to wa-polls.
 *
 * Votes: a pollUpdateMessage arrives on the normal messages.upsert path (Baileys'
 * auto-decrypt is disabled in this version, so we decrypt manually with the
 * stored secret), resolve the chosen option(s), and APPEND to a per-poll vote log
 * { voter, options, at, late } — kept even past the deadline (late flag) for an
 * audit trail. The AI reads live/final results via getPoll().
 *
 * Timestamps stored as epoch seconds (UTC). Everything is wrapped/non-fatal.
 */
const OpenAI = require('openai');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { jidNormalizedUser, getKeyAuthor, decryptPollVote, getAggregateVotesInPollMessage } = require('baileys');

let cfg = {};
let openai = null;
let ddb = null;
let loaded = false;

const FALLBACK_HOURS = 12;
const CAP_DAYS = 14;
const TRACK_DAYS = 30; // keep decrypting/logging this long after creation, then evict

const polls = new Map();       // pollMsgId -> record
const seenVotes = new Set();   // dedup vote message ids
const writeChains = new Map(); // pollMsgId -> Promise (serialize persists)

function unwrap(m) {
  if (!m) return m;
  if (m.ephemeralMessage) return unwrap(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return unwrap(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return unwrap(m.viewOnceMessageV2.message);
  return m;
}
function table() { return cfg.pollsTable || 'wa-polls'; }
function meIdOf(sock) { try { return sock && sock.user && sock.user.id ? jidNormalizedUser(sock.user.id) : 'me'; } catch (e) { return 'me'; } }

function init(c) {
  cfg = c || {};
  if (process.env.OPENAI_API_KEY && !openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (!ddb) ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region || 'ap-south-1' }), { marshallOptions: { removeUndefinedValues: true } });
  if (!loaded) { loaded = true; loadActive().catch((e) => console.error('[poll] loadActive failed:', e && e.message)); }
}

// Closing time (epoch sec): title-derived → +12h fallback → 14d cap. Never throws.
async function computeDeadline(title, createdAtSec) {
  const createdMs = (Number(createdAtSec) || Math.floor(Date.now() / 1000)) * 1000;
  const fallback = createdMs + FALLBACK_HOURS * 3600 * 1000;
  const cap = createdMs + CAP_DAYS * 86400 * 1000;
  let dl = fallback;
  if (openai && title) {
    try {
      const resp = await openai.responses.create({
        model: cfg.model || 'gpt-5.4',
        instructions:
          'You extract a poll\'s closing time from its title. Reply with ONLY an ISO-8601 timestamp (include a ' +
          'timezone offset) for when voting closes, or exactly NONE if the title implies no deadline. Resolve ' +
          'relative phrases ("by 6pm", "kal shaam tak", "before Friday", "today") against the creation time. ' +
          'Default timezone Asia/Kolkata.',
        input: `Poll created at ${new Date(createdMs).toISOString()}. Title: "${title}"`,
        max_output_tokens: 1500,
        reasoning: { effort: 'low' },
      });
      const t = Date.parse((resp.output_text || '').trim());
      if (!isNaN(t) && t > createdMs) dl = t;
    } catch (e) { console.error('[poll] deadline extract failed:', e && e.message); }
  }
  if (dl < createdMs + 60 * 1000) dl = fallback;
  if (dl > cap) dl = cap;
  return Math.floor(dl / 1000);
}

// Load still-trackable polls into memory on boot (so votes survive a restart).
async function loadActive() {
  const now = Math.floor(Date.now() / 1000);
  let ek, n = 0;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: table(), ExclusiveStartKey: ek }));
    for (const it of r.Items || []) {
      if ((Number(it.createdAt) || 0) + TRACK_DAYS * 86400 < now) continue;
      polls.set(String(it.pollMsgId), {
        pollMsgId: String(it.pollMsgId), chatJid: it.chatJid, question: it.question || '',
        options: it.options || [], secret: it.secret, creatorJid: it.creatorJid,
        deadline: Number(it.deadline) || 0, selectable: Number(it.selectable) || 0,
        createdAt: Number(it.createdAt) || 0, voteLog: Array.isArray(it.voteLog) ? it.voteLog : [],
      });
      n++;
    }
    ek = r.LastEvaluatedKey;
  } while (ek);
  if (n) console.log(`[poll] tracking ${n} poll(s)`);
}

// Record a new poll (called from store.js on creation). meta carries the secret.
async function register(meta, msg, sock) {
  if (!meta || !meta.pollMsgId || !meta.secret) return;
  const rec = {
    pollMsgId: String(meta.pollMsgId), chatJid: meta.chatJid, question: meta.question || '',
    options: meta.options || [], secret: meta.secret, creatorJid: getKeyAuthor(msg.key, meIdOf(sock)),
    deadline: Number(meta.deadline) || 0, selectable: Number(meta.selectable) || 0,
    createdAt: Number(meta.createdAt) || 0, voteLog: [],
  };
  polls.set(rec.pollMsgId, rec);
  try { await ddb.send(new PutCommand({ TableName: table(), Item: rec })); }
  catch (e) { console.error('[poll] register persist failed:', e && e.message); }
}

function persist(rec) {
  const prev = writeChains.get(rec.pollMsgId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => ddb.send(new PutCommand({ TableName: table(), Item: rec })));
  writeChains.set(rec.pollMsgId, next);
  return next.catch((e) => console.error('[poll] persist failed:', e && e.message));
}

// Decrypt one vote, resolve chosen option(s), append to the poll's log.
async function handleVote(msg, sock) {
  try {
    const vid = msg.key && msg.key.id;
    if (!vid || seenVotes.has(vid)) return;
    const pu = (unwrap(msg.message) || {}).pollUpdateMessage;
    if (!pu || !pu.pollCreationMessageKey || !pu.vote) return;
    const rec = polls.get(String(pu.pollCreationMessageKey.id));
    if (!rec) return; // untracked poll (created before we had it, or no secret) — can't decrypt
    seenVotes.add(vid); if (seenVotes.size > 5000) seenVotes.clear();

    const meId = meIdOf(sock);
    const voterJid = getKeyAuthor(msg.key, meId);
    let voteMsg;
    try {
      voteMsg = decryptPollVote(pu.vote, {
        pollEncKey: Buffer.from(rec.secret, 'base64'),
        pollCreatorJid: rec.creatorJid, pollMsgId: rec.pollMsgId, voterJid,
      });
    } catch (e) { console.error('[poll] decrypt failed:', e && e.message); return; }

    const agg = getAggregateVotesInPollMessage({
      message: { pollCreationMessage: { name: rec.question, options: rec.options.map((o) => ({ optionName: o })) } },
      pollUpdates: [{ pollUpdateMessageKey: msg.key, vote: voteMsg }],
    }, meId);
    const chosen = (agg || []).filter((a) => (a.voters || []).includes(voterJid)).map((a) => a.name);

    const at = pu.senderTimestampMs ? Math.floor(Number(pu.senderTimestampMs) / 1000)
      : (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000));
    rec.voteLog.push({ voter: voterJid, name: msg.pushName || undefined, options: chosen, at, late: rec.deadline ? at > rec.deadline : false });
    await persist(rec);
    console.log(`[poll] vote in "${rec.question}": ${msg.pushName || voterJid} → [${chosen.join(', ') || 'cleared'}]${rec.deadline && at > rec.deadline ? ' (late)' : ''}`);
  } catch (e) { console.error('[poll] handleVote error:', e && e.message); }
}

// Snapshot for the AI: result = latest non-late vote per voter; full log for audit.
function getPoll(pollMsgId) {
  const rec = polls.get(String(pollMsgId));
  if (!rec) return null;
  const now = Math.floor(Date.now() / 1000);
  const latest = new Map(); // voter -> last on-time vote (log is chronological)
  let lateCount = 0;
  for (const v of rec.voteLog) { if (v.late) lateCount++; else latest.set(v.voter, v); }
  const tally = {};
  for (const o of rec.options) tally[o] = [];
  for (const [voter, v] of latest) for (const o of (v.options || [])) if (tally[o]) tally[o].push({ voter, at: v.at, name: v.name });
  return {
    question: rec.question, options: rec.options, deadline: rec.deadline, selectable: rec.selectable,
    status: rec.deadline && now > rec.deadline ? 'closed' : 'open',
    tally, lateCount, log: rec.voteLog,
  };
}

module.exports = { init, computeDeadline, register, handleVote, getPoll };
