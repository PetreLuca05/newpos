const test = require('node:test');
const assert = require('node:assert');
const { Store, emptyState, vatFromGross } = require('../src/store');
const { loadLocations } = require('../src/locations');
const { sessionRows, receiptRow, voidRow, cashRow, zRow, stateFromRows } = require('../src/supabase-sync');

const [cluj, buc] = loadLocations();
const newStore = (loc = cluj) => new Store({ location: loc });

function tableWithTwo(st) {
  const { session, guest: ana } = st.joinTable('T5', { name: 'Ana' });
  const { guest: dan } = st.joinTable('T5', { name: 'Dan' });
  return { session, ana, dan };
}

test('VAT is extracted from VAT-inclusive prices', () => {
  assert.strictEqual(vatFromGross(12100, 21), 2100);
  assert.strictEqual(vatFromGross(11100, 11), 1100);
});

test('guests share one table session and re-join by id', () => {
  const st = newStore();
  const { session, ana, dan } = tableWithTwo(st);
  assert.strictEqual(session.guests.length, 2);
  assert.notStrictEqual(ana.id, dan.id);
  assert.strictEqual(st.joinTable('T5', { guestId: ana.id }).guest.id, ana.id);
  assert.strictEqual(st.joinTable('T5', {}).guest, null);
});

test('bill is split per guest; prices come from the server', () => {
  const st = newStore();
  const { session, ana, dan } = tableWithTwo(st);
  st.sendOrder(session.id, ana.id, [{ itemId: 'mn-sarmale', qty: 1, price: 1 }]);
  st.sendOrder(session.id, dan.id, [{ itemId: 'wn-feteasca-neagra', qty: 2 }]);
  const bill = st.bill(session);
  assert.deepStrictEqual(bill.guests.map((g) => g.total), [4900, 5200]);
  assert.strictEqual(bill.total, 10100);
  assert.deepStrictEqual(bill.vat.map((v) => v.code), ['A', 'B']);
});

test('order validation', () => {
  const st = newStore();
  const { session, ana } = tableWithTwo(st);
  assert.throws(() => st.sendOrder(session.id, ana.id, []), /goală/);
  assert.throws(() => st.sendOrder(session.id, ana.id, [{ itemId: 'nope', qty: 1 }]), /inexistent/);
  assert.throws(() => st.sendOrder(session.id, ana.id, [{ itemId: 'mn-sarmale', qty: 99 }]), /Cantitate/);
  assert.throws(() => st.sendOrder(session.id, 'G999', [{ itemId: 'mn-sarmale', qty: 1 }]), /necunoscut/);
  st.updateMenuItem('mn-sarmale', { available: false });
  assert.throws(() => st.sendOrder(session.id, ana.id, [{ itemId: 'mn-sarmale', qty: 1 }]), /disponibil/);
});

test('per-guest payment, mixed payment, change only from cash, tips', () => {
  const st = newStore();
  const { session, ana, dan } = tableWithTwo(st);
  st.sendOrder(session.id, ana.id, [{ itemId: 'mn-sarmale', qty: 1 }], { source: 'pos' });
  st.sendOrder(session.id, dan.id, [{ itemId: 'pp-diavola', qty: 1 }], { source: 'pos' });
  assert.throws(() => st.pay(session.id, { guestId: ana.id, payments: [{ method: 'card', amount: 6000 }] }), /numerar/);
  assert.throws(() => st.pay(session.id, { guestId: ana.id, payments: [{ method: 'card', amount: 100 }] }), /mai mică/);
  const { receipt } = st.pay(session.id, { guestId: ana.id, tip: 500, payments: [{ method: 'cash', amount: 10000 }] });
  assert.strictEqual(receipt.total, 4900);
  assert.strictEqual(receipt.change, 4600);
  assert.deepStrictEqual(receipt.payments, [{ method: 'cash', amount: 5400, tendered: 10000 }]);
  const r2 = st.pay(session.id, { payments: [{ method: 'card', amount: 3000 }, { method: 'meal', amount: 1600 }] }).receipt;
  assert.strictEqual(r2.total, 4600);
  assert.strictEqual(st.bill(session).unpaid, 0);
  assert.throws(() => st.pay(session.id, { payments: [{ method: 'cash', amount: 100 }] }), /Nu există/);
  assert.strictEqual(st.closeSession(session.id).status, 'closed');
});

test('pay selected items only (split by items)', () => {
  const st = newStore();
  const { session, ana } = tableWithTwo(st);
  const o = st.sendOrder(session.id, ana.id, [{ itemId: 'cf-espresso', qty: 1 }, { itemId: 'ds-tiramisu', qty: 1 }], { source: 'pos' });
  const { receipt } = st.pay(session.id, { lineIds: [o.lines[0].id], payments: [{ method: 'card', amount: 900 }] });
  assert.strictEqual(receipt.total, 900);
  assert.strictEqual(st.bill(session).unpaid, 3000);
});

