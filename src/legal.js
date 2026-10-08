// Integrations with public Romanian / EU services, so legal values don't need manual updates.
//
// 1. ANAF – „Serviciul web pentru verificarea plătitorilor de TVA” (PlatitorTvaRest v9), public, fără autentificare.
//    https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt
//    Folosit pentru: datele firmei proprii (denumire, adresă, Nr. Reg. Com., plătitor TVA) și
//    validarea / completarea CIF-ului clientului care cere factură.
//    Limită ANAF: max 1 cerere/secundă, max 100 CUI per cerere.
//
// 2. Comisia Europeană – TEDB „VAT Retrieval Service” (SOAP), public.
//    https://ec.europa.eu/taxation_customs/tedb/
//    Folosit pentru: cotele TVA în vigoare în România la o dată (cota standard și cota redusă pentru restaurante).
//
// Ambele sunt opționale: dacă nu răspund, aplicația folosește valorile din src/restaurant.js.

const ANAF_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
const TEDB_URL = 'https://ec.europa.eu/taxation_customs/tedb/ws/VatRetrievalService';

const today = () => new Date().toISOString().slice(0, 10);

function normalizeCui(cui) {
  const digits = String(cui || '').toUpperCase().replace(/^RO/, '').replace(/\D/g, '');
  return /^\d{2,10}$/.test(digits) ? digits : null;
}

// Algoritmul oficial de control pentru CIF/CUI (cifra de control, cheia 753217532).
function isValidCui(cui) {
  const digits = normalizeCui(cui);
  if (!digits) return false;
  const key = '753217532';
  const body = digits.slice(0, -1).padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(body[i]) * Number(key[i]);
  const control = ((sum * 10) % 11) % 10;
  return control === Number(digits.at(-1));
}

function parseAnafResponse(json) {
  const found = json && Array.isArray(json.found) ? json.found[0] : null;
  if (!found) return null;
  const g = found.date_generale || {};
  const tva = found.inregistrare_scop_Tva || {};
  return {
    cui: String(g.cui || ''),
    name: g.denumire || '',
    address: g.adresa || '',
    regCom: g.nrRegCom || '',
    phone: g.telefon || '',
    vatPayer: !!tva.scpTVA,
    inactive: !!(found.stare_inactiv && found.stare_inactiv.statusInactivi),
    checkedAt: Date.now(),
  };
}

class AnafClient {
  constructor({ fetchImpl = globalThis.fetch, minIntervalMs = 1100 } = {}) {
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.lastCall = 0;
  }

  // Returns company info or null when not found. Throws on network/service errors.
  async lookup(cui) {
    const digits = normalizeCui(cui);
    if (!digits) return null;
    const cached = this.cache.get(digits);
    if (cached && Date.now() - cached.checkedAt < 24 * 3600 * 1000) return cached;

    // serialize requests to respect ANAF's 1 request/second limit
    const run = this.queue.then(async () => {
      const wait = this.lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      const res = await this.fetch(ANAF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ cui: Number(digits), data: today() }]),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`ANAF HTTP ${res.status}`);
      return parseAnafResponse(await res.json());
    });
    this.queue = run.catch(() => {});
    const info = await run;
    if (info) this.cache.set(digits, info);
    return info;
  }
}

// ---------- TEDB (cote TVA) ----------

function tedbRequest(country, date) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService"
  xmlns:urn1="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:retrieveVatRatesReqMsg>
      <urn1:memberStates><urn1:isoCode>${country}</urn1:isoCode></urn1:memberStates>
      <urn1:situationOn>${date}</urn1:situationOn>
    </urn:retrieveVatRatesReqMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// Extracts { standard, restaurant } rates from a TEDB SOAP response. Tag names may carry namespace prefixes.
