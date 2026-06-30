/* merge.js — select 2+ people (contactIds) and merge them into one. */
const $ = (s) => document.querySelector(s);
const listEl = $('#plist'), countEl = $('#count'), searchEl = $('#msearch');
let people = [];
const selected = new Set();

function toast(m, e) {
  const t = $('#toast');
  t.textContent = m;
  t.style.background = e ? '#c0392b' : '#111b21';
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function load() {
  countEl.textContent = 'loading…';
  const [rows, faces] = await Promise.all([api('GET', '/api/contacts'), api('GET', '/api/faces').catch(() => [])]);
  const faceCids = new Set(faces.map((f) => f.contactId));
  const byId = new Map();
  for (const c of rows) {
    const cid = c.contactId || ('n_' + c.number);
    if (!byId.has(cid)) byId.set(cid, { contactId: cid, name: c.name, numbers: [] });
    byId.get(cid).numbers.push(String(c.number));
  }
  people = [...byId.values()].map((p) => ({ ...p, hasFace: faceCids.has(p.contactId) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  render();
  updateBar();
}

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  const list = q ? people.filter((p) => p.name.toLowerCase().includes(q) || (qd && p.numbers.some((n) => n.includes(qd)))) : people;
  countEl.textContent = `${list.length}${q ? ' / ' + people.length : ''} people`;
  listEl.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('label');
    row.className = 'prow';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(p.contactId);
    cb.addEventListener('change', () => { if (cb.checked) selected.add(p.contactId); else selected.delete(p.contactId); updateBar(); });
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `+${p.numbers[0]}${p.numbers.length > 1 ? ` · ${p.numbers.length} numbers` : ''}`;
    const spacer = document.createElement('span'); spacer.style.flex = '1';
    const face = document.createElement('span'); face.textContent = p.hasFace ? '📷' : '';
    row.append(cb, nm, meta, spacer, face);
    listEl.appendChild(row);
  }
}

function updateBar() {
  const sel = [...selected].map((cid) => people.find((p) => p.contactId === cid)).filter(Boolean);
  $('#selcount').textContent = `${sel.length} selected`;
  const keep = $('#keepname');
  keep.innerHTML = '';
  for (const n of [...new Set(sel.map((p) => p.name))]) {
    const o = document.createElement('option'); o.value = n; o.textContent = n; keep.appendChild(o);
  }
  $('#mergebar').classList.toggle('show', sel.length >= 2);
}

$('#mergebtn').addEventListener('click', async () => {
  const ids = [...selected];
  if (ids.length < 2) return toast('Select at least 2 people', true);
  const name = $('#customname').value.trim() || $('#keepname').value;
  if (!name) return toast('Choose a name to keep', true);
  if (!confirm(`Merge ${ids.length} contacts into one named "${name}"?`)) return;
  try {
    const r = await api('POST', '/api/contacts/merge', { contactIds: ids, name });
    selected.clear();
    $('#customname').value = '';
    await load();
    toast(`Merged ${r.mergedPeople} people · ${r.mergedNumbers} number(s) → "${r.name}"`);
  } catch (e) { toast(e.message, true); }
});
$('#clearsel').addEventListener('click', () => { selected.clear(); render(); updateBar(); });
searchEl.addEventListener('input', render);
load().catch((e) => { countEl.textContent = 'error'; toast(e.message, true); });
