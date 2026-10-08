// Hardware abstraction: fiscal cash registers / printers (AMEF) and non-fiscal ticket printers.
//
// In România bonul fiscal trebuie emis de o casă de marcat (AMEF) conectată la ANAF; aplicația nu
// poate emite singură bonuri fiscale. Aplicația trimite documentul către AMEF printr-un driver:
//
//   simulated  – nimic fizic; păstrează documentele în memorie (testare)
//   file       – scrie câte un fișier pe comandă într-un folder urmărit de programul producătorului
//                (modul „fișier” / bridge oferit de majoritatea caselor de marcat: Datecs, Tremol,
//                Daisy, Partner, Elcom etc.). Formatul se alege cu `format` (json implicit; adăugați
//                formatul specific producătorului în FORMATTERS).
//   http       – POST JSON către un bridge local (de ex. un serviciu pe PC-ul de lângă casa de marcat)
//
// Imprimante non-fiscale (bonuri de comandă bucătărie / bar), ESC/POS:
//   none | console | escpos-tcp (imprimantă de rețea, port 9100) | http
//
// Configurarea se face per locație în src/locations/<id>.js → devices.

const fs = require('fs');
const path = require('path');
const net = require('net');

const money = (bani) => (bani / 100).toFixed(2);

// ---------- formatters (document → payload for a device) ----------

const FORMATTERS = {
  json: (doc) => ({ ext: 'json', body: JSON.stringify(doc, null, 2) }),
  // Plain text, useful for debugging or text-mode bridges.
  text: (doc) => ({ ext: 'txt', body: renderText(doc) }),
};

function renderText(doc) {
  if (doc.kind === 'receipt') {
    const r = doc.receipt;
    const rows = r.lines.map((l) => `${l.name}\n  ${l.qty} x ${money(l.unitPrice)}${l.discountPct ? ` -${l.discountPct}%` : ''} = ${money(l.total)} ${l.vat}`);
    const pays = r.payments.map((p) => `${p.method.toUpperCase()} ${money(p.tendered || p.amount)}`);
    return [
      `${doc.type === 'refund' ? 'STORNO ' : ''}BON ${r.no}`,
      ...rows,
      `TOTAL ${money(r.total)}`,
      ...(r.tip ? [`BACSIS ${money(r.tip)}`] : []),
      ...pays,
      ...(r.change ? [`REST ${money(r.change)}`] : []),
      ...(r.cif ? [`CIF CLIENT ${r.cif}`] : []),
    ].join('\n');
  }
  return `${doc.kind.toUpperCase()}\n${JSON.stringify(doc, null, 2)}`;
}

// ---------- fiscal drivers ----------

class SimulatedFiscal {
  constructor() {
    this.journal = [];
  }

  async send(doc) {
    this.journal.push({ at: Date.now(), ...doc });
    if (this.journal.length > 500) this.journal.shift();
    return { ok: true, driver: 'simulated' };
  }
}

class FileFiscal {
  constructor({ dir, format = 'json' }) {
    if (!dir) throw new Error('Driverul „file” are nevoie de `dir`.');
    this.dir = dir;
    this.format = FORMATTERS[format];
    if (!this.format) throw new Error(`Format necunoscut: ${format}`);
  }

  async send(doc) {
    fs.mkdirSync(this.dir, { recursive: true });
    const { ext, body } = this.format(doc);
    const name = `${Date.now()}-${doc.kind}-${doc.ref || ''}.${ext}`;
    // write to temp and rename so the watcher never reads a half-written file
    const tmp = path.join(this.dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(this.dir, name));
    return { ok: true, driver: 'file', file: name };
  }
}

class HttpDevice {
  constructor({ url, token = '' }) {
    if (!url) throw new Error('Driverul „http” are nevoie de `url`.');
    this.url = url;
    this.token = token;
  }

  async send(doc) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(doc),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
    return { ok: true, driver: 'http' };
  }
}

// ---------- non-fiscal ticket printers (ESC/POS) ----------

const ESC = '\x1b';
const GS = '\x1d';

// Romanian diacritics are not in most printer code pages; transliterate for safety.
function ascii(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\n]/g, '?');
}

