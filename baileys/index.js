/*
 * index.js — route new WhatsApp messages to per-rule target numbers.
 *
 * config.json holds a `rules` array. Each rule has its own `target` number and
 * its own set of sources (groups / contacts / all DMs). A message is forwarded
 * to every rule whose sources match it.
 *
 *   npm run groups   # list group JIDs to put in a rule
 *   npm start        # run the forwarder
 */
require('dotenv').config({ path: __dirname + '/.env' }); // loads OPENAI_API_KEY from ./.env
const fs = require('fs');
const path = require('path');
const { getContentType } = require('baileys');
const { runSocket } = require('./socket');
const store = require('./store');
const ai = require('./ai');
const poll = require('./poll');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error('Could not read config.json:', e.message);
  process.exit(1);
}
store.init(config.persist || {});
function initAi() {
  const p = config.persist || {};
  ai.init({ ...(config.ai || {}), region: p.region, tableName: p.tableName, mediaBucket: p.mediaBucket });
}
function initPoll() {
  const p = config.persist || {};
  poll.init({ model: (config.ai && config.ai.model) || 'gpt-5.4', region: p.region, pollsTable: 'wa-polls' });
}
initAi();
initPoll();

// Hot-reload config so edits take effect without a restart.
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  try {
    config = loadConfig();
    store.init(config.persist || {});
    initAi();
    initPoll();
    console.log('↻ Reloaded config.json');
  } catch (e) {
    console.error('Bad config.json, keeping previous:', e.message);
  }
});

// ---- forwarding state --------------------------------------------------
const processed = new Set();
const queue = [];
let pumping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userJid(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits ? digits + '@s.whatsapp.net' : '';
}

// Does this rule's source set include the given chat?
//   groups      -> rule.groups (JIDs)
//   individuals -> rule.forwardAllDMs, or rule.contacts (JID or bare number)
function ruleMatches(rule, jid, altJid) {
  if (jid.endsWith('@g.us')) {
    return Array.isArray(rule.groups) && rule.groups.includes(jid);
  }
  if (rule.forwardAllDMs) return true;
  if (!Array.isArray(rule.contacts)) return false;
  // WhatsApp may address a DM by an opaque "@lid" instead of the phone number;
  // remoteJidAlt then carries the phone-number form. Match against both.
  const nums = [jid, altJid].filter(Boolean).map((j) => j.split('@')[0].replace(/\D/g, ''));
  return rule.contacts.some((c) => {
    if (c === jid || c === altJid) return true;          // exact JID (incl. raw @lid)
    const cd = String(c).replace(/\D/g, '');
    return cd && nums.includes(cd);                       // phone-number match (via alt too)
  });
}

// Does the chat match any forwarding rule? (used for media scope = "watched")
function anyRuleMatches(jid, altJid) {
  return Array.isArray(config.rules) && config.rules.some((r) => ruleMatches(r, jid, altJid));
}

// Human-readable source label for the header message.
//   manual override (config.chatLabels) → group subject (cached)
//   → for DMs, sender's pushName + number → JID
const groupNameCache = new Map();
async function chatLabel(sock, msg, jid, altJid) {
  const override = config.chatLabels && (config.chatLabels[jid] || (altJid && config.chatLabels[altJid]));
  if (override) return override;

  if (jid.endsWith('@g.us')) {
    if (groupNameCache.has(jid)) return groupNameCache.get(jid);
    let label = jid;
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta && meta.subject) label = meta.subject;
    } catch (e) {
      // network/perm issue — fall back to the JID
    }
    groupNameCache.set(jid, label);
    return label;
  }

  // Prefer the phone-number form for display (jid may be an @lid).
  const pnJid = jid.endsWith('@s.whatsapp.net') ? jid
    : (altJid && altJid.endsWith('@s.whatsapp.net') ? altJid : jid);
  const number = '+' + pnJid.split('@')[0];
  return msg.pushName ? `${msg.pushName} (${number})` : number;
}

// Skip system/control messages that shouldn't (or can't) be forwarded.
// WhatsApp often bundles a senderKeyDistributionMessage (group key material) and/or
// messageContextInfo ALONGSIDE the real message. getContentType ignores those wrappers
// and returns the true content type, so we don't drop real messages.
function isForwardable(msg) {
  const ct = getContentType(msg.message);
  if (!ct) return false;                  // pure key-distribution / metadata, no real content
  if (ct === 'reactionMessage' || ct === 'pollUpdateMessage' || ct === 'protocolMessage') return false;
  return true;
}

