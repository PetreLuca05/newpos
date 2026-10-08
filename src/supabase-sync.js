// Persists the in-memory Store to Supabase (Postgres). The Node server is the single writer;
// tables have RLS enabled with no policies, so only the secret (service_role) key can access them.

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const ms = (ts) => (ts ? new Date(ts).getTime() : null);

// ---------- state -> rows ----------

function sessionRows(session) {
  const rows = { sessions: [], guests: [], orders: [], order_lines: [], calls: [] };
  rows.sessions.push({
    id: session.id,
    table_id: session.tableId,
    status: session.status,
    opened_at: iso(session.openedAt),
    closed_at: iso(session.closedAt),
  });
  for (const g of session.guests) {
    rows.guests.push({ id: g.id, session_id: session.id, name: g.name, color: g.color, joined_at: iso(g.joinedAt), anonymized: !!g.anonymized });
  }
  for (const o of session.orders) {
    rows.orders.push({ id: o.id, session_id: session.id, guest_id: o.guestId, status: o.status, created_at: iso(o.at) });
    o.lines.forEach((l, position) => {
      rows.order_lines.push({
        id: l.id, order_id: o.id, item_id: l.itemId, name: l.name, category: l.cat, qty: l.qty,
        unit_price: l.unitPrice, vat_code: l.vat, note: l.note, voided: l.voided, receipt_no: l.receiptNo, position,
      });
    });
  }
  for (const c of session.calls) {
    rows.calls.push({ id: c.id, session_id: session.id, type: c.type, created_at: iso(c.at), ack: c.ack });
  }
  return rows;
}

const receiptRow = (r) => ({
  no: r.no, session_id: r.sessionId, table_id: r.tableId, method: r.method, cif: r.cif, total: r.total,
  vat: r.vat, lines: r.lines, guest_ids: r.guestIds, z_no: r.zNo, created_at: iso(r.at),
});

const voidRow = (v) => ({
  line_id: v.lineId, session_id: v.sessionId, table_id: v.tableId, name: v.name, qty: v.qty, total: v.total,
  z_no: v.zNo, created_at: iso(v.at),
});

const zRow = (z) => ({ no: z.no, generated_at: iso(z.generatedAt), total: z.total, report: z });

// ---------- rows -> state ----------

function stateFromRows({ meta, sessions, guests, orders, order_lines: lines, calls, receipts, voids, z_reports: zs }) {
  const metaMap = Object.fromEntries((meta || []).map((m) => [m.key, m.value]));
  const state = {
    seq: metaMap.seq || { session: 0, guest: 0, order: 0, line: 0, call: 0, receipt: 0, z: 0 },
    grandTotal: metaMap.grandTotal || 0,
    sessions: {},
    activeByTable: {},
    receipts: [],
    voids: [],
    zReports: [],
  };
  for (const s of sessions) {
    state.sessions[s.id] = {
      id: s.id, tableId: s.table_id, status: s.status, openedAt: ms(s.opened_at), closedAt: ms(s.closed_at),
      guests: [], orders: [], calls: [],
    };
    if (s.status === 'open') state.activeByTable[s.table_id] = s.id;
  }
  const byOrder = new Map();
  for (const g of [...guests].sort((a, b) => ms(a.joined_at) - ms(b.joined_at))) {
    state.sessions[g.session_id]?.guests.push({ id: g.id, name: g.name, color: g.color, joinedAt: ms(g.joined_at), anonymized: g.anonymized });
  }
  for (const o of [...orders].sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    const order = { id: o.id, guestId: o.guest_id, at: ms(o.created_at), status: o.status, lines: [] };
    byOrder.set(o.id, order);
    state.sessions[o.session_id]?.orders.push(order);
  }
  for (const l of [...lines].sort((a, b) => a.position - b.position)) {
    byOrder.get(l.order_id)?.lines.push({
      id: l.id, itemId: l.item_id, name: l.name, cat: l.category, qty: l.qty, unitPrice: l.unit_price,
      vat: l.vat_code, note: l.note, voided: l.voided, receiptNo: l.receipt_no,
    });
  }
  for (const c of [...calls].sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    state.sessions[c.session_id]?.calls.push({ id: c.id, type: c.type, at: ms(c.created_at), ack: c.ack });
  }
  state.receipts = [...receipts].sort((a, b) => a.no - b.no).map((r) => ({
    no: r.no, at: ms(r.created_at), sessionId: r.session_id, tableId: r.table_id, guestIds: r.guest_ids,
    method: r.method, cif: r.cif, lines: r.lines, total: r.total, vat: r.vat, zNo: r.z_no,
  }));
  state.voids = [...voids].sort((a, b) => ms(a.created_at) - ms(b.created_at)).map((v) => ({
    at: ms(v.created_at), sessionId: v.session_id, tableId: v.table_id, lineId: v.line_id, name: v.name,
    qty: v.qty, total: v.total, zNo: v.z_no,
  }));
  state.zReports = [...zs].sort((a, b) => a.no - b.no).map((z) => z.report);
  return state;
}

