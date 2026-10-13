// The on-call calendar as Josué, Bekah and Jay already know it.
//
// THE SHAPE IS NOT NEGOTIABLE, the same way the Code Violations export's is.
// People have been reading OnCall_Rotation_September_2026.xlsx and
// OnCall_Rotation_October_2026.xlsx since August: a title, the DRAFT line with
// the carry-in note, one row per property and one column per week, an On-Call
// Techs row, a fairness check and two 📌 notes at the foot. Every string below
// is taken from those files. Changing the wording would make the export
// something people have to learn instead of something they recognise.
//
// Technician names are FIRST NAMES in the property grid and full names in the
// On-Call Techs row and the fairness table — exactly as the originals have it.

'use strict';

const R = require('./oncall-rotation.js');

const PREPARED_BY = 'Arturo Mendoza Carvajal';
const APPROVERS_LINE = 'Pending approval from Josue, Rebekah, and Jay.';
// THIS LINE HAD TO CHANGE and it is the one piece of the header that is not
// verbatim any more. It read "Properties assigned per on-call week (never by
// group) per standing policy" — which was true of the old rule and is the exact
// opposite of Bekah's, where the groups are the whole point. A header that
// contradicts the table under it is worse than one people have to re-read once.
const POLICY_LINE = 'Properties assigned by group (Red / Blue) per on-call week, '
  + 'per the rotation policy of 10/13.';

const SHORT_MONTH = m => m.slice(0, 3);

// The status line. An approved calendar must not keep saying DRAFT — that is
// the one thing in the header that is not fixed text, because a reader who
// sees "DRAFT" on an approved calendar will go looking for a newer one.
function headerLine(doc) {
  const bits = [];
  if (doc.state === 'approved') {
    const who = (doc.approvals || []).map(a => a.by).join(', ');
    bits.push('APPROVED' + (who ? ' by ' + who : '') + '.');
  } else if (doc.state === 'pending_approval') {
    bits.push('PENDING APPROVAL — ' + APPROVERS_LINE);
  } else {
    bits.push('DRAFT — ' + APPROVERS_LINE);
  }
  bits.push('Prepared by ' + PREPARED_BY + '.');
  bits.push(POLICY_LINE);
  if (doc.carry && doc.carry.note) bits.push('Note: ' + doc.carry.note + '.');
  return bits.join('  ');
}

// "Week 1\n(Sat 11/07 8am –\nFri 11/13 7:59am)" plus the spill warning. The
// line breaks are in the originals and Excel shows them because the cell wraps.
function weekHeader(w) {
  const m = String(w.range).match(/^(Sat .+? 8am) – (Fri .+ 7:59am)$/);
  const head = w.label + '\n(' + (m ? m[1] + ' –\n' + m[2] : w.range) + ')';
  return w.spillsInto ? head + '\n⚠ Spills into ' + SHORT_MONTH(w.spillsInto) : head;
}

// An edited cell is marked. A reviewer has to be able to tell what the rule
// produced from what a person decided — an approval that cannot distinguish
// them covers both without anybody noticing there was a difference.
const EDIT_MARK = ' *';

function editedProperties(week) {
  return new Set((week.edited || []).filter(e => e.type === 'property').map(e => e.property));
}
const pairEdited = week => (week.edited || []).some(e => e.type === 'pair');

/**
 * The workbook as an array of arrays, ready for XLSX.utils.aoa_to_sheet.
 * Kept separate from the writing so it can be asserted on without a file.
 */
