// Meniul comun al brandului „Smochinul de Aramă” (fictiv). Fiecare locație îl poate suprascrie.

const categories = [
  { id: 'starters', name: 'Aperitive' },
  { id: 'salads', name: 'Ciorbe & Salate' },
  { id: 'mains', name: 'Feluri principale' },
  { id: 'pasta', name: 'Pizza & Paste' },
  { id: 'desserts', name: 'Deserturi' },
  { id: 'soft', name: 'Băuturi răcoritoare' },
  { id: 'coffee', name: 'Cafea & Ceai' },
  { id: 'beer', name: 'Bere & Cidru' },
  { id: 'wine', name: 'Vin' },
  { id: 'cocktails', name: 'Cocktailuri' },
];

// tags: v = vegetarian, vg = vegan, gf = fără gluten, sp = picant, a = conține alcool
// qty = gramaj / cantitate afișată în meniu (obligatoriu în meniurile din România)
// allergens = alergeni conform Reg. (UE) 1169/2011 (listă simplificată, fictivă)
// vat = codul cotei TVA (vezi vatGroups)
const items = [
  // Aperitive
  { id: 'st-bruschetta', cat: 'starters', emoji: '🍅', name: 'Bruschetta cu smochine și burrata', desc: 'Pâine cu maia la grătar, burrata, smochine coapte, miere, cimbru.', qty: '220 g', allergens: ['gluten', 'lapte'], price: 3400, vat: 'B', tags: ['v'] },
  { id: 'st-calamari', cat: 'starters', emoji: '🦑', name: 'Calamar crocant', desc: 'Aioli cu lămâie, sare cu boia afumată.', qty: '200 g', allergens: ['gluten', 'moluște', 'ouă'], price: 3900, vat: 'B', tags: [] },
  { id: 'st-board', cat: 'starters', emoji: '🧀', name: 'Platou Aramă', desc: 'Mezeluri maturate, trei brânzeturi, murături, dulceață de smochine. Pentru 2.', qty: '450 g', allergens: ['lapte', 'gluten', 'nuci'], price: 6800, vat: 'B', tags: [] },
  { id: 'st-zacusca', cat: 'starters', emoji: '🫑', name: 'Zacuscă afumată', desc: 'Zacuscă de casă din ardei copți și vinete, lipie caldă.', qty: '250 g', allergens: ['gluten'], price: 2600, vat: 'B', tags: ['vg'] },
  { id: 'st-jumari', cat: 'starters', emoji: '🥓', name: 'Jumări cu ceapă roșie', desc: 'Jumări de casă, ceapă roșie, pâine de casă.', qty: '200 g', allergens: ['gluten'], price: 2900, vat: 'B', tags: [] },
  { id: 'st-fries', cat: 'starters', emoji: '🍟', name: 'Cartofi cu trufe și parmezan', desc: 'Cartofi tăiați manual, ulei de trufe, parmezan, pătrunjel.', qty: '250 g', allergens: ['lapte'], price: 2400, vat: 'B', tags: ['v'] },

  // Ciorbe & salate
  { id: 'sa-ciorba', cat: 'salads', emoji: '🍲', name: 'Ciorbă de burtă', desc: 'Cu smântână, ardei iute și pâine.', qty: '400 ml', allergens: ['lapte', 'ouă', 'țelină'], price: 2800, vat: 'B', tags: ['sp'] },
  { id: 'sa-radauteana', cat: 'salads', emoji: '🍲', name: 'Ciorbă rădăuțeană', desc: 'Ciorbă de pui cu smântână și usturoi.', qty: '400 ml', allergens: ['lapte', 'ouă', 'țelină'], price: 2600, vat: 'B', tags: [] },
  { id: 'sa-tomato', cat: 'salads', emoji: '🥣', name: 'Supă cremă de roșii coapte', desc: 'Ulei de busuioc, semințe prăjite, crutoane.', qty: '350 ml', allergens: ['gluten'], price: 2400, vat: 'B', tags: ['vg'] },
  { id: 'sa-caesar', cat: 'salads', emoji: '🥗', name: 'Salată Caesar cu pui', desc: 'Lăptucă romană, pui la grătar, dressing cu anșoa, parmezan.', qty: '350 g', allergens: ['gluten', 'lapte', 'ouă', 'pește'], price: 4200, vat: 'B', tags: [] },
  { id: 'sa-beet', cat: 'salads', emoji: '🥬', name: 'Sfeclă coaptă cu brânză de capră', desc: 'Sfeclă, cremă de brânză de capră, nuci, rucola, balsamic.', qty: '300 g', allergens: ['lapte', 'nuci'], price: 3800, vat: 'B', tags: ['v', 'gf'] },

  // Feluri principale
  { id: 'mn-burger', cat: 'mains', emoji: '🍔', name: 'Burger Smochinul', desc: 'Vită maturată, chutney de smochine, cheddar, bacon, chiflă brioșă, cartofi.', qty: '200 g / 150 g', allergens: ['gluten', 'lapte', 'ouă', 'muștar', 'susan'], price: 5900, vat: 'B', tags: [] },
  { id: 'mn-steak', cat: 'mains', emoji: '🥩', name: 'Antricot de vită 300 g', desc: 'Sos de piper, cartofi copți.', qty: '300 g / 200 g', allergens: ['lapte'], price: 12900, vat: 'B', tags: ['gf'] },
  { id: 'mn-salmon', cat: 'mains', emoji: '🐟', name: 'Somon la tigaie', desc: 'Cartofi zdrobiți, salicornia, sos beurre blanc cu lămâie.', qty: '180 g / 200 g', allergens: ['pește', 'lapte'], price: 7800, vat: 'B', tags: ['gf'] },
  { id: 'mn-sarmale', cat: 'mains', emoji: '🥬', name: 'Sarmale cu mămăligă', desc: 'Sarmale în foi de varză cu afumătură, mămăligă, smântână, ardei iute.', qty: '350 g / 200 g', allergens: ['lapte'], price: 4900, vat: 'B', tags: [] },
  { id: 'mn-mici', cat: 'mains', emoji: '🌭', name: 'Mici cu muștar (5 buc.)', desc: 'Mici la grătar, muștar, cartofi prăjiți.', qty: '250 g / 200 g', allergens: ['muștar'], price: 3900, vat: 'B', tags: [] },
  { id: 'mn-tochitura', cat: 'mains', emoji: '🍳', name: 'Tochitură moldovenească', desc: 'Porc, cârnați, mămăligă, ou ochi, telemea.', qty: '450 g', allergens: ['lapte', 'ouă'], price: 5400, vat: 'B', tags: [] },
  { id: 'mn-risotto', cat: 'mains', emoji: '🍄', name: 'Risotto cu ciuperci de pădure', desc: 'Hribi, mascarpone, parmezan, trufe.', qty: '350 g', allergens: ['lapte', 'țelină'], price: 5200, vat: 'B', tags: ['v', 'gf'] },
  { id: 'mn-curry', cat: 'mains', emoji: '🍛', name: 'Curry cu năut și cartof dulce', desc: 'Lapte de cocos, spanac, orez iasomie, coriandru.', qty: '400 g', allergens: [], price: 4600, vat: 'B', tags: ['vg', 'gf', 'sp'] },

  // Pizza & paste
  { id: 'pp-margherita', cat: 'pasta', emoji: '🍕', name: 'Pizza Margherita', desc: 'Sos de roșii San Marzano, fior di latte, busuioc.', qty: '450 g', allergens: ['gluten', 'lapte'], price: 3900, vat: 'B', tags: ['v'] },
  { id: 'pp-diavola', cat: 'pasta', emoji: '🌶️', name: 'Pizza Diavola', desc: 'Salam picant, ulei cu chili, mozzarella, oregano.', qty: '480 g', allergens: ['gluten', 'lapte'], price: 4600, vat: 'B', tags: ['sp'] },
  { id: 'pp-fig', cat: 'pasta', emoji: '🍕', name: 'Pizza cu smochine și prosciutto', desc: 'Gorgonzola, smochine, prosciutto, rucola, miere.', qty: '480 g', allergens: ['gluten', 'lapte'], price: 5200, vat: 'B', tags: [] },
  { id: 'pp-carbonara', cat: 'pasta', emoji: '🍝', name: 'Spaghete Carbonara', desc: 'Guanciale, gălbenuș, pecorino, piper negru.', qty: '350 g', allergens: ['gluten', 'lapte', 'ouă'], price: 4800, vat: 'B', tags: [] },
  { id: 'pp-pesto', cat: 'pasta', emoji: '🍝', name: 'Trofie al pesto', desc: 'Pesto de busuioc, fasole verde, cartof, semințe de pin.', qty: '350 g', allergens: ['gluten', 'lapte', 'nuci'], price: 4400, vat: 'B', tags: ['v'] },

  // Deserturi
  { id: 'ds-papanasi', cat: 'desserts', emoji: '🍩', name: 'Papanași', desc: 'Cu smântână și dulceață de vișine.', qty: '250 g', allergens: ['gluten', 'lapte', 'ouă'], price: 3200, vat: 'B', tags: ['v'] },
  { id: 'ds-fondant', cat: 'desserts', emoji: '🍫', name: 'Fondant de ciocolată', desc: 'Miez lichid, înghețată de vanilie.', qty: '180 g', allergens: ['gluten', 'lapte', 'ouă'], price: 3400, vat: 'B', tags: ['v'] },
  { id: 'ds-tiramisu', cat: 'desserts', emoji: '☕', name: 'Tiramisu', desc: 'Mascarpone, pișcoturi însiropate în espresso, cacao.', qty: '180 g', allergens: ['gluten', 'lapte', 'ouă'], price: 3000, vat: 'B', tags: ['v'] },
  { id: 'ds-cheesecake', cat: 'desserts', emoji: '🍰', name: 'Cheesecake cu smochine', desc: 'Cheesecake copt cu vanilie, compot de smochine, crumble de migdale.', qty: '170 g', allergens: ['gluten', 'lapte', 'ouă', 'nuci'], price: 3200, vat: 'B', tags: ['v'] },
  { id: 'ds-sorbet', cat: 'desserts', emoji: '🍧', name: 'Trio de sorbet', desc: 'Zmeură, lămâie și mango.', qty: '3 x 50 g', allergens: [], price: 2400, vat: 'B', tags: ['vg', 'gf'] },

  // Băuturi răcoritoare
  { id: 'sd-lemonade', cat: 'soft', emoji: '🍋', name: 'Limonadă de casă', desc: 'Lămâie, mentă, zahăr din trestie.', qty: '400 ml', allergens: [], price: 1800, vat: 'B', tags: ['vg'] },
  { id: 'sd-figlemonade', cat: 'soft', emoji: '🥤', name: 'Limonadă cu smochine și ghimbir', desc: 'Specialitatea casei.', qty: '400 ml', allergens: [], price: 2000, vat: 'B', tags: ['vg'] },
  { id: 'sd-cola', cat: 'soft', emoji: '🥤', name: 'Cola', desc: 'Sticlă.', qty: '330 ml', allergens: [], price: 1200, vat: 'B', tags: ['vg'] },
  { id: 'sd-water', cat: 'soft', emoji: '💧', name: 'Apă minerală / plată', desc: 'Izvor din Carpați.', qty: '750 ml', allergens: [], price: 1400, vat: 'B', tags: ['vg'] },
  { id: 'sd-juice', cat: 'soft', emoji: '🍊', name: 'Fresh de portocale', desc: 'Stors pe loc.', qty: '300 ml', allergens: [], price: 1900, vat: 'B', tags: ['vg'] },

  // Cafea & ceai
  { id: 'cf-espresso', cat: 'coffee', emoji: '☕', name: 'Espresso', desc: 'Cafea de origine, prăjită local.', qty: '30 ml', allergens: [], price: 900, vat: 'B', tags: ['vg'] },
  { id: 'cf-flatwhite', cat: 'coffee', emoji: '☕', name: 'Flat White', desc: 'Dublu ristretto, lapte spumat.', qty: '180 ml', allergens: ['lapte'], price: 1400, vat: 'B', tags: ['v'] },
  { id: 'cf-cappuccino', cat: 'coffee', emoji: '☕', name: 'Cappuccino', desc: 'Espresso, spumă de lapte.', qty: '200 ml', allergens: ['lapte'], price: 1300, vat: 'B', tags: ['v'] },
  { id: 'cf-tea', cat: 'coffee', emoji: '🍵', name: 'Ceai', desc: 'Earl grey, verde, mușețel sau mentă.', qty: '400 ml', allergens: [], price: 1100, vat: 'B', tags: ['vg'] },

  // Bere & cidru — berea (NC 2203 00) intră la cota redusă în serviciile de restaurant
  { id: 'br-lager', cat: 'beer', emoji: '🍺', name: 'Bere blondă la halbă', desc: 'Lager local, nefiltrat.', qty: '500 ml', allergens: ['gluten'], price: 1600, vat: 'B', tags: ['a'] },
  { id: 'br-ipa', cat: 'beer', emoji: '🍺', name: 'Hazy IPA', desc: 'Bere artizanală, citrice și fructe.', qty: '330 ml', allergens: ['gluten'], price: 2200, vat: 'B', tags: ['a'] },
  { id: 'br-cider', cat: 'beer', emoji: '🍏', name: 'Cidru de mere', desc: 'Cidru sec transilvănean.', qty: '330 ml', allergens: ['sulfiți'], price: 1900, vat: 'A', tags: ['a', 'gf'] },
  { id: 'br-zero', cat: 'beer', emoji: '🍺', name: 'Bere fără alcool', desc: 'Sticlă.', qty: '330 ml', allergens: ['gluten'], price: 1300, vat: 'B', tags: [] },

  // Vin
  { id: 'wn-feteasca-alba', cat: 'wine', emoji: '🥂', name: 'Fetească Albă (pahar)', desc: 'Vin alb sec, Dealu Mare.', qty: '150 ml', allergens: ['sulfiți'], price: 2400, vat: 'A', tags: ['a'] },
  { id: 'wn-feteasca-neagra', cat: 'wine', emoji: '🍷', name: 'Fetească Neagră (pahar)', desc: 'Vin roșu sec, prune și condimente.', qty: '150 ml', allergens: ['sulfiți'], price: 2600, vat: 'A', tags: ['a'] },
  { id: 'wn-rose', cat: 'wine', emoji: '🍷', name: 'Rosé (pahar)', desc: 'Proaspăt, note de căpșuni.', qty: '150 ml', allergens: ['sulfiți'], price: 2300, vat: 'A', tags: ['a'] },
  { id: 'wn-bottle-red', cat: 'wine', emoji: '🍾', name: 'Vin roșu al casei (sticlă)', desc: 'Cupaj Cabernet & Fetească Neagră.', qty: '750 ml', allergens: ['sulfiți'], price: 11500, vat: 'A', tags: ['a'] },
  { id: 'wn-palinca', cat: 'wine', emoji: '🥃', name: 'Pălincă de prune', desc: 'Din Maramureș, 52% vol.', qty: '50 ml', allergens: [], price: 1800, vat: 'A', tags: ['a'] },

  // Cocktailuri
  { id: 'ck-figspritz', cat: 'cocktails', emoji: '🍹', name: 'Spritz cu smochine', desc: 'Lichior de smochine, prosecco, sifon, portocală.', qty: '300 ml', allergens: ['sulfiți'], price: 3600, vat: 'A', tags: ['a'] },
  { id: 'ck-negroni', cat: 'cocktails', emoji: '🥃', name: 'Negroni', desc: 'Gin, Campari, vermut roșu.', qty: '120 ml', allergens: ['sulfiți'], price: 3800, vat: 'A', tags: ['a'] },
  { id: 'ck-mojito', cat: 'cocktails', emoji: '🍸', name: 'Mojito', desc: 'Rom, lime, mentă, sifon.', qty: '300 ml', allergens: [], price: 3400, vat: 'A', tags: ['a'] },
  { id: 'ck-espresso-martini', cat: 'cocktails', emoji: '🍸', name: 'Espresso Martini', desc: 'Vodcă, lichior de cafea, espresso.', qty: '150 ml', allergens: [], price: 3900, vat: 'A', tags: ['a'] },
  { id: 'ck-virgin', cat: 'cocktails', emoji: '🍹', name: 'Garden Cooler (fără alcool)', desc: 'Castravete, soc, lime, apă tonică.', qty: '300 ml', allergens: [], price: 2400, vat: 'B', tags: ['vg'] },
];

module.exports = { categories, items };