function escposTicket(ticket) {
  const lines = [
    `${ESC}@`, // init
    `${ESC}a\x01${GS}!\x11${ascii(ticket.title)}\n${GS}!\x00`, // centered, double size
    `${ESC}a\x00${ascii(ticket.subtitle || '')}\n`,
    `${'-'.repeat(32)}\n`,
    ...ticket.lines.map((l) => `${GS}!\x01${l.qty} x ${ascii(l.name)}\n${GS}!\x00${l.note ? `   > ${ascii(l.note)}\n` : ''}`),
    `${'-'.repeat(32)}\n\n\n\n`,
    `${GS}V\x41\x03`, // partial cut
  ];
  return Buffer.from(lines.join(''), 'latin1');
}

class EscposTcpPrinter {
  constructor({ host, port = 9100 }) {
    if (!host) throw new Error('Imprimanta ESC/POS are nevoie de `host`.');
    this.host = host;
    this.port = port;
  }

  send(ticket) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port }, () => {
        sock.end(escposTicket(ticket), () => resolve({ ok: true, driver: 'escpos-tcp' }));
      });
      sock.setTimeout(8000, () => sock.destroy(new Error('Imprimanta nu răspunde.')));
      sock.on('error', reject);
    });
  }
}

class ConsolePrinter {
  async send(ticket) {
    console.log(`[imprimantă] ${ticket.title} ${ticket.subtitle || ''}\n${ticket.lines.map((l) => `  ${l.qty} x ${l.name}${l.note ? ` (${l.note})` : ''}`).join('\n')}`);
    return { ok: true, driver: 'console' };
  }
}

class NoPrinter {
  async send() {
    return { ok: true, driver: 'none' };
  }
}

function createFiscal(cfg = {}) {
  switch (cfg.driver || 'simulated') {
    case 'simulated': return new SimulatedFiscal();
    case 'file': return new FileFiscal(cfg);
    case 'http': return new HttpDevice(cfg);
    default: throw new Error(`Driver fiscal necunoscut: ${cfg.driver}`);
  }
}

function createPrinter(cfg = {}) {
  switch (cfg.driver || 'none') {
    case 'none': return new NoPrinter();
    case 'console': return new ConsolePrinter();
    case 'escpos-tcp': return new EscposTcpPrinter(cfg);
    case 'http': return new HttpDevice(cfg);
    default: throw new Error(`Driver imprimantă necunoscut: ${cfg.driver}`);
  }
}

// Per-location device set with a status the POS can display. Failures never block the sale in the
// app; they are reported so staff can re-send (the AMEF is the legal source of truth).
class Devices {
  constructor(config = {}, log = console) {
    this.log = log;
    this.fiscal = createFiscal(config.fiscal);
    this.fiscalDriver = config.fiscal?.driver || 'simulated';
    this.printers = {};
    for (const [station, cfg] of Object.entries(config.printers || {})) this.printers[station] = createPrinter(cfg);
    this.status = { fiscal: { ok: true, lastError: null, at: null }, printers: {} };
  }

  async fiscalSend(kind, ref, payload) {
    const doc = { kind, ref, at: Date.now(), ...payload };
    try {
      const res = await this.fiscal.send(doc);
      this.status.fiscal = { ok: true, lastError: null, at: Date.now() };
      return res;
    } catch (err) {
      this.status.fiscal = { ok: false, lastError: err.message, at: Date.now() };
      this.log.error(`[fiscal] ${kind} ${ref}:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  printReceipt(receipt, location) {
    return this.fiscalSend('receipt', receipt.no, { type: receipt.type, receipt, company: { name: location.company, cui: location.cui } });
  }

  printReport(report) {
    return this.fiscalSend(report.type === 'Z' ? 'report-z' : 'report-x', report.no || '', { report });
  }

  cashMove(move) {
    return this.fiscalSend(move.type === 'in' ? 'cash-in' : 'cash-out', move.id, { move });
  }

  async printTicket(station, ticket) {
    const p = this.printers[station];
    if (!p) return { ok: true, driver: 'none' };
    try {
      const res = await p.send(ticket);
      this.status.printers[station] = { ok: true, lastError: null, at: Date.now() };
      return res;
    } catch (err) {
      this.status.printers[station] = { ok: false, lastError: err.message, at: Date.now() };
      this.log.error(`[imprimantă ${station}]`, err.message);
      return { ok: false, error: err.message };
    }
  }

  journal() {
    return this.fiscal instanceof SimulatedFiscal ? this.fiscal.journal.slice(-50).reverse() : [];
  }
}

module.exports = { Devices, FORMATTERS, escposTicket, renderText, createFiscal, createPrinter };
