// Kara's brief as email HTML.
//
// WHY NOT <pre>. The first version wrapped the plain-text layout in one <pre>
// block, which reads correctly when the mail is opened and collapses into a
// single paragraph the moment anybody forwards it — Outlook drops the tag on
// reply and forward — and wraps badly on a phone, where a fixed-width block
// has nowhere to go.
//
// So: tables, inline styles, nothing that depends on a stylesheet surviving a
// trip through two mail clients. No <pre> anywhere, which a test asserts.
//
// STILL NO GRAPHICS. She asked for numbers. The only visual device here is a
// red bullet on a broken threshold, because "which ones are red" is the one
// thing the layout has to answer before she reads a word.

'use strict';

const B = require('./kara-brief.js');
const CALLS = require('./brief-calls.js');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Colours kept to three, named once. A palette is a thing to maintain.
const INK = '#1a1a1a';
const MUTED = '#666666';
const RED = '#b00020';
const RULE = '#dddddd';

const FONT = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif";

// A two-column row: label on the left, value on the right.
//
// Left-aligned values, not right. These are counts and percentages of
// different kinds, and a column of right-aligned mixed units reads as a total
// that was never computed.
function row(label, value, opts) {
  const o = opts || {};
  return '<tr>'
    + `<td style="${FONT};font-size:14px;color:${MUTED};padding:3px 14px 3px 0;`
    + `white-space:nowrap;vertical-align:top">${esc(label)}</td>`
    + `<td style="${FONT};font-size:14px;color:${o.color || INK};padding:3px 0;`
    + `${o.bold ? 'font-weight:600;' : ''}width:100%">${value}</td>`
    + '</tr>';
}

const pct = B.pct;
const money = B.money;
const num = v => (v === null || v === undefined ? '—' : String(v));

function rentShare(p) {
  const dq = B.num(p.delinquency), rent = B.num(p.monthlyRent);
  if (dq === null || !rent) return '';
  return `<span style="color:${MUTED}"> &nbsp;${((dq / rent) * 100).toFixed(1)}% of `
    + `${esc(money(rent))} monthly rent</span>`;
}

function propertyBlock(p, isRed) {
  const L = [];
  L.push(`<div style="margin:0 0 22px 0">`);
  L.push(`<div style="${FONT};font-size:16px;font-weight:700;color:${INK};margin:0 0 6px 0">`
    + esc(p.name) + '</div>');

  if (isRed && p.flags.length) {
    L.push(`<ul style="margin:0 0 10px 0;padding:0 0 0 18px">`);
    p.flags.forEach(f => L.push(
      `<li style="${FONT};font-size:14px;color:${RED};margin:0 0 3px 0">${esc(f.text)}</li>`));
    L.push('</ul>');
  }

  L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
  L.push(row('Occupancy',
    `${num(p.occupied)}/${num(p.units)} &nbsp;<b>${esc(pct(B.num(p.occupancyPct)))}</b>`
    + (B.num(p.goalPct) !== null
      ? `<span style="color:${MUTED}"> &nbsp;goal ${esc(pct(B.num(p.goalPct)))}</span>` : '')));
  // Only where a building cannot be leased; everywhere else it is the same
  // number twice and teaches people to skip the line.
  if (B.num(p.rentableOccupancyPct) !== null) {
    L.push(row('Rentable occupancy',
      `${num(p.rentableOccupied)}/${num(p.rentableUnits)} &nbsp;<b>`
      + `${esc(pct(B.num(p.rentableOccupancyPct)))}</b>`
      + (p.rentableNote ? `<span style="color:${MUTED}"> &nbsp;${esc(p.rentableNote)}</span>` : '')));
  }
  L.push(row('Signed, not moved in', num(p.preleased)));
  L.push(row('Applications pending', num(p.applicationsPending)
    + (B.num(p.applicationOldestDays) !== null
      ? `<span style="color:${MUTED}"> &nbsp;oldest ${p.applicationOldestDays}d</span>` : '')));
  L.push(row('Make-readies open', num(p.makeReadyOpen)
    + (B.num(p.makeReadyOldestDays) !== null
      ? `<span style="color:${MUTED}"> &nbsp;oldest ${p.makeReadyOldestDays}d</span>` : '')));
  L.push(row('Move-ins this week', num(p.moveInsExpected)));
  L.push(row('Move-outs this week', num(p.moveOutsExpected)));
  L.push(row('Notices', num(p.notices)));
  L.push(row('Delinquency', esc(money(B.num(p.delinquency))) + rentShare(p)));
  L.push('</table></div>');
  return L.join('');
}

