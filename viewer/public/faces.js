/* faces.js — upload a group photo, crop detected faces, assign each to a PERSON
   (contactId, consolidating their numbers), and enroll into the wa-faces collection. */
const $ = (s) => document.querySelector(s);
let people = [];            // [{contactId, name, numbers:[], primary, label}]
const labelToId = {};       // datalist label -> contactId

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = err ? '#c0392b' : '#111b21';
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
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
const nameForId = (cid) => { const p = people.find((x) => x.contactId === cid); return p && p.name; };
function resolveContactId(val) {
  const v = val.trim();
  if (labelToId[v]) return labelToId[v];                 // picked from the dropdown
  const d = v.replace(/\D/g, '');                        // or typed a raw number
  const num = d.length === 10 ? '91' + d : d;
  const p = people.find((pp) => pp.numbers.includes(num));
  return p ? p.contactId : null;
}

async function loadContacts() {
  const rows = await api('GET', '/api/contacts');
  const byId = new Map();
  for (const c of rows) {
    const cid = c.contactId || ('n_' + c.number);
    if (!byId.has(cid)) byId.set(cid, { contactId: cid, name: c.name, numbers: [] });
    byId.get(cid).numbers.push(String(c.number));
  }
  people = [...byId.values()];
  const dl = $('#contactsDL');
  dl.innerHTML = '';
  for (const p of people) {
    p.primary = p.numbers[0];
    p.label = `${p.name} — +${p.primary}${p.numbers.length > 1 ? ` (+${p.numbers.length - 1} more)` : ''}`;
    labelToId[p.label] = p.contactId;
    const o = document.createElement('option');
    o.value = p.label;
    dl.appendChild(o);
  }
}

function renderFaces(faces) {
  const grid = $('#faces');
  grid.innerHTML = '';
  for (const f of faces) {
    const card = document.createElement('div');
    card.className = 'facecard';
    const img = document.createElement('img');
    img.src = f.thumb;
    const inp = document.createElement('input');
    inp.className = 'f assign';
    inp.setAttribute('list', 'contactsDL');
    inp.placeholder = 'assign to person…';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Enroll';
    const st = document.createElement('div');
    st.className = 'st muted';
    const enroll = async () => {
      const cid = resolveContactId(inp.value);
      if (!cid) { toast('Pick a person from the list (or type a known number)', true); return; }
      btn.disabled = true; st.textContent = 'Enrolling…';
      try {
        await api('POST', '/api/faces/enroll', { contactId: cid, crop: f.thumb });
        card.classList.add('done');
        st.textContent = '✓ ' + (nameForId(cid) || cid);
        btn.remove(); inp.disabled = true;
        loadEnrolled();
      } catch (e) { st.textContent = ''; btn.disabled = false; toast(e.message, true); }
    };
    btn.addEventListener('click', enroll);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') enroll(); });
    card.append(img, inp, btn, st);
    grid.appendChild(card);
  }
}

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#detectStatus').textContent = 'Reading…';
  const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  $('#detectStatus').textContent = 'Detecting faces…';
  try {
    const { count, faces } = await api('POST', '/api/faces/detect', { image: dataUrl });
    renderFaces(faces);
    $('#detectStatus').textContent = count ? `${count} face(s) found — assign each to a person and Enroll.` : 'No faces detected in that photo.';
  } catch (err) { $('#detectStatus').textContent = ''; toast(err.message, true); }
  e.target.value = '';
});

async function loadEnrolled() {
  try {
    const list = await api('GET', '/api/faces');
    const faceTotal = list.reduce((a, p) => a + p.count, 0);
    $('#enrolledCount').textContent = `${list.length} people · ${faceTotal} faces`;
    $('#empty').style.display = list.length ? 'none' : 'block';
    const ul = $('#enrolled');
    ul.innerHTML = '';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'erow';
      const nm = document.createElement('span'); nm.className = 'enm'; nm.textContent = p.name;
      const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = ` · ${p.count} face${p.count > 1 ? 's' : ''}`;
      const del = document.createElement('button'); del.className = 'btn del'; del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        if (!confirm(`Remove all ${p.count} enrolled face(s) for ${p.name}?`)) return;
        try { for (const fid of p.faceIds) await api('DELETE', '/api/faces/' + fid); loadEnrolled(); toast('Removed'); }
        catch (e) { toast(e.message, true); }
      });
      row.append(nm, meta, del);
      ul.appendChild(row);
    }
  } catch (e) { $('#enrolledCount').textContent = 'error'; toast(e.message, true); }
}

loadContacts().catch((e) => toast(e.message, true));
loadEnrolled();