function parseTedbResponse(xml) {
  const blocks = [...String(xml).matchAll(/<(?:\w+:)?vatRateResults>([\s\S]*?)<\/(?:\w+:)?vatRateResults>/g)].map((m) => m[1]);
  const results = blocks.map((b) => {
    const type = (b.match(/<(?:\w+:)?type>\s*(STANDARD|REDUCED|SUPER_REDUCED|PARKING|ZERO|EXEMPTED)\s*<\//) || [])[1];
    const value = Number((b.match(/<(?:\w+:)?value>\s*([\d.]+)\s*<\//) || [])[1]);
    return { type, value, text: b };
  }).filter((r) => r.type && Number.isFinite(r.value));

  const sane = (v) => (Number.isFinite(v) && v > 0 && v < 40 ? v : null);
  const standard = sane(results.find((r) => r.type === 'STANDARD')?.value);
  const reduced = results.filter((r) => r.type === 'REDUCED');
  const forRestaurants = reduced.find((r) => /restaurant|catering/i.test(r.text));
  const restaurant = sane(forRestaurants ? forRestaurants.value : Math.max(...reduced.map((r) => r.value)));
  return { standard, restaurant };
}

async function fetchVatRates({ fetchImpl = globalThis.fetch, country = 'RO', date = today() } = {}) {
  const res = await fetchImpl(TEDB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:ec.europa.eu:taxud:tedb:services:v1:VatRetrievalService/RetrieveVatRates' },
    body: tedbRequest(country, date),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`TEDB HTTP ${res.status}`);
  return parseTedbResponse(await res.text());
}

// Applies fetched rates onto the vatGroups objects (A = standard, B = redusă restaurant).
function applyVatRates(vatGroups, { standard, restaurant }) {
  const changes = [];
  const set = (code, rate) => {
    const g = vatGroups.find((x) => x.code === code);
    if (!g || !rate || g.rate === rate) return;
    changes.push(`${code}: ${g.rate}% → ${rate}%`);
    g.rate = rate;
    g.label = `Cota ${code} ${rate}%`;
  };
  set('A', standard);
  set('B', restaurant);
  return changes;
}

// Keeps a status object the POS can show (sursa valorilor, ultima verificare, erori).
class LegalSync {
  constructor({ restaurant, vatGroups, anaf = new AnafClient(), fetchImpl = globalThis.fetch, log = console }) {
    this.restaurant = restaurant;
    this.vatGroups = vatGroups;
    this.anaf = anaf;
    this.fetch = fetchImpl;
    this.log = log;
    this.status = {
      vat: { source: 'config', checkedAt: null, error: null, changes: [] },
      company: { source: 'config', checkedAt: null, error: null },
    };
  }

  async syncVat() {
    try {
      const rates = await fetchVatRates({ fetchImpl: this.fetch });
      const changes = applyVatRates(this.vatGroups, rates);
      this.status.vat = { source: 'TEDB (Comisia Europeană)', checkedAt: Date.now(), error: null, changes, rates };
      if (changes.length) this.log.info('[legal] cote TVA actualizate:', changes.join(', '));
    } catch (err) {
      this.status.vat = { ...this.status.vat, checkedAt: Date.now(), error: err.message };
      this.log.warn('[legal] TEDB indisponibil, folosesc cotele din configurare:', err.message);
    }
  }

  async syncCompany() {
    try {
      const info = await this.anaf.lookup(this.restaurant.cui);
      if (!info) throw new Error('CUI negăsit la ANAF');
      Object.assign(this.restaurant, {
        company: info.name || this.restaurant.company,
        address: info.address || this.restaurant.address,
        regCom: info.regCom || this.restaurant.regCom,
        cui: `${info.vatPayer ? 'RO' : ''}${info.cui}`,
        vatPayer: info.vatPayer,
      });
      this.status.company = { source: 'ANAF', checkedAt: Date.now(), error: null, inactive: info.inactive };
    } catch (err) {
      this.status.company = { ...this.status.company, checkedAt: Date.now(), error: err.message };
      this.log.warn('[legal] ANAF indisponibil, folosesc datele firmei din configurare:', err.message);
    }
  }

  async syncAll() {
    await Promise.all([this.syncVat(), this.syncCompany()]);
  }

  // Re-checks once a day (cotele TVA se pot modifica prin lege).
  start(intervalMs = 24 * 3600 * 1000) {
    this.syncAll();
    this.timer = setInterval(() => this.syncAll(), intervalMs);
    this.timer.unref();
  }
}

module.exports = {
  AnafClient,
  LegalSync,
  isValidCui,
  normalizeCui,
  parseAnafResponse,
  parseTedbResponse,
  applyVatRates,
  fetchVatRates,
};