// Extract the text/caption from a message (unwrapping disappearing-message envelopes).
function messageText(m) {
  if (!m) return '';
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    (m.ephemeralMessage && messageText(m.ephemeralMessage.message)) ||
    (m.viewOnceMessage && messageText(m.viewOnceMessage.message)) ||
    (m.viewOnceMessageV2 && messageText(m.viewOnceMessageV2.message)) ||
    ''
  );
}

// First few characters of the message, for log visibility. '' if no text (e.g. media).
function preview(msg, n = 40) {
  const t = String(messageText(msg.message) || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return ` "${t.length > n ? t.slice(0, n) + '…' : t}"`;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    try { await job(); } catch (e) { console.error('Forward failed:', e.message); }
    await sleep(config.minDelayMs || 2000);
  }
  pumping = false;
}

function handle(msg, getSock, type) {
  try {
    const jid = msg.key && msg.key.remoteJid;
    if (!jid) return;

    // Status / broadcast / newsletter: never relevant — skip silently (no log).
    if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

    const altJid = msg.key.remoteJidAlt || undefined; // phone-number form when jid is an @lid
    const ct = getContentType(msg.message);
    const kind = ct || (msg.message ? Object.keys(msg.message)[0] : 'empty');
    const who = msg.pushName ? `${msg.pushName} (${jid})` : jid;
    const snip = preview(msg);
    const tag = type && type !== 'notify' ? `[${type}] ` : '';
    const v = (reason) => { if (config.verbose) console.log(`·  ${tag}${reason}: ${kind} from ${who}${snip}`); };

    // Archive every real message (both directions, all chats, all delivery types) —
    // independent of forwarding rules and fully non-blocking (see store.js).
    if (ct && ct !== 'protocolMessage') {
      store.persist(msg, getSock(), { watched: anyRuleMatches(jid, altJid) });
    }

    // Poll votes: decrypt + log (fire-and-forget, guarded). Arrives on upsert.
    if (ct === 'pollUpdateMessage') poll.handleVote(msg, getSock());

    // Only live ('notify') messages are forwarded; others are logged for visibility only.
    if (type && type !== 'notify') return v('seen (non-live)');

    // In-group AI assistant (mention + keyword). Fire-and-forget; fully guarded internally.
    ai.handle(msg, getSock());

    if (config.skipFromMe !== false && msg.key.fromMe) return v('skip (you sent it)');
    if (!isForwardable(msg)) return v('skip (non-content)');
    if (!Array.isArray(config.rules) || !config.rules.length) return v('skip (no rules)');

    // Collect the unique targets this message should go to.
    const targets = new Set();
    for (const rule of config.rules) {
      const target = userJid(rule.target);
      if (!target) continue;
      if (jid === target || altJid === target) continue;   // loop guard: never forward a target's own chat back
      if (ruleMatches(rule, jid, altJid)) targets.add(target);
    }
    if (!targets.size) return v('no rule match');

    const id = msg.key.id;
    if (!id || processed.has(id)) return v('skip (already forwarded)');
    processed.add(id);
    if (processed.size > 5000) processed.clear();

    if (config.verbose) {
      console.log(`✦  match: ${kind} from ${who} → ${[...targets].map((t) => t.split('@')[0]).join(', ')}${snip}`);
    }

    for (const target of targets) {
      queue.push(async () => {
        const sock = getSock();
        if (!sock) throw new Error('socket not connected');
        let label = jid;
        if (config.prefixGroupName !== false) {
          label = await chatLabel(sock, msg, jid, altJid);
          await sock.sendMessage(target, { text: `📨 *${label}*` });
          await sleep(400); // ensure the header lands before the forward
        }
        await sock.sendMessage(target, { forward: msg });
        console.log(`→ forwarded ${kind} from "${label}" → ${target.split('@')[0]}${snip}`);
      });
    }
    pump();
  } catch (e) {
    console.error('handle error:', e.message);
  }
}

async function main() {
  console.log('WhatsApp router (Baileys)');
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const active = rules.filter((r) => userJid(r.target));
  if (!active.length) {
    console.warn('⚠ No rules with a valid target in config.json — nothing will be forwarded.');
  } else {
    for (const r of active) {
      const srcCount = (r.groups || []).length + (r.contacts || []).length + (r.forwardAllDMs ? 1 : 0);
      console.log(`  rule "${r.name || r.target}" → ${r.target}  (${srcCount} source${srcCount === 1 ? '' : 's'}${r.forwardAllDMs ? ', all DMs' : ''})`);
    }
  }

  let getSock;
  getSock = await runSocket({
    onMessage: (msg, type) => handle(msg, () => getSock && getSock(), type),
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