test('discounts, voids, moving items and closing rules', () => {
  const st = newStore();
  const { session, ana, dan } = tableWithTwo(st);
  const o = st.sendOrder(session.id, ana.id, [{ itemId: 'pp-margherita', qty: 2 }, { itemId: 'sd-cola', qty: 1 }]);
  assert.throws(() => st.closeSession(session.id), /neîncasate/);
  st.setOrderStatus(o.id, 'accepted');
  st.discountLine(session.id, o.lines[0].id, 50);
  st.voidLine(session.id, o.lines[1].id, { reason: 'test' });
  st.moveLine(session.id, o.lines[0].id, dan.id);
  const bill = st.bill(session);
  assert.strictEqual(bill.total, 3900);
  assert.strictEqual(bill.discount, 3900);
  assert.strictEqual(bill.guests.find((g) => g.guestId === dan.id).total, 3900);
  assert.strictEqual(st.reportX().voids.count, 1);
});

test('transfer and merge tables', () => {
  const st = newStore();
  const { session, ana } = tableWithTwo(st);
  st.transferSession(session.id, 'T1');
  assert.strictEqual(st.activeSession('T1').id, session.id);
  assert.strictEqual(st.activeSession('T5'), null);
  const { session: other } = st.joinTable('T2', { name: 'Ion' });
  st.sendOrder(other.id, other.guests[0].id, [{ itemId: 'cf-espresso', qty: 1 }], { source: 'pos' });
  st.mergeSessions(other.id, session.id);
  assert.strictEqual(session.guests.length, 3);
  assert.strictEqual(st.bill(session).total, 900);
  assert.strictEqual(st.activeSession('T2'), null);
  assert.throws(() => st.transferSession(session.id, 'T1'), /ocupată|Alegeți/);
  assert.ok(ana);
});

test('takeaway and delivery orders', () => {
  const st = newStore();
  assert.throws(() => st.openVirtual('delivery', { name: 'X' }), /Adresa/);
  const s = st.openVirtual('delivery', { name: 'Ion', phone: '0722 000 000', address: 'Str. A 1' });
  assert.match(st.tableName(s), /Livrare/);
  st.sendOrder(s.id, s.guests[0].id, [{ itemId: 'pp-margherita', qty: 1 }], { source: 'pos' });
  const r = st.pay(s.id, { payments: [{ method: 'eur', amount: 3900, rate: 5 }] }).receipt;
  assert.strictEqual(r.payments[0].foreign, 780);
});

test('refund (storno), cash moves and Z report', () => {
  const st = newStore();
  const { session, ana } = tableWithTwo(st);
  st.sendOrder(session.id, ana.id, [{ itemId: 'mn-burger', qty: 1 }, { itemId: 'ck-negroni', qty: 1 }], { source: 'pos', staffId: 'U2' });
  const { receipt } = st.pay(session.id, { tip: 1000, payments: [{ method: 'card', amount: 10700 }], cif: 'RO18547290', staffId: 'U2' });
  st.closeSession(session.id);
  st.cashMove({ type: 'in', amount: 50000, reason: 'sold inițial' });
  st.cashMove({ type: 'out', amount: 10000, reason: 'furnizor' });

  const x = st.reportX();
  assert.strictEqual(x.total, 9700);
  assert.strictEqual(x.tips, 1000);
  assert.strictEqual(x.receiptsWithCif, 1);
  assert.strictEqual(x.cash.drawer, 40000);
  assert.strictEqual(x.byStaff[0].name, 'Ana');
  assert.strictEqual(x.vat.find((v) => v.code === 'A').gross, 3800);

  const refund = st.refundReceipt(receipt.no, { reason: 'retur' });
  assert.strictEqual(refund.total, -9700);
  assert.throws(() => st.refundReceipt(receipt.no), /deja/);

  const z1 = st.reportZ();
  assert.strictEqual(z1.no, 1);
  assert.strictEqual(z1.total, 0);
  assert.strictEqual(z1.refunds.count, 1);
  const z2 = st.reportZ();
  assert.strictEqual(z2.no, 2);
  assert.strictEqual(z2.receiptCount, 0);
  assert.strictEqual(st.zReports().length, 2);
});

test('Z refuses open tables unless forced', () => {
  const st = newStore();
  tableWithTwo(st);
  assert.throws(() => st.reportZ(), /mese deschise/);
  assert.strictEqual(st.reportZ({ force: true }).no, 1);
});

