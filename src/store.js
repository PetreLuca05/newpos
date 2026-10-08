// In-memory state: table sessions, guests, orders, payments, X/Z reports, staff and menu overrides.
// Pure logic (no sockets) so it can be unit tested. Persisted to Supabase (src/supabase-sync.js)
// or, without Supabase, to a local JSON file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GUEST_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8e6dd8', '#3a86ff', '#f4a261', '#43aa8b', '#ef476f'];
const ORDER_STATUSES = ['new', 'accepted', 'served', 'rejected'];
const ROLES = ['manager', 'waiter', 'kitchen'];
const BAR_CATEGORIES = new Set(['soft', 'coffee', 'beer', 'wine', 'cocktails']);
const MAX_LINES_PER_ORDER = 30;
const MAX_QTY = 20;
const DAY = 24 * 3600 * 1000;

class PosError extends Error {}

function hashPin(pin, salt = crypto.randomBytes(8).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}

function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

// Personal de test (PIN-urile se schimbă din ecranul Manager).
function defaultStaff() {
  return [
    { id: 'U1', name: 'Manager', role: 'manager', pin: '1234' },
    { id: 'U2', name: 'Ana', role: 'waiter', pin: '1111' },
    { id: 'U3', name: 'Mihai', role: 'waiter', pin: '2222' },
    { id: 'U4', name: 'Bucătărie', role: 'kitchen', pin: '3333' },
  ].map(({ pin, ...s }) => ({ ...s, active: true, pinHash: hashPin(pin) }));
}

function emptyState() {
  return {
    seq: { session: 0, guest: 0, order: 0, line: 0, call: 0, receipt: 0, z: 0, staff: 4, cash: 0 },
    sessions: {},
    activeByTable: {},
    receipts: [],
    voids: [],
    cashMoves: [],
    zReports: [],
    grandTotal: 0, // total cumulat (toate rapoartele Z)
    staff: defaultStaff(),
    menu: {}, // itemId -> { available, price }
  };
}

// Extracts VAT from a VAT-inclusive amount, rounded to the nearest ban.
function vatFromGross(gross, rate) {
  return Math.round((gross * rate) / (100 + rate));
}

function lineTotal(l) {
  return Math.round((l.unitPrice * l.qty * (100 - (l.discountPct || 0))) / 100);
}

function lineGross(l) {
  return l.unitPrice * l.qty;
}

function vatBreakdown(vatGroups, lines, sign = 1) {
  const groups = {};
  for (const l of lines) groups[l.vat] = (groups[l.vat] || 0) + lineTotal(l);
  return vatGroups
    .filter((g) => groups[g.code])
    .map((g) => {
      const gross = groups[g.code] * sign;
      const vat = vatFromGross(gross, g.rate);
      return { code: g.code, rate: g.rate, gross, base: gross - vat, vat };
    });
}

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

