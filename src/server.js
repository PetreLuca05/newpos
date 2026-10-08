// newpos — server POS cu comandă de la masă prin QR, multi-locație.
//
// Pagini (per locație):  /l/<loc>/pos   – POS (plan de sală, comenzi, încasare, rapoarte)
//                        /l/<loc>/kds   – ecran bucătărie / bar
//                        /l/<loc>/qr    – coduri QR pentru mese (de printat)
//                        /l/<loc>/t/<masă>?k=<cod> – pagina clientului (deschisă din QR)

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { loadLocations } = require('./locations');
const { Store, emptyState, PosError } = require('./store');
const { Devices } = require('./devices');
const { LegalSync, AnafClient, isValidCui } = require('./legal');
const { vatGroups } = require('./ro');

const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.POS_SECRET || 'dev-secret-schimbati-in-productie';
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 30;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_HOURS = 12;

if (!process.env.POS_SECRET) console.warn('[securitate] Setați POS_SECRET în producție (codurile QR depind de el).');

// ---------- helpers ----------

const tableKey = (loc, table) => crypto.createHmac('sha256', SECRET).update(`${loc}:${table}`).digest('base64url').slice(0, 12);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- locations ----------

async function createContexts({ supabase, log = console } = {}) {
  const contexts = new Map();
  for (const loc of loadLocations()) {
    const store = new Store({ location: loc, file: supabase ? null : path.join(DATA_DIR, `${loc.id}.json`) });
    let sync = null;
    if (supabase) {
      const { SupabaseSync } = require('./supabase-sync');
      sync = new SupabaseSync(store, supabase, { log });
      await sync.registerLocation();
      await sync.load(emptyState());
      sync.attach();
    }
    const devices = new Devices(loc.devices, log);
    contexts.set(loc.id, { loc, store, sync, devices });
  }
  return contexts;
}

// ---------- app ----------

