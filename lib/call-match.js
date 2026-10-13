// Matching a delinquent resident to the calls on their number.
//
// WHAT CHANGED. The old lookup was inbound-only and deliberately so: the
// archive's `caller` column holds the resident's number on an inbound call and
// the AGENT's name on an outbound one, so an outbound attempt left no number
// to match. Since 2026-09-29 the sync stores `counterparty_number` on every
// call, which is the resident's number in both directions — so "last contact"
// is now a question this can answer, where before only "last inbound call"
// was.
//
// THE CAPTURE STARTED ON A DATE AND THAT DATE MATTERS. 2,146 calls before
// 09-29 carry no number. "Never called" would be a lie about them; "no calls
// since 9/29" is the truth, and the difference is whether somebody picks up
// the phone believing nobody has tried.

'use strict';

// The day counterparty_number began to be stored. Before this, absence of a
// call means absence of a RECORD.
const CAPTURE_START = '2026-09-29';

const clean = s => String(s == null ? '' : s).trim();

// Last ten digits, no country code. Anything that is not ten digits is not a
// US phone and is not matched on — a partial number would join strangers.
function normPhone(v) {
  let d = clean(v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
}

// Calls indexed by the other party's number, newest first.
function indexCalls(calls) {
  const by = new Map();
  (calls || []).forEach(c => {
    const n = normPhone(c.counterparty_number);
    if (!n) return;
    if (!by.has(n)) by.set(n, []);
    by.get(n).push(c);
  });
  by.forEach(list => list.sort((a, b) =>
    String(b.call_date).localeCompare(String(a.call_date))));
  return by;
}

// Which residents share a number, from the tenant directory.
//
// A number on two leases is two people, and saying "Maria called" when it
// might have been her husband is the kind of small wrong fact that makes
// somebody distrust the whole screen.
function indexResidents(directory) {
  const by = new Map();
  (directory || []).forEach(r => {
    [r.phone, r.mobile].forEach(v => {
      const n = normPhone(v);
      if (!n) return;
      if (!by.has(n)) by.set(n, []);
      const who = clean(r.tenant_name);
      if (who && !by.get(n).includes(who)) by.get(n).push(who);
    });
  });
  return by;
}

const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Minutes and seconds from whatever the archive stored. It holds a number of
// seconds on some rows and "m:ss" on others.
function seconds(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

function duration(v) {
  const s = seconds(v);
  if (s === null) return null;
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
}

// What to say about one resident's number.
//
// Returns { phone, lastContact, count30, sharedWith, note }. `note` is set
// when there is nothing to show and says WHY — the two reasons are "no number
// on file" and "no calls since the capture began", and they lead to different
// actions.
function summarise(phone, opts) {
  const o = opts || {};
  const today = o.today || CAPTURE_START;
  const n = normPhone(phone);
  if (!n) return { phone: null, lastContact: null, count30: 0, sharedWith: [], note: 'no number on file' };

  const list = (o.callsByNumber && o.callsByNumber.get(n)) || [];
  const residents = (o.residentsByNumber && o.residentsByNumber.get(n)) || [];
  // The resident this card is about does not count as "shared with".
  const others = residents.filter(r => clean(r).toLowerCase() !== clean(o.name).toLowerCase());

  if (!list.length) {
    return {
      phone: n, lastContact: null, count30: 0, sharedWith: others,
      note: 'No calls since ' + CAPTURE_START,
    };
  }

  const first = list[0];
  const since30 = (() => {
    const d = new Date(Date.parse(today + 'T00:00:00Z') - 30 * 86400000);
    return d.toISOString().slice(0, 10);
  })();
  return {
    phone: n,
    lastContact: {
      date: String(first.call_date).slice(0, 10),
      direction: clean(first.call_direction) || 'unknown',
      duration: duration(first.duration),
      daysAgo: daysBetween(String(first.call_date).slice(0, 10), today),
    },
    count30: list.filter(c => String(c.call_date).slice(0, 10) >= since30).length,
    sharedWith: others,
    note: null,
  };
}

// The line the card shows. One place, so the wording cannot drift between the
// queue and anything built on it later.
function line(s) {
  if (!s) return '';
  if (s.note) return s.note;
  const c = s.lastContact;
  const bits = ['Last contact: ' + c.date + ' — ' + c.direction];
  if (c.duration) bits.push(c.duration);
  let out = bits.join(', ');
  out += '  ·  ' + s.count30 + ' call' + (s.count30 === 1 ? '' : 's') + ' in the last 30 days';
  if (s.sharedWith.length) {
    out += '  ·  this number is shared with ' + s.sharedWith.length + ' other resident'
      + (s.sharedWith.length === 1 ? '' : 's') + ' — the calls may not be theirs';
  }
  return out;
}

module.exports = {
  CAPTURE_START, normPhone, indexCalls, indexResidents, seconds, duration,
  summarise, line, clean,
};