test('staff login by PIN and roles', () => {
  const st = newStore();
  assert.strictEqual(st.login('1234').role, 'manager');
  assert.throws(() => st.login('0000'), /PIN/);
  const u = st.saveStaff({ name: 'Ioana', role: 'waiter', pin: '5555' });
  assert.strictEqual(st.login('5555').id, u.id);
  assert.throws(() => st.saveStaff({ name: 'X', role: 'waiter', pin: '5555' }), /folosit/);
  assert.throws(() => st.saveStaff({ id: 'U1', name: 'Manager', role: 'waiter' }), /manager activ/);
  assert.ok(!('pinHash' in st.staffList()[0]));
});

test('GDPR anonymization after retention', () => {
  const st = newStore();
  const { session, ana } = tableWithTwo(st);
  st.sendOrder(session.id, ana.id, [{ itemId: 'cf-espresso', qty: 1, note: 'pentru Ana Popescu' }], { source: 'pos' });
  st.pay(session.id, { payments: [{ method: 'card', amount: 900 }] });
  st.closeSession(session.id);
  assert.strictEqual(st.anonymizeOlderThan(30), 0);
  assert.strictEqual(st.anonymizeOlderThan(30, Date.now() + 31 * 86400000), 2);
  assert.deepStrictEqual(session.guests.map((g) => g.name), ['Client 1', 'Client 2']);
  assert.strictEqual(session.orders[0].lines[0].note, '');
  assert.ok(!JSON.stringify(st.state.receipts).includes('Ana'));
});

test('locations are independent (own numbering, own menu/prices)', () => {
  const a = newStore(cluj);
  const b = newStore(buc);
  const sa = a.joinTable('T1', { name: 'A' });
  const sb = b.joinTable('T1', { name: 'B' });
  a.sendOrder(sa.session.id, sa.guest.id, [{ itemId: 'mn-sarmale', qty: 1 }], { source: 'pos' });
  b.sendOrder(sb.session.id, sb.guest.id, [{ itemId: 'mn-sarmale', qty: 1 }], { source: 'pos' });
  assert.strictEqual(a.bill(sa.session).total, 4900);
  assert.strictEqual(b.bill(sb.session).total, 5400);
  assert.throws(() => b.sendOrder(sb.session.id, sb.guest.id, [{ itemId: 'st-board', qty: 1 }]), /inexistent/);
  assert.throws(() => b.joinTable('T9', { name: 'x' }), /inexistentă/);
  a.pay(sa.session.id, { payments: [{ method: 'card', amount: 4900 }] });
  b.pay(sb.session.id, { payments: [{ method: 'card', amount: 5400 }] });
  assert.strictEqual(a.state.receipts[0].no, 1);
  assert.strictEqual(b.state.receipts[0].no, 1);
});

test('Supabase row mapping round-trips the state', () => {
  const st = newStore();
  const { session, ana, dan } = tableWithTwo(st);
  const o = st.sendOrder(session.id, ana.id, [{ itemId: 'pp-margherita', qty: 2, note: 'x' }, { itemId: 'sd-cola', qty: 1 }]);
  st.setOrderStatus(o.id, 'accepted');
  st.voidLine(session.id, o.lines[1].id, { reason: 'r' });
  st.call(session.id, 'bill');
  st.pay(session.id, { guestId: ana.id, payments: [{ method: 'cash', amount: 10000 }] });
  st.cashMove({ type: 'in', amount: 100 });
  st.joinTable('T1', { name: 'Solo' });
  st.reportZ({ force: true });
  st.state.seq.session += 0;

  const rows = { sessions: [], guests: [], orders: [], order_lines: [], calls: [] };
  for (const s of Object.values(st.state.sessions)) {
    const r = sessionRows('cluj', s);
    for (const k of Object.keys(rows)) rows[k].push(...r[k]);
  }
  // simulate JSON transport through Postgres
  const all = JSON.parse(JSON.stringify({
    ...rows,
    receipts: st.state.receipts.map((r) => receiptRow('cluj', r)),
    voids: st.state.voids.map((v) => voidRow('cluj', v)),
    cash_moves: st.state.cashMoves.map((m) => cashRow('cluj', m)),
    z_reports: st.state.zReports.map((z) => zRow('cluj', z)),
    pos_meta: ['seq', 'grandTotal', 'staff', 'menu'].map((key) => ({ key, value: st.state[key] })),
  }));
  const restored = stateFromRows(all, emptyState());
  assert.deepStrictEqual(restored.sessions, JSON.parse(JSON.stringify(st.state.sessions)));
  assert.deepStrictEqual(restored.activeByTable, st.state.activeByTable);
  assert.deepStrictEqual(restored.receipts, JSON.parse(JSON.stringify(st.state.receipts)));
  assert.deepStrictEqual(restored.voids, JSON.parse(JSON.stringify(st.state.voids)));
  assert.deepStrictEqual(restored.cashMoves, JSON.parse(JSON.stringify(st.state.cashMoves)));
  assert.deepStrictEqual(restored.seq, st.state.seq);
  assert.ok(dan);
});
