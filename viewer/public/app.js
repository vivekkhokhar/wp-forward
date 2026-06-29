let chats = [];
let activeChat = null;
let activeIsGroup = false;
let messages = [];        // current chat's messages (sorted)
let seenIds = new Set();  // de-dupe by messageId
let lastTs = 0;           // max timestamp seen → poll cursor
let live = false;
let pollTimer = null;
const POLL_MS = 10000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
const fmtShort = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

// ---- chats (left pane) -------------------------------------------------
async function loadChats() {
  $('chats').innerHTML = '<div class="loading">Loading chats…</div>';
  try {
    chats = await (await fetch('/api/chats')).json();
    if (chats.error) throw new Error(chats.error);
    renderChats();
  } catch (e) {
    $('chats').innerHTML = `<div class="loading">Error: ${esc(e.message)}</div>`;
  }
}

function renderChats() {
  const q = $('search').value.trim().toLowerCase();
  const list = chats.filter((c) => !q || (c.name || '').toLowerCase().includes(q) || c.chatJid.includes(q));
  if (!list.length) { $('chats').innerHTML = '<div class="loading">No chats yet.</div>'; return; }
  $('chats').innerHTML = list.map((c) => `
    <div class="chat ${c.chatJid === activeChat ? 'active' : ''}" data-jid="${esc(c.chatJid)}">
      <div class="row1">
        <span class="name">${c.isGroup ? '<span class="grp">#</span> ' : ''}${esc(c.name)}</span>
        <span class="time">${fmtShort(c.lastTs)}</span>
      </div>
      <div class="last">${esc(c.lastText).slice(0, 60)}</div>
      <div class="badge">${c.count} messages${c.isGroup ? ' · group' : ''}</div>
    </div>`).join('');
  document.querySelectorAll('.chat').forEach((el) => el.addEventListener('click', () => openChat(el.dataset.jid)));
}

// ---- messages (right pane) ---------------------------------------------
async function openChat(jid) {
  activeChat = jid;
  const chat = chats.find((c) => c.chatJid === jid) || {};
  activeIsGroup = !!chat.isGroup;
  renderChats();
  $('convo-title').textContent = chat.name || jid;
  $('convo-sub').textContent = (!chat.isGroup && chat.phone) ? '+' + chat.phone : jid;
  messages = []; seenIds = new Set(); lastTs = 0;
  $('messages').innerHTML = '<div class="loading">Loading messages…</div>';
  try {
    const data = await (await fetch('/api/messages?chat=' + encodeURIComponent(jid))).json();
    if (data.error) throw new Error(data.error);
    ingest(data);
    renderMessages(true);
  } catch (e) {
    $('messages').innerHTML = `<div class="loading">Error: ${esc(e.message)}</div>`;
  }
  restartPoll();
}

// Merge messages (dedupe by id), keep sorted, advance the poll cursor.
function ingest(arr) {
  let added = 0;
  for (const m of arr || []) {
    if (!m.messageId || seenIds.has(m.messageId)) continue;
    seenIds.add(m.messageId);
    messages.push(m);
    const ts = Number(m.timestamp) || 0;
    if (ts > lastTs) lastTs = ts;
    added++;
  }
  if (added) {
    messages.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0) || String(a.sk).localeCompare(String(b.sk)));
  }
  return added;
}

function renderMessages(forceBottom) {
  const box = $('messages');
  if (!messages.length) { box.innerHTML = '<div class="empty">No messages.</div>'; return; }
  const byId = {};
  messages.forEach((m) => { if (m.messageId) byId[m.messageId] = m; });
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = messages.map((m) => renderMsg(m, byId)).join('');
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  document.querySelectorAll('.media[data-key]').forEach(loadMedia);
}

function renderMsg(m, byId) {
  const out = m.fromMe ? 'out' : '';
  const sender = (activeIsGroup && !m.fromMe && m.senderName) ? `<div class="sender">${esc(m.senderName)}</div>` : '';

  if (m.type === 'reactionMessage') {
    const tgt = m.reactionTo && byId[m.reactionTo];
    const tgtText = tgt ? (tgt.text || `[${tgt.type || 'media'}]`) : null;
    const quote = tgtText ? ` to “${esc(tgtText).slice(0, 40)}”` : (m.reactionTo ? ' (to an earlier message)' : '');
    const who = (activeIsGroup && !m.fromMe && m.senderName) ? esc(m.senderName) + ' ' : '';
    return `<div class="msg ${out} reaction"><div class="text">${who}${esc(m.emoji || 'reacted')}${quote}</div><div class="meta">${fmtTime(m.timestamp)}</div></div>`;
  }

  let body = m.text ? `<div class="text">${esc(m.text)}</div>` : '';
  let media = '';
  if (m.mediaKey) media = `<div class="media" data-key="${esc(m.mediaKey)}" data-mime="${esc(m.mediaMime || '')}">loading media…</div>`;
  else if (m.mediaError) media = `<div class="err">media unavailable</div>`;
  else if (!m.text) body = `<div class="text">[${esc(m.type || 'message')}]</div>`;
  return `<div class="msg ${out}">${sender}${media}${body}<div class="meta">${fmtTime(m.timestamp)}</div></div>`;
}

async function loadMedia(el) {
  const key = el.dataset.key, mime = el.dataset.mime || '';
  try {
    const { url, error } = await (await fetch('/api/media?key=' + encodeURIComponent(key))).json();
    if (error) throw new Error(error);
    if (mime.startsWith('image/')) el.innerHTML = `<a href="${url}" target="_blank"><img src="${url}" loading="lazy"></a>`;
    else if (mime.startsWith('video/')) el.innerHTML = `<video controls src="${url}"></video>`;
    else if (mime.startsWith('audio/')) el.innerHTML = `<audio controls src="${url}"></audio>`;
    else el.innerHTML = `<a class="doc" href="${url}" target="_blank" download>⬇ ${mime || 'file'}</a>`;
  } catch (e) {
    el.innerHTML = `<span class="err">media error</span>`;
  }
}

// ---- live polling (open chat only) -------------------------------------
async function pollNew() {
  if (!activeChat) return;
  try {
    const url = '/api/messages?chat=' + encodeURIComponent(activeChat) + '&after=' + encodeURIComponent(lastTs);
    const data = await (await fetch(url)).json();
    if (Array.isArray(data) && ingest(data)) renderMessages(false);
  } catch (e) { /* ignore transient poll errors */ }
}

function restartPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (live && activeChat) pollTimer = setInterval(pollNew, POLL_MS);
}

function setLive(on) {
  live = on;
  $('live').checked = on;
  $('live-toggle').classList.toggle('on', on);
  restartPoll();
  if (on) pollNew(); // immediate first poll
}

// ---- wiring ------------------------------------------------------------
$('refresh').addEventListener('click', loadChats);
$('search').addEventListener('input', renderChats);
$('live').addEventListener('change', (e) => setLive(e.target.checked));
loadChats();
