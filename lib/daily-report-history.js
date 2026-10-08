// Reading a PAST day of the Unified Daily Operations Report (Jay, 2026-10-09).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: nothing is reconstructed. If a
// figure was not written down on the day, the answer is "no record for this
// day" — never a number derived from how things look now. Today's work orders
// cannot say how the board looked on 09/30, and the 2026-10-08 backfill put
// 1,050 rows into maintenance_work_orders carrying old dates, so anything
// recomputed from them would be a number that was never on anybody's screen.
//
// THE SOURCE is daily_reports.sections[], which already stores one entry per
// person per day with an `owner` and a `content` object frozen at save time.
// For Erick that content holds asana {open, overdue, completed_today, titles},
// board {total_open, completed_today, severity, critical[], followup[]} and
// commandCenter {total_tasks, completed_tasks, pct, byCategory, generated_at}.
//
// cc_daily_state is a FALLBACK ONLY, and labelled as one wherever it is used.
// The two overlap only from 2026-10-06 and can disagree: the section snapshot
// is taken when the report is saved, cc_daily_state at 23:30 CT.

'use strict';

// cc_daily_state recorded no completions at all before this date — every row
// from 09/29 to 10/05 reads 0 because the counters did not exist yet. A zero
// from those days means "not measured", and showing it as 0 would read as
// "Erick closed nothing".
//
// THIS APPLIES TO cc_daily_state ONLY. The snapshot stored inside
// daily_reports is a different record and it is NOT all zeroes before this
// date: commandCenter.completed_tasks reads 34 on 09/03, 68 on 09/07 and 1 on
// 09/25. Blanking those as "no record" would hide figures that were genuinely
// measured and saved, which is the same sin in the other direction.
const COUNTERS_LIVE_FROM = '2026-10-06';

// Fields inside the stored snapshot that were NOT being populated before a
// given day — checked across all 17 saved reports, not assumed:
//
//   board.completed_today  reads 0 on every report from 08/28 to 10/06 and
//                          first carries a real number (9) on 10/07.
//
// commandCenter.completed_tasks is deliberately NOT in this list: it has real
// non-zero values going back to 09/03, so its zeroes are quiet days, not
// missing measurements.
const FIELD_FIRST_RELIABLE = {
  'board.completed_today': '2026-10-07',
};

// A stored value whose field was not yet being populated on that day.
function measured(value, date, field) {
  const from = FIELD_FIRST_RELIABLE[field];
  if (from && ymd(date) < from) return NO_RECORD;
  return recorded(value);
}

// Never shown: it has been 0 on every single day since the column existed.
// A metric that has only ever been zero describes the feature's adoption, not
// the person's work.
const SUPPRESSED_COUNTERS = ['completed_manual'];

const NO_RECORD = 'no record for this day';

const ymd = v => String(v || '').slice(0, 10);
const isYmd = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// A value that was genuinely recorded, or the marker. `null` and `undefined`
// are both "not written down"; 0 is a real zero and is kept.
function recorded(v) {
  return (v === null || v === undefined) ? NO_RECORD : v;
}

// Erick's Command Center counters for one day, with the pre-counter window
// handled explicitly rather than by letting a 0 through.
function commandCenterFor(section, date) {
  const cc = section && section.content && section.content.commandCenter;
  if (!cc) return { available: false, reason: NO_RECORD };
  // No date cutoff here: this snapshot carried real completion counts well
  // before cc_daily_state did, so what it stored is what is shown.
  const out = {
    available: true,
    total_tasks: recorded(cc.total_tasks),
    pct: recorded(cc.pct),
    byCategory: cc.byCategory || null,
    generated_at: cc.generated_at || null,
    completed_tasks: recorded(cc.completed_tasks),
    completed_auto: recorded(cc.completed_auto),
    completed_routine: recorded(cc.completed_routine),
  };
  SUPPRESSED_COUNTERS.forEach(k => { delete out[k]; });
  return out;
}

