// POS page: /l/<loc>/pos
const loc = location.pathname.split('/')[2];
const socket = io();
const tokenKey = `pos-token:${loc}`;
let token = storage(tokenKey);
let me = null;
let config = null;
let state = { sessions: [], stats: {} };
let staffList = [];
let selected = null; // { tableId } or { sessionId }
let view = 'floor';
const feed = [];

const isManager = () => me && me.role === 'manager';
const api = (event, payload = {}) => call(socket, event, { token, ...payload });
const itemsById = () => new Map(config.items.map((i) => [i.id, i]));
const methodName = (id) => config.paymentMethods.find((m) => m.id === id)?.name || id;

// ---------- login ----------

async function login(pin) {
  const res = await call(socket, 'staff:login', { loc, pin, token: pin ? undefined : token });
  token = res.token;
  storage(tokenKey, token);
  me = res.staff;
  config = res.config;
  state = res.state;
  staffList = res.staffList;
  if (me.role === 'kitchen') {
    location.href = `/l/${loc}/kds?station=kitchen`;
    return;
  }
  $('#login').classList.add('hidden');
  $('#nav').classList.remove('hidden');
  $('#title').textContent = `${config.name} — ${config.tagline}`;
  $('#who').textContent = `${me.name} (${me.role === 'manager' ? 'manager' : 'ospătar'})`;
  $('#kdsLink').href = `/l/${loc}/kds?station=kitchen`;
  $('#barLink').href = `/l/${loc}/kds?station=bar`;
  $('#qrLink').href = `/l/${loc}/qr`;
  document.querySelectorAll('[data-mgr]').forEach((el) => el.classList.toggle('hidden', !isManager()));
  show(view);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await login($('#pin').value);
    $('#pin').value = '';
  } catch (err) {
    toast(err.message);
  }
});

$('#logout').onclick = async () => {
  await call(socket, 'staff:logout', { token }).catch(() => {});
  storage(tokenKey, null);
  location.reload();
};

socket.on('connect', () => {
  if (token) login().catch(() => storage(tokenKey, null));
});

// ---------- navigation ----------

function show(v) {
  view = v;
  document.querySelectorAll('main > section[id^="view-"]').forEach((s) => s.classList.toggle('hidden', s.id !== `view-${v}`));
  ({
    floor: renderFloorView,
    virtual: renderVirtual,
    receipts: renderReceipts,
    reports: renderReports,
    menu: renderMenuAdmin,
    staff: renderStaff,
    cash: renderCash,
    status: renderStatus,
  })[v]();
}
document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => show(b.dataset.view); });

socket.on('pos:state', (s) => {
  state = s;
  renderStats();
  if (view === 'floor') renderFloorView();
  if (view === 'virtual') renderVirtual();
});

socket.on('pos:event', (ev) => {
  feed.unshift({ ...ev, at: Date.now() });
  feed.length = Math.min(feed.length, 30);
  if (ev.type === 'order' || ev.type === 'call') beep();
  toast(ev.text);
  if (view === 'floor') renderFeed();
});

socket.on('menu', (items) => {
  if (config) config.items = items;
  if (view === 'menu') renderMenuAdmin();
});

function renderStats() {
  const s = state.stats;
  $('#stats').textContent = `Mese deschise: ${s.openTables} · Clienți: ${s.guests} · Comenzi noi: ${s.newOrders} · Vânzări de la ultimul Z: ${fmt.money(s.salesSinceZ || 0)} (${s.receiptsSinceZ} bonuri)`;
}

// ---------- floor plan ----------

function sessionFor(tableId) {
  return state.sessions.find((s) => s.tableId === tableId) || null;
}

function tableColor(s) {
  if (!s) return '#fff';
  if (s.calls.some((c) => c.type === 'bill')) return '#f66';
  if (s.calls.some((c) => c.type === 'waiter')) return '#f96';
  if (s.orders.some((o) => o.status === 'new')) return '#fd5';
  return '#cfe6ff';
}

function chairs(t) {
  const out = [];
  const c = (x, y) => out.push(`<rect x="${x - 9}" y="${y - 9}" width="18" height="18" rx="4" fill="#ddd" stroke="#999"/>`);
  if (t.shape === 'round') {
    for (let i = 0; i < t.seats; i += 1) {
      const a = (2 * Math.PI * i) / t.seats - Math.PI / 2;
      c(t.x + Math.cos(a) * (t.r + 14), t.y + Math.sin(a) * (t.r + 14));
    }
  } else {
    const perSide = Math.ceil(t.seats / 2);
    const sides = t.seats === 4 && t.w === t.h ? 'square' : 'long';
    if (sides === 'square') {
      c(t.x, t.y - t.h / 2 - 14); c(t.x, t.y + t.h / 2 + 14); c(t.x - t.w / 2 - 14, t.y); c(t.x + t.w / 2 + 14, t.y);
    } else {
      for (let i = 0; i < perSide; i += 1) {
        const x = t.x - t.w / 2 + (t.w / perSide) * (i + 0.5);
        c(x, t.y - t.h / 2 - 14);
        if (i < t.seats - perSide) c(x, t.y + t.h / 2 + 14);
      }
    }
  }
  return out.join('');
}

