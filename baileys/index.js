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
const fs = require('fs');
const path = require('path');
const { runSocket } = require('./socket');

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

// Hot-reload config so edits take effect without a restart.
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  try {
    config = loadConfig();
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
function ruleMatches(rule, jid) {
  if (jid.endsWith('@g.us')) {
    return Array.isArray(rule.groups) && rule.groups.includes(jid);
  }
  if (rule.forwardAllDMs) return true;
  if (!Array.isArray(rule.contacts)) return false;
  const num = jid.split('@')[0].replace(/\D/g, '');
  return rule.contacts.some((c) => c === jid || String(c).replace(/\D/g, '') === num);
}

// Human-readable source label for the header message.
//   manual override (config.chatLabels) → group subject (cached)
//   → for DMs, sender's pushName + number → JID
const groupNameCache = new Map();
async function chatLabel(sock, msg, jid) {
  if (config.chatLabels && config.chatLabels[jid]) return config.chatLabels[jid];

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

  const number = '+' + jid.split('@')[0];
  return msg.pushName ? `${msg.pushName} (${number})` : number;
}

// Skip system/control messages that shouldn't (or can't) be forwarded.
function isForwardable(msg) {
  const m = msg.message;
  if (!m) return false;
  if (m.protocolMessage || m.senderKeyDistributionMessage || m.reactionMessage || m.pollUpdateMessage) {
    return false;
  }
  return Object.keys(m).length > 0;
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

function handle(msg, getSock) {
  try {
    const jid = msg.key && msg.key.remoteJid;
    if (!jid) return;
    const kind = msg.message ? Object.keys(msg.message)[0] : 'empty';
    const who = msg.pushName ? `${msg.pushName} (${jid})` : jid;
    const v = (reason) => { if (config.verbose) console.log(`·  ${reason}: ${kind} from ${who}`); };

    if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return v('skip status/broadcast');
    if (config.skipFromMe !== false && msg.key.fromMe) return v('skip (you sent it)');
    if (!isForwardable(msg)) return v('skip (non-content)');
    if (!Array.isArray(config.rules) || !config.rules.length) return v('skip (no rules)');

    // Collect the unique targets this message should go to.
    const targets = new Set();
    for (const rule of config.rules) {
      const target = userJid(rule.target);
      if (!target) continue;
      if (jid === target) continue;          // loop guard: never forward a target's own chat back
      if (ruleMatches(rule, jid)) targets.add(target);
    }
    if (!targets.size) return v('no rule match');

    const id = msg.key.id;
    if (!id || processed.has(id)) return v('skip (already forwarded)');
    processed.add(id);
    if (processed.size > 5000) processed.clear();

    if (config.verbose) {
      console.log(`✦  match: ${kind} from ${who} → ${[...targets].map((t) => t.split('@')[0]).join(', ')}`);
    }

    for (const target of targets) {
      queue.push(async () => {
        const sock = getSock();
        if (!sock) throw new Error('socket not connected');
        let label = jid;
        if (config.prefixGroupName !== false) {
          label = await chatLabel(sock, msg, jid);
          await sock.sendMessage(target, { text: `📨 *${label}*` });
          await sleep(400); // ensure the header lands before the forward
        }
        await sock.sendMessage(target, { forward: msg });
        const kind = Object.keys(msg.message)[0];
        console.log(`→ forwarded ${kind} from "${label}" → ${target.split('@')[0]}`);
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
    onMessage: (msg) => handle(msg, () => getSock && getSock()),
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
