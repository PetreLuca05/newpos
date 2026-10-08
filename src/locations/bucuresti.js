// Locația 2 (fictivă): București — local mic de tip bistro, același meniu cu prețuri ajustate.
const { categories, items } = require('./menu-smochinul');

// Prețuri +10% în București, rotunjite la leu; fără platou (nu există în această locație).
const localItems = items
  .filter((i) => i.id !== 'st-board')
  .map((i) => ({ ...i, price: Math.round((i.price * 1.1) / 100) * 100 }));

module.exports = {
  id: 'bucuresti',
  name: 'Smochinul de Aramă',
  tagline: 'Bistro Floreasca',
  company: 'SMOCHINUL DE ARAMĂ SRL',
  cui: 'RO12345678', // aceeași firmă, punct de lucru diferit (fictiv)
  regCom: 'J12/1234/2024',
  address: 'Str. Glicinelor nr. 3, Sector 1, București (punct de lucru)',
  phone: '021 000 000',
  currency: 'RON',
  currencySymbol: 'lei',
  locale: 'ro-RO',
  timeZone: 'Europe/Bucharest',
  floor: {
    width: 700,
    height: 460,
    zones: [
      { id: 'hall', name: 'Salon', x: 20, y: 20, w: 460, h: 420, kind: 'indoor' },
      { id: 'bar', name: 'Bar', x: 500, y: 20, w: 180, h: 420, kind: 'indoor' },
    ],
    fixtures: [
      { kind: 'counter', label: 'Bar', x: 620, y: 60, w: 40, h: 340 },
      { kind: 'door', label: 'Intrare', x: 200, y: 430, w: 90, h: 10 },
      { kind: 'plant', x: 450, y: 50 },
    ],
    tables: [
      { id: 'T1', name: 'Masa 1', zone: 'hall', shape: 'round', x: 100, y: 100, r: 32, seats: 2 },
      { id: 'T2', name: 'Masa 2', zone: 'hall', shape: 'round', x: 240, y: 100, r: 32, seats: 2 },
      { id: 'T3', name: 'Masa 3', zone: 'hall', shape: 'rect', x: 380, y: 100, w: 70, h: 70, seats: 4 },
      { id: 'T4', name: 'Masa 4', zone: 'hall', shape: 'rect', x: 140, y: 260, w: 140, h: 64, seats: 6 },
      { id: 'T5', name: 'Masa 5', zone: 'hall', shape: 'rect', x: 370, y: 260, w: 70, h: 70, seats: 4 },
      { id: 'B1', name: 'Bar 1', zone: 'bar', shape: 'round', x: 560, y: 120, r: 22, seats: 2 },
      { id: 'B2', name: 'Bar 2', zone: 'bar', shape: 'round', x: 560, y: 230, r: 22, seats: 2 },
      { id: 'B3', name: 'Bar 3', zone: 'bar', shape: 'round', x: 560, y: 340, r: 22, seats: 2 },
    ],
  },
  categories,
  items: localItems,
  devices: {
    fiscal: { driver: process.env.BUCURESTI_FISCAL_DRIVER || 'simulated' },
    printers: { kitchen: { driver: 'none' }, bar: { driver: 'none' } },
  },
};