function renderFloor() {
  const f = config.floor;
  const svg = $('#floor');
  svg.setAttribute('viewBox', `0 0 ${f.width} ${f.height}`);
  const zones = f.zones.map((z) => `
    <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="${z.kind === 'outdoor' ? '#eef7e8' : z.kind === 'service' ? '#eee' : '#f8f5ef'}" stroke="#bbb" stroke-dasharray="${z.kind === 'outdoor' ? '6 4' : ''}"/>
    <text x="${z.x + 8}" y="${z.y + 18}" font-size="14" fill="#888">${esc(z.name)}</text>`).join('');
  const fixtures = f.fixtures.map((x) => {
    if (x.kind === 'plant') return `<circle cx="${x.x}" cy="${x.y}" r="10" fill="#8c8"/>`;
    const fill = x.kind === 'door' ? '#c96' : '#a88';
    return `<rect x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}" fill="${fill}"/><text x="${x.x + 4}" y="${x.y + (x.h > 20 ? x.h / 2 + 4 : -4)}" font-size="11" fill="#555">${esc(x.label || '')}</text>`;
  }).join('');
  const tables = f.tables.map((t) => {
    const s = sessionFor(t.id);
    const fill = tableColor(s);
    const sel = selected && selected.tableId === t.id;
    const shape = t.shape === 'round'
      ? `<circle cx="${t.x}" cy="${t.y}" r="${t.r}" fill="${fill}" stroke="${sel ? '#06c' : '#666'}" stroke-width="${sel ? 4 : 1.5}"/>`
      : `<rect x="${t.x - t.w / 2}" y="${t.y - t.h / 2}" width="${t.w}" height="${t.h}" rx="6" fill="${fill}" stroke="${sel ? '#06c' : '#666'}" stroke-width="${sel ? 4 : 1.5}"/>`;
    const info = s ? `${s.guests.length}p · ${fmt.money(s.bill.unpaid).replace(' lei', '')}` : `${t.seats} loc.`;
    return `<g class="table" data-table="${t.id}">${chairs(t)}${shape}
      <text x="${t.x}" y="${t.y - 2}" text-anchor="middle" font-size="14" font-weight="bold">${esc(t.id)}</text>
      <text x="${t.x}" y="${t.y + 14}" text-anchor="middle" font-size="11">${esc(info)}</text></g>`;
  }).join('');
  svg.innerHTML = zones + fixtures + tables;
}

$('#floor').addEventListener('click', (e) => {
  const g = e.target.closest('[data-table]');
  if (!g) return;
  selected = { tableId: g.dataset.table };
  renderFloorView();
});

function renderFeed() {
  $('#feedList').innerHTML = feed.map((f) => `<div>${fmt.time(f.at)} — ${esc(f.text)}</div>`).join('') || '—';
}

function renderFloorView() {
  if (!config) return;
  renderStats();
  renderFloor();
  renderFeed();
  const panel = $('#panel');
  if (!selected) {
    panel.innerHTML = '<div class="box muted">Selectați o masă din plan.</div>';
    return;
  }
  const s = selected.sessionId ? state.sessions.find((x) => x.id === selected.sessionId) : sessionFor(selected.tableId);
  if (!s) {
    const t = config.floor.tables.find((x) => x.id === selected.tableId);
    panel.innerHTML = `<div class="box"><h2>${esc(t.name)}</h2><p>Liberă · ${t.seats} locuri</p>
      <p>Clienții pot scana codul QR al mesei sau puteți deschide masa manual.</p>
      <button class="primary" id="openTable">Deschide masa</button></div>`;
    $('#openTable').onclick = () => api('pos:openTable', { tableId: t.id }).catch((e) => toast(e.message));
    return;
  }
  renderSession(panel, s);
}

// ---------- session panel (used by floor and takeaway/delivery) ----------

