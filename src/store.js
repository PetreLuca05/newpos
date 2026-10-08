// In-memory state for table sessions, orders, receipts and X/Z reports.
// Pure logic (no sockets) so it can be unit tested. Optionally persisted to a JSON file.

const fs = require('fs');
const path = require('path');
const { itemsById, tablesById, vatGroups, vatByCode, paymentMethods, categories } = require('./restaurant');

const GUEST_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8e6dd8', '#3a86ff', '#f4a261', '#43aa8b', '#ef476f'];
const ORDER_STATUSES = ['new', 'accepted', 'served', 'rejected'];
const MAX_LINES_PER_ORDER = 30;
const MAX_QTY = 20;

class PosError extends Error {}

function emptyState() {
  return {
    seq: { session: 0, guest: 0, order: 0, line: 0, call: 0, receipt: 0, z: 0 },
    sessions: {},
    activeByTable: {},
    receipts: [],
    voids: [],
    zReports: [],
    grandTotal: 0, // total cumulat (toate rapoartele Z)
  };
}

// Extracts VAT from a VAT-inclusive amount, rounded to the nearest ban.
function vatFromGross(gross, rate) {
  return Math.round((gross * rate) / (100 + rate));
}

function vatBreakdown(lines) {
  const groups = {};
  for (const l of lines) {
    groups[l.vat] = (groups[l.vat] || 0) + l.unitPrice * l.qty;
  }
  return vatGroups
    .filter((g) => groups[g.code])
    .map((g) => {
      const gross = groups[g.code];
      const vat = vatFromGross(gross, g.rate);
      return { code: g.code, rate: g.rate, gross, base: gross - vat, vat };
    });
}

