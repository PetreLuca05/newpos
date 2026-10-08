// Locația 1 (fictivă): Cluj-Napoca — salon, terasă și bar.
const { categories, items } = require('./menu-smochinul');

const restaurant = {
  id: 'cluj',
  name: 'Smochinul de Aramă',
  tagline: 'Bistro & Bar',
  company: 'SMOCHINUL DE ARAMĂ SRL',
  cui: 'RO12345678', // fictiv
  regCom: 'J12/1234/2024', // fictiv
  address: 'Str. Felinarului nr. 17, Cluj-Napoca, jud. Cluj',
  phone: '0264 000 000',
  currency: 'RON',
  currencySymbol: 'lei',
  locale: 'ro-RO',
  timeZone: 'Europe/Bucharest',
};

// Plan de sală văzut de sus. Coordonate într-un viewBox SVG de 1000 x 660.
// shape: 'round' folosește r, 'rect' folosește w/h. Scaunele sunt desenate în jurul mesei.
const floor = {
  width: 1000,
  height: 660,
  zones: [
    { id: 'hall', name: 'Salon', x: 30, y: 30, w: 600, h: 400, kind: 'indoor' },
    { id: 'terrace', name: 'Terasă', x: 30, y: 470, w: 600, h: 160, kind: 'outdoor' },
    { id: 'bar', name: 'Bar', x: 660, y: 30, w: 310, h: 340, kind: 'indoor' },
    { id: 'kitchen', name: 'Bucătărie', x: 660, y: 400, w: 310, h: 230, kind: 'service' },
  ],
  fixtures: [
    { kind: 'counter', label: 'Tejghea bar', x: 690, y: 60, w: 250, h: 40 },
    { kind: 'counter', label: 'Pass', x: 690, y: 410, w: 250, h: 26 },
    { kind: 'door', label: 'Intrare', x: 30, y: 180, w: 10, h: 80 },
    { kind: 'door', label: 'Ieșire terasă', x: 250, y: 430, w: 120, h: 10 },
    { kind: 'plant', x: 600, y: 60 },
    { kind: 'plant', x: 600, y: 400 },
    { kind: 'plant', x: 60, y: 600 },
    { kind: 'plant', x: 600, y: 600 },
    { kind: 'plant', x: 945, y: 345 },
  ],
  tables: [
    // Salon
    { id: 'T1', name: 'Masa 1', zone: 'hall', shape: 'round', x: 110, y: 110, r: 30, seats: 2 },
    { id: 'T2', name: 'Masa 2', zone: 'hall', shape: 'round', x: 230, y: 110, r: 30, seats: 2 },
    { id: 'T3', name: 'Masa 3', zone: 'hall', shape: 'rect', x: 365, y: 110, w: 70, h: 70, seats: 4 },
    { id: 'T4', name: 'Masa 4', zone: 'hall', shape: 'rect', x: 510, y: 110, w: 70, h: 70, seats: 4 },
    { id: 'T5', name: 'Masa 5', zone: 'hall', shape: 'rect', x: 160, y: 250, w: 150, h: 64, seats: 6 },
    { id: 'T6', name: 'Masa 6', zone: 'hall', shape: 'rect', x: 365, y: 250, w: 70, h: 70, seats: 4 },
    { id: 'T7', name: 'Masa 7', zone: 'hall', shape: 'rect', x: 510, y: 250, w: 120, h: 64, seats: 6 },
    { id: 'T8', name: 'Masa 8', zone: 'hall', shape: 'round', x: 160, y: 370, r: 34, seats: 4 },
    { id: 'T9', name: 'Masa 9', zone: 'hall', shape: 'round', x: 420, y: 370, r: 42, seats: 8 },
    // Terasă
    { id: 'T10', name: 'Terasa 10', zone: 'terrace', shape: 'round', x: 120, y: 550, r: 30, seats: 2 },
    { id: 'T11', name: 'Terasa 11', zone: 'terrace', shape: 'rect', x: 250, y: 550, w: 70, h: 70, seats: 4 },
    { id: 'T12', name: 'Terasa 12', zone: 'terrace', shape: 'rect', x: 390, y: 550, w: 70, h: 70, seats: 4 },
    { id: 'T13', name: 'Terasa 13', zone: 'terrace', shape: 'round', x: 520, y: 550, r: 34, seats: 4 },
    // Bar
    { id: 'B1', name: 'Bar 1', zone: 'bar', shape: 'round', x: 720, y: 200, r: 24, seats: 2 },
    { id: 'B2', name: 'Bar 2', zone: 'bar', shape: 'round', x: 815, y: 200, r: 24, seats: 2 },
    { id: 'B3', name: 'Bar 3', zone: 'bar', shape: 'round', x: 910, y: 200, r: 24, seats: 2 },
    { id: 'B4', name: 'Bar 4', zone: 'bar', shape: 'rect', x: 815, y: 300, w: 110, h: 50, seats: 4 },
  ],
};


module.exports = {
  ...restaurant,
  floor,
  categories,
  items,
  // Casa de marcat (AMEF) a acestei locații. Vezi src/devices.js pentru drivere.
  devices: {
    fiscal: { driver: process.env.CLUJ_FISCAL_DRIVER || 'simulated' },
    printers: { kitchen: { driver: 'none' }, bar: { driver: 'none' } },
  },
};
