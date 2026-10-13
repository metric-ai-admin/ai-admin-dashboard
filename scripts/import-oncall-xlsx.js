#!/usr/bin/env node
//
// Load a hand-built on-call calendar into the dashboard.
//
//   node scripts/import-oncall-xlsx.js "C:\\...\\OnCall_Rotation_October_2026.xlsx"
//   node scripts/import-oncall-xlsx.js <file> --state approved
//   ... takes --dry-run
//
// WHY THIS EXISTS. November generated wrong: October was never in the
// dashboard, so the generator did not know that Oct Week 5 (Sat 10/31 – Fri
// 11/06) is Carlos + Angel. Without that, the carry-in is empty, the same pair
// can be handed Week 1, and the fairness table counts a week nobody is told
// about. The month before is not a detail of this month's calendar; it is an
// input to it.
//
// IT IS IMPORTED VERBATIM. The pairs and the property assignment are read off
// the file and stored as they are — INCLUDING Week 3, where José took the north
// and Angel the south, which Arturo has since confirmed was an oversight. That
// week is what was actually in force, and a calendar nobody worked is not a
// record of October. The deviation is reported, not corrected.
//
// Rows are found by their content, not by position: the September file has one
// fewer leading blank row than October's.
require('dotenv').config();

const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const R = require('../lib/oncall-rotation.js');
const GEO = require('../lib/property-geo.js');

const DRY = process.argv.includes('--dry-run');
const stateAt = process.argv.indexOf('--state');
const STATE = stateAt > -1 ? process.argv[stateAt + 1] : 'approved';
const file = process.argv.slice(2).find(a => !a.startsWith('--') && /\.xlsx?$/i.test(a));