function renderSession(panel, s) {
  const items = itemsById();
  const guestOptions = s.guests.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  const calls = s.calls.map((c) => `<div class="box" style="background:#fee">${c.type === 'bill' ? 'Cere nota' : 'Cheamă ospătarul'} · ${fmt.time(c.at)}
    <button data-ack="${c.id}">Am văzut</button></div>`).join('');

  const orders = s.orders.slice().reverse().map((o) => `
    <div class="box">
      <div class="row"><span class="dot" style="background:${o.guestColor}"></span><strong>${esc(o.guestName)}</strong>
        <span class="muted">${o.id} · ${fmt.time(o.at)} · ${o.source === 'pos' ? 'ospătar' : 'QR'}</span>
        <span class="badge st-${o.status}">${fmt.status[o.status]}</span>
        ${o.status === 'new' ? `<button class="primary" data-status="accepted" data-order="${o.id}">Confirmă</button><button class="danger" data-status="rejected" data-order="${o.id}">Respinge</button>` : ''}
        ${o.status === 'accepted' ? `<button data-status="served" data-order="${o.id}">Servită</button>` : ''}
      </div>
      <table>${o.lines.map((l) => `
        <tr style="${l.voided ? 'text-decoration:line-through;color:#999' : ''}">
          <td>${l.qty} × ${esc(l.name)}${l.note ? ` <em>(${esc(l.note)})</em>` : ''}
            <span class="muted">${l.station === 'bar' ? 'bar' : 'bucătărie'}${l.ready ? ' · gata' : ''}${l.guestId !== o.guestId ? ` · → ${esc(l.guestName)}` : ''}${l.voidReason ? ` · ${esc(l.voidReason)}` : ''}</span></td>
          <td class="num">${l.discountPct ? `-${l.discountPct}% ` : ''}${fmt.money(l.total)}${l.receiptNo ? ` <span class="muted">bon ${l.receiptNo}</span>` : ''}</td>
          <td class="num">${!l.voided && !l.receiptNo && o.status !== 'rejected' ? `
            <select data-line-action="${l.id}">
              <option value="">…</option>
              <option value="void">Anulează</option>
              ${isManager() ? '<option value="discount">Reducere %</option>' : ''}
              ${s.guests.length > 1 ? '<option value="move">Mută pe alt client</option>' : ''}
            </select>` : ''}</td>
        </tr>`).join('')}</table>
    </div>`).join('') || '<p class="muted">Nicio comandă.</p>';

  const b = s.bill;
  const bill = b.guests.map((g) => `
    <tr><td><span class="dot" style="background:${g.color}"></span>${esc(g.name)}</td>
      <td class="num">${fmt.money(g.total)}</td><td class="num">${fmt.money(g.unpaid)}</td>
      <td>${g.unpaid > 0 ? `<button data-pay-guest="${g.guestId}">Încasează</button>` : g.total ? '✓' : ''}</td></tr>`).join('');

  const freeTables = config.floor.tables.filter((t) => !sessionFor(t.id)).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  const otherSessions = state.sessions.filter((x) => x.id !== s.id).map((x) => `<option value="${x.id}">${esc(x.tableName)}</option>`).join('');
  const waiters = staffList.filter((u) => u.role !== 'kitchen' && u.active).map((u) => `<option value="${u.id}" ${u.id === s.waiterId ? 'selected' : ''}>${esc(u.name)}</option>`).join('');

  panel.innerHTML = `
    <div class="box">
      <h2>${esc(s.tableName)}</h2>
      <div class="muted">Deschisă ${fmt.time(s.openedAt)} · ${s.guests.length} clienți: ${s.guests.map((g) => `<span class="dot" style="background:${g.color}"></span>${esc(g.name)}`).join(' ')}</div>
      ${s.customer ? `<div>${esc(s.customer.name)} · ${esc(s.customer.phone || '')} ${esc(s.customer.address || '')}</div>` : ''}
      <div class="row" style="margin-top:6px">
        Ospătar: <select id="assign"><option value="">—</option>${waiters}</select>
        <button id="addGuest">+ Client</button>
      </div>
    </div>
    ${calls}
    <div class="box">
      <h3>Adaugă comandă</h3>
      <div class="row">
        Pentru: <select id="orderGuest">${guestOptions}</select>
        <input id="itemSearch" placeholder="caută produs…" list="itemList" size="24">
        <datalist id="itemList">${config.items.filter((i) => i.available).map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
        <input id="itemQty" type="number" value="1" min="1" max="20" style="width:60px">
        <input id="itemNote" placeholder="mențiuni" maxlength="140">
        <button id="addItem">Adaugă</button>
      </div>
      <div id="draft"></div>
    </div>
    <h3>Comenzi</h3>${orders}
    <div class="box">
      <h3>Nota</h3>
      <table><tr><th>Client</th><th class="num">Total</th><th class="num">De plată</th><th></th></tr>${bill}
        ${b.discount ? `<tr><td>Reduceri</td><td class="num">-${fmt.money(b.discount)}</td><td></td><td></td></tr>` : ''}
        <tr><th>Total masă</th><th class="num">${fmt.money(b.total)}</th><th class="num">${fmt.money(b.unpaid)}</th><td></td></tr>
      </table>
      <div class="row" style="margin-top:6px">
        ${b.unpaid > 0 ? '<button class="primary" id="payAll">Încasează tot</button><button id="payItems">Încasează pe produse</button>' : ''}
        ${isManager() && b.unpaid > 0 ? '<button id="discountAll">Reducere masă %</button>' : ''}
        <button id="printBill">Notă de plată</button>
        <button class="danger" id="closeTable">Închide masa</button>
      </div>
      ${s.receipts.length ? `<p class="muted">Bonuri: ${s.receipts.map((n) => `<a href="#" data-receipt="${n}">${n}</a>`).join(', ')}</p>` : ''}
    </div>
    <div class="box row">
      ${s.kind === 'table' && freeTables ? `Mută pe: <select id="transferTo">${freeTables}</select><button id="transfer">Mută masa</button>` : ''}
      ${otherSessions ? `Unește cu: <select id="mergeInto">${otherSessions}</select><button id="merge">Unește</button>` : ''}
    </div>`;

  const draft = [];
  const renderDraft = () => {
    $('#draft', panel).innerHTML = draft.length ? `<ul>${draft.map((d) => `<li>${d.qty} × ${esc(items.get(d.itemId).name)}${d.note ? ` (${esc(d.note)})` : ''}</li>`).join('')}</ul><button class="primary" id="sendDraft">Trimite comanda</button>` : '';
    const btn = $('#sendDraft', panel);
    if (btn) {
      btn.onclick = () => api('pos:order', { sessionId: s.id, guestId: $('#orderGuest', panel).value, items: draft })
        .then(() => toast('Comandă trimisă'), (e) => toast(e.message));
    }
  };
  $('#addItem', panel).onclick = () => {
    const name = $('#itemSearch', panel).value.trim().toLowerCase();
    const item = config.items.find((i) => i.name.toLowerCase() === name) || config.items.find((i) => i.available && i.name.toLowerCase().includes(name));
    if (!name || !item) return toast('Produs negăsit');
    draft.push({ itemId: item.id, qty: Number($('#itemQty', panel).value) || 1, note: $('#itemNote', panel).value });
    $('#itemSearch', panel).value = '';
    $('#itemNote', panel).value = '';
    $('#itemQty', panel).value = 1;
    renderDraft();
  };

  const act = (p) => p.catch((e) => toast(e.message));
  panel.onclick = (e) => {
    const t = e.target;
    if (t.dataset.ack) act(api('pos:ackCall', { sessionId: s.id, callId: t.dataset.ack }));
    if (t.dataset.status) act(api('pos:orderStatus', { orderId: t.dataset.order, status: t.dataset.status }));
    if (t.dataset.payGuest) openPayment(s, { guestId: t.dataset.payGuest });
    if (t.dataset.receipt) { e.preventDefault(); showReceipt(Number(t.dataset.receipt)); }
  };
  panel.onchange = (e) => {
    const lineId = e.target.dataset.lineAction;
    if (!lineId) return;
    const a = e.target.value;
    e.target.value = '';
    if (a === 'void') {
      const reason = prompt('Motivul anulării:', 'greșeală comandă');
      if (reason !== null) act(api('pos:void', { sessionId: s.id, lineId, reason }));
    }
    if (a === 'discount') {
      const pct = prompt('Reducere (%)', '10');
      if (pct !== null) act(api('pos:discount', { sessionId: s.id, lineId, pct: Number(pct) }));
    }
    if (a === 'move') {
      const names = s.guests.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
      const n = Number(prompt(`Mută pe clientul:\n${names}`, '1'));
      const g = s.guests[n - 1];
      if (g) act(api('pos:moveLine', { sessionId: s.id, lineId, toGuestId: g.id }));
    }
  };
  $('#assign', panel).onchange = (e) => act(api('pos:assign', { sessionId: s.id, staffId: e.target.value }));
  $('#addGuest', panel).onclick = () => {
    const name = prompt('Nume client', `Client ${s.guests.length + 1}`);
    if (name) act(api('pos:addGuest', { sessionId: s.id, name }));
  };
  if ($('#payAll', panel)) $('#payAll', panel).onclick = () => openPayment(s, {});
  if ($('#payItems', panel)) $('#payItems', panel).onclick = () => openPayment(s, { pickItems: true });
  if ($('#discountAll', panel)) {
    $('#discountAll', panel).onclick = () => {
      const pct = prompt('Reducere pe toată masa (%)', '10');
      if (pct !== null) act(api('pos:discount', { sessionId: s.id, pct: Number(pct) }));
    };
  }
  $('#printBill', panel).onclick = () => printBill(s);
  $('#closeTable', panel).onclick = () => act(api('pos:close', { sessionId: s.id }).then(() => { selected = null; show(view); }));
  if ($('#transfer', panel)) {
    $('#transfer', panel).onclick = () => act(api('pos:transfer', { sessionId: s.id, toTableId: $('#transferTo', panel).value }).then(() => { selected = { tableId: $('#transferTo', panel).value }; }));
  }
  if ($('#merge', panel)) {
    $('#merge', panel).onclick = () => {
      const into = $('#mergeInto', panel).value;
      if (confirm('Toți clienții și comenzile acestei mese trec pe masa aleasă. Continuați?')) {
        act(api('pos:merge', { fromSessionId: s.id, intoSessionId: into }).then(() => { selected = { sessionId: into }; }));
      }
    };
  }
}