function sheetRows(doc, properties) {
  const weeks = doc.weeks || [];
  const rows = [];

  rows.push(['ON-CALL ROTATION CALENDAR — ' + String(doc.monthName).toUpperCase()]);
  rows.push([headerLine(doc)]);
  rows.push([]);

  rows.push(['Property'].concat(weeks.map(weekHeader)));
  rows.push(['On-Call Techs'].concat(weeks.map(w => {
    const names = (w.pair || []).join(' + ');
    const tag = doc.state === 'approved' ? '' : ' (draft)';
    return names + tag + (pairEdited(w) ? EDIT_MARK : '');
  })));

  // Properties in GROUP ORDER, red block then blue, the way Bekah's old tracker
  // laid them out. The group is named in the row so the colour is not the only
  // thing carrying it — a printed calendar photocopied in black and white has
  // to stay readable, and so does a screen reader.
  const G = require('./oncall-groups.js');
  const byGroup = [];
  ['RED', 'BLUE'].forEach(key => {
    (G.GROUPS[key].properties || []).forEach(name => {
      const p = (properties || []).find(x => x.name === name);
      if (p) byGroup.push({ p, group: key });
    });
  });
  // Anything in no group still appears — a property nobody is on call for must
  // never be invisible.
  (properties || []).forEach(p => {
    if (!byGroup.some(x => x.p.name === p.name)) byGroup.push({ p, group: null });
  });

  byGroup.forEach(({ p, group }) => {
    rows.push([p.name + (group ? '  (' + G.GROUPS[group].label + ')' : '  (no group)')]
      .concat(weeks.map(w => {
        const who = w.assign ? w.assign[p.name] : null;
        if (!who) return '';
        return R.shortOf(who) + (editedProperties(w).has(p.name) ? EDIT_MARK : '');
      })));
  });

  rows.push([]);
  rows.push(['GROUPS — ' + G.GROUPS.RED.label + ': ' + G.GROUPS.RED.properties.join(', ')
    + '   |   ' + G.GROUPS.BLUE.label + ': ' + G.GROUPS.BLUE.properties.join(', ')]);
  rows.push(['Each week one technician takes ' + G.GROUPS.RED.label + ' and the other '
    + G.GROUPS.BLUE.label + '. ' + G.GROUPS.RED.label + ' goes to '
    + G.GROUPS.RED.techs.map(R.shortOf).join(' or ') + '; ' + G.GROUPS.BLUE.label + ' to '
    + G.GROUPS.BLUE.techs.map(R.shortOf).join(' or ') + '.']);

  rows.push([]);
  rows.push(['ROTATION FAIRNESS CHECK — On-call weeks per technician ('
    + SHORT_MONTH(String(doc.monthName).split(' ')[0]) + ' ' + doc.year + ' cycle)']);
  rows.push(['Technician', 'Weeks On-Call', 'Which Weeks']);
  ((doc.fairness && doc.fairness.rows) || []).forEach(r => {
    rows.push([
      r.technician,
      // "1 (+Sep 01-04 via Aug W5)" is the originals' own phrasing: the carry-in
      // week was served, in the previous month's calendar, and a bare count
      // would read as that technician having had a lighter month.
      r.carried && doc.carry && doc.carry.days
        ? r.weeks + ' (+' + carryShort(doc) + ' via ' + prevWeekShort(doc) + ')'
        : String(r.weeks),
      r.which,
    ]);
  });

  rows.push([]);
  if (doc.carry && doc.carry.days) {
    rows.push(['📌 Note: ' + doc.carry.note + '. Full ' + String(doc.monthName).split(' ')[0]
      + ' on-call begins ' + firstWeekStart(doc) + '.']);
  }
  const last = weeks[weeks.length - 1];
  if (last && last.spillsInto) {
    rows.push(['📌 Note: ' + last.label + ' (' + last.range + ') spills into '
      + last.spillsInto + '. ' + (last.pair || []).join(' + ')
      + ' carry forward unless the ' + last.spillsInto + ' rotation is confirmed before '
      + startDayOf(last) + '.']);
  }
  if ((doc.excluded || []).length) {
    rows.push(['📌 Not in the on-call pool: '
      + doc.excluded.map(e => e.name + ' (' + e.reason + ')').join('; ') + '.']);
  }
  if (weeks.some(w => (w.edited || []).length)) {
    rows.push(['📌 ' + EDIT_MARK.trim() + ' marks a cell changed by hand after the rotation was generated.']);
  }
  if (doc.fairness && doc.fairness.note) rows.push(['📌 ' + doc.fairness.note]);
  // A broken hard constraint is on the FACE of the calendar, not in a log. The
  // three people approving it are the ones who would catch it.
  (doc.weeks || []).forEach(w => (w.violations || []).forEach(v =>
    rows.push(['⚠ ' + w.label + ': ' + v.message])));
  (doc.warnings || []).forEach(w => rows.push(['📌 ' + w]));

  return rows;
}

const carryShort = doc => {
  const mon = SHORT_MONTH(String(doc.monthName).split(' ')[0]);
  return mon + ' 01-' + String(doc.carry.days).padStart(2, '0');
};
const prevWeekShort = doc => {
  const from = doc.carry && doc.carry.from ? String(doc.carry.from) : '';
  const m = from.match(/^(\w{3})\w*\s+Week\s+(\d+)$/i);
  return m ? m[1] + ' W' + m[2] : (from || 'the previous month');
};
const firstWeekStart = doc => {
  const w = (doc.weeks || [])[0];
  if (!w) return '—';
  const m = String(w.range).match(/^(Sat [\d/]+ 8am)/);
  return m ? m[1] : w.range;
};
const startDayOf = week => {
  const m = String(week.range).match(/^Sat ([\d/]+)/);
  return m ? m[1] : week.range;
};

// Column widths, so the week headers are readable without anybody dragging a
// column. The originals are formatted; an export that needs manual fixing is
// one people stop using.
function columnWidths(doc) {
  return [{ wch: 24 }].concat((doc.weeks || []).map(() => ({ wch: 26 })));
}

module.exports = {
  PREPARED_BY, APPROVERS_LINE, POLICY_LINE, EDIT_MARK,
  headerLine, weekHeader, sheetRows, columnWidths, editedProperties, pairEdited,
};