class Store {
  constructor({ file } = {}) {
    this.file = file || null;
    this.state = emptyState();
    this._saveTimer = null;
    this.dirty = { sessions: new Set(), receipts: new Set(), voids: new Set(), z: new Set() };
    this.onChange = null; // set by the persistence layer (Supabase)
    if (this.file && fs.existsSync(this.file)) {
      try {
        this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (err) {
        console.warn(`Nu am putut citi ${this.file}, pornesc cu stare goală:`, err.message);
      }
    }
  }

  touch(kind, id) {
    this.dirty[kind].add(id);
  }

  // Takes and clears the set of changed entities (used by the Supabase sync).
  takeDirty() {
    const d = this.dirty;
    this.dirty = { sessions: new Set(), receipts: new Set(), voids: new Set(), z: new Set() };
    return d;
  }

  save() {
    if (this.onChange) this.onChange();
    if (!this.file) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this._saveTimer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  nextId(kind) {
    this.state.seq[kind] += 1;
    return this.state.seq[kind];
  }

  // ---------- sessions & guests ----------

  activeSession(tableId) {
    const id = this.state.activeByTable[tableId];
    return id ? this.state.sessions[id] : null;
  }

  getSession(sessionId) {
    const s = this.state.sessions[sessionId];
    if (!s) throw new PosError('Sesiunea nu există.');
    return s;
  }

  openSession(tableId) {
    if (!tablesById.has(tableId)) throw new PosError('Masă inexistentă.');
    const existing = this.activeSession(tableId);
    if (existing) return existing;
    const id = `S${this.nextId('session')}`;
    const session = {
      id,
      tableId,
      openedAt: Date.now(),
      closedAt: null,
      status: 'open',
      guests: [],
      orders: [],
      calls: [],
    };
    this.state.sessions[id] = session;
    this.state.activeByTable[tableId] = id;
    this.touch('sessions', id);
    this.save();
    return session;
  }

  // Joins (or re-joins) a guest to the table's active session, opening one if needed.
  joinTable(tableId, { guestId, name } = {}) {
    if (!tablesById.has(tableId)) throw new PosError('Masă inexistentă.');
    const current = this.activeSession(tableId);
    if (current && guestId) {
      const guest = current.guests.find((g) => g.id === guestId);
      if (guest) return { session: current, guest };
    }
    const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!clean) return { session: current, guest: null };
    const session = current || this.openSession(tableId);
    const guest = {
      id: `G${this.nextId('guest')}`,
      name: clean,
      color: GUEST_COLORS[session.guests.length % GUEST_COLORS.length],
      joinedAt: Date.now(),
    };
    session.guests.push(guest);
    this.touch('sessions', session.id);
    this.save();
    return { session, guest };
  }

  // ---------- orders ----------

  sendOrder(sessionId, guestId, items) {
    const session = this.getSession(sessionId);
    if (session.status !== 'open') throw new PosError('Masa a fost închisă.');
    if (!session.guests.some((g) => g.id === guestId)) throw new PosError('Client necunoscut la această masă.');
    if (!Array.isArray(items) || items.length === 0) throw new PosError('Comanda este goală.');
    if (items.length > MAX_LINES_PER_ORDER) throw new PosError('Prea multe produse într-o comandă.');

    const lines = items.map((raw) => {
      const item = itemsById.get(raw && raw.itemId);
      if (!item) throw new PosError('Produs inexistent în meniu.');
      const qty = Number.parseInt(raw.qty, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new PosError('Cantitate invalidă.');
      return {
        id: `L${this.nextId('line')}`,
        itemId: item.id,
        name: item.name,
        cat: item.cat,
        qty,
        unitPrice: item.price, // prețul vine mereu de pe server, nu de la client
        vat: item.vat,
        note: String(raw.note || '').trim().slice(0, 140),
        voided: false,
        receiptNo: null,
      };
    });

    const order = { id: `O${this.nextId('order')}`, guestId, at: Date.now(), status: 'new', lines };
    session.orders.push(order);
    this.touch('sessions', session.id);
    this.save();
    return order;
  }

  findOrder(orderId) {
    for (const s of Object.values(this.state.sessions)) {
      const o = s.orders.find((x) => x.id === orderId);
      if (o) return { session: s, order: o };
    }
    throw new PosError('Comanda nu există.');
  }

  setOrderStatus(orderId, status) {
    if (!ORDER_STATUSES.includes(status)) throw new PosError('Status invalid.');
    const { session, order } = this.findOrder(orderId);
    if (session.status !== 'open') throw new PosError('Masa a fost închisă.');
    if (status === 'rejected' && order.lines.some((l) => l.receiptNo)) {
      throw new PosError('Comanda are produse deja încasate.');
    }
    order.status = status;
    this.touch('sessions', session.id);
    this.save();
    return { session, order };
  }

  // Anulare produs (storno înainte de încasare). Apare în raportul Z la „Anulări”.
  voidLine(sessionId, lineId) {
    const session = this.getSession(sessionId);
    if (session.status !== 'open') throw new PosError('Masa a fost închisă.');
    for (const order of session.orders) {
      const line = order.lines.find((l) => l.id === lineId);
      if (!line) continue;
      if (line.receiptNo) throw new PosError('Produsul a fost deja încasat.');
      if (line.voided || order.status === 'rejected') throw new PosError('Produsul este deja anulat.');
      line.voided = true;
      this.state.voids.push({
        at: Date.now(),
        sessionId,
        tableId: session.tableId,
        lineId,
        name: line.name,
        qty: line.qty,
        total: line.qty * line.unitPrice,
        zNo: null,
      });
      this.touch('sessions', sessionId);
      this.touch('voids', lineId);
      this.save();
      return session;
    }
    throw new PosError('Produsul nu există.');
  }

  // ---------- calls (chemare ospătar / cerere notă) ----------

  call(sessionId, type) {
    if (!['waiter', 'bill'].includes(type)) throw new PosError('Tip invalid.');
    const session = this.getSession(sessionId);
    if (session.status !== 'open') throw new PosError('Masa a fost închisă.');
    const pending = session.calls.find((c) => c.type === type && !c.ack);
    if (pending) return { session, call: pending };
    const call = { id: `C${this.nextId('call')}`, type, at: Date.now(), ack: false };
    session.calls.push(call);
    this.touch('sessions', session.id);
    this.save();
    return { session, call };
  }

  ackCall(sessionId, callId) {
    const session = this.getSession(sessionId);
    const call = session.calls.find((c) => c.id === callId);
    if (!call) throw new PosError('Solicitarea nu există.');
    call.ack = true;
    this.touch('sessions', session.id);
    this.save();
    return session;
  }

  // ---------- bill & payments ----------

  billableLines(session) {
    const out = [];
    for (const order of session.orders) {
      if (order.status === 'rejected') continue;
      for (const line of order.lines) {
        if (!line.voided) out.push({ ...line, guestId: order.guestId, orderId: order.id, orderStatus: order.status });
      }
    }
    return out;
  }

  bill(session) {
    const lines = this.billableLines(session);
    const guests = session.guests.map((g) => {
      const own = lines.filter((l) => l.guestId === g.id);
      const total = own.reduce((s, l) => s + l.qty * l.unitPrice, 0);
      const paid = own.filter((l) => l.receiptNo).reduce((s, l) => s + l.qty * l.unitPrice, 0);
      return { guestId: g.id, name: g.name, color: g.color, lines: own, total, paid, unpaid: total - paid };
    });
    const total = guests.reduce((s, g) => s + g.total, 0);
    const paid = guests.reduce((s, g) => s + g.paid, 0);
    return { guests, total, paid, unpaid: total - paid, vat: vatBreakdown(lines) };
  }

  // Încasare: pentru un singur client (guestId) sau pentru tot restul mesei (guestId null).
  pay(sessionId, { guestId = null, method, cif = '' } = {}) {
    const session = this.getSession(sessionId);
    if (session.status !== 'open') throw new PosError('Masa a fost închisă.');
    if (!paymentMethods.some((m) => m.id === method)) throw new PosError('Metodă de plată invalidă.');
    const cleanCif = String(cif || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 14);
    if (cleanCif && !/^(RO)?\d{2,10}$/.test(cleanCif)) throw new PosError('CIF invalid.');

    const lines = this.billableLines(session).filter((l) => !l.receiptNo && (!guestId || l.guestId === guestId));
    if (lines.length === 0) throw new PosError('Nu există nimic de încasat.');

    const no = this.nextId('receipt');
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const order of session.orders) {
      for (const line of order.lines) if (byId.has(line.id)) line.receiptNo = no;
    }
    const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const receipt = {
      no,
      at: Date.now(),
      sessionId,
      tableId: session.tableId,
      guestIds: [...new Set(lines.map((l) => l.guestId))],
      method,
      cif: cleanCif,
      lines: lines.map(({ id, itemId, name, cat, qty, unitPrice, vat, guestId: g }) => ({
        id, itemId, name, cat, qty, unitPrice, vat, guestId: g, total: qty * unitPrice,
      })),
      total,
      vat: vatBreakdown(lines),
      zNo: null,
    };
    this.state.receipts.push(receipt);
    this.touch('sessions', sessionId);
    this.touch('receipts', no);
    this.save();
    return { session, receipt };
  }

  closeSession(sessionId) {
    const session = this.getSession(sessionId);
    if (session.status !== 'open') return session;
    const bill = this.bill(session);
    if (bill.unpaid > 0) throw new PosError('Masa are produse neîncasate. Încasați sau anulați-le înainte de închidere.');
    if (session.orders.some((o) => o.status === 'new' && o.lines.some((l) => !l.voided))) {
      throw new PosError('Masa are comenzi neconfirmate.');
    }
    session.status = 'closed';
    session.closedAt = Date.now();
    delete this.state.activeByTable[session.tableId];
    this.touch('sessions', session.id);
    this.save();
    return session;
  }

  // ---------- Raport X / Raport Z ----------

  // Construiește raportul pentru bonurile și anulările care nu au intrat încă într-un raport Z.
  buildReport() {
    const receipts = this.state.receipts.filter((r) => r.zNo === null);
    const voids = this.state.voids.filter((v) => v.zNo === null);
    const allLines = receipts.flatMap((r) => r.lines);

    const vat = vatGroups.map((g) => {
      const rows = receipts.flatMap((r) => r.vat.filter((v) => v.code === g.code));
      const gross = rows.reduce((s, v) => s + v.gross, 0);
      const tax = rows.reduce((s, v) => s + v.vat, 0);
      return { code: g.code, rate: g.rate, label: g.label, gross, base: gross - tax, vat: tax };
    });
    const payments = paymentMethods.map((m) => {
      const rs = receipts.filter((r) => r.method === m.id);
      return { id: m.id, name: m.name, count: rs.length, total: rs.reduce((s, r) => s + r.total, 0) };
    });
    const byCategory = categories
      .map((c) => {
        const ls = allLines.filter((l) => l.cat === c.id);
        return { id: c.id, name: c.name, qty: ls.reduce((s, l) => s + l.qty, 0), total: ls.reduce((s, l) => s + l.total, 0) };
      })
      .filter((c) => c.qty > 0);

    const total = receipts.reduce((s, r) => s + r.total, 0);
    const sessionIds = new Set(receipts.map((r) => r.sessionId));
    const covers = [...sessionIds].reduce((s, id) => s + (this.state.sessions[id]?.guests.length || 0), 0);
    const lastZ = this.state.zReports[this.state.zReports.length - 1];

    return {
      generatedAt: Date.now(),
      periodStart: lastZ ? lastZ.generatedAt : receipts[0]?.at || Date.now(),
      receiptCount: receipts.length,
      firstReceipt: receipts[0]?.no || null,
      lastReceipt: receipts[receipts.length - 1]?.no || null,
      receiptsWithCif: receipts.filter((r) => r.cif).length,
      vat,
      total,
      totalVat: vat.reduce((s, v) => s + v.vat, 0),
      payments,
      voids: { count: voids.length, total: voids.reduce((s, v) => s + v.total, 0) },
      byCategory,
      tables: sessionIds.size,
      covers,
      grandTotal: this.state.grandTotal + total,
      openTables: Object.keys(this.state.activeByTable).length,
    };
  }

  reportX() {
    return { type: 'X', ...this.buildReport() };
  }

  // Raportul Z închide ziua: numerotare consecutivă, marchează bonurile și actualizează totalul cumulat.
  // Se poate emite și cu valoare zero (păstrează consecutivitatea numerelor).
  reportZ() {
    const report = { type: 'Z', no: this.nextId('z'), ...this.buildReport() };
    for (const r of this.state.receipts) {
      if (r.zNo === null) {
        r.zNo = report.no;
        this.touch('receipts', r.no);
      }
    }
    for (const v of this.state.voids) {
      if (v.zNo === null) {
        v.zNo = report.no;
        this.touch('voids', v.lineId);
      }
    }
    this.state.grandTotal = report.grandTotal;
    this.state.zReports.push(report);
    this.touch('z', report.no);
    this.save();
    return report;
  }

  zReports() {
    return this.state.zReports.map(({ no, generatedAt, total, receiptCount }) => ({ no, generatedAt, total, receiptCount }));
  }

  getZReport(no) {
    const r = this.state.zReports.find((z) => z.no === no);
    if (!r) throw new PosError('Raportul Z nu există.');
    return r;
  }

  // ---------- GDPR ----------

  // Anonimizează numele clienților și notițele mai vechi de `days` zile (minimizarea datelor).
  // Bonurile (documente fiscale) nu conțin nume, doar ID-uri anonime.
  anonymizeOlderThan(days, now = Date.now()) {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const s of Object.values(this.state.sessions)) {
      if (s.status !== 'closed' || s.closedAt > cutoff) continue;
      count += this._anonymizeSession(s);
    }
    if (count) this.save();
    return count;
  }