class Store {
  // location: prepared config from src/locations (menu, floor, VAT groups, payment methods)
  constructor({ location, file } = {}) {
    if (!location) throw new Error('Store needs a location');
    this.loc = location;
    this.file = file || null;
    this.state = emptyState();
    this._saveTimer = null;
    this.dirty = this.emptyDirty();
    this.onChange = null; // set by the persistence layer (Supabase)
    if (this.file && fs.existsSync(this.file)) {
      try {
        this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (err) {
        console.warn(`Nu am putut citi ${this.file}, pornesc cu stare goală:`, err.message);
      }
    }
  }

  // ---------- persistence ----------

  emptyDirty() {
    return { sessions: new Set(), receipts: new Set(), voids: new Set(), z: new Set(), cash: new Set() };
  }

  touch(kind, id) {
    this.dirty[kind].add(id);
  }

  // Takes and clears the set of changed entities (used by the Supabase sync).
  takeDirty() {
    const d = this.dirty;
    this.dirty = this.emptyDirty();
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
    this.state.seq[kind] = (this.state.seq[kind] || 0) + 1;
    return this.state.seq[kind];
  }

  // ---------- staff ----------

  login(pin) {
    const s = this.state.staff.find((u) => u.active && checkPin(pin, u.pinHash));
    if (!s) throw new PosError('PIN greșit.');
    return this.publicStaff(s);
  }

  publicStaff({ pinHash, ...s }) {
    return s;
  }

  getStaff(id) {
    const s = this.state.staff.find((u) => u.id === id);
    if (!s) throw new PosError('Utilizator inexistent.');
    return s;
  }

  staffList() {
    return this.state.staff.map((s) => this.publicStaff(s));
  }

  saveStaff({ id, name, role, pin, active = true }) {
    const cleanName = String(name || '').trim().slice(0, 30);
    if (!cleanName) throw new PosError('Numele este obligatoriu.');
    if (!ROLES.includes(role)) throw new PosError('Rol invalid.');
    if (pin !== undefined && pin !== '' && !/^\d{4,8}$/.test(String(pin))) throw new PosError('PIN-ul are 4–8 cifre.');
    if (pin && this.state.staff.some((u) => u.id !== id && checkPin(pin, u.pinHash))) throw new PosError('PIN folosit de alt utilizator.');
    let s = id ? this.getStaff(id) : null;
    if (!s) {
      if (!pin) throw new PosError('PIN obligatoriu pentru utilizator nou.');
      s = { id: `U${this.nextId('staff')}`, name: cleanName, role, active: true, pinHash: hashPin(pin) };
      this.state.staff.push(s);
    } else {
      if (s.role === 'manager' && (role !== 'manager' || !active) && this.state.staff.filter((u) => u.role === 'manager' && u.active).length === 1) {
        throw new PosError('Trebuie să rămână cel puțin un manager activ.');
      }
      Object.assign(s, { name: cleanName, role, active: !!active });
      if (pin) s.pinHash = hashPin(pin);
    }
    this.save();
    return this.publicStaff(s);
  }

  // ---------- menu (disponibilitate / prețuri) ----------

  menuItem(itemId) {
    const base = this.loc.itemsById.get(itemId);
    if (!base) return null;
    const o = this.state.menu[itemId] || {};
    return { ...base, price: o.price ?? base.price, available: o.available ?? true };
  }

  menuView() {
    return this.loc.items.map((i) => this.menuItem(i.id));
  }

  updateMenuItem(itemId, { available, price }) {
    if (!this.loc.itemsById.has(itemId)) throw new PosError('Produs inexistent.');
    const o = { ...(this.state.menu[itemId] || {}) };
    if (available !== undefined) o.available = !!available;
    if (price !== undefined) {
      const p = Math.round(Number(price));
      if (!Number.isInteger(p) || p < 0 || p > 10_000_000) throw new PosError('Preț invalid.');
      o.price = p;
    }
    this.state.menu[itemId] = o;
    this.save();
    return this.menuItem(itemId);
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

  openSessionOrThrow(sessionId) {
    const s = this.getSession(sessionId);
    if (s.status !== 'open') throw new PosError('Masa a fost închisă.');
    return s;
  }

  tableName(session) {
    return this.loc.tablesById.get(session.tableId)?.name || session.label || session.tableId;
  }

  // Comandă fără masă: la pachet sau livrare. customer = { name, phone, address } (date personale minime,
  // anonimizate automat după perioada de retenție).
  openVirtual(kind, customer = {}, waiterId = null) {
    if (!['takeaway', 'delivery'].includes(kind)) throw new PosError('Tip comandă invalid.');
    const name = String(customer.name || '').trim().slice(0, 40) || (kind === 'takeaway' ? 'Client pachet' : 'Client livrare');
    const phone = String(customer.phone || '').replace(/[^\d+ ]/g, '').slice(0, 20);
    const address = String(customer.address || '').trim().slice(0, 160);
    if (kind === 'delivery' && !address) throw new PosError('Adresa de livrare este obligatorie.');
    const n = this.nextId('session');
    const id = `S${n}`;
    const tableId = `${kind === 'takeaway' ? 'P' : 'D'}${n}`;
    const session = {
      id, tableId, kind, label: `${kind === 'takeaway' ? 'Pachet' : 'Livrare'} #${n} · ${name}`,
      customer: { name, phone, address }, waiterId, openedAt: Date.now(), closedAt: null, status: 'open',
      mergedInto: null, guests: [], orders: [], calls: [],
    };
    this.state.sessions[id] = session;
    this.state.activeByTable[tableId] = id;
    this.touch('sessions', id);
    this.addGuest(session, name);
    return session;
  }

  openSession(tableId, waiterId = null) {
    if (!this.loc.tablesById.has(tableId)) throw new PosError('Masă inexistentă.');
    const existing = this.activeSession(tableId);
    if (existing) return existing;
    const id = `S${this.nextId('session')}`;
    const session = {
      id,
      tableId,
      kind: 'table',
      label: null,
      customer: null,
      waiterId,
      openedAt: Date.now(),
      closedAt: null,
      status: 'open',
      mergedInto: null,
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

  addGuest(session, name) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!clean) throw new PosError('Numele este obligatoriu.');
    const guest = {
      id: `G${this.nextId('guest')}`,
      name: clean,
      color: GUEST_COLORS[session.guests.length % GUEST_COLORS.length],
      joinedAt: Date.now(),
      anonymized: false,
    };
    session.guests.push(guest);
    this.touch('sessions', session.id);
    this.save();
    return guest;
  }

  // Joins (or re-joins) a guest to the table's active session, opening one if needed.
  joinTable(tableId, { guestId, name } = {}) {
    if (!this.loc.tablesById.has(tableId)) throw new PosError('Masă inexistentă.');
    const current = this.activeSession(tableId);
    if (current && guestId) {
      const guest = current.guests.find((g) => g.id === guestId);
      if (guest) return { session: current, guest };
    }
    if (!String(name || '').trim()) return { session: current, guest: null };
    const session = current || this.openSession(tableId);
    return { session, guest: this.addGuest(session, name) };
  }

  assignWaiter(sessionId, staffId) {
    const s = this.openSessionOrThrow(sessionId);
    if (staffId) this.getStaff(staffId);
    s.waiterId = staffId || null;
    this.touch('sessions', s.id);
    this.save();
    return s;
  }

  // Mutare masă: întreaga sesiune trece pe o masă liberă.
  transferSession(sessionId, toTableId) {
    const s = this.openSessionOrThrow(sessionId);
    if (!this.loc.tablesById.has(toTableId)) throw new PosError('Masă inexistentă.');
    if (s.kind !== 'table') throw new PosError('Doar comenzile la masă se pot muta.');
    if (this.activeSession(toTableId)) throw new PosError('Masa destinație este ocupată. Folosiți „Unește mese”.');
    delete this.state.activeByTable[s.tableId];
    s.tableId = toTableId;
    this.state.activeByTable[toTableId] = s.id;
    this.touch('sessions', s.id);
    this.save();
    return s;
  }

  // Unire mese: clienții, comenzile și solicitările trec pe sesiunea destinație.
  mergeSessions(fromId, intoId) {
    if (fromId === intoId) throw new PosError('Alegeți altă masă.');
    const from = this.openSessionOrThrow(fromId);
    const into = this.openSessionOrThrow(intoId);
    into.guests.push(...from.guests);
    into.orders.push(...from.orders);
    into.calls.push(...from.calls);
    from.guests = [];
    from.orders = [];
    from.calls = [];
    from.status = 'closed';
    from.mergedInto = into.id;
    from.closedAt = Date.now();
    delete this.state.activeByTable[from.tableId];
    // payments already made on `from` keep pointing to it; re-point so the bill stays consistent
    for (const r of this.state.receipts) {
      if (r.sessionId === from.id) {
        r.sessionId = into.id;
        this.touch('receipts', r.no);
      }
    }
    this.touch('sessions', from.id);
    this.touch('sessions', into.id);
    this.save();
    return into;
  }

  // ---------- orders ----------

  // source: 'guest' (QR) or 'pos' (introdus de ospătar, confirmat automat)
  sendOrder(sessionId, guestId, orderItems, { source = 'guest', staffId = null } = {}) {
    const session = this.openSessionOrThrow(sessionId);
    if (!session.guests.some((g) => g.id === guestId)) throw new PosError('Client necunoscut la această masă.');
    if (!Array.isArray(orderItems) || orderItems.length === 0) throw new PosError('Comanda este goală.');
    if (orderItems.length > MAX_LINES_PER_ORDER) throw new PosError('Prea multe produse într-o comandă.');

    const lines = orderItems.map((raw) => {
      const item = this.menuItem(raw && raw.itemId);
      if (!item) throw new PosError('Produs inexistent în meniu.');
      if (!item.available) throw new PosError(`„${item.name}” nu mai este disponibil.`);
      const qty = Number.parseInt(raw.qty, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new PosError('Cantitate invalidă.');
      return {
        id: `L${this.nextId('line')}`,
        guestId,
        itemId: item.id,
        name: item.name,
        cat: item.cat,
        station: BAR_CATEGORIES.has(item.cat) ? 'bar' : 'kitchen',
        qty,
        unitPrice: item.price, // prețul vine mereu de pe server, nu de la client
        vat: item.vat,
        discountPct: 0,
        note: String(raw.note || '').trim().slice(0, 140),
        voided: false,
        voidReason: '',
        ready: false,
        receiptNo: null,
      };
    });

    const order = {
      id: `O${this.nextId('order')}`,
      guestId,
      at: Date.now(),
      status: source === 'pos' ? 'accepted' : 'new',
      source,
      staffId,
      lines,
    };
    session.orders.push(order);
    if (staffId && !session.waiterId) session.waiterId = staffId;
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

  findLine(session, lineId) {
    for (const order of session.orders) {
      const line = order.lines.find((l) => l.id === lineId);
      if (line) return { order, line };
    }
    throw new PosError('Produsul nu există.');
  }

  setOrderStatus(orderId, status, staffId = null) {
    if (!ORDER_STATUSES.includes(status)) throw new PosError('Status invalid.');
    const { session, order } = this.findOrder(orderId);
    if (session.status !== 'open') throw new PosError('Masa a fost închisă.');
    if (status === 'rejected' && order.lines.some((l) => l.receiptNo)) {
      throw new PosError('Comanda are produse deja încasate.');
    }
    order.status = status;
    if (status === 'served') for (const l of order.lines) l.ready = true;
    if (staffId && !session.waiterId && status === 'accepted') session.waiterId = staffId;
    this.touch('sessions', session.id);
    this.save();
    return { session, order };
  }

  // KDS: bucătăria / barul marchează produsele unei comenzi ca fiind gata.
  markReady(orderId, station) {
    const { session, order } = this.findOrder(orderId);
    for (const l of order.lines) if (l.station === station) l.ready = true;
    this.touch('sessions', session.id);
    this.save();
    return { session, order };
  }

  // Anulare produs (înainte de încasare). Apare în raportul Z la „Anulări”.
  voidLine(sessionId, lineId, { reason = '', staffId = null } = {}) {
    const session = this.openSessionOrThrow(sessionId);
    const { order, line } = this.findLine(session, lineId);
    if (line.receiptNo) throw new PosError('Produsul a fost deja încasat.');
    if (line.voided || order.status === 'rejected') throw new PosError('Produsul este deja anulat.');
    line.voided = true;
    line.voidReason = String(reason).trim().slice(0, 100);
    this.state.voids.push({
      at: Date.now(),
      sessionId,
      tableId: session.tableId,
      lineId,
      name: line.name,
      qty: line.qty,
      total: lineTotal(line),
      reason: line.voidReason,
      staffId,
      zNo: null,
    });
    this.touch('sessions', sessionId);
    this.touch('voids', lineId);
    this.save();
    return session;
  }

  // Reducere procentuală pe un produs (doar manager).
  discountLine(sessionId, lineId, pct) {
    const session = this.openSessionOrThrow(sessionId);
    const { line } = this.findLine(session, lineId);
    if (line.receiptNo) throw new PosError('Produsul a fost deja încasat.');
    const p = Number(pct);
    if (!Number.isInteger(p) || p < 0 || p > 100) throw new PosError('Reducerea trebuie să fie între 0 și 100%.');
    line.discountPct = p;
    this.touch('sessions', sessionId);
    this.save();
    return session;
  }

  // Reducere pe toată masa (toate produsele neîncasate).
  discountSession(sessionId, pct) {
    const session = this.openSessionOrThrow(sessionId);
    for (const l of this.billableLines(session)) if (!l.receiptNo) this.discountLine(sessionId, l.id, pct);
    return session;
  }

  // Mută un produs pe alt client al aceleiași mese (pentru nota separată).
  moveLine(sessionId, lineId, toGuestId) {
    const session = this.openSessionOrThrow(sessionId);
    const { line } = this.findLine(session, lineId);
    if (line.receiptNo) throw new PosError('Produsul a fost deja încasat.');
    if (!session.guests.some((g) => g.id === toGuestId)) throw new PosError('Client inexistent.');
    line.guestId = toGuestId;
    this.touch('sessions', sessionId);
    this.save();
    return session;
  }

  // ---------- calls (chemare ospătar / cerere notă) ----------

  call(sessionId, type) {
    if (!['waiter', 'bill'].includes(type)) throw new PosError('Tip invalid.');
    const session = this.openSessionOrThrow(sessionId);
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
        if (!line.voided) out.push({ ...line, orderId: order.id, orderStatus: order.status, total: lineTotal(line) });
      }
    }
    return out;
  }

  bill(session) {
    const lines = this.billableLines(session);
    const guests = session.guests.map((g) => {
      const own = lines.filter((l) => l.guestId === g.id);
      const total = sum(own, (l) => l.total);
      const paid = sum(own.filter((l) => l.receiptNo), (l) => l.total);
      return { guestId: g.id, name: g.name, color: g.color, lines: own, total, paid, unpaid: total - paid };
    });
    const total = sum(guests, (g) => g.total);
    const paid = sum(guests, (g) => g.paid);
    const discount = sum(lines, (l) => lineGross(l) - l.total);
    return { guests, total, paid, unpaid: total - paid, discount, vat: vatBreakdown(this.loc.vatGroups, lines) };
  }

  // Încasare. Selecția produselor: lineIds (pe produse), guestId (per client) sau toată masa.
  // payments: [{ method, amount }] — plată mixtă permisă. Restul (la numerar) se calculează automat.
  // tip: bacșiș (nu intră în baza de TVA, apare separat în raport).
  pay(sessionId, { guestId = null, lineIds = null, payments, tip = 0, cif = '', staffId = null } = {}) {
    const session = this.openSessionOrThrow(sessionId);
    const cleanCif = String(cif || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 14);
    if (cleanCif && !/^(RO)?\d{2,10}$/.test(cleanCif)) throw new PosError('CIF invalid.');

    let lines = this.billableLines(session).filter((l) => !l.receiptNo);
    if (Array.isArray(lineIds) && lineIds.length) lines = lines.filter((l) => lineIds.includes(l.id));
    else if (guestId) lines = lines.filter((l) => l.guestId === guestId);
    if (lines.length === 0) throw new PosError('Nu există nimic de încasat.');

    const total = sum(lines, (l) => l.total);
    const tipAmount = Math.round(Number(tip) || 0);
    if (tipAmount < 0) throw new PosError('Bacșiș invalid.');
    if (!Array.isArray(payments) || payments.length === 0) throw new PosError('Alegeți metoda de plată.');
    const cleanPayments = payments.map((p) => {
      if (!this.loc.paymentMethods.some((m) => m.id === p.method)) throw new PosError('Metodă de plată invalidă.');
      const amount = Math.round(Number(p.amount));
      if (!Number.isInteger(amount) || amount <= 0) throw new PosError('Sumă invalidă.');
      const out = { method: p.method, amount };
      if (p.method === 'eur') {
        const rate = Number(p.rate);
        if (!(rate > 0)) throw new PosError('Curs EUR lipsă.');
        out.rate = rate;
        out.foreign = Math.round(amount / rate); // eurocenți
      }
      if (p.method === 'gift' || p.method === 'account' || p.method === 'transfer') out.ref = String(p.ref || '').slice(0, 40);
      return out;
    });
    const paidAmount = sum(cleanPayments, (p) => p.amount);
    const due = total + tipAmount;
    if (paidAmount < due) throw new PosError('Suma încasată este mai mică decât totalul.');
    const cashGiven = sum(cleanPayments.filter((p) => this.loc.paymentMethods.find((m) => m.id === p.method)?.change), (p) => p.amount);
    const change = paidAmount - due;
    if (change > cashGiven) throw new PosError('Restul se poate da doar din numerar.');
    // Plățile se înregistrează net (fără rest); suma primită rămâne în `tendered`.
    let remaining = change;
    for (const pmt of [...cleanPayments].reverse()) {
      if (!remaining || !this.loc.paymentMethods.find((m) => m.id === pmt.method)?.change) continue;
      const take = Math.min(remaining, pmt.amount - 1);
      pmt.tendered = pmt.amount;
      pmt.amount -= take;
      if (pmt.foreign) pmt.foreign = Math.round(pmt.amount / pmt.rate);
      remaining -= take;
    }
    if (remaining) throw new PosError('Restul nu poate depăși suma în numerar.');

    const no = this.nextId('receipt');
    const ids = new Set(lines.map((l) => l.id));
    for (const order of session.orders) for (const line of order.lines) if (ids.has(line.id)) line.receiptNo = no;

    const receipt = {
      no,
      type: 'sale',
      refNo: null,
      reason: '',
      at: Date.now(),
      sessionId,
      tableId: session.tableId,
      guestIds: [...new Set(lines.map((l) => l.guestId))],
      staffId: staffId || session.waiterId || null,
      payments: cleanPayments,
      change,
      tip: tipAmount,
      cif: cleanCif,
      lines: lines.map((l) => ({
        id: l.id, itemId: l.itemId, name: l.name, cat: l.cat, qty: l.qty, unitPrice: l.unitPrice,
        vat: l.vat, discountPct: l.discountPct, guestId: l.guestId, total: l.total,
      })),
      gross: sum(lines, lineGross),
      discount: sum(lines, (l) => lineGross(l) - l.total),
      total,
      vat: vatBreakdown(this.loc.vatGroups, lines),
      zNo: null,
    };
    this.state.receipts.push(receipt);
    this.touch('sessions', sessionId);
    this.touch('receipts', no);
    this.save();
    return { session, receipt };
  }

  getReceipt(no) {
    const r = this.state.receipts.find((x) => x.no === Number(no));
    if (!r) throw new PosError('Bonul nu există.');
    return r;
  }

  // Stornare bon (retur): document negativ care face referire la bonul inițial. Doar manager.
  refundReceipt(no, { staffId = null, reason = '' } = {}) {
    const orig = this.getReceipt(no);
    if (orig.type !== 'sale') throw new PosError('Doar bonurile de vânzare pot fi stornate.');
    if (this.state.receipts.some((r) => r.refNo === orig.no)) throw new PosError('Bonul a fost deja stornat.');
    const n = this.nextId('receipt');
    const refund = {
      ...orig,
      no: n,
      type: 'refund',
      refNo: orig.no,
      reason: String(reason).trim().slice(0, 100),
      at: Date.now(),
      staffId,
      payments: orig.payments.map((p) => ({ ...p, amount: -p.amount })),
      change: -orig.change,
      tip: -orig.tip,
      lines: orig.lines.map((l) => ({ ...l, qty: -l.qty, total: -l.total })),
      gross: -orig.gross,
      discount: -orig.discount,
      total: -orig.total,
      vat: orig.vat.map((v) => ({ ...v, gross: -v.gross, base: -v.base, vat: -v.vat })),
      zNo: null,
    };
    this.state.receipts.push(refund);
    this.touch('receipts', n);
    this.save();
    return refund;
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

  // ---------- numerar: intrări / ieșiri (sold inițial, depuneri, plăți din casă) ----------

  cashMove({ type, amount, reason = '', staffId = null }) {
    if (!['in', 'out'].includes(type)) throw new PosError('Tip invalid.');
    const a = Math.round(Number(amount));
    if (!Number.isInteger(a) || a <= 0) throw new PosError('Sumă invalidă.');
    const move = { id: `M${this.nextId('cash')}`, at: Date.now(), type, amount: a, reason: String(reason).trim().slice(0, 100), staffId, zNo: null };
    this.state.cashMoves.push(move);
    this.touch('cash', move.id);
    this.save();
    return move;
  }

  // ---------- Raport X / Raport Z ----------

  staffName(id) {
    return this.state.staff.find((s) => s.id === id)?.name || '—';
  }

  // Aggregates a list of receipts (used by X/Z and by the sales report).
  aggregate(receipts) {
    const sales = receipts.filter((r) => r.type !== 'refund');
    const refunds = receipts.filter((r) => r.type === 'refund');
    const allLines = receipts.flatMap((r) => r.lines);

    const vat = this.loc.vatGroups.map((g) => {
      const rows = receipts.flatMap((r) => r.vat.filter((v) => v.code === g.code));
      const gross = sum(rows, (v) => v.gross);
      const tax = sum(rows, (v) => v.vat);
      return { code: g.code, rate: g.rate, label: g.label, gross, base: gross - tax, vat: tax };
    });
    const payments = this.loc.paymentMethods.map((m) => {
      const ps = receipts.flatMap((r) => r.payments.filter((p) => p.method === m.id));
      return { id: m.id, name: m.name, count: ps.length, total: sum(ps, (p) => p.amount) };
    });
    const byCategory = this.loc.categories
      .map((c) => {
        const ls = allLines.filter((l) => l.cat === c.id);
        return { id: c.id, name: c.name, qty: sum(ls, (l) => l.qty), total: sum(ls, (l) => l.total) };
      })
      .filter((c) => c.qty !== 0);
    const products = new Map();
    for (const l of allLines) {
      const p = products.get(l.itemId) || { itemId: l.itemId, name: l.name, qty: 0, total: 0 };
      p.qty += l.qty;
      p.total += l.total;
      products.set(l.itemId, p);
    }
    const staff = new Map();
    for (const r of receipts) {
      const id = r.staffId || '-';
      const s = staff.get(id) || { staffId: id, name: this.staffName(r.staffId), receipts: 0, total: 0, tips: 0 };
      s.receipts += r.type === 'refund' ? 0 : 1;
      s.total += r.total;
      s.tips += r.tip;
      staff.set(id, s);
    }
    const hours = new Map();
    for (const r of receipts) {
      const h = Number(new Intl.DateTimeFormat('ro-RO', { hour: 'numeric', hour12: false, timeZone: this.loc.timeZone }).format(r.at));
      hours.set(h, (hours.get(h) || 0) + r.total);
    }

    const total = sum(receipts, (r) => r.total);
    const sessionIds = new Set(sales.map((r) => r.sessionId));
    const covers = sum([...sessionIds], (id) => this.state.sessions[id]?.guests.length || 0);
    return {
      receiptCount: sales.length,
      firstReceipt: receipts[0]?.no || null,
      lastReceipt: receipts[receipts.length - 1]?.no || null,
      receiptsWithCif: sales.filter((r) => r.cif).length,
      gross: sum(sales, (r) => r.gross),
      discounts: sum(sales, (r) => r.discount),
      refunds: { count: refunds.length, total: sum(refunds, (r) => r.total) },
      vat,
      total,
      totalVat: sum(vat, (v) => v.vat),
      payments,
      change: sum(receipts, (r) => r.change),
      tips: sum(receipts, (r) => r.tip),
      byCategory,
      topProducts: [...products.values()].sort((a, b) => b.total - a.total),
      byStaff: [...staff.values()].sort((a, b) => b.total - a.total),
      byHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, t]) => ({ hour, total: t })),
      tables: sessionIds.size,
      covers,
      averagePerCover: covers ? Math.round(total / covers) : 0,
    };
  }

