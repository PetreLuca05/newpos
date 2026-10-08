// Guest page: /l/<loc>/t/<table>?k=<code>
const [, , loc, , table] = location.pathname.split('/');
const k = new URLSearchParams(location.search).get('k') || '';
const socket = io();
let config = null;
let me = null;
let view = null;
let cart = []; // { itemId, qty, note }
const guestKey = `guest:${loc}:${table}`;

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').classList.toggle('hidden', !msg);
}

async function hello() {
  try {
    const res = await call(socket, 'guest:hello', { loc, table, k, guestId: storage(guestKey) });
    $('#tableName').textContent = res.table.name;
    showError('');
    if (res.guest) {
      enter(res.guest, res.session);
    } else {
      $('#others').textContent = res.othersAtTable ? `La masă sunt deja ${res.othersAtTable} persoane.` : 'Sunteți primul la această masă.';
      $('#join').classList.remove('hidden');
      $('#app').classList.add('hidden');
    }
  } catch (err) {
    showError(err.message);
  }
}

function enter(guest, session) {
  me = guest;
  storage(guestKey, guest.id);
  $('#me').textContent = `· ${guest.name}`;
  $('#join').classList.add('hidden');
  $('#app').classList.remove('hidden');
  view = session;
  render();
}

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await call(socket, 'guest:join', { loc, table, k, name: $('#name').value, consent: $('#consent').checked });
    enter(res.guest, res.session);
  } catch (err) {
    toast(err.message);
  }
});

// ----- menu -----

function renderMenu() {
  $('#cats').innerHTML = config.categories.map((c) => `<a href="#cat-${c.id}">${esc(c.name)}</a>`).join(' · ');
  $('#menu').innerHTML = config.categories.map((c) => {
    const items = config.items.filter((i) => i.cat === c.id);
    if (!items.length) return '';
    return `<h3 id="cat-${c.id}">${esc(c.name)}</h3><table>${items.map((i) => `
      <tr>
        <td>${i.emoji || ''} <strong>${esc(i.name)}</strong> <span class="muted">${esc(i.qty)}</span><br>
          <span class="muted">${esc(i.desc)}${i.allergens.length ? ` · Alergeni: ${esc(i.allergens.join(', '))}` : ''}</span></td>
        <td class="num">${fmt.money(i.price)}<br>
          ${i.available ? `<button data-add="${i.id}">Adaugă</button>` : '<span class="muted">indisponibil</span>'}</td>
      </tr>`).join('')}</table>`;
  }).join('');
}

$('#menu').addEventListener('click', (e) => {
  const id = e.target.dataset.add;
  if (!id) return;
  const line = cart.find((l) => l.itemId === id && !l.note);
  if (line) line.qty += 1;
  else cart.push({ itemId: id, qty: 1, note: '' });
  renderCart();
});

function renderCart() {
  const items = new Map(config.items.map((i) => [i.id, i]));
  $('#cart').classList.toggle('hidden', cart.length === 0);
  $('#cartLines').innerHTML = cart.map((l, idx) => `
    <div class="row" style="margin-bottom:4px">
      <button data-dec="${idx}">−</button><span>${l.qty}</span><button data-inc="${idx}">+</button>
      <span>${esc(items.get(l.itemId).name)}</span>
      <input data-note="${idx}" placeholder="mențiuni (ex. fără ceapă)" value="${esc(l.note)}" maxlength="140">
      <span class="muted">${fmt.money(items.get(l.itemId).price * l.qty)}</span>
    </div>`).join('');
  $('#cartTotal').textContent = `Total: ${fmt.money(cart.reduce((s, l) => s + items.get(l.itemId).price * l.qty, 0))}`;
}

$('#cartLines').addEventListener('click', (e) => {
  const { inc, dec } = e.target.dataset;
  if (inc !== undefined) cart[inc].qty = Math.min(20, cart[inc].qty + 1);
  if (dec !== undefined) {
    cart[dec].qty -= 1;
    if (cart[dec].qty <= 0) cart.splice(dec, 1);
  }
  renderCart();
});
$('#cartLines').addEventListener('change', (e) => {
  if (e.target.dataset.note !== undefined) cart[e.target.dataset.note].note = e.target.value;
});
$('#clearCart').onclick = () => { cart = []; renderCart(); };