  // Dreptul la ștergere: anonimizează un client anume.
  anonymizeGuest(sessionId, guestId) {
    const s = this.getSession(sessionId);
    const n = this._anonymizeSession(s, guestId);
    if (n) this.save();
    return n;
  }

  _anonymizeSession(s, onlyGuestId = null) {
    let count = 0;
    for (const g of s.guests) {
      if (onlyGuestId && g.id !== onlyGuestId) continue;
      if (g.anonymized) continue;
      g.name = `Client ${s.guests.indexOf(g) + 1}`;
      g.anonymized = true;
      count += 1;
      for (const o of s.orders) if (o.guestId === g.id) for (const l of o.lines) l.note = '';
    }
    if (count) this.touch('sessions', s.id);
    return count;
  }

  // ---------- views ----------

  sessionView(session) {
    const guestNames = new Map(session.guests.map((g) => [g.id, g]));
    return {
      id: session.id,
      tableId: session.tableId,
      tableName: tablesById.get(session.tableId).name,
      status: session.status,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      guests: session.guests,
      orders: session.orders.map((o) => ({
        ...o,
        guestName: guestNames.get(o.guestId)?.name || '?',
        guestColor: guestNames.get(o.guestId)?.color || '#999',
      })),
      calls: session.calls.filter((c) => !c.ack),
      bill: this.bill(session),
    };
  }

  posState() {
    const sessions = Object.values(this.state.activeByTable).map((id) => this.sessionView(this.state.sessions[id]));
    const today = this.buildReport();
    return {
      sessions,
      stats: {
        openTables: sessions.length,
        guests: sessions.reduce((s, x) => s + x.guests.length, 0),
        newOrders: sessions.reduce((s, x) => s + x.orders.filter((o) => o.status === 'new').length, 0),
        salesSinceZ: today.total,
        receiptsSinceZ: today.receiptCount,
        lastZ: this.state.zReports.length ? this.state.zReports[this.state.zReports.length - 1].no : null,
      },
    };
  }
}

module.exports = { Store, PosError, vatFromGross, vatBreakdown, vatByCode };