function createApp(contexts, { legal = null, anaf = new AnafClient() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 100_000 });
  const tokens = new Map(); // token -> { loc, staffId, exp }

  const page = (file) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', file));
  const ctxOf = (id) => {
    const c = contexts.get(id);
    if (!c) throw new PosError('Locație inexistentă.');
    return c;
  };

  function issueToken(loc, staff) {
    const token = crypto.randomBytes(24).toString('base64url');
    tokens.set(token, { loc, staffId: staff.id, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
    return token;
  }

  function staffFromToken(loc, token) {
    const t = tokens.get(String(token || ''));
    if (!t || t.loc !== loc || t.exp < Date.now()) return null;
    const ctx = contexts.get(loc);
    const s = ctx?.store.state.staff.find((u) => u.id === t.staffId && u.active);
    return s ? ctx.store.publicStaff(s) : null;
  }

  function requireStaffHttp(roles) {
    return (req, res, next) => {
      const staff = staffFromToken(req.params.loc, req.get('x-auth') || req.query.auth);
      if (!staff || (roles && !roles.includes(staff.role))) return res.status(401).json({ error: 'Neautorizat' });
      req.staff = staff;
      next();
    };
  }

  // ---------- broadcast ----------

  const room = {
    session: (loc, id) => `${loc}:session:${id}`,
    pos: (loc) => `${loc}:pos`,
    kds: (loc, station) => `${loc}:kds:${station}`,
  };

  function publicConfig(ctx) {
    const { loc, store } = ctx;
    return {
      id: loc.id,
      name: loc.name,
      tagline: loc.tagline,
      company: loc.company,
      cui: loc.cui,
      regCom: loc.regCom,
      address: loc.address,
      phone: loc.phone,
      currencySymbol: loc.currencySymbol,
      floor: loc.floor,
      categories: loc.categories,
      items: store.menuView(),
      vatGroups: loc.vatGroups,
      paymentMethods: loc.paymentMethods,
      orderKinds: loc.orderKinds,
      eurRate: legal ? legal.fx.EUR : Number(process.env.EUR_RATE) || 5,
      retentionDays: RETENTION_DAYS,
    };
  }

  function emitChanged(ctx, sessionId) {
    const { loc, store } = ctx;
    if (sessionId) {
      const s = store.state.sessions[sessionId];
      if (s) {
        io.to(room.session(loc.id, sessionId)).emit('session', store.guestView(s));
        // merged sessions: tell guests of the old session where they moved
        if (s.mergedInto) io.to(room.session(loc.id, sessionId)).emit('session:moved', { tableId: store.state.sessions[s.mergedInto].tableId });
      }
    }
    io.to(room.pos(loc.id)).emit('pos:state', store.posState());
    for (const station of ['kitchen', 'bar']) io.to(room.kds(loc.id, station)).emit('kds:state', store.kdsView(station));
  }

  function emitMenu(ctx) {
    io.to(`${ctx.loc.id}:menu`).emit('menu', ctx.store.menuView());
  }

  // Bon de comandă către bucătărie / bar (imprimantă non-fiscală).
  function printTickets(ctx, session, order) {
    const guest = session.guests.find((g) => g.id === order.guestId);
    for (const station of ['kitchen', 'bar']) {
      const lines = order.lines.filter((l) => l.station === station && !l.voided);
      if (!lines.length) continue;
      ctx.devices.printTicket(station, {
        title: ctx.store.tableName(session),
        subtitle: `${order.id} · ${guest?.name || ''} · ${new Date(order.at).toLocaleTimeString('ro-RO', { timeZone: ctx.loc.timeZone })}`,
        lines: lines.map((l) => ({ qty: l.qty, name: l.name, note: l.note })),
      });
    }
  }

  // ---------- HTTP routes ----------

  app.get('/', page('index.html'));
  app.get('/confidentialitate', page('privacy.html'));
  app.get('/l/:loc/pos', page('pos.html'));
  app.get('/l/:loc/kds', page('kds.html'));
  app.get('/l/:loc/qr', page('qr.html'));
  app.get('/l/:loc/t/:table', page('guest.html'));

  app.get('/api/locations', (req, res) => {
    res.json([...contexts.values()].map(({ loc }) => ({ id: loc.id, name: loc.name, tagline: loc.tagline, address: loc.address })));
  });

  app.get('/api/l/:loc/config', (req, res) => {
    const ctx = contexts.get(req.params.loc);
    if (!ctx) return res.status(404).json({ error: 'Locație inexistentă' });
    res.json(publicConfig(ctx));
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      locations: [...contexts.values()].map(({ loc, sync, devices }) => ({ id: loc.id, sync: sync ? (sync.lastError ? 'error' : 'ok') : 'file', fiscal: devices.status.fiscal.ok })),
    });
  });

  // QR codes for all tables (staff only — the codes give access to ordering).
  app.get('/api/l/:loc/qr', requireStaffHttp(['manager']), async (req, res) => {
    const ctx = ctxOf(req.params.loc);
    const out = [];
    for (const t of ctx.loc.floor.tables) {
      const url = `${baseUrl(req)}/l/${ctx.loc.id}/t/${t.id}?k=${tableKey(ctx.loc.id, t.id)}`;
      out.push({ id: t.id, name: t.name, seats: t.seats, url, svg: await QRCode.toString(url, { type: 'svg', margin: 1 }) });
    }
    res.json(out);
  });

  // Export CSV bonuri (pentru contabilitate). Separator „;” (Excel în setări românești).
  app.get('/api/l/:loc/export/receipts.csv', requireStaffHttp(['manager']), (req, res) => {
    const ctx = ctxOf(req.params.loc);
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || Date.now() + 1;
    const rows = [['Nr', 'Tip', 'Ref', 'Data', 'Masa', 'Ospatar', 'CIF client', 'Brut', 'Reducere', 'Total', 'TVA A', 'TVA B', 'Bacsis', 'Plati', 'Z']];
    for (const r of ctx.store.receiptsBetween(from, to)) {
      const vat = (c) => (r.vat.find((v) => v.code === c)?.vat || 0) / 100;
      rows.push([
        r.no, r.type === 'refund' ? 'storno' : 'vanzare', r.refNo || '', new Date(r.at).toISOString(), r.tableId,
        ctx.store.staffName(r.staffId), r.cif, r.gross / 100, r.discount / 100, r.total / 100, vat('A'), vat('B'), r.tip / 100,
        r.payments.map((p) => `${p.method}:${p.amount / 100}`).join(' '), r.zNo || '',
      ]);
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="bonuri-${ctx.loc.id}.csv"`);
    res.send(`﻿${rows.map((r) => r.map(csvCell).join(';')).join('\n')}`);
  });

  // Verificare CIF client la ANAF (pentru factură).
  app.get('/api/l/:loc/anaf/:cui', requireStaffHttp(), async (req, res) => {
    if (!isValidCui(req.params.cui)) return res.status(400).json({ error: 'CIF invalid (cifra de control nu corespunde).' });
    try {
      const info = await anaf.lookup(req.params.cui);
      if (!info) return res.status(404).json({ error: 'CIF negăsit la ANAF.' });
      res.json(info);
    } catch (err) {
      res.status(502).json({ error: `ANAF indisponibil: ${err.message}` });
    }
  });

  app.use((err, req, res, next) => {
    if (err instanceof PosError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Eroare internă' });
  });

  // ---------- sockets ----------

  io.on('connection', (socket) => {
    // simple per-socket rate limit against spam from guest phones
    let budget = 40;
    const refill = setInterval(() => { budget = Math.min(40, budget + 4); }, 1000);
    socket.on('disconnect', () => clearInterval(refill));

    // Wraps a handler: rate limit, error → { error }, success → { ok, ...result }.
    const on = (event, handler) => {
      socket.on(event, async (payload, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        if (--budget < 0) return ack({ error: 'Prea multe cereri, încercați din nou.' });
        try {
          ack({ ok: true, ...((await handler(payload || {})) || {}) });
        } catch (err) {
          if (!(err instanceof PosError)) console.error(`[socket ${event}]`, err);
          ack({ error: err instanceof PosError ? err.message : 'Eroare internă' });
        }
      });
    };

    // ----- guest (client la masă) -----

    function guestCtx({ loc, table, k }) {
      const ctx = ctxOf(loc);
      const t = ctx.loc.tablesById.get(table);
      if (!t || !safeEqual(k, tableKey(loc, table))) throw new PosError('Cod QR invalid. Scanați din nou codul de pe masă.');
      return { ctx, t };
    }

    function bindGuest(ctx, session, guest) {
      for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
      socket.join(room.session(ctx.loc.id, session.id));
      socket.join(`${ctx.loc.id}:menu`);
      socket.data.guest = { loc: ctx.loc.id, sessionId: session.id, guestId: guest.id };
    }

    on('guest:hello', (p) => {
      const { ctx, t } = guestCtx(p);
      socket.join(`${ctx.loc.id}:menu`);
      const { session, guest } = ctx.store.joinTable(t.id, { guestId: p.guestId });
      if (guest) bindGuest(ctx, session, guest);
      return {
        table: { id: t.id, name: t.name, seats: t.seats },
        guest,
        session: guest ? ctx.store.guestView(session) : null,
        othersAtTable: session ? session.guests.length : 0,
      };
    });

    on('guest:join', (p) => {
      const { ctx, t } = guestCtx(p);
      if (!p.consent) throw new PosError('Confirmați că ați citit informarea privind datele personale.');
      const { session, guest } = ctx.store.joinTable(t.id, { guestId: p.guestId, name: p.name });
      if (!guest) throw new PosError('Introduceți un nume sau o poreclă.');
      bindGuest(ctx, session, guest);
      emitChanged(ctx, session.id);
      io.to(room.pos(ctx.loc.id)).emit('pos:event', { type: 'join', tableId: t.id, text: `${guest.name} s-a așezat la ${t.name}` });
      return { guest, session: ctx.store.guestView(session) };
    });

    function currentGuest() {
      const g = socket.data.guest;
      if (!g) throw new PosError('Scanați codul QR al mesei.');
      return { ...g, ctx: ctxOf(g.loc) };
    }

    on('guest:order', (p) => {
      const g = currentGuest();
      const order = g.ctx.store.sendOrder(g.sessionId, g.guestId, p.items);
      const session = g.ctx.store.getSession(g.sessionId);
      emitChanged(g.ctx, g.sessionId);
      io.to(room.pos(g.loc)).emit('pos:event', { type: 'order', tableId: session.tableId, sessionId: session.id, text: `Comandă nouă la ${g.ctx.store.tableName(session)}` });
      return { orderId: order.id };
    });

    on('guest:call', (p) => {
      const g = currentGuest();
      const { session } = g.ctx.store.call(g.sessionId, p.type);
      emitChanged(g.ctx, g.sessionId);
      const text = p.type === 'bill' ? `${g.ctx.store.tableName(session)} cere nota` : `${g.ctx.store.tableName(session)} cheamă ospătarul`;
      io.to(room.pos(g.loc)).emit('pos:event', { type: 'call', tableId: session.tableId, sessionId: session.id, text });
    });

    // GDPR: clientul își poate șterge numele (anonimizare) oricând.
    on('guest:forget', () => {
      const g = currentGuest();
      g.ctx.store.anonymizeGuest(g.sessionId, g.guestId);
      emitChanged(g.ctx, g.sessionId);
      socket.data.guest = null;
    });

    // ----- staff -----

    on('staff:login', ({ loc, pin, token }) => {
      const ctx = ctxOf(loc);
      let staff = token ? staffFromToken(loc, token) : null;
      if (!staff) {
        if (!pin) throw new PosError('Sesiune expirată. Introduceți PIN-ul.');
        staff = ctx.store.login(pin);
        token = issueToken(loc, staff);
      }
      socket.data.staff = { loc, ...staff };
      socket.join(room.pos(loc));
      socket.join(`${loc}:menu`);
      return { token, staff, config: publicConfig(ctx), state: ctx.store.posState(), staffList: ctx.store.staffList() };
    });

    on('staff:logout', ({ token }) => {
      tokens.delete(String(token || ''));
      socket.data.staff = null;
      for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
    });

    // Staff handler: role check + context + broadcast after mutation.
    const staffOn = (event, roles, handler) => on(event, async (p) => {
      const s = socket.data.staff;
      if (!s) throw new PosError('Autentificați-vă.');
      const fresh = staffFromToken(s.loc, p.token) || contexts.get(s.loc).store.staffList().find((u) => u.id === s.id && u.active);
      if (!fresh) throw new PosError('Sesiune expirată.');
      if (roles && !roles.includes(fresh.role)) throw new PosError('Acțiune permisă doar pentru manager.');
      return handler(contexts.get(s.loc), p, fresh);
    });

    const ALL = null;
    const MANAGER = ['manager'];
    const FLOOR = ['manager', 'waiter'];

    staffOn('pos:state', ALL, (ctx) => ({ state: ctx.store.posState() }));

    staffOn('pos:openTable', FLOOR, (ctx, p, staff) => {
      const s = ctx.store.openSession(p.tableId, staff.id);
      if (!s.guests.length) ctx.store.addGuest(s, p.guestName || 'Client 1');
      emitChanged(ctx, s.id);
      return { sessionId: s.id };
    });

    staffOn('pos:openVirtual', FLOOR, (ctx, p, staff) => {
      const s = ctx.store.openVirtual(p.kind, p.customer, staff.id);
      emitChanged(ctx, s.id);
      return { sessionId: s.id };
    });

    staffOn('pos:addGuest', FLOOR, (ctx, p) => {
      const s = ctx.store.openSessionOrThrow(p.sessionId);
      const guest = ctx.store.addGuest(s, p.name || `Client ${s.guests.length + 1}`);
      emitChanged(ctx, s.id);
      return { guest };
    });

    staffOn('pos:order', FLOOR, (ctx, p, staff) => {
      const order = ctx.store.sendOrder(p.sessionId, p.guestId, p.items, { source: 'pos', staffId: staff.id });
      printTickets(ctx, ctx.store.getSession(p.sessionId), order);
      emitChanged(ctx, p.sessionId);
      return { orderId: order.id };
    });

    staffOn('pos:orderStatus', FLOOR, (ctx, p, staff) => {
      const { session, order } = ctx.store.setOrderStatus(p.orderId, p.status, staff.id);
      if (p.status === 'accepted') printTickets(ctx, session, order);
      emitChanged(ctx, session.id);
    });

    staffOn('pos:void', FLOOR, (ctx, p, staff) => {
      const s = ctx.store.getSession(p.sessionId);
      const { order } = ctx.store.findLine(s, p.lineId);
      // după confirmare, anularea cere manager (produsul poate fi deja preparat)
      if (order.status !== 'new' && staff.role !== 'manager') throw new PosError('Anularea după confirmare necesită manager.');
      ctx.store.voidLine(p.sessionId, p.lineId, { reason: p.reason, staffId: staff.id });
      emitChanged(ctx, p.sessionId);
    });

    staffOn('pos:discount', MANAGER, (ctx, p) => {
      if (p.lineId) ctx.store.discountLine(p.sessionId, p.lineId, Number(p.pct));
      else ctx.store.discountSession(p.sessionId, Number(p.pct));
      emitChanged(ctx, p.sessionId);
    });

    staffOn('pos:moveLine', FLOOR, (ctx, p) => {
      ctx.store.moveLine(p.sessionId, p.lineId, p.toGuestId);
      emitChanged(ctx, p.sessionId);
    });

    staffOn('pos:transfer', FLOOR, (ctx, p) => {
      const s = ctx.store.transferSession(p.sessionId, p.toTableId);
      emitChanged(ctx, s.id);
    });

    staffOn('pos:merge', FLOOR, (ctx, p) => {
      const into = ctx.store.mergeSessions(p.fromSessionId, p.intoSessionId);
      emitChanged(ctx, p.fromSessionId);
      emitChanged(ctx, into.id);
    });

    staffOn('pos:assign', FLOOR, (ctx, p) => {
      ctx.store.assignWaiter(p.sessionId, p.staffId);
      emitChanged(ctx, p.sessionId);
    });

    staffOn('pos:ackCall', FLOOR, (ctx, p) => {
      ctx.store.ackCall(p.sessionId, p.callId);
      emitChanged(ctx, p.sessionId);
    });

    staffOn('pos:pay', FLOOR, async (ctx, p, staff) => {
      const { receipt } = ctx.store.pay(p.sessionId, { ...p, staffId: staff.id });
      const fiscal = await ctx.devices.printReceipt(receipt, ctx.loc);
      emitChanged(ctx, p.sessionId);
      return { receipt, fiscal };
    });

    staffOn('pos:refund', MANAGER, async (ctx, p, staff) => {
      const receipt = ctx.store.refundReceipt(p.no, { staffId: staff.id, reason: p.reason });
      const fiscal = await ctx.devices.printReceipt(receipt, ctx.loc);
      emitChanged(ctx, null);
      return { receipt, fiscal };
    });

    staffOn('pos:receipt', ALL, (ctx, p) => ({ receipt: ctx.store.getReceipt(p.no) }));

    staffOn('pos:reprint', FLOOR, async (ctx, p) => ({ fiscal: await ctx.devices.printReceipt(ctx.store.getReceipt(p.no), ctx.loc) }));

    staffOn('pos:receipts', MANAGER, (ctx, p) => {
      const from = Number(p.from) || Date.now() - 86400000;
      const to = Number(p.to) || Date.now() + 1;
      return { receipts: ctx.store.receiptsBetween(from, to).slice(-300).reverse() };
    });

    staffOn('pos:close', FLOOR, (ctx, p) => {
      const s = ctx.store.closeSession(p.sessionId);
      emitChanged(ctx, s.id);
    });

    staffOn('pos:cash', MANAGER, async (ctx, p, staff) => {
      const move = ctx.store.cashMove({ ...p, staffId: staff.id });
      await ctx.devices.cashMove(move);
      emitChanged(ctx, null);
      return { move };
    });

    staffOn('pos:reportX', MANAGER, async (ctx) => {
      const report = ctx.store.reportX();
      return { report, fiscal: await ctx.devices.printReport(report) };
    });

    staffOn('pos:reportZ', MANAGER, async (ctx, p, staff) => {
      const report = ctx.store.reportZ({ staffId: staff.id, force: !!p.force });
      const fiscal = await ctx.devices.printReport(report);
      emitChanged(ctx, null);
      return { report, fiscal };
    });

    staffOn('pos:zList', MANAGER, (ctx) => ({ list: ctx.store.zReports() }));
    staffOn('pos:zGet', MANAGER, (ctx, p) => ({ report: ctx.store.getZReport(p.no) }));

    staffOn('pos:sales', MANAGER, (ctx, p) => ({ report: ctx.store.salesReport(Number(p.from), Number(p.to)) }));

    staffOn('pos:menuUpdate', MANAGER, (ctx, p) => {
      const item = ctx.store.updateMenuItem(p.itemId, p);
      emitMenu(ctx);
      return { item };
    });

    staffOn('pos:staffList', MANAGER, (ctx) => ({ staff: ctx.store.staffList() }));
    staffOn('pos:staffSave', MANAGER, (ctx, p) => ({ staff: ctx.store.saveStaff(p) }));

    staffOn('pos:anonymizeGuest', MANAGER, (ctx, p) => {
      ctx.store.anonymizeGuest(p.sessionId, p.guestId);
      emitChanged(ctx, p.sessionId);
    });

    staffOn('pos:status', ALL, (ctx) => ({
      legal: legal ? legal.status : null,
      fx: legal ? legal.fx : null,
      vatGroups,
      devices: ctx.devices.status,
      fiscalDriver: ctx.devices.fiscalDriver,
      journal: ctx.devices.journal(),
      storage: ctx.sync ? { kind: 'supabase', lastError: ctx.sync.lastError } : { kind: 'file' },
      retentionDays: RETENTION_DAYS,
    }));

    // ----- KDS (bucătărie / bar) -----

    staffOn('kds:join', ALL, (ctx, p) => {
      const station = p.station === 'bar' ? 'bar' : 'kitchen';
      socket.join(room.kds(ctx.loc.id, station));
      return { orders: ctx.store.kdsView(station) };
    });

    staffOn('kds:ready', ALL, (ctx, p) => {
      const { session } = ctx.store.markReady(p.orderId, p.station === 'bar' ? 'bar' : 'kitchen');
      emitChanged(ctx, session.id);
      io.to(room.pos(ctx.loc.id)).emit('pos:event', { type: 'ready', tableId: session.tableId, text: `${ctx.store.tableName(session)}: ${p.station === 'bar' ? 'băuturile' : 'mâncarea'} e gata` });
    });
  });

  // GDPR: anonimizare automată după perioada de retenție.
  const gdprTimer = setInterval(() => {
    for (const ctx of contexts.values()) {
      const n = ctx.store.anonymizeOlderThan(RETENTION_DAYS);
      if (n) console.log(`[gdpr] ${ctx.loc.id}: ${n} înregistrări anonimizate`);
    }
  }, 3600 * 1000);
  gdprTimer.unref();

  // expired staff tokens cleanup
  setInterval(() => {
    for (const [t, v] of tokens) if (v.exp < Date.now()) tokens.delete(t);
  }, 600000).unref();

  return { app, server, io, tableKey };
}

async function main() {
  let supabase = null;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.SUPABASE_URL && key) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false } });
    console.log('[stocare] Supabase:', process.env.SUPABASE_URL);
  } else {
    console.log(`[stocare] fișiere locale în ${DATA_DIR} (setați SUPABASE_URL și SUPABASE_SECRET_KEY pentru Supabase)`);
  }
  const contexts = await createContexts({ supabase });
  const locations = [...contexts.values()].map((c) => c.loc);
  const legal = new LegalSync({ locations, vatGroups });
  if (process.env.LEGAL_SYNC !== '0') legal.start();
  const { server } = createApp(contexts, { legal });

  server.listen(PORT, () => {
    console.log(`\nnewpos pornit pe portul ${PORT}`);
    for (const url of [`http://localhost:${PORT}`, ...lanUrls()]) {
      console.log(`  ${url}`);
    }
    for (const c of contexts.values()) console.log(`  POS ${c.loc.id}: /l/${c.loc.id}/pos   (PIN manager test: 1234)`);
  });

  const shutdown = async () => {
    for (const c of contexts.values()) {
      c.store.flush();
      if (c.sync) await c.sync.flush();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, createContexts, tableKey };
