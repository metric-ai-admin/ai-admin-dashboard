// How the Collections Review orders its delinquency lists.
//
// The review has always been a balance ranking. Rocío works the list by walking
// a building, so Kara asked (2026-10-08) for the option to read it by property
// and unit instead.
//
// THE SELECTION IS ALWAYS BY BALANCE. Only the ORDER changes. Taking the
// twenty-five alphabetically-first properties rather than the twenty-five
// largest debts would quietly drop the accounts the review exists for, and the
// report would look equally complete either way — so `pick` runs first and
// `sortMode` only decides how what it picked is arranged.

// Natural unit order: "2" before "10", "B2" before "B12". A plain string
// compare puts unit 10 ahead of unit 2, which is the kind of wrong nobody
// reports as a bug and everybody works around.
function unitKey(u) {
  return String(u == null ? '' : u).trim().toLowerCase()
    .replace(/\d+/g, d => d.padStart(10, '0'));
}

function byPropertyUnit(a, b) {
  return String(a.property || '').localeCompare(String(b.property || ''))
    || unitKey(a.unit).localeCompare(unitKey(b.unit))
    || String(a.name || '').localeCompare(String(b.name || ''));
}

// 'property' or 'balance'. Anything else — absent, misspelt, a number — is
// balance, the behaviour every existing caller already gets.
function normalizeMode(v) {
  return String(v == null ? '' : v).toLowerCase() === 'property' ? 'property' : 'balance';
}

// `picked` is already the top N by balance, in balance order.
function arrange(picked, mode) {
  return normalizeMode(mode) === 'property' ? [...picked].sort(byPropertyUnit) : [...picked];
}

// Renders the list for the prompt. In property mode each property is named once
// as a heading, so the model is not left to infer the grouping from a repeated
// column.
function render(picked, mode, line) {
  const list = arrange(picked, mode);
  if (normalizeMode(mode) !== 'property') return list.map(line).join('\n');
  const out = [];
  let seen = null;
  for (const r of list) {
    const prop = String(r.property || '(no property)');
    if (prop !== seen) { out.push('-- ' + prop + ' --'); seen = prop; }
    out.push(line(r));
  }
  return out.join('\n');
}

module.exports = { unitKey, byPropertyUnit, normalizeMode, arrange, render };