// One week of the occupancy projection.
//
// THE GREY IS THE POINT. Past 30 days nobody has signed a lease yet, so the
// line falls every week by construction — it is "here is the hole if nothing
// else is leased", not a forecast. Rendering it in the same ink as the firm
// weeks would make it the most alarming wrong number in the email.
function weekRow(w, units, greyNote) {
  const grey = !w.firm;
  const ink = grey ? MUTED : INK;
  const moves = w.firm
    ? `<span style="color:${MUTED}"> &nbsp;&minus;${w.moveOuts} out`
      + (w.moveIns === null ? '' : ` / +${w.moveIns} in`) + '</span>'
    : `<span style="color:${MUTED}"> &nbsp;&minus;${w.moveOuts} out &nbsp;·&nbsp; `
      + esc(greyNote) + '</span>';
  return '<tr>'
    + `<td style="${FONT};font-size:13px;color:${MUTED};padding:3px 14px 3px 0;`
    + `white-space:nowrap;vertical-align:top">${esc(w.label)}</td>`
    + `<td style="${FONT};font-size:13px;color:${ink};padding:3px 0">`
    + `${num(w.occupied)}/${num(units)} &nbsp;<b${grey ? ' style="font-weight:600"' : ''}>`
    + `${esc(pct(w.pct))}</b>${moves}</td></tr>`;
}

function heading(text, colour) {
  return `<div style="${FONT};font-size:13px;font-weight:700;letter-spacing:.06em;`
    + `text-transform:uppercase;color:${colour || INK};border-bottom:2px solid ${RULE};`
    + `padding:0 0 5px 0;margin:26px 0 14px 0">${esc(text)}</div>`;
}

function freshnessBlock(f) {
  const L = [];
  L.push(`<div style="${FONT};font-size:13px;color:${MUTED};background:#f6f6f6;`
    + `border:1px solid ${RULE};padding:10px 12px;margin:0 0 6px 0">`);
  if (!f) {
    L.push(`<b style="color:${RED}">Data age not recorded.</b> Treat every number below as unverified.`);
    L.push('</div>');
    return L.join('');
  }
  L.push(`<b style="color:${INK}">Data as of ${esc(f.asOf || 'unknown')}</b>`);
  const bad = (f.lines || []).filter(x => !x.ok);
  if (bad.length) {
    L.push(`<div style="color:${RED};font-weight:700;margin:8px 0 2px 0">`
      + `${bad.length} morning sync${bad.length === 1 ? '' : 's'} did not run — `
      + 'the numbers below are older than they look.</div>');
    L.push(`<div style="color:${RED}">`
      + bad.map(x => esc(x.source) + ' — ' + esc(x.note || 'failed')).join('<br>')
      + '</div>');
  }
  L.push('</div>');
  return L.join('');
}

