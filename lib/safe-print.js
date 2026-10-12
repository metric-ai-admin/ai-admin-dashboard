// Printing a row from a report, without printing a person.
//
// WHY THIS EXISTS. scripts/probe-applications-report.js dumped a complete
// sample row to settle which columns the Rental Applications report carries,
// and that row was a real applicant: email, phone, employer and monthly
// salary, on a terminal whose output gets pasted into chats. The script needed
// the COLUMN NAMES and the shape of a few dates; it printed everything because
// printing everything was easier than deciding.
//
// scripts/windy-hill-prelease.js had already got this right — it drops fields
// whose NAME looks like a person rather than selecting around them — and the
// lesson did not travel to the next script. So it lives here now, and every
// diagnostic uses it.
//
// THE DEFAULT IS TO HIDE. A column this module has never seen is redacted
// rather than shown: a report that gains a column must not start leaking one,
// and a diagnostic is read once while a leak is permanent.

'use strict';

// Anything whose column NAME suggests it identifies or describes a person.
// Matched on the name, so a new column called `co_applicant_mobile` or
// `guarantor_income` is covered without anybody remembering to add it.
const PERSONAL = /name|email|phone|mobile|contact|address|applicant|tenant|resident|occupant|guarantor|employer|salary|income|ssn|dob|birth|license|passport|account|bank|card/i;

// Columns that are safe to show in full because they identify a RECORD, not a
// person, and are what a diagnostic is usually trying to read.
const SAFE_NAME = /^(id|.*_id|.*_uuid|status|.*_status|.*_date|date_.*|received|created_at|updated_at|.*_at|property|property_name|unit|unit_type|page|count|total|type|category|source|stage|reason|visibility)$/i;

const clean = s => String(s == null ? '' : s).trim();

// Is this column safe to print as-is?
//
// SAFE_NAME is checked FIRST so that `property_name`, `tenant_status` and
// `applicant_id` — all of which match PERSONAL on a substring — stay readable.
// They name a property, a state and a record, not a person.
// Columns that are personal NO MATTER WHAT ELSE THEY LOOK LIKE, checked before
// the safe list rather than after.
//
// `date_of_birth` is what found this: it matched the safe pattern `date_.*`
// and was printed. A date is usually harmless and a date of birth is an
// identifier, so the shape of the name is not enough — these win outright.
const HARD_PERSONAL = /birth|dob|ssn|social_security|salary|income|wage|email|phone|mobile|passport|license|bank|card|account_number/i;

function isSafe(column) {
  const c = clean(column);
  if (!c) return false;
  if (HARD_PERSONAL.test(c)) return false;
  if (SAFE_NAME.test(c)) return true;
  return !PERSONAL.test(c);
}

// What to print instead of a value we are not showing. Says whether the field
// HAD something, because "this column is always empty" and "this column is
// full of personal data" are different findings and a diagnostic needs both.
function mask(value) {
  const v = clean(value);
  if (!v) return '(empty)';
  return '(set, ' + v.length + ' chars)';
}

// One row, safe to print. Keeps every KEY — the column list is usually the
// whole point — and redacts the values that identify somebody.
function safeRow(row) {
  const out = {};
  Object.keys(row || {}).forEach(k => {
    out[k] = isSafe(k) ? row[k] : mask(row[k]);
  });
  return out;
}

// The column list with one example value each, as lines ready to print.
function describeColumns(row) {
  return Object.keys(row || {}).sort().map(k => {
    const shown = isSafe(k) ? JSON.stringify(row[k]) : mask(row[k]);
    return '   ' + k.padEnd(34) + shown;
  });
}

// How many rows carry a value in each column, with no values shown at all.
// The safest summary there is, and often the one actually wanted.
function fillRates(rows, columns) {
  const list = columns || Object.keys((rows && rows[0]) || {});
  return list.sort().map(k => {
    const n = (rows || []).filter(r => clean(r[k])).length;
    return '   ' + k.padEnd(34) + n + ' of ' + (rows || []).length;
  });
}

module.exports = { PERSONAL, SAFE_NAME, HARD_PERSONAL, isSafe, mask, safeRow, describeColumns, fillRates, clean };