// One person's card for one day.
function personCard(section, date) {
  const content = (section && section.content) || null;
  const card = {
    key: section.key,
    owner: section.owner || 'Team',
    title: section.title || section.key,
    icon: section.icon || null,
    status: section.status || 'pending',
    lastUpdated: section.last_updated || (content && content.lastUpdated) || null,
    // A section that exists but was never filled in is NOT the same as a day
    // with no report. Both are honest answers and they are different ones.
    filled: !!content,
  };
  if (!content) { card.note = 'pending — never filled in'; return card; }
  if (content.severity) card.severity = content.severity;
  if (content.asana) {
    card.asana = {
      open: recorded(content.asana.open),
      overdue: recorded(content.asana.overdue),
      completed_today: recorded(content.asana.completed_today),
      titles: content.asana.titles || [],
    };
  }
  if (content.board) {
    card.board = {
      total_open: recorded(content.board.total_open),
      // Not populated before 2026-10-07 — 0 on every earlier report.
      completed_today: measured(content.board.completed_today, date, 'board.completed_today'),
      severity: content.board.severity || null,
      critical: content.board.critical || [],
      followup: content.board.followup || [],
    };
  }
  const cc = commandCenterFor(section, date);
  if (cc.available) card.commandCenter = cc;
  return card;
}

// The whole day.
function dayView(row) {
  if (!row) return { date: null, exists: false, note: NO_RECORD, people: [] };
  const date = ymd(row.report_date);
  const sections = Array.isArray(row.sections) ? row.sections : [];
  return {
    date,
    exists: true,
    savedAt: row.created_at || null,
    people: sections.map(s => personCard(s, date)),
  };
}

// ---- the seven-day comparison ---------------------------------------------
//
// Over the last seven days THAT HAVE A RECORD, and it says how many of the
// seven are missing. An average over three of seven days is not a week's
// average, and presenting it as one is how a gap becomes a trend.
function sevenDay(rows, ownerKey, date) {
  const end = ymd(date);
  const wanted = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(end + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    wanted.push(d.toISOString().slice(0, 10));
  }
  const byDate = new Map();
  (rows || []).forEach(r => byDate.set(ymd(r.report_date), r));

  const series = [];
  const missing = [];
  for (const d of wanted.slice().reverse()) {
    const row = byDate.get(d);
    const section = row && (row.sections || []).find(s => s.key === ownerKey);
    if (!section || !section.content) { missing.push(d); continue; }
    const cc = commandCenterFor(section, d);
    const board = section.content.board || {};
    series.push({
      date: d,
      total_tasks: cc.available ? cc.total_tasks : NO_RECORD,
      completed_tasks: cc.available ? cc.completed_tasks : NO_RECORD,
      board_open: recorded(board.total_open),
      board_completed: measured(board.completed_today, d, 'board.completed_today'),
    });
  }

  // Averaged ONLY over the days that carry a real number for that metric.
  const avg = field => {
    const nums = series.map(s => s[field]).filter(v => typeof v === 'number');
    if (!nums.length) return { value: NO_RECORD, over: 0 };
    return { value: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10, over: nums.length };
  };

  return {
    window: { from: wanted[wanted.length - 1], to: wanted[0] },
    daysWithRecord: series.length,
    daysMissing: missing.length,
    missingDates: missing,
    series,
    averages: {
      total_tasks: avg('total_tasks'),
      completed_tasks: avg('completed_tasks'),
      board_open: avg('board_open'),
      board_completed: avg('board_completed'),
    },
  };
}

// cc_daily_state, for a day whose report was never saved. Clearly marked.
function fallbackFromState(state, date) {
  if (!state) return null;
  const before = ymd(date) < COUNTERS_LIVE_FROM;
  const out = {
    source: 'cc_daily_state',
    note: 'The report for this day was never saved. These are the nightly '
      + 'Command Center figures, taken at 23:30 CT — not what the report showed.',
    total_tasks: recorded(state.total_tasks),
    completed_tasks: before ? NO_RECORD : recorded(state.completed_tasks),
    completed_auto: before ? NO_RECORD : recorded(state.completed_auto),
    completed_routine: before ? NO_RECORD : recorded(state.completed_routine),
    generated_at: state.generated_at || null,
  };
  if (before) out.countersNote = 'Completion counters started on ' + COUNTERS_LIVE_FROM
    + '. Earlier days were never measured.';
  SUPPRESSED_COUNTERS.forEach(k => { delete out[k]; });
  return out;
}

module.exports = {
  COUNTERS_LIVE_FROM, FIELD_FIRST_RELIABLE, SUPPRESSED_COUNTERS, NO_RECORD,
  ymd, isYmd, recorded, measured, commandCenterFor, personCard, dayView, sevenDay, fallbackFromState,
};