if (!file) {
  console.error('usage: import-oncall-xlsx.js <file.xlsx> [--state approved|draft] [--dry-run]');
  process.exit(1);
}
if (!R.STATES.includes(STATE)) {
  console.error('--state must be one of ' + R.STATES.join(', '));
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const clean = s => String(s == null ? '' : s).trim();
const squash = s => clean(s).replace(/\s+/g, ' ');

(async () => {
  const wb = XLSX.readFile(file);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
    { header: 1, raw: false, defval: '' });

  const titleRow = aoa.find(r => /ON-CALL ROTATION CALENDAR/i.test(clean(r[0])));
  if (!titleRow) throw new Error('No "ON-CALL ROTATION CALENDAR" title — is this an on-call file?');
  const m = squash(titleRow[0]).match(/—\s*([A-Za-z]+)\s+(\d{4})/);
  if (!m) throw new Error('Could not read the month from: ' + squash(titleRow[0]));
  const month = R.MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase()) + 1;
  const year = Number(m[2]);
  if (!month) throw new Error('Unknown month "' + m[1] + '"');

  const techRow = aoa.find(r => /^On-Call Techs$/i.test(clean(r[0])));
  if (!techRow) throw new Error('No "On-Call Techs" row');
  const weekCount = techRow.slice(1).filter(c => clean(c)).length;

  // The roster, so first names in the grid become the full names everything
  // else uses. Matched without accents: the file says "Jose Renteria".
  const { data: techs, error: tErr } = await db.from('technicians')
    .select('id,full_name,active,position,show_on_map,home_lat,home_lng');
  if (tErr) throw new Error(tErr.message);
  const byFirst = new Map();
  (techs || []).forEach(t => {
    const full = clean(t.full_name);
    const first = GEO.normName(full).split(' ')[0];
    if (full && !byFirst.has(first)) byFirst.set(first, full);
  });
  const full = raw => {
    const n = GEO.normName(raw);
    if (!n) return null;
    const exact = (techs || []).find(t => GEO.normName(t.full_name) === n);
    if (exact) return clean(exact.full_name);
    return byFirst.get(n.split(' ')[0]) || null;
  };

  const unknown = new Set();
  const pairs = techRow.slice(1, 1 + weekCount).map(cell => squash(cell)
    .replace(/\(draft\)/ig, '')
    .split('+').map(s => {
      const name = full(s);
      if (!name) unknown.add(squash(s));
      return name;
    }).filter(Boolean));

  const { data: assigns, error: aErr } = await db.from('property_assignments')
    .select('property,maintenance_tech,grounds_tech');
  if (aErr) throw new Error(aErr.message);
  const { properties } = GEO.propertiesFrom(assigns || []);
  const propByNorm = new Map(properties.map(p => [GEO.normName(p.name), p]));
  // The Coverage Map spells it "Windy Hill"; the file may use either.
  Object.entries(GEO.ALIASES).forEach(([from, to]) => {
    const p = propByNorm.get(GEO.normName(to));
    if (p) propByNorm.set(GEO.normName(from), p);
  });

  // The structure — weeks, dates, carry-in — is computed, because it is a fact
  // about the calendar and not something to re-read from a spreadsheet. The
  // PAIRS and the ASSIGNMENT come from the file.
  // THE CARRY-IN IS IN THE FILE, so it is read rather than asked for. The
  // DRAFT line carries it: "Note: Oct 01–02 (7:59am) covered by September Week
  // 4 rotation (Carlos + Angel)." Importing a month without it would store the
  // same hole that made November generate wrong, one month further back.
  const draftLine = squash((aoa.find(r => /Pending approval|Prepared by/i.test(clean(r[0]))) || [])[0]);
  const carryNote = draftLine.match(/covered by ([A-Za-z]+ Week \d+)[^(]*\(([^)]+)\)/i);
  const carryPair = carryNote
    ? carryNote[2].split('+').map(s => full(s)).filter(Boolean)
    : [];
  const carryFrom = carryNote ? carryNote[1] : null;
  if (carryNote && carryPair.length !== 2) {
    console.log('WARNING: could not resolve the carry-in pair "' + carryNote[2] + '" to the roster.');
  }

  const doc = R.build({
    year, month, technicians: techs || [], properties,
    carryPair, carryFrom,
  });
  if (doc.weeks.length !== weekCount) {
    throw new Error(`the file has ${weekCount} weeks, ${R.MONTHS[month - 1]} ${year} has ${doc.weeks.length}`);
  }

  const assignRows = aoa.filter(r => propByNorm.has(GEO.normName(r[0])));
  if (assignRows.length !== properties.length) {
    console.log('WARNING: ' + assignRows.length + ' property rows in the file, '
      + properties.length + ' properties on the roster.');
  }

  const deviations = [];
  const techByName = {};
  R.poolFrom(techs || []).pool.forEach(p => { techByName[p.name] = p; });

  doc.weeks.forEach((w, i) => {
    w.pair = pairs[i] || [];
    // What the RULE would have done with the pair the FILE names. Comparing
    // against the generated week would compare two different pairings and call
    // every cell a disagreement — which is how a diff becomes noise.
    // Against the rule AS IT STANDS TODAY — Bekah's groups, not the
    // ownership-and-proximity rule that was in force when this file was
    // written. The diff is "what would we produce for this week now", which is
    // the only question worth asking of an old calendar.
    const generated = w.pair.length === 2
      ? require('../lib/oncall-groups.js').assignGroups(w.pair, properties).assign
      : {};
    assignRows.forEach(r => {
      const p = propByNorm.get(GEO.normName(r[0]));
      const who = full(r[i + 1]);
      if (!p || !who) return;
      if (!w.pair.includes(who)) {
        console.log('WARNING: ' + w.label + ' gives ' + p.name + ' to ' + who
          + ', who is not on call that week. Taken from the file anyway.');
      }
      w.assign[p.name] = who;
      w.reasons[p.name] = 'imported from the hand-built calendar';
    });
    Object.keys(w.assign).forEach(k => {
      if (generated[k] && generated[k] !== w.assign[k]) {
        deviations.push({ week: w.label, property: k, file: w.assign[k], rule: generated[k] });
      }
    });
    w.guard = null;
    w.edited = [];
  });

  doc.fairness = R.fairness(doc.weeks, doc.carry.pair, doc.pool.map(n => ({ name: n })));
  doc.state = STATE;
  doc.importedFrom = path.basename(file);
  doc.importedAt = new Date().toISOString();

  // ---- what it found -------------------------------------------------------
  console.log(doc.monthName + ' — ' + doc.weeks.length + ' weeks, from ' + path.basename(file));
  doc.weeks.forEach(w => console.log('   ' + w.label.padEnd(8) + w.range
    + (w.spillsInto ? '  [spills into ' + w.spillsInto + ']' : '')
    + '   ' + w.pair.map(R.shortOf).join(' + ')));
  if (unknown.size) console.log('\nNames not on the roster: ' + [...unknown].join(', '));

  console.log('\nTHE CARRY-IN THIS GIVES THE NEXT MONTH:');
  const last = doc.weeks[doc.weeks.length - 1];
  console.log('   ' + last.label + ' (' + last.range + ')  ' + last.pair.join(' + '));
  console.log('   That is what was missing when November was generated.');

  if (deviations.length) {
    console.log('\nWHERE THE FILE AND THE RULE DISAGREE (' + deviations.length
      + ' cells) — imported as the file has it:');
    const byWeek = {};
    deviations.forEach(d => { (byWeek[d.week] = byWeek[d.week] || []).push(d); });
    Object.entries(byWeek).forEach(([w, ds]) => console.log('   ' + w + ': ' + ds.length
      + ' properties, e.g. ' + ds[0].property + ' → ' + R.shortOf(ds[0].file)
      + ' (the rule says ' + R.shortOf(ds[0].rule) + ')'));
    console.log('   A calendar nobody worked is not a record of the month.');
  }

  if (DRY) { console.log('\nDRY RUN — nothing written.'); return; }

  const { error } = await db.from('oncall_rotations').upsert({
    year, month, state: STATE, draft: doc, edits: [],
    approvals: STATE === 'approved'
      ? [{ by: 'Imported from ' + path.basename(file), at: new Date().toISOString(),
        note: 'Built by hand before the generator existed.' }]
      : [],
    carry_pair: doc.carry.pair, carry_from: doc.carry.from,
    created_by: 'scripts/import-oncall-xlsx.js',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'year,month' });
  if (error) throw new Error(error.message);
  console.log('\nstored: ' + doc.monthName + ' as ' + STATE);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