$('#send').onclick = async () => {
  $('#send').disabled = true;
  try {
    await call(socket, 'guest:order', { items: cart });
    cart = [];
    renderCart();
    toast('Comanda a fost trimisă. Ospătarul o va confirma.');
    showTab('table');
  } catch (err) {
    toast(err.message);
  } finally {
    $('#send').disabled = false;
  }
};

// ----- table / bill -----

function renderTable() {
  if (!view || !me) return;
  if (view.status === 'closed') {
    $('#tableView').innerHTML = '<div class="box"><h2>Mulțumim!</h2><p>Masa a fost închisă. Vă așteptăm cu drag.</p></div>';
    $('#cart').classList.add('hidden');
    return;
  }
  const orders = view.orders.slice().reverse().map((o) => `
    <div class="box">
      <span class="dot" style="background:${o.guestColor}"></span><strong>${esc(o.guestName)}</strong>
      <span class="muted">${fmt.time(o.at)}</span> <span class="badge st-${o.status}">${fmt.status[o.status]}</span>
      <ul>${o.lines.map((l) => `<li>${l.qty} × ${esc(l.name)}${l.note ? ` <em>(${esc(l.note)})</em>` : ''}${l.voided ? ' <span class="badge st-rejected">anulat</span>' : ''}</li>`).join('')}</ul>
    </div>`).join('') || '<p class="muted">Nicio comandă încă.</p>';

  const b = view.bill;
  const bill = `
    <div class="box"><h3>Nota mesei</h3>
    ${b.guests.map((g) => `
      <p><span class="dot" style="background:${g.color}"></span><strong>${esc(g.name)}</strong>${g.guestId === me.id ? ' (eu)' : ''}</p>
      <table>${g.lines.map((l) => `<tr><td>${l.qty} × ${esc(l.name)}${l.discountPct ? ` <span class="muted">-${l.discountPct}%</span>` : ''}</td>
        <td class="num">${fmt.money(l.total)}${l.receiptNo ? ' ✓' : ''}</td></tr>`).join('')}
        <tr><th>Subtotal ${esc(g.name)}</th><th class="num">${fmt.money(g.total)}${g.paid ? ` <span class="muted">(achitat ${fmt.money(g.paid)})</span>` : ''}</th></tr>
      </table>`).join('')}
    <h3>Total masă: ${fmt.money(b.total)}</h3>
    ${b.paid ? `<p>Achitat: ${fmt.money(b.paid)} · Rest de plată: ${fmt.money(b.unpaid)}</p>` : ''}
    <p class="muted">Prețurile includ TVA. Acest document nu este bon fiscal; bonul fiscal se emite la plată.</p></div>`;
  $('#tableView').innerHTML = `<h3>${esc(view.tableName)} · ${view.guests.map((g) => esc(g.name)).join(', ')}</h3>${bill}<h3>Comenzi</h3>${orders}`;
}

function render() {
  renderMenu();
  renderCart();
  renderTable();
}

function showTab(tab) {
  $('#tab-menu').classList.toggle('hidden', tab !== 'menu');
  $('#tab-table').classList.toggle('hidden', tab !== 'table');
}
document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

$('#callWaiter').onclick = () => call(socket, 'guest:call', { type: 'waiter' }).then(() => toast('Ospătarul a fost anunțat.'), (e) => toast(e.message));
$('#askBill').onclick = () => call(socket, 'guest:call', { type: 'bill' }).then(() => toast('Ați cerut nota.'), (e) => toast(e.message));
$('#forget').onclick = async () => {
  if (!confirm('Numele dvs. va fi înlocuit cu „Client N”. Continuați?')) return;
  await call(socket, 'guest:forget').catch((e) => toast(e.message));
  storage(guestKey, null);
  location.reload();
};

socket.on('session', (s) => {
  view = s;
  renderTable();
});
socket.on('session:moved', ({ tableId }) => toast(`Comanda a fost mutată la masa ${tableId}.`));
socket.on('menu', (items) => {
  config.items = items;
  renderMenu();
});
socket.on('connect', () => { if (config) hello(); });

fetch(`/api/l/${loc}/config`).then((r) => r.json()).then((c) => {
  config = c;
  $('#title').textContent = `${c.name} — ${c.tagline}`;
  document.title = c.name;
  hello();
});