  // Raport pentru bonurile, anulările și mișcările de numerar care nu au intrat încă într-un raport Z.
  buildReport() {
    const receipts = this.state.receipts.filter((r) => r.zNo === null);
    const voids = this.state.voids.filter((v) => v.zNo === null);
    const moves = this.state.cashMoves.filter((m) => m.zNo === null);
    const agg = this.aggregate(receipts);
    const lastZ = this.state.zReports[this.state.zReports.length - 1];
    const cashIn = sum(moves.filter((m) => m.type === 'in'), (m) => m.amount);
    const cashOut = sum(moves.filter((m) => m.type === 'out'), (m) => m.amount);
    const cashSales = agg.payments.find((p) => p.id === 'cash')?.total || 0;
    const eurForeign = sum(receipts.flatMap((r) => r.payments.filter((p) => p.method === 'eur')), (p) => p.foreign || 0);
    return {
      generatedAt: Date.now(),
      periodStart: lastZ ? lastZ.generatedAt : receipts[0]?.at || Date.now(),
      ...agg,
      voids: { count: voids.length, total: sum(voids, (v) => v.total) },
      cash: { in: cashIn, out: cashOut, sales: cashSales, change: agg.change, drawer: cashIn - cashOut + cashSales, eurCents: eurForeign },
      grandTotal: this.state.grandTotal + agg.total,
      openTables: Object.keys(this.state.activeByTable).length,
      unpaidOpen: sum(Object.values(this.state.activeByTable), (id) => this.bill(this.state.sessions[id]).unpaid),
    };
  }

