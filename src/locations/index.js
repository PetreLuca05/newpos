// Registry of locations. Add a location = add a file here and list it in LOCATION_FILES.
// A server process loads either all locations or only those in env LOCATIONS (e.g. "cluj,bucuresti"),
// so locations can be spread over several servers that share the same database.

const { vatGroups, paymentMethods, orderKinds } = require('../ro');

const LOCATION_FILES = ['./cluj', './bucuresti'];

function prepare(config) {
  if (!/^[a-z0-9-]{2,32}$/.test(config.id)) throw new Error(`ID locație invalid: ${config.id}`);
  return {
    ...config,
    vatGroups, // shared object: updated in place by the legal sync
    paymentMethods,
    orderKinds,
    itemsById: new Map(config.items.map((i) => [i.id, i])),
    tablesById: new Map(config.floor.tables.map((t) => [t.id, t])),
  };
}

function loadLocations(filter = process.env.LOCATIONS) {
  const wanted = filter ? new Set(filter.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const all = LOCATION_FILES.map((f) => prepare(require(f)));
  const ids = new Set();
  for (const l of all) {
    if (ids.has(l.id)) throw new Error(`Locație duplicată: ${l.id}`);
    ids.add(l.id);
  }
  return all.filter((l) => !wanted || wanted.has(l.id));
}

module.exports = { loadLocations, prepare };
