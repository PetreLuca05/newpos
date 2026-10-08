// Persists a location's in-memory Store to Supabase (Postgres). Each location's server process is the
// single writer for that location's rows (location_id). Tables have RLS enabled with no policies,
// so only the secret (service_role) key used by the server can access them.

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const ms = (ts) => (ts ? new Date(ts).getTime() : null);

// ---------- state -> rows ----------

function sessionRows(loc, session) {
  const rows = { sessions: [], guests: [], orders: [], order_lines: [], calls: [] };
  rows.sessions.push({
    location_id: loc, id: session.id, table_id: session.tableId, kind: session.kind || 'table', label: session.label || null,
    customer: session.customer || null, waiter_id: session.waiterId || null, status: session.status,
    merged_into: session.mergedInto || null, opened_at: iso(session.openedAt), closed_at: iso(session.closedAt),
  });
  for (const g of session.guests) {
    rows.guests.push({
      location_id: loc, id: g.id, session_id: session.id, name: g.name, color: g.color, joined_at: iso(g.joinedAt), anonymized: !!g.anonymized,
    });
  }
  for (const o of session.orders) {
    rows.orders.push({
      location_id: loc, id: o.id, session_id: session.id, guest_id: o.guestId, status: o.status,
      source: o.source || 'guest', staff_id: o.staffId || null, created_at: iso(o.at),
    });
    o.lines.forEach((l, position) => {
      rows.order_lines.push({
        location_id: loc, id: l.id, order_id: o.id, guest_id: l.guestId, item_id: l.itemId, name: l.name, category: l.cat,
        station: l.station, qty: l.qty, unit_price: l.unitPrice, vat_code: l.vat, discount_pct: l.discountPct || 0,
        note: l.note, voided: l.voided, void_reason: l.voidReason || '', ready: !!l.ready, receipt_no: l.receiptNo, position,
      });
    });
  }
  for (const c of session.calls) {
    rows.calls.push({ location_id: loc, id: c.id, session_id: session.id, type: c.type, created_at: iso(c.at), ack: c.ack });
  }
  return rows;
}

const receiptRow = (loc, r) => ({
  location_id: loc, no: r.no, type: r.type, ref_no: r.refNo, reason: r.reason || '', session_id: r.sessionId, table_id: r.tableId,
  staff_id: r.staffId, payments: r.payments, change: r.change, tip: r.tip, cif: r.cif, gross: r.gross, discount: r.discount,
  total: r.total, vat: r.vat, lines: r.lines, guest_ids: r.guestIds, z_no: r.zNo, created_at: iso(r.at),
});

const voidRow = (loc, v) => ({
  location_id: loc, line_id: v.lineId, session_id: v.sessionId, table_id: v.tableId, name: v.name, qty: v.qty, total: v.total,
  reason: v.reason || '', staff_id: v.staffId || null, z_no: v.zNo, created_at: iso(v.at),
});

const cashRow = (loc, m) => ({
  location_id: loc, id: m.id, type: m.type, amount: m.amount, reason: m.reason, staff_id: m.staffId, z_no: m.zNo, created_at: iso(m.at),
});

const zRow = (loc, z) => ({ location_id: loc, no: z.no, generated_at: iso(z.generatedAt), total: z.total, report: z });

// ---------- rows -> state ----------

const byTime = (field) => (a, b) => ms(a[field]) - ms(b[field]);

function stateFromRows(rows, defaults) {
  const meta = Object.fromEntries((rows.pos_meta || []).map((m) => [m.key, m.value]));
  const state = {
    ...defaults,
    seq: { ...defaults.seq, ...(meta.seq || {}) },
    grandTotal: meta.grandTotal || 0,
    staff: meta.staff || defaults.staff,
    menu: meta.menu || {},
    sessions: {},
    activeByTable: {},
    receipts: [],
    voids: [],
    cashMoves: [],
    zReports: [],
  };
  for (const s of rows.sessions) {
    state.sessions[s.id] = {
      id: s.id, tableId: s.table_id, kind: s.kind, label: s.label, customer: s.customer, waiterId: s.waiter_id,
      status: s.status, mergedInto: s.merged_into, openedAt: ms(s.opened_at), closedAt: ms(s.closed_at),
      guests: [], orders: [], calls: [],
    };
    if (s.status === 'open') state.activeByTable[s.table_id] = s.id;
  }
  for (const g of [...rows.guests].sort(byTime('joined_at'))) {
    state.sessions[g.session_id]?.guests.push({ id: g.id, name: g.name, color: g.color, joinedAt: ms(g.joined_at), anonymized: g.anonymized });
  }
  const orders = new Map();
  for (const o of [...rows.orders].sort(byTime('created_at'))) {
    const order = { id: o.id, guestId: o.guest_id, at: ms(o.created_at), status: o.status, source: o.source, staffId: o.staff_id, lines: [] };
    orders.set(o.id, order);
    state.sessions[o.session_id]?.orders.push(order);
  }
  for (const l of [...rows.order_lines].sort((a, b) => a.position - b.position)) {
    orders.get(l.order_id)?.lines.push({
      id: l.id, guestId: l.guest_id, itemId: l.item_id, name: l.name, cat: l.category, station: l.station, qty: l.qty,
      unitPrice: l.unit_price, vat: l.vat_code, discountPct: l.discount_pct, note: l.note, voided: l.voided,
      voidReason: l.void_reason, ready: l.ready, receiptNo: l.receipt_no,
    });
  }
  for (const c of [...rows.calls].sort(byTime('created_at'))) {
    state.sessions[c.session_id]?.calls.push({ id: c.id, type: c.type, at: ms(c.created_at), ack: c.ack });
  }
  state.receipts = [...rows.receipts].sort((a, b) => a.no - b.no).map((r) => ({
    no: r.no, type: r.type, refNo: r.ref_no, reason: r.reason, at: ms(r.created_at), sessionId: r.session_id, tableId: r.table_id,
    guestIds: r.guest_ids, staffId: r.staff_id, payments: r.payments, change: r.change, tip: r.tip, cif: r.cif,
    lines: r.lines, gross: r.gross, discount: r.discount, total: r.total, vat: r.vat, zNo: r.z_no,
  }));
  state.voids = [...rows.voids].sort(byTime('created_at')).map((v) => ({
    at: ms(v.created_at), sessionId: v.session_id, tableId: v.table_id, lineId: v.line_id, name: v.name, qty: v.qty,
    total: v.total, reason: v.reason, staffId: v.staff_id, zNo: v.z_no,
  }));
  state.cashMoves = [...rows.cash_moves].sort(byTime('created_at')).map((m) => ({
    id: m.id, at: ms(m.created_at), type: m.type, amount: m.amount, reason: m.reason, staffId: m.staff_id, zNo: m.z_no,
  }));
  state.zReports = [...rows.z_reports].sort((a, b) => a.no - b.no).map((z) => z.report);
  return state;
}