function renderHtml(brief, opts) {
  const o = opts || {};
  const L = [];
  L.push('<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">');
  // One outer table: Outlook ignores max-width on a div.
  L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
    + 'style="width:100%;background:#ffffff"><tr><td align="left" style="padding:18px">');
  L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
    + 'style="width:100%;max-width:680px"><tr><td>');

  L.push(`<div style="${FONT};font-size:19px;font-weight:700;color:${INK};margin:0 0 12px 0">`
    + 'Metric — Morning Numbers'
    + (o.testMode ? `<span style="color:${RED};font-size:13px;font-weight:600">`
      + ' &nbsp;TEST — not sent to Kara</span>' : '')
    + '</div>');

  L.push(freshnessBlock(brief.freshness));

  if (brief.red.length) {
    L.push(heading('Needs attention — ' + brief.red.length + ' propert'
      + (brief.red.length === 1 ? 'y' : 'ies'), RED));
    brief.red.forEach(p => L.push(propertyBlock(p, true)));
  } else {
    L.push(heading('Needs attention'));
    L.push(`<div style="${FONT};font-size:14px;color:${MUTED};margin:0 0 18px 0">`
      + 'None. Every property is inside its thresholds.</div>');
  }

  if (brief.ok.length) {
    L.push(heading('Everything else'));
    brief.ok.forEach(p => L.push(propertyBlock(p, false)));
  }

  if (brief.portfolio) {
    const p = brief.portfolio;
    L.push(heading('Portfolio total'));
    L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
    L.push(row('Occupancy', `${num(p.occupied)}/${num(p.units)} &nbsp;<b>`
      + `${esc(pct(B.num(p.occupancyPct)))}</b>`));
    L.push(row('Signed, not moved in', num(p.preleased)));
    L.push(row('Applications pending', num(p.applicationsPending)));
    L.push(row('Make-readies open', num(p.makeReadyOpen)));
    L.push(row('Move-ins expected', num(p.moveInsExpected)));
    L.push(row('Move-outs expected', num(p.moveOutsExpected)));
    L.push(row('Notices', num(p.notices)));
    L.push(row('Delinquency', esc(money(B.num(p.delinquency))) + rentShare(p)));
    L.push('</table>');
  }

  // ---- collections against last month --------------------------------------
  const coll = brief.collections;
  if (coll) {
    L.push(heading('Collections vs the same stretch of last month'));
    if (!coll.measurable) {
      // Amber and stated, not absent. A section that vanishes while the
      // history fills reads as "collections are fine".
      L.push(`<div style="${FONT};font-size:13px;color:#8a6d00">${esc(coll.note)}</div>`);
    } else {
      L.push(`<div style="${FONT};font-size:13px;color:${MUTED};margin:0 0 8px 0">`
        + esc(coll.note) + '.</div>');
      if ((coll.down || []).length) {
        L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
        coll.down.forEach(r => L.push(row(r.property,
          `<b style="color:${RED}">${esc(money(B.num(r.now)))}</b>`
          + `<span style="color:${MUTED}"> vs ${esc(money(B.num(r.then)))} to ${esc(r.comparedOn)}`
          + (r.pct === null ? '' : ' &nbsp;' + r.pct + '%') + '</span>')));
        L.push('</table>');
      }
    }
  }

  // ---- (b) call scores — counted, never red --------------------------------
  //
  // Deliberately in the muted ink, not the red. Kara asked for a count: a low
  // score is a coaching conversation, and a section that shouts every morning
  // teaches the reader to skip the shouting that matters.
  const calls = brief.calls;
  if (calls) {
    L.push(heading('Call scores — ' + calls.day));
    if (calls.empty) {
      // Amber: an empty table is not a quiet day. The analyzer has gone silent
      // before, and a section that renders nothing reads as "nobody scored
      // badly yesterday".
      L.push(`<div style="${FONT};font-size:13px;color:#8a6d00">`
        + `No calls were graded for ${esc(calls.day)}. That is not the same as no bad `
        + 'calls — check the Call Analyzer is still receiving recordings.</div>');
    } else {
      L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
      calls.rows.forEach(g => L.push(row(g.property, esc(CALLS.line(g)))));
      L.push('</table>');
      if ((calls.others || []).length) {
        L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:10px 0 4px 0">`
          + 'Not one of the eight we manage</div>');
        L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
        calls.others.forEach(g => L.push(row(g.property, esc(CALLS.line(g)))));
        L.push('</table>');
      }
      if (calls.unidentified) {
        L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:10px 0 0 0">');
        L.push(row(calls.unidentified.property, esc(CALLS.line(calls.unidentified))));
        L.push('</table>');
        L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:2px 0 0 0">`
          + 'Calls the analyzer could not attribute to a property. A large number '
          + 'here is a matching problem, not a performance one.</div>');
      }
    }
  }

  // ---- (c) projected occupancy ---------------------------------------------
  const occ = brief.occupancy;
  if (occ) {
    L.push(heading('Projected occupancy'));
    if (!occ.moveInsKnown) {
      L.push(`<div style="${FONT};font-size:13px;color:#8a6d00;margin:0 0 10px 0">`
        + '<b>Move-ins are not in this projection.</b> The dated source was empty, so '
        + 'every line counts departures only and understates where each property '
        + 'lands. Treat them as a floor, not a forecast.</div>');
    }
    if (occ.staleLeaseFutureMoveIns) {
      L.push(`<div style="${FONT};font-size:12px;color:#8a6d00;margin:0 0 10px 0">`
        + `<b>${occ.staleLeaseFutureMoveIns} lease`
        + `${occ.staleLeaseFutureMoveIns === 1 ? '' : 's'} with a future move-in date `
        + `${occ.staleLeaseFutureMoveIns === 1 ? 'was' : 'were'} left out.</b> `
        + 'The latest sync did not return them, so their dates are stale'
        + (occ.staleLeaseRows ? ` — ${occ.staleLeaseRows} lease rows in all have not been `
          + 'refreshed.' : '.') + '</div>');
    }
    if (occ.undatedMoveIns) {
      L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:0 0 10px 0">`
        + `${occ.undatedMoveIns} signed lease${occ.undatedMoveIns === 1 ? '' : 's'} `
        + `with no move-in date ${occ.undatedMoveIns === 1 ? 'is' : 'are'} counted in `
        + 'the <b>first</b> week — the earliest they could happen, not a date anybody '
        + 'gave us.</div>');
    }
    occ.rows.forEach(r => {
      L.push(`<div style="${FONT};font-size:15px;font-weight:700;color:${INK};margin:14px 0 4px 0">`
        + esc(r.property) + '</div>');
      // Above the table, in the red. The percentage below has been capped at
      // 100% because of this, and a reader who meets the capped number first
      // has no reason to read any further.
      (r.conflicts || []).forEach(c => L.push(
        `<div style="${FONT};font-size:13px;color:${RED};margin:0 0 5px 0">`
        + '<b>Data conflict:</b> '
        + (c.count ? esc(c.count + ' signed move-ins with no move-in date')
          : esc('1 signed move-in on ' + c.date))
        + (c.unit ? esc(', unit ' + c.unit + ',') : '')
        + ' with no notice or move-out on file — check the unit in AppFolio.</div>'));
      L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
      r.weeks.forEach(w => L.push(weekRow(w, r.units, occ.greyNote)));
      L.push('</table>');
    });
    L.push(`<div style="${FONT};font-size:15px;font-weight:700;color:${INK};margin:16px 0 4px 0">`
      + 'Metric total</div>');
    L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
    occ.total.forEach(w => L.push(weekRow(w, w.units, occ.greyNote)));
    L.push('</table>');
    if (occ.groups && !occ.groups.configured) {
      const u = (occ.groups.ungrouped || []).length;
      L.push(`<div style="${FONT};font-size:13px;color:${MUTED};margin:12px 0 0 0">`
        + '<b>By portfolio (RR / Greystone):</b> not split yet — waiting on Kara to say '
        + `which properties belong to each. ${u} propert${u === 1 ? 'y is' : 'ies are'} `
        + 'currently ungrouped, so no portfolio total is shown rather than one built '
        + 'on a guess.</div>');
    } else if (occ.groups) {
      occ.groups.groups.forEach(g => {
        L.push(`<div style="${FONT};font-size:15px;font-weight:700;color:${INK};margin:16px 0 4px 0">`
          + esc(g.name) + `<span style="font-weight:400;font-size:12px;color:${MUTED}"> `
          + esc(g.members.join(', ')) + '</span></div>');
        L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
        g.weeks.forEach(w => L.push(weekRow(w, w.units, occ.greyNote)));
        L.push('</table>');
      });
      if ((occ.groups.ungrouped || []).length) {
        L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:6px 0 0 0">`
          + 'Not in any portfolio: ' + esc(occ.groups.ungrouped.join(', ')) + '</div>');
      }
    }
  }

  // ---- (d) FAS — not measurable, and saying so -----------------------------
  const fas = brief.fas;
  if (fas && !fas.measurable) {
    L.push(heading('Final account statements'));
    L.push(`<div style="${FONT};font-size:13px;color:#8a6d00">${esc(fas.note)}</div>`);
    if (fas.waitingOn) {
      L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:4px 0 0 0">`
        + 'Waiting on: ' + esc(fas.waitingOn) + '</div>');
    }
  }

  // ---- move-outs (Kara, Phase C item 1) ------------------------------------
  const mo = brief.moveOuts;
  if (mo && (mo.today.length || mo.walkOverdue.length || mo.sourceEmpty)) {
    L.push(heading('Move-outs'));
    L.push(`<div style="${FONT};font-size:13px;color:${MUTED};margin:0 0 10px 0">`
      + (mo.today.length
        ? 'Moving out today: ' + mo.today.map(m => esc(m.property + ' ' + (m.unit || '(no unit)'))).join(' &nbsp;·&nbsp; ')
        : 'Nobody is moving out today.')
      + '</div>');
    const openOnes = mo.walkOverdue.filter(x => x.state === 'open');
    if (openOnes.length) {
      // A click in AppFolio, not a trip to the unit. Amber, not red.
      L.push(`<div style="${FONT};font-size:13px;color:#8a6d00;font-weight:600;margin:0 0 6px 0">`
        + 'Inspection exists but is not marked done in AppFolio</div>');
      L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
      openOnes.forEach(x => {
        const maybe = (x.unnamedInspections || []).length
          ? '<br><span style="font-size:12px;color:' + MUTED + '">'
            + x.unnamedInspections.length + ' inspection'
            + (x.unnamedInspections.length === 1 ? '' : 's')
            + ' on this unit with an unrecognised name — probably where the real walk is: '
            + esc(x.unnamedInspections.slice(0, 4)
              .map(u => u.name + (u.inspectedOn ? ' ' + u.inspectedOn : '')
                + (u.status ? ' (' + u.status + ')' : '')).join(', '))
            + '</span>'
          : '';
        L.push(row(x.property + ' ' + (x.unit || '(no unit)'),
          esc(x.openName || 'an inspection') + ' is ' + esc(x.openWalk || 'open')
          + ' &nbsp;<span style="color:' + MUTED + '">moved out ' + esc(x.moveOut) + '</span>'
          + maybe));
      });
      L.push('</table>');
      L.push('<div style="' + FONT + ';font-size:12px;color:#8a6d00;margin:6px 0 0 0">'
        + 'Erick checked the open ones on 2026-10-14 and <b>all were empty</b> — no areas, '
        + 'no photos. Check before closing one.</div>');
    }
    const missing = mo.walkOverdue.filter(x => x.state !== 'open');
    if (missing.length) {
      L.push(`<div style="${FONT};font-size:13px;color:${RED};font-weight:600;margin:10px 0 6px 0">`
        + 'No move-out inspection recorded after 2 business days</div>');
      L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
      missing.forEach(a2 => {
        const extra = a2.unnamedInspections.length
          ? `<br><span style="font-size:12px;color:${MUTED}">`
            + a2.unnamedInspections.length + ' inspection'
            + (a2.unnamedInspections.length === 1 ? '' : 's')
            + ' on this unit with an unrecognised name — one of them may be the walk: '
            + esc(a2.unnamedInspections.slice(0, 4).map(u => u.name).join(', ')) + '</span>'
          : '';
        L.push(row(a2.property + ' ' + (a2.unit || '(no unit)'),
          'moved out ' + esc(a2.moveOut) + ', due ' + esc(a2.due)
          + (a2.businessDaysOverdue
            ? ' &nbsp;<b style="color:' + RED + '">' + a2.businessDaysOverdue + 'd late</b>' : '')
          + (a2.openWalk
            ? ' <span style="color:' + MUTED + '">an inspection is open ('
              + esc(a2.openWalk) + ')</span>' : '')
          + extra));
      });
      L.push('</table>');
      L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:6px 0 0 0">`
        + 'An inspection is recognised by its NAME, which is free text in AppFolio. '
        + '&ldquo;Not recorded&rdquo; can mean the walk was done and the record was named '
        + 'something else.</div>');
    }
    if (mo.sourceEmpty) {
      L.push(`<div style="${FONT};font-size:13px;color:${RED};margin:8px 0 0 0">`
        + 'No inspections were read at all, so this section cannot say anything about '
        + 'walks. That is a broken source, not a clean week.</div>');
    }
  }

  // ---- long-open make-readies ----------------------------------------------
  // Bekah, 2026-10-13: the 90+ day turns are NOT records to close, "they
  // aren't done". Its own section, above the records and in red, because a
  // unit empty for 490 days is the most expensive line on this page and the
  // old rule filed it under paperwork.
  const longOpen = brief.properties.filter(p => p.longOpenMakeReadies);
  if (longOpen.length) {
    L.push(heading('Long-open make-readies (90+ days)'));
    L.push(`<div style="${FONT};font-size:13px;color:${MUTED};margin:0 0 10px 0">`
      + 'Units the rent roll shows vacant today, with a turn open past '
      + B.DEFAULTS.make_ready_stale_days + ' days. These are counted in '
      + '&ldquo;Make-readies open&rdquo; above; they are listed again here because '
      + 'their age is the point.'
      + (brief.makeReadyCaveat
        ? `<br><b style="color:${RED}">${esc(brief.makeReadyCaveat)}</b>` : '')
      + '</div>');
    L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
    longOpen.forEach(p => {
      const units = (p.longOpenUnits || []).slice(0, 12)
        .map(u => esc(u.unit) + ' <span style="color:' + MUTED + '">' + u.days + 'd</span>')
        .join(' &nbsp;·&nbsp; ');
      const more = (p.longOpenUnits || []).length > 12
        ? ' <span style="color:' + MUTED + '">+' + ((p.longOpenUnits || []).length - 12) + ' more</span>' : '';
      L.push(row(p.name, `<b style="color:${RED}">${p.longOpenMakeReadies}</b>`
        + ` <span style="color:${MUTED}">oldest ${p.longOpenOldestDays}d</span>`
        + (units ? `<br><span style="font-size:12px">${units}${more}</span>` : '')));
    });
    L.push('</table>');
  }

  const heldOut = brief.properties.filter(p => p.thresholds.applications_excluded);
  const records = brief.properties.filter(p =>
    p.staleMakeReadies || (p.staleApplications && !p.thresholds.applications_excluded));
  if (records.length) {
    L.push(heading('Records to clean up in AppFolio'));
    L.push(`<div style="${FONT};font-size:13px;color:${MUTED};margin:0 0 10px 0">`
      + 'Not counted above and not red: open records on units that are occupied, '
      + 'or older than any real make-ready or decision.</div>');
    L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
    records.forEach(p => {
      const bits = [];
      if (p.staleMakeReadies) {
        bits.push(p.staleMakeReadies + ' unit turn' + (p.staleMakeReadies === 1 ? '' : 's')
          + ' (oldest ' + p.staleMakeReadyOldest + 'd)');
      }
      if (p.staleApplications && !p.thresholds.applications_excluded) {
        bits.push(p.staleApplications + ' application' + (p.staleApplications === 1 ? '' : 's')
          + ' (oldest ' + p.staleApplicationOldest + 'd)');
      }
      L.push(row(p.name, esc(bits.join(' · '))));
    });
    L.push('</table>');
  }

  // HELD OUT, AND SAID SO. Dropped without a word, these properties would be
  // indistinguishable from properties with nothing outstanding.
  if (heldOut.length) {
    L.push(heading('Applications held out'));
    L.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">');
    heldOut.forEach(p => {
      const c = num(p.applicationsPending);
      L.push(row(p.name,
        esc((c === null ? 'applications' : c + ' application' + (c === 1 ? '' : 's'))
          + ' not counted or flagged')
        + `<div style="color:${MUTED};font-size:12px">`
        + esc(p.thresholds.applications_excluded_note
          || 'held out by request — ask Arturo why') + '</div>'));
    });
    L.push('</table>');
    L.push(`<div style="${FONT};font-size:12px;color:${MUTED};margin:6px 0 0 0">`
      + 'These are out of the alerts above AND out of Records to clean up.</div>');
  }

  L.push(`<div style="${FONT};font-size:12px;color:${MUTED};border-top:1px solid ${RULE};`
    + 'padding:12px 0 0 0;margin:26px 0 0 0">'
    + (brief.makeReadyCaveat ? esc(brief.makeReadyCaveat) + '<br>' : '')
    + 'Thresholds: occupancy below the property goal; delinquency over '
    + esc(money(B.DEFAULTS.delinquency_over)) + '; a make-ready open over '
    + B.DEFAULTS.make_ready_days + ' days; an application pending over '
    + B.DEFAULTS.application_days + ' days.<br>'
    + 'A make-ready counts on a unit the rent roll shows vacant today, at any age; '
    + 'past ' + B.DEFAULTS.make_ready_stale_days + ' days it also gets its own section. '
    + 'On an OCCUPIED unit it is a record and not work, however old. An application past '
    + B.DEFAULTS.application_stale_days + ' days is a record too.<br>'
    + 'Ask Arturo to change any of these — they are settings, not code.'
    + '</div>');

  L.push('</td></tr></table></td></tr></table></body></html>');
  return L.join('');
}