  reportX() {
    return { type: 'X', ...this.buildReport() };
  }

  // Raportul Z închide ziua fiscală: numerotare consecutivă, marchează documentele și actualizează
  // totalul cumulat. Se poate emite și cu valoare zero (păstrează consecutivitatea numerelor).
  reportZ({ staffId = null, force = false } = {}) {
    const open = Object.keys(this.state.activeByTable).length;
    if (open && !force) throw new PosError(`Există ${open} mese deschise. Închideți-le sau confirmați emiterea raportului Z.`);
    const report = { type: 'Z', no: this.nextId('z'), staffId, staffName: this.staffName(staffId), ...this.buildReport() };
    for (const r of this.state.receipts) if (r.zNo === null) { r.zNo = report.no; this.touch('receipts', r.no); }
    for (const v of this.state.voids) if (v.zNo === null) { v.zNo = report.no; this.touch('voids', v.lineId); }
    for (const m of this.state.cashMoves) if (m.zNo === null) { m.zNo = report.no; this.touch('cash', m.id); }
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
    const r = this.state.zReports.find((z) => z.no === Number(no));
    if (!r) throw new PosError('Raportul Z nu există.');
    return r;
  }

  // Raport de vânzări pe un interval (ms), indiferent de rapoartele Z.
  salesReport(from, to) {
    const receipts = this.state.receipts.filter((r) => r.at >= from && r.at < to);
    return { from, to, ...this.aggregate(receipts) };
  }