// ---------- sync ----------

const TABLE_ORDER = ['sessions', 'guests', 'orders', 'order_lines', 'calls'];

class SupabaseSync {
  constructor(store, client, { delayMs = 300, log = console } = {}) {
    this.store = store;
    this.db = client;
    this.delayMs = delayMs;
    this.log = log;
    this.timer = null;
    this.running = Promise.resolve();
    this.lastError = null;
  }

  async loadAll() {
    const names = ['pos_meta', 'sessions', 'guests', 'orders', 'order_lines', 'calls', 'receipts', 'voids', 'z_reports'];
    const results = await Promise.all(names.map((n) => this.selectAll(n)));
    const rows = Object.fromEntries(names.map((n, i) => [n === 'pos_meta' ? 'meta' : n, results[i]]));
    this.store.state = stateFromRows(rows);
  }

  async selectAll(table) {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.db.from(table).select('*').range(from, from + page - 1);
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
      this.log.error('[supabase] sincronizare eșuată, reîncerc:', err.message);
      // put back what failed so the next flush retries it
      for (const k of Object.keys(dirty)) for (const id of dirty[k]) this.store.touch(k, id);
      setTimeout(() => this.schedule(), 5000);
    });
    return this.running;
  }

  async write(dirty) {
    const { state } = this.store;
    const batch = { sessions: [], guests: [], orders: [], order_lines: [], calls: [] };
    for (const id of dirty.sessions) {
      const s = state.sessions[id];
      if (!s) continue;
      const rows = sessionRows(s);
      for (const t of TABLE_ORDER) batch[t].push(...rows[t]);
    }
    for (const t of TABLE_ORDER) await this.upsert(t, batch[t], 'id');

    const receipts = state.receipts.filter((r) => dirty.receipts.has(r.no)).map(receiptRow);
    await this.upsert('receipts', receipts, 'no');
    const voids = state.voids.filter((v) => dirty.voids.has(v.lineId)).map(voidRow);
    await this.upsert('voids', voids, 'line_id');
    const zs = state.zReports.filter((z) => dirty.z.has(z.no)).map(zRow);
    await this.upsert('z_reports', zs, 'no');

    await this.upsert('pos_meta', [
      { key: 'seq', value: state.seq, updated_at: new Date().toISOString() },
      { key: 'grandTotal', value: state.grandTotal, updated_at: new Date().toISOString() },
    ], 'key');
    this.lastError = null;
  }

  async upsert(table, rows, onConflict) {
    if (rows.length === 0) return;
    const { error } = await this.db.from(table).upsert(rows, { onConflict });
    if (error) throw new Error(`Supabase ${table}: ${error.message}`);
  }
}

module.exports = { SupabaseSync, sessionRows, receiptRow, voidRow, zRow, stateFromRows };
