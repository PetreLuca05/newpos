// Valori specifice României, comune tuturor locațiilor.
// Cotele TVA pot fi actualizate automat din TEDB (vezi src/legal.js).

// Cote TVA conform Codului fiscal (în vigoare de la 1 august 2025):
//   A = 21% (cota standard)     — băuturi alcoolice (cu excepția berii)
//   B = 11% (cota redusă)       — servicii de restaurant: mâncare, băuturi nealcoolice, bere (NC 2203 00)
//   D = 0%  (scutit)            — nefolosit în meniu, păstrat pentru raport
// Verificați încadrarea cu contabilul înainte de utilizare reală.
const vatGroups = [
  { code: 'A', rate: 21, label: 'Cota A 21%' },
  { code: 'B', rate: 11, label: 'Cota B 11%' },
  { code: 'D', rate: 0, label: 'Cota D 0% (scutit)' },
];

// Metode de încasare. `fiscal` = tipul de plată trimis la casa de marcat (AMEF):
// numerar, card, tichete (masă / cadou), alte (transfer, credit, protocol).
const paymentMethods = [
  { id: 'cash', name: 'Numerar', fiscal: 'cash', change: true },
  { id: 'eur', name: 'Numerar EUR (curs BNR)', fiscal: 'cash', change: true, currency: 'EUR' },
  { id: 'card', name: 'Card', fiscal: 'card' },
  { id: 'meal', name: 'Tichete de masă', fiscal: 'meal' },
  { id: 'gift', name: 'Voucher / card cadou', fiscal: 'voucher' },
  { id: 'transfer', name: 'Ordin de plată (factură)', fiscal: 'other' },
  { id: 'account', name: 'Pe cont client (credit)', fiscal: 'other' },
  { id: 'protocol', name: 'Protocol / consum propriu', fiscal: 'other' },
];

// Tipuri de comenzi: la masă (QR sau ospătar), la pachet, livrare.
const orderKinds = [
  { id: 'table', name: 'La masă' },
  { id: 'takeaway', name: 'La pachet' },
  { id: 'delivery', name: 'Livrare' },
];

module.exports = { vatGroups, paymentMethods, orderKinds };