// ---- the message itself ----------------------------------------------------

// A multipart/alternative message, as RFC-822 text.
//
// WHY THIS IS HERE AND NOT IN server.js. The first version built it inline and
// called crypto.randomBytes — and server.js destructures crypto rather than
// binding the namespace, so `crypto` was not defined there. Exactly the fault
// that shipped "AFP is not defined" a day earlier, and for the same reason: a
// function nothing runs in a test.
//
// Graph's message.body takes ONE contentType, so a JSON send can carry HTML or
// text and never both. The raw-MIME form of sendMail is the only way to send a
// real alternative part.
function buildMime(o) {
  const opts = o || {};
  const to = (Array.isArray(opts.to) ? opts.to : String(opts.to || '').split(','))
    .map(a => String(a).trim()).filter(Boolean);
  if (!to.length) throw new Error('buildMime: no recipient');
  if (!opts.from) throw new Error('buildMime: no sender');

  // A boundary that cannot occur in either part. Random, because a fixed one
  // appearing inside a body would split the message in the wrong place.
  const boundary = 'metric_' + (opts.boundary || String(Date.now()) + Math.random().toString(36).slice(2))
    .replace(/[^a-zA-Z0-9]/g, '');
  const b64 = str => Buffer.from(String(str), 'utf8').toString('base64')
    .replace(/(.{76})/g, '$1\r\n');          // RFC 2045 line length
  // Encoded-word, so an em dash in the subject does not arrive as mojibake.
  const subject = '=?utf-8?B?' + Buffer.from(String(opts.subject || ''), 'utf8').toString('base64') + '?=';

  // CRLF throughout: a bare LF in a header is how a message ends up unparsed.
  return [
    'From: ' + opts.from,
    'To: ' + to.join(', '),
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    // Order matters: least-rich FIRST. A client renders the LAST part it
    // understands, so text before html is what makes html the one that shows.
    '--' + boundary,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(opts.text || ''),
    '',
    '--' + boundary,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(opts.html || ''),
    '',
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

module.exports = { renderHtml, buildMime, esc, FONT, RED, INK, MUTED };
