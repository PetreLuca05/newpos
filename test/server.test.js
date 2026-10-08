// End-to-end: real HTTP + Socket.IO server, a guest phone and a POS terminal.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { io: connect } = require('socket.io-client');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newpos-test-'));
const { createApp, createContexts, tableKey } = require('../src/server');

function emit(sock, event, payload) {
  return new Promise((resolve) => sock.emit(event, payload, resolve));
}

test('guest orders via QR, POS confirms, splits the bill and closes the day', async (t) => {
  const contexts = await createContexts();
  const { server, io } = createApp(contexts);
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const guest = connect(url, { transports: ['websocket'] });
  const guest2 = connect(url, { transports: ['websocket'] });
  const pos = connect(url, { transports: ['websocket'] });
  t.after(() => {
    guest.close(); guest2.close(); pos.close(); io.close(); server.close();
  });

  // pages and config
  assert.strictEqual((await fetch(`${url}/l/cluj/pos`)).status, 200);
  const config = await (await fetch(`${url}/api/l/cluj/config`)).json();
  assert.strictEqual(config.floor.tables.length, 17);
  assert.strictEqual((await fetch(`${url}/api/l/cluj/qr`)).status, 401);

  // invalid QR code is rejected
  const bad = await emit(guest, 'guest:hello', { loc: 'cluj', table: 'T3', k: 'wrong' });
  assert.match(bad.error, /QR invalid/);

  const k = tableKey('cluj', 'T3');
  const hello = await emit(guest, 'guest:hello', { loc: 'cluj', table: 'T3', k });
  assert.strictEqual(hello.guest, null);
  assert.match((await emit(guest, 'guest:join', { loc: 'cluj', table: 'T3', k, name: 'Ana' })).error, /informarea/);
  const j1 = await emit(guest, 'guest:join', { loc: 'cluj', table: 'T3', k, name: 'Ana', consent: true });
  const j2 = await emit(guest2, 'guest:join', { loc: 'cluj', table: 'T3', k, name: 'Dan', consent: true });
  assert.strictEqual(j2.session.guests.length, 2);

  // POS login
  assert.match((await emit(pos, 'staff:login', { loc: 'cluj', pin: '9999' })).error, /PIN/);
  const login = await emit(pos, 'staff:login', { loc: 'cluj', pin: '1234' });
  assert.strictEqual(login.staff.role, 'manager');
  const token = login.token;
  assert.strictEqual((await fetch(`${url}/api/l/cluj/qr`, { headers: { 'x-auth': token } })).status, 200);

  const posEvent = new Promise((r) => pos.once('pos:event', r));
  const sessionUpdate = new Promise((r) => guest2.once('session', r));
  const o1 = await emit(guest, 'guest:order', { items: [{ itemId: 'mn-sarmale', qty: 1 }, { itemId: 'br-lager', qty: 2 }] });
  assert.ok(o1.ok);
  assert.match((await posEvent).text, /Comandă nouă/);
  assert.strictEqual((await sessionUpdate).orders.length, 1); // other guest sees it live
  await emit(guest2, 'guest:order', { items: [{ itemId: 'pp-fig', qty: 1 }] });
  await emit(guest2, 'guest:call', { type: 'bill' });

  const st = (await emit(pos, 'pos:state', { token })).state;
  const s = st.sessions.find((x) => x.tableId === 'T3');
  assert.strictEqual(s.calls.length, 1);
  for (const o of s.orders) assert.ok((await emit(pos, 'pos:orderStatus', { token, orderId: o.id, status: 'accepted' })).ok);

  // kitchen display sees the food, bar sees the beer
  const kds = connect(url, { transports: ['websocket'] });
  t.after(() => kds.close());
  await emit(kds, 'staff:login', { loc: 'cluj', pin: '3333' });
  const kitchen = await emit(kds, 'kds:join', { station: 'kitchen' });
  assert.strictEqual(kitchen.orders.length, 2);
  assert.match((await emit(kds, 'pos:discount', { sessionId: s.id, pct: 10 })).error, /manager/);

  // Ana pays her part in cash, Dan pays by card with a tip
  const ana = s.guests.find((g) => g.name === 'Ana');
  const p1 = await emit(pos, 'pos:pay', { token, sessionId: s.id, guestId: ana.id, payments: [{ method: 'cash', amount: 10000 }] });
  assert.strictEqual(p1.receipt.total, 4900 + 3200);
  assert.strictEqual(p1.fiscal.ok, true);
  const p2 = await emit(pos, 'pos:pay', { token, sessionId: s.id, tip: 500, payments: [{ method: 'card', amount: 5700 }] });
  assert.strictEqual(p2.receipt.total, 5200);
  assert.ok((await emit(pos, 'pos:close', { token, sessionId: s.id })).ok);

  const z = await emit(pos, 'pos:reportZ', { token });
  assert.strictEqual(z.report.no, 1);
  assert.strictEqual(z.report.total, 13300);
  assert.strictEqual(z.report.receiptCount, 2);
  assert.strictEqual(z.report.tips, 500);

  const csv = await (await fetch(`${url}/api/l/cluj/export/receipts.csv?auth=${token}`)).text();
  assert.strictEqual(csv.trim().split('\n').length, 3);

  // waiter cannot run a Z report
  const waiter = connect(url, { transports: ['websocket'] });
  t.after(() => waiter.close());
  await emit(waiter, 'staff:login', { loc: 'cluj', pin: '1111' });
  assert.match((await emit(waiter, 'pos:reportZ', {})).error, /manager/);

  // the other location is fully separate
  const other = await emit(guest, 'guest:hello', { loc: 'bucuresti', table: 'T3', k });
  assert.match(other.error, /QR invalid/);
});
