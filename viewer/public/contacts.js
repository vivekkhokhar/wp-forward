/* contacts.js — review/edit the wa-contacts table (number -> name). */
const $ = (s) => document.querySelector(s);
const rowsEl = $('#crows'), countEl = $('#count'), searchEl = $('#csearch');
let all = [];

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = err ? '#c0392b' : '#111b21';
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1900);
}
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const fmtNum = (n) => '+' + n;

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  const list = q
    ? all.filter((c) => (c.name || '').toLowerCase().includes(q) || (qd && String(c.number).includes(qd)))
    : all;
  countEl.textContent = `${list.length}${q ? ' / ' + all.length : ''} contacts`;
  rowsEl.innerHTML = '';
  for (const c of list) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const inp = document.createElement('input');
    inp.className = 'ed';
    inp.value = c.name || '';
    inp.dataset.orig = c.name || '';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); } });
    inp.addEventListener('blur', async () => {
      const name = inp.value.trim();
      if (!name || name === inp.dataset.orig) { inp.value = inp.dataset.orig; return; }
      try { await api('PUT', '/api/contacts/' + c.number, { name }); c.name = name; inp.dataset.orig = name; toast('Saved'); }
      catch (e) { inp.value = inp.dataset.orig; toast(e.message, true); }
    });
    tdName.appendChild(inp);

    const tdNum = document.createElement('td');
    tdNum.className = 'num';
    tdNum.textContent = fmtNum(c.number);

    const tdAct = document.createElement('td');
    tdAct.className = 'actions';
    const del = document.createElement('button');
    del.className = 'btn del';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${c.name}" (${fmtNum(c.number)})?`)) return;
      try { await api('DELETE', '/api/contacts/' + c.number); all = all.filter((x) => x.number !== c.number); render(); toast('Deleted'); }
      catch (e) { toast(e.message, true); }
    });
    tdAct.appendChild(del);

    tr.append(tdName, tdNum, tdAct);
    rowsEl.appendChild(tr);
  }
}

async function load() {
  countEl.textContent = 'loading…';
  try { all = await api('GET', '/api/contacts'); render(); }
  catch (e) { countEl.textContent = 'error'; toast(e.message, true); }
}

$('#addBtn').addEventListener('click', async () => {
  const number = $('#addNum').value.trim(), name = $('#addName').value.trim();
  if (!number || !name) return toast('Enter both a number and a name', true);
  try {
    const c = await api('POST', '/api/contacts', { number, name });
    const i = all.findIndex((x) => x.number === c.number);
    if (i >= 0) all[i] = c; else all.push(c);
    $('#addNum').value = ''; $('#addName').value = '';
    render();
    toast('Saved ' + fmtNum(c.number));
  } catch (e) { toast(e.message, true); }
});
$('#addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addBtn').click(); });
searchEl.addEventListener('input', render);
$('#creload').addEventListener('click', load);
load();