  receiptsBetween(from, to) {
    return this.state.receipts.filter((r) => r.at >= from && r.at < to);
  }

  // ---------- GDPR ----------

  // Anonimizează numele clienților și notițele mai vechi de `days` zile (minimizarea datelor).
  // Bonurile (documente fiscale) nu conțin nume, doar ID-uri anonime.
  anonymizeOlderThan(days, now = Date.now()) {
    const cutoff = now - days * DAY;
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
    s.guests.forEach((g, i) => {
      if ((onlyGuestId && g.id !== onlyGuestId) || g.anonymized) return;
      g.name = `Client ${i + 1}`;
      g.anonymized = true;
      count += 1;
      for (const o of s.orders) for (const l of o.lines) if (l.guestId === g.id) l.note = '';
    });
    if (!onlyGuestId && s.customer && !s.customer.anonymized) {
      s.customer = { name: 'Anonim', phone: '', address: '', anonymized: true };
      if (s.label) s.label = s.label.replace(/ · .*$/, '');
      count += 1;
    }
    if (count) this.touch('sessions', s.id);
    return count;
  }

  // ---------- views ----------

  sessionView(session) {
    const guests = new Map(session.guests.map((g) => [g.id, g]));
    return {
      id: session.id,
      tableId: session.tableId,
      tableName: this.tableName(session),
      kind: session.kind || 'table',
      customer: session.customer || null,
      status: session.status,
      mergedInto: session.mergedInto,
      waiterId: session.waiterId,
      waiterName: session.waiterId ? this.staffName(session.waiterId) : null,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      guests: session.guests,
      orders: session.orders.map((o) => ({
        ...o,
        guestName: guests.get(o.guestId)?.name || '?',
        guestColor: guests.get(o.guestId)?.color || '#999',
        lines: o.lines.map((l) => ({ ...l, total: lineTotal(l), guestName: guests.get(l.guestId)?.name || '?' })),
      })),
      calls: session.calls.filter((c) => !c.ack),
      bill: this.bill(session),
      receipts: this.state.receipts.filter((r) => r.sessionId === session.id).map((r) => r.no),
    };
  }

