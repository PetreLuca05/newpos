const test = require('node:test');
const assert = require('node:assert');
const { isValidCui, parseAnafResponse, parseTedbResponse, parseBnrRates, applyVatRates, AnafClient, LegalSync } = require('../src/legal');

test('CUI check digit', () => {
  assert.ok(isValidCui('RO18547290')); // ANAF
  assert.ok(isValidCui('18547290'));
  assert.ok(!isValidCui('18547291'));
  assert.ok(!isValidCui('abc'));
});

test('ANAF v9 response parsing', () => {
  const info = parseAnafResponse({
    cod: 200,
    found: [{
      date_generale: { cui: 18547290, denumire: 'AGENTIA NATIONALA DE ADMINISTRARE FISCALA', adresa: 'MUN. BUCUREŞTI', nrRegCom: '' },
      inregistrare_scop_Tva: { scpTVA: false },
      stare_inactiv: { statusInactivi: false },
    }],
    notFound: [],
  });
  assert.strictEqual(info.cui, '18547290');
  assert.strictEqual(info.vatPayer, false);
  assert.strictEqual(parseAnafResponse({ found: [], notFound: [123] }), null);
});

test('TEDB response parsing and applying rates', () => {
  const xml = `<soap:Envelope><soap:Body><ns2:retrieveVatRatesRespMsg>
    <ns2:vatRateResults><ns2:memberState>RO</ns2:memberState><ns2:type>STANDARD</ns2:type><ns2:rate><ns2:type>DEFAULT</ns2:type><ns2:value>21.0</ns2:value></ns2:rate></ns2:vatRateResults>
    <ns2:vatRateResults><ns2:memberState>RO</ns2:memberState><ns2:type>REDUCED</ns2:type><ns2:rate><ns2:type>REDUCED_RATE</ns2:type><ns2:value>11.0</ns2:value></ns2:rate>
      <ns2:category><ns2:identifier>RESTAURANT</ns2:identifier></ns2:category></ns2:vatRateResults>
    <ns2:vatRateResults><ns2:memberState>RO</ns2:memberState><ns2:type>REDUCED</ns2:type><ns2:rate><ns2:type>REDUCED_RATE</ns2:type><ns2:value>5.0</ns2:value></ns2:rate></ns2:vatRateResults>
  </ns2:retrieveVatRatesRespMsg></soap:Body></soap:Envelope>`;
  const rates = parseTedbResponse(xml);
  assert.deepStrictEqual(rates, { standard: 21, restaurant: 11 });
  const groups = [{ code: 'A', rate: 19, label: '' }, { code: 'B', rate: 9, label: '' }];
  assert.deepStrictEqual(applyVatRates(groups, rates), ['A: 19% → 21%', 'B: 9% → 11%']);
  assert.deepStrictEqual(parseTedbResponse('<garbage/>'), { standard: null, restaurant: null });
});

test('BNR XML parsing', () => {
  const { date, rates } = parseBnrRates('<Cube date="2026-10-07"><Rate currency="EUR">5.0812</Rate><Rate currency="HUF" multiplier="100">1.3000</Rate></Cube>');
  assert.strictEqual(date, '2026-10-07');
  assert.strictEqual(rates.EUR, 5.0812);
  assert.ok(Math.abs(rates.HUF - 0.013) < 1e-9);
});

test('ANAF client caches lookups', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ found: [{ date_generale: { cui: 18547290, denumire: 'X' }, inregistrare_scop_Tva: { scpTVA: true } }] }) };
  };
  const anaf = new AnafClient({ fetchImpl, minIntervalMs: 0 });
  assert.strictEqual((await anaf.lookup('RO18547290')).name, 'X');
  await anaf.lookup('18547290');
  assert.strictEqual(calls, 1);
});

test('legal sync falls back to config when services are down', async () => {
  const vatGroups = [{ code: 'A', rate: 21, label: 'A' }, { code: 'B', rate: 11, label: 'B' }];
  const locations = [{ id: 'x', cui: 'RO18547290', company: 'Cfg' }];
  const down = async () => { throw new Error('offline'); };
  const silent = { info() {}, warn() {}, error() {} };
  const legal = new LegalSync({ locations, vatGroups, fetchImpl: down, anaf: new AnafClient({ fetchImpl: down, minIntervalMs: 0 }), log: silent });
  await legal.syncAll();
  assert.strictEqual(vatGroups[0].rate, 21);
  assert.strictEqual(locations[0].company, 'Cfg');
  assert.match(legal.status.vat.error, /offline/);
  assert.strictEqual(legal.fx.source, 'config');
});