// ---------- payment ----------

function openPayment(s, { guestId = null, pickItems = false }) {
  const unpaid = s.bill.guests.flatMap((g) => g.lines).filter((l) => !l.receiptNo && (!guestId || l.guestId === guestId));
  const d = dialog(`
    <h2>Încasare — ${esc(s.tableName)}${guestId ? ` · ${esc(s.guests.find((g) => g.id === guestId).name)}` : ''}</h2>
    <table>${unpaid.map((l) => `<tr>
      <td>${pickItems ? `<input type="checkbox" data-line="${l.id}" checked>` : ''} ${l.qty} × ${esc(l.name)} <span class="muted">${esc(l.guestName || '')}</span></td>
      <td class="num">${fmt.money(l.total)}</td></tr>`).join('')}</table>
    <p><strong>Total: <span id="payTotal"></span></strong></p>
    <div class="row">Bacșiș (lei): <input id="tip" value="0" size="6"> <button data-tip="5">5%</button><button data-tip="10">10%</button><button data-tip="15">15%</button></div>
    <div class="row" style="margin-top:6px">CIF client (factură, opțional): <input id="cif" size="14" placeholder="RO…"> <button id="anaf">Verifică ANAF</button> <span id="anafRes" class="muted"></span></div>
    <h3>Plată</h3>
    <div id="payRows"></div>
    <button id="addPay">+ Altă metodă (plată mixtă)</button>
    <p id="payInfo"></p>
    <div class="row"><button class="primary" id="confirmPay">Încasează</button><button id="cancelPay">Renunță</button></div>
    <p class="muted">Curs EUR (BNR): ${config.eurRate}</p>`);

  const selectedLines = () => (pickItems ? unpaid.filter((l) => $(`[data-line="${l.id}"]`, d).checked) : unpaid);
  const total = () => selectedLines().reduce((x, l) => x + l.total, 0);
  const tip = () => parseLei($('#tip', d).value) || 0;
  const rows = [{ method: 'cash', amount: '' }];

  const renderRows = () => {
    $('#payRows', d).innerHTML = rows.map((r, i) => `<div class="row" style="margin-bottom:4px">
      <select data-m="${i}">${config.paymentMethods.map((m) => `<option value="${m.id}" ${m.id === r.method ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <input data-a="${i}" value="${esc(r.amount)}" placeholder="${r.method === 'eur' ? 'sumă EUR' : 'sumă lei'}" size="10">
      ${['gift', 'account', 'transfer'].includes(r.method) ? `<input data-ref="${i}" value="${esc(r.ref || '')}" placeholder="cod voucher / cont / nr. factură" size="18">` : ''}
      ${rows.length > 1 ? `<button data-rm="${i}">×</button>` : ''}</div>`).join('');
    update();
  };
  const amountLei = (r) => {
    const v = parseLei(r.amount);
    if (!Number.isFinite(v)) return 0;
    return r.method === 'eur' ? Math.round(v * config.eurRate) : v;
  };
  const update = () => {
    const due = total() + tip();
    $('#payTotal', d).textContent = `${fmt.money(total())}${tip() ? ` + bacșiș ${fmt.money(tip())} = ${fmt.money(due)}` : ''} (≈ ${(due / 100 / config.eurRate).toFixed(2)} EUR)`;
    const paid = rows.reduce((x, r) => x + amountLei(r), 0);
    $('#payInfo', d).textContent = paid >= due ? `Rest: ${fmt.money(paid - due)}` : `Mai sunt de încasat: ${fmt.money(due - paid)}`;
  };
  // pre-fill the single row with the full amount
  rows[0].amount = (total() / 100).toFixed(2);
  renderRows();

  d.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.a !== undefined) rows[t.dataset.a].amount = t.value;
    if (t.dataset.ref !== undefined) rows[t.dataset.ref].ref = t.value;
    update();
  });
  d.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.m !== undefined) {
      rows[t.dataset.m].method = t.value;
      if (t.value === 'eur') rows[t.dataset.m].amount = ((total() + tip()) / 100 / config.eurRate).toFixed(2);
      renderRows();
    }
    if (t.dataset.line) update();
  });
  d.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.tip) { $('#tip', d).value = ((total() * Number(t.dataset.tip)) / 10000).toFixed(2); update(); }
    if (t.dataset.rm !== undefined) { rows.splice(Number(t.dataset.rm), 1); renderRows(); }
  });
  $('#addPay', d).onclick = () => {
    const paid = rows.reduce((x, r) => x + amountLei(r), 0);
    rows.push({ method: 'card', amount: (Math.max(0, total() + tip() - paid) / 100).toFixed(2) });
    renderRows();
  };
  $('#anaf', d).onclick = async () => {
    const cui = $('#cif', d).value.trim();
    $('#anafRes', d).textContent = 'se verifică…';
    try {
      const r = await fetch(`/api/l/${loc}/anaf/${encodeURIComponent(cui)}`, { headers: { 'x-auth': token } });
      const j = await r.json();
      $('#anafRes', d).textContent = r.ok ? `${j.name} · ${j.address} · ${j.vatPayer ? 'plătitor TVA' : 'neplătitor TVA'}${j.inactive ? ' · INACTIV' : ''}` : j.error;
    } catch {
      $('#anafRes', d).textContent = 'ANAF indisponibil';
    }
  };
  $('#cancelPay', d).onclick = () => d.remove();
  $('#confirmPay', d).onclick = async () => {
    const payments = rows.map((r) => ({
      method: r.method,
      amount: amountLei(r),
      ...(r.method === 'eur' ? { rate: config.eurRate } : {}),
      ...(r.ref ? { ref: r.ref } : {}),
    })).filter((p) => p.amount > 0);
    try {
      const res = await api('pos:pay', {
        sessionId: s.id,
        guestId,
        lineIds: pickItems ? selectedLines().map((l) => l.id) : null,
        payments,
        tip: tip(),
        cif: $('#cif', d).value,
      });
      d.remove();
      if (res.fiscal && !res.fiscal.ok) toast(`Atenție: casa de marcat a raportat o eroare: ${res.fiscal.error}`);
      showReceiptDoc(res.receipt);
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- documents ----------

function companyHeader() {
  return `${config.company}\n${config.address}\nCIF: ${config.cui}  Reg. Com.: ${config.regCom}\n`;
}

function receiptText(r) {
  const lines = r.lines.map((l) => `${l.name}\n  ${l.qty} x ${(l.unitPrice / 100).toFixed(2)}${l.discountPct ? `  -${l.discountPct}%` : ''}  = ${(l.total / 100).toFixed(2)} ${l.vat}`).join('\n');
  const vat = r.vat.map((v) => `TVA ${v.code} ${v.rate}%   bază ${(v.base / 100).toFixed(2)}   TVA ${(v.vat / 100).toFixed(2)}`).join('\n');
  const pays = r.payments.map((p) => `${methodName(p.method)}: ${((p.tendered || p.amount) / 100).toFixed(2)} lei${p.foreign ? ` (${(p.foreign / 100).toFixed(2)} EUR @ ${p.rate})` : ''}${p.ref ? ` [${p.ref}]` : ''}`).join('\n');
  return `${companyHeader()}${'-'.repeat(38)}
${r.type === 'refund' ? `STORNO la bonul ${r.refNo}${r.reason ? ` (${r.reason})` : ''}\n` : ''}Document nr. ${r.no}   ${fmt.dateTime(r.at)}
Masa: ${r.tableId}
${'-'.repeat(38)}
${lines}
${'-'.repeat(38)}
${r.discount ? `Reduceri: -${(r.discount / 100).toFixed(2)}\n` : ''}TOTAL: ${(r.total / 100).toFixed(2)} lei
${vat}
${r.tip ? `Bacșiș: ${(r.tip / 100).toFixed(2)} lei\n` : ''}${pays}
${r.change ? `Rest: ${(r.change / 100).toFixed(2)} lei\n` : ''}${r.cif ? `CIF client: ${r.cif}\n` : ''}${'-'.repeat(38)}
Document intern. Bonul fiscal este emis de casa de marcat.`;
}

function showReceiptDoc(r) {
  const d = dialog(`<div class="receipt">${esc(receiptText(r))}</div>
    <div class="row noprint"><button onclick="window.print()">Printează</button>
    <button id="reprint">Retrimite la casa de marcat</button>
    ${isManager() && r.type === 'sale' ? '<button class="danger" id="refund">Stornează</button>' : ''}
    <button id="closeDoc">Închide</button></div>`);
  $('#closeDoc', d).onclick = () => d.remove();
  $('#reprint', d).onclick = () => api('pos:reprint', { no: r.no }).then((x) => toast(x.fiscal.ok ? 'Trimis' : x.fiscal.error), (e) => toast(e.message));
  if ($('#refund', d)) {
    $('#refund', d).onclick = async () => {
      const reason = prompt('Motivul stornării:', 'retur client');
      if (reason === null) return;
      try {
        const res = await api('pos:refund', { no: r.no, reason });
        d.remove();
        showReceiptDoc(res.receipt);
      } catch (err) {
        toast(err.message);
      }
    };
  }
}

async function showReceipt(no) {
  try {
    showReceiptDoc((await api('pos:receipt', { no })).receipt);
  } catch (err) {
    toast(err.message);
  }
}

function printBill(s) {
  const b = s.bill;
  const text = `${companyHeader()}${'-'.repeat(38)}
NOTĂ DE PLATĂ — ${s.tableName}
${fmt.dateTime(Date.now())}
${'-'.repeat(38)}
${b.guests.filter((g) => g.lines.length).map((g) => `${g.name}\n${g.lines.map((l) => `  ${l.qty} x ${l.name}${l.discountPct ? ` -${l.discountPct}%` : ''}  ${(l.total / 100).toFixed(2)}${l.receiptNo ? ' (achitat)' : ''}`).join('\n')}\n  Subtotal: ${(g.total / 100).toFixed(2)}`).join('\n')}
${'-'.repeat(38)}
TOTAL: ${(b.total / 100).toFixed(2)} lei   De plată: ${(b.unpaid / 100).toFixed(2)} lei
${b.vat.map((v) => `TVA ${v.code} ${v.rate}%: ${(v.vat / 100).toFixed(2)}`).join('   ')}
Acest document nu este bon fiscal.`;
  const d = dialog(`<div class="receipt">${esc(text)}</div><div class="row noprint"><button onclick="window.print()">Printează</button><button id="closeDoc">Închide</button></div>`);
  $('#closeDoc', d).onclick = () => d.remove();
}

// ---------- takeaway / delivery ----------

$('#virtualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('pos:openVirtual', {
      kind: $('#vKind').value,
      customer: { name: $('#vName').value, phone: $('#vPhone').value, address: $('#vAddress').value },
    });
    selected = { sessionId: res.sessionId };
    e.target.reset();
    renderVirtual();
  } catch (err) {
    toast(err.message);
  }
});

function renderVirtual() {
  const list = state.sessions.filter((s) => s.kind !== 'table');
  $('#virtualList').innerHTML = `<div class="box"><h3>Comenzi deschise</h3>${list.map((s) => `<button data-open="${s.id}">${esc(s.tableName)} · ${fmt.money(s.bill.unpaid)}</button>`).join(' ') || '<span class="muted">—</span>'}</div><div id="virtualPanel"></div>`;
  $('#virtualList').querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { selected = { sessionId: b.dataset.open }; renderVirtual(); }; });
  const s = selected && selected.sessionId && list.find((x) => x.id === selected.sessionId);
  if (s) renderSession($('#virtualPanel'), s);
}

// ---------- receipts ----------

async function renderReceipts() {
  const box = $('#view-receipts');
  if (!isManager()) {
    box.innerHTML = '<div class="box">Introduceți numărul bonului: <input id="rNo" size="6"> <button id="rShow">Arată</button></div>';
    $('#rShow').onclick = () => showReceipt(Number($('#rNo').value));
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { receipts } = await api('pos:receipts', { from: today.getTime() - 6 * 86400000 });
  box.innerHTML = `<div class="box"><h3>Bonuri (ultimele 7 zile)</h3>
    <p><a href="/api/l/${loc}/export/receipts.csv?auth=${encodeURIComponent(token)}">Export CSV (toate)</a></p>
    <table><tr><th>Nr</th><th>Data</th><th>Masa</th><th>Ospătar</th><th class="num">Total</th><th>Plată</th><th>Z</th></tr>
    ${receipts.map((r) => `<tr><td><a href="#" data-receipt="${r.no}">${r.no}</a>${r.type === 'refund' ? ` storno ${r.refNo}` : ''}</td><td>${fmt.dateTime(r.at)}</td><td>${esc(r.tableId)}</td>
      <td>${esc(staffList.find((u) => u.id === r.staffId)?.name || '')}</td><td class="num">${fmt.money(r.total)}</td>
      <td>${r.payments.map((p) => esc(methodName(p.method))).join(' + ')}</td><td>${r.zNo || '—'}</td></tr>`).join('')}</table></div>`;
  box.onclick = (e) => {
    if (e.target.dataset.receipt) { e.preventDefault(); showReceipt(Number(e.target.dataset.receipt)); }
  };
}

// ---------- reports ----------

function reportText(r) {
  const L = '-'.repeat(42);
  const m = (x) => (x / 100).toFixed(2);
  return `${companyHeader()}${L}
${r.type === 'Z' ? `RAPORT Z (ÎNCHIDERE ZILNICĂ) nr. ${r.no}` : r.type === 'X' ? 'RAPORT X (INTERMEDIAR, FĂRĂ ÎNCHIDERE)' : 'RAPORT VÂNZĂRI'}
Emis: ${fmt.dateTime(r.generatedAt || Date.now())}${r.staffName ? ` de ${r.staffName}` : ''}
Perioada: ${fmt.dateTime(r.periodStart || r.from)} – ${fmt.dateTime(r.generatedAt || r.to)}
${L}
Documente emise: ${r.receiptCount}${r.firstReceipt ? ` (nr. ${r.firstReceipt} – ${r.lastReceipt})` : ''}
Documente cu CIF client: ${r.receiptsWithCif}
Vânzări brute:          ${m(r.gross)}
Reduceri:              -${m(r.discounts)}
Stornări (${r.refunds.count}):            ${m(r.refunds.total)}
${r.voids ? `Anulări înainte de plată (${r.voids.count}): ${m(r.voids.total)}\n` : ''}TOTAL VÂNZĂRI:          ${m(r.total)} lei
${L}
TVA PE COTE             Bază      TVA     Total
${r.vat.map((v) => `${v.label.padEnd(20)} ${m(v.base).padStart(8)} ${m(v.vat).padStart(8)} ${m(v.gross).padStart(9)}`).join('\n')}
TOTAL TVA:              ${m(r.totalVat)}
${L}
ÎNCASĂRI PE FORME DE PLATĂ
${r.payments.map((p) => `${p.name.padEnd(28)} ${String(p.count).padStart(3)} ${m(p.total).padStart(10)}`).join('\n')}
Rest acordat (informativ): ${m(r.change)}
Bacșiș:                 ${m(r.tips)}
${r.cash ? `${L}
NUMERAR (lei)
Intrări în casă:        ${m(r.cash.in)}
Ieșiri din casă:        ${m(r.cash.out)}
Încasări numerar:       ${m(r.cash.sales)}
Sold numerar în sertar: ${m(r.cash.drawer)}
EUR încasat:            ${m(r.cash.eurCents)} EUR
` : ''}${L}
Mese servite: ${r.tables}   Clienți: ${r.covers}   Medie/client: ${m(r.averagePerCover)}
${L}
PE OSPĂTARI
${r.byStaff.map((s) => `${s.name.padEnd(20)} ${String(s.receipts).padStart(4)} bon. ${m(s.total).padStart(10)}  bacșiș ${m(s.tips)}`).join('\n') || '—'}
${L}
PE CATEGORII
${r.byCategory.map((c) => `${c.name.padEnd(24)} ${String(c.qty).padStart(4)} ${m(c.total).padStart(10)}`).join('\n') || '—'}
${L}
TOP PRODUSE
${r.topProducts.slice(0, 15).map((p) => `${p.name.slice(0, 26).padEnd(26)} ${String(p.qty).padStart(4)} ${m(p.total).padStart(10)}`).join('\n') || '—'}
${r.byHour.length ? `${L}\nPE ORE\n${r.byHour.map((h) => `${String(h.hour).padStart(2, '0')}:00  ${m(h.total).padStart(10)}`).join('\n')}\n` : ''}${r.grandTotal !== undefined ? `${L}\nTOTAL CUMULAT: ${m(r.grandTotal)} lei\n` : ''}${r.openTables ? `Mese încă deschise: ${r.openTables} (neîncasat ${m(r.unpaidOpen)})\n` : ''}${L}
Raport intern al aplicației. Raportul Z fiscal se emite
din casa de marcat (AMEF) și se transmite la ANAF.`;
}

function showReport(r) {
  const d = dialog(`<div class="receipt">${esc(reportText(r))}</div><div class="row noprint"><button onclick="window.print()">Printează</button><button id="closeDoc">Închide</button></div>`);
  $('#closeDoc', d).onclick = () => d.remove();
}

async function renderReports() {
  const box = $('#view-reports');
  const { list } = await api('pos:zList');
  const today = new Date().toISOString().slice(0, 10);
  box.innerHTML = `
    <div class="box row">
      <button id="repX">Raport X (intermediar)</button>
      <button class="danger" id="repZ">Raport Z (închidere zi)</button>
    </div>
    <div class="box">
      <h3>Raport vânzări pe perioadă</h3>
      <div class="row">De la <input type="date" id="from" value="${today}"> până la <input type="date" id="to" value="${today}"> <button id="sales">Generează</button>
      <a id="csv" href="#">Export CSV bonuri</a></div>
    </div>
    <div class="box"><h3>Istoric rapoarte Z</h3>
      <table><tr><th>Nr</th><th>Data</th><th class="num">Bonuri</th><th class="num">Total</th></tr>
      ${list.slice().reverse().map((z) => `<tr><td><a href="#" data-z="${z.no}">Z ${z.no}</a></td><td>${fmt.dateTime(z.generatedAt)}</td><td class="num">${z.receiptCount}</td><td class="num">${fmt.money(z.total)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">—</td></tr>'}</table>
    </div>`;
  const range = () => {
    const from = new Date(`${$('#from').value}T00:00:00`).getTime();
    const to = new Date(`${$('#to').value}T00:00:00`).getTime() + 86400000;
    return { from, to };
  };
  $('#csv').onclick = (e) => {
    e.preventDefault();
    const { from, to } = range();
    location.href = `/api/l/${loc}/export/receipts.csv?auth=${encodeURIComponent(token)}&from=${from}&to=${to}`;
  };
  $('#repX').onclick = () => api('pos:reportX').then((r) => showReport(r.report), (e) => toast(e.message));
  $('#repZ').onclick = async () => {
    if (!confirm('Raportul Z închide ziua fiscală și nu poate fi anulat. Continuați?')) return;
    try {
      let res;
      try {
        res = await api('pos:reportZ');
      } catch (err) {
        if (!/mese deschise/.test(err.message) || !confirm(`${err.message}\n\nEmiteți totuși raportul Z?`)) throw err;
        res = await api('pos:reportZ', { force: true });
      }
      showReport(res.report);
      renderReports();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#sales').onclick = () => api('pos:sales', range()).then((r) => showReport({ ...r.report, type: 'S' }), (e) => toast(e.message));
  box.onclick = (e) => {
    if (e.target.dataset.z) {
      e.preventDefault();
      api('pos:zGet', { no: Number(e.target.dataset.z) }).then((r) => showReport(r.report), (err) => toast(err.message));
    }
  };
}

// ---------- menu admin ----------

function renderMenuAdmin() {
  const box = $('#view-menu');
  box.innerHTML = `<div class="box"><h3>Meniu — disponibilitate și prețuri</h3>
    <p class="muted">Modificările de preț se aplică doar comenzilor noi. Produsele indisponibile dispar din comanda clienților.</p>
    <table><tr><th>Produs</th><th>Categorie</th><th>TVA</th><th class="num">Preț (lei)</th><th>Disponibil</th></tr>
    ${config.items.map((i) => `<tr><td>${esc(i.name)} <span class="muted">${esc(i.qty)}</span></td><td>${esc(config.categories.find((c) => c.id === i.cat)?.name)}</td><td>${i.vat}</td>
      <td class="num"><input data-price="${i.id}" value="${(i.price / 100).toFixed(2)}" size="7"></td>
      <td><input type="checkbox" data-avail="${i.id}" ${i.available ? 'checked' : ''}></td></tr>`).join('')}</table></div>`;
  box.onchange = (e) => {
    const t = e.target;
    if (t.dataset.avail) api('pos:menuUpdate', { itemId: t.dataset.avail, available: t.checked }).catch((err) => toast(err.message));
    if (t.dataset.price) {
      const price = parseLei(t.value);
      if (!Number.isFinite(price)) return toast('Preț invalid');
      api('pos:menuUpdate', { itemId: t.dataset.price, price }).then(() => toast('Preț actualizat'), (err) => toast(err.message));
    }
  };
}

// ---------- staff ----------

async function renderStaff() {
  const box = $('#view-staff');
  staffList = (await api('pos:staffList')).staff;
  const roles = { manager: 'Manager', waiter: 'Ospătar', kitchen: 'Bucătărie / bar' };
  const roleSelect = (cur) => Object.entries(roles).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  box.innerHTML = `<div class="box"><h3>Personal</h3>
    <table><tr><th>Nume</th><th>Rol</th><th>PIN nou</th><th>Activ</th><th></th></tr>
    ${staffList.map((u) => `<tr data-id="${u.id}"><td><input name="name" value="${esc(u.name)}"></td><td><select name="role">${roleSelect(u.role)}</select></td>
      <td><input name="pin" placeholder="neschimbat" size="8" inputmode="numeric"></td><td><input type="checkbox" name="active" ${u.active ? 'checked' : ''}></td>
      <td><button data-save>Salvează</button></td></tr>`).join('')}
    <tr data-id=""><td><input name="name" placeholder="Nume nou"></td><td><select name="role">${roleSelect('waiter')}</select></td>
      <td><input name="pin" placeholder="PIN 4-8 cifre" size="8" inputmode="numeric"></td><td><input type="checkbox" name="active" checked></td><td><button data-save>Adaugă</button></td></tr>
    </table></div>`;
  box.onclick = async (e) => {
    if (e.target.dataset.save === undefined) return;
    const tr = e.target.closest('tr');
    const val = (n) => tr.querySelector(`[name="${n}"]`);
    try {
      await api('pos:staffSave', { id: tr.dataset.id || undefined, name: val('name').value, role: val('role').value, pin: val('pin').value, active: val('active').checked });
      toast('Salvat');
      renderStaff();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- cash ----------

function renderCash() {
  const box = $('#view-cash');
  box.innerHTML = `<div class="box"><h3>Intrări / ieșiri numerar</h3>
    <p class="muted">Sold inițial (fond de rulment), depuneri la bancă, plăți către furnizori din casă etc. Apar în raportul X/Z.</p>
    <div class="row"><select id="cType"><option value="in">Intrare (introducere numerar)</option><option value="out">Ieșire (scoatere numerar)</option></select>
    <input id="cAmount" placeholder="sumă lei" size="8"><input id="cReason" placeholder="motiv" size="24"><button class="primary" id="cSave">Înregistrează</button></div></div>`;
  $('#cSave').onclick = () => {
    api('pos:cash', { type: $('#cType').value, amount: parseLei($('#cAmount').value), reason: $('#cReason').value })
      .then(() => { toast('Înregistrat'); renderCash(); }, (e) => toast(e.message));
  };
}

// ---------- status ----------

async function renderStatus() {
  const box = $('#view-status');
  const st = await api('pos:status');
  const when = (x) => (x && x.checkedAt ? fmt.dateTime(x.checkedAt) : '—');
  const legal = st.legal
    ? `<tr><td>Cote TVA</td><td>${esc(st.legal.vat.source)}</td><td>${when(st.legal.vat)}</td><td>${esc(st.legal.vat.error || (st.legal.vat.changes || []).join(', ') || 'OK')}</td></tr>
       <tr><td>Date firmă (ANAF)</td><td>${esc(st.legal.company.source)}</td><td>${when(st.legal.company)}</td><td>${esc(st.legal.company.error || 'OK')}</td></tr>
       <tr><td>Curs BNR</td><td>${esc(st.legal.fx.source)}</td><td>${when(st.legal.fx)}</td><td>${esc(st.legal.fx.error || `EUR ${st.fx.EUR} (${st.fx.date || ''})`)}</td></tr>`
    : '';
  box.innerHTML = `
    <div class="box"><h3>Valori legale (actualizare automată)</h3>
      <table><tr><th></th><th>Sursă</th><th>Verificat</th><th>Stare</th></tr>${legal}</table>
      <p>${st.vatGroups.map((v) => `${esc(v.label)}`).join(' · ')}</p></div>
    <div class="box"><h3>Echipamente</h3>
      <p>Casă de marcat: driver <strong>${esc(st.fiscalDriver)}</strong> · ${st.devices.fiscal.ok ? 'OK' : `EROARE: ${esc(st.devices.fiscal.lastError)}`}</p>
      ${Object.entries(st.devices.printers).map(([k, v]) => `<p>Imprimantă ${esc(k)}: ${v.ok ? 'OK' : esc(v.lastError)}</p>`).join('')}
      ${st.journal.length ? `<details><summary>Jurnal casă de marcat simulată (${st.journal.length})</summary><pre class="receipt">${esc(st.journal.map((j) => `${fmt.dateTime(j.at)} ${j.kind} ${j.ref}`).join('\n'))}</pre></details>` : ''}</div>
    <div class="box"><h3>Stocare & GDPR</h3>
      <p>Stocare: ${st.storage.kind === 'supabase' ? `Supabase ${st.storage.lastError ? `EROARE: ${esc(st.storage.lastError)}` : 'OK'}` : 'fișier local'}</p>
      <p>Numele clienților și datele de livrare se anonimizează automat după ${st.retentionDays} zile de la închiderea mesei.</p></div>`;
}