  // Guests don't need staff ids or receipt details.
  guestView(session) {
    const v = this.sessionView(session);
    delete v.waiterId;
    delete v.receipts;
    return v;
  }

  posState() {
    const sessions = Object.values(this.state.activeByTable).map((id) => this.sessionView(this.state.sessions[id]));
    const today = this.buildReport();
    return {
      sessions,
      stats: {
        openTables: sessions.length,
        guests: sum(sessions, (x) => x.guests.length),
        newOrders: sum(sessions, (x) => x.orders.filter((o) => o.status === 'new').length),
        salesSinceZ: today.total,
        receiptsSinceZ: today.receiptCount,
        lastZ: this.state.zReports.length ? this.state.zReports[this.state.zReports.length - 1].no : null,
      },
    };
  }

  // Kitchen / bar display: accepted orders with lines not yet ready for that station.
  kdsView(station) {
    const out = [];
    for (const id of Object.values(this.state.activeByTable)) {
      const s = this.state.sessions[id];
      for (const o of s.orders) {
        if (o.status !== 'accepted') continue;
        const lines = o.lines.filter((l) => l.station === station && !l.voided && !l.ready);
        if (lines.length) {
          out.push({ orderId: o.id, at: o.at, tableId: s.tableId, tableName: this.tableName(s), lines });
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }
}

module.exports = { Store, emptyState, PosError, vatFromGross, vatBreakdown, lineTotal, hashPin, checkPin, ROLES };