// ---------- sync ----------

const SESSION_TABLES = ['sessions', 'guests', 'orders', 'order_lines', 'calls'];
const ALL_TABLES = ['pos_meta', ...SESSION_TABLES, 'receipts', 'voids', 'cash_moves', 'z_reports'];

class SupabaseSync {
  constructor(store, client, { delayMs = 300, log = console } = {}) {
    this.store = store;
    this.loc = store.loc.id;
    this.db = client;
    this.delayMs = delayMs;
    this.log = log;
    this.timer = null;
    this.running = Promise.resolve();
    this.lastError = null;
  }

  async registerLocation() {
    const l = this.store.loc;
    await this.upsert('locations', [{ id: l.id, name: `${l.name} ${l.tagline || ''}`.trim(), cui: l.cui, address: l.address }], 'id');
  }

  // Loads open sessions fully, plus everything needed for the current fiscal day (documents not yet in a Z)
  // and the Z history. Closed sessions from older days stay in the database only.
  async load(defaults) {
    const rows = {};
    for (const t of ALL_TABLES) rows[t] = await this.selectAll(t);
    this.store.state = stateFromRows(rows, defaults);
  }

  async selectAll(table) {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.db.from(table).select('*').eq('location_id', this.loc).range(from, from + page - 1);
      if (error) throw new Error(`Supabase ${table}: ${error.message}`);
      out.push(...data);
      if (data.length < page) return out;
    }
  }

  attach() {
    this.store.onChange = () => this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  // Writes are serialized so rows always land in order (parents before children).
  flush() {
    clearTimeout(this.timer);
    const dirty = this.store.takeDirty();
    this.running = this.running.then(() => this.write(dirty)).catch((err) => {
      this.lastError = err.message;
      this.log.error(`[supabase ${this.loc}] sincronizare eșuată, reîncerc:`, err.message);
      for (const k of Object.keys(dirty)) for (const id of dirty[k]) this.store.touch(k, id);
      setTimeout(() => this.schedule(), 5000);
    });
    return this.running;
  }

  async write(dirty) {
    const { state } = this.store;
    const loc = this.loc;
    const batch = Object.fromEntries(SESSION_TABLES.map((t) => [t, []]));
    for (const id of dirty.sessions) {
      const s = state.sessions[id];
      if (!s) continue;
      const rows = sessionRows(loc, s);
      for (const t of SESSION_TABLES) batch[t].push(...rows[t]);
    }
    for (const t of SESSION_TABLES) await this.upsert(t, batch[t], 'location_id,id');

    await this.upsert('receipts', state.receipts.filter((r) => dirty.receipts.has(r.no)).map((r) => receiptRow(loc, r)), 'location_id,no');
    await this.upsert('voids', state.voids.filter((v) => dirty.voids.has(v.lineId)).map((v) => voidRow(loc, v)), 'location_id,line_id');
    await this.upsert('cash_moves', state.cashMoves.filter((m) => dirty.cash.has(m.id)).map((m) => cashRow(loc, m)), 'location_id,id');
    await this.upsert('z_reports', state.zReports.filter((z) => dirty.z.has(z.no)).map((z) => zRow(loc, z)), 'location_id,no');

    const now = new Date().toISOString();
    await this.upsert('pos_meta', ['seq', 'grandTotal', 'staff', 'menu'].map((key) => ({ location_id: loc, key, value: state[key], updated_at: now })), 'location_id,key');
    this.lastError = null;
  }

  async upsert(table, rows, onConflict) {
    if (rows.length === 0) return;
    const { error } = await this.db.from(table).upsert(rows, { onConflict });
    if (error) throw new Error(`Supabase ${table}: ${error.message}`);
  }
}

module.exports = { SupabaseSync, sessionRows, receiptRow, voidRow, cashRow, zRow, stateFromRows, ALL_TABLES };
