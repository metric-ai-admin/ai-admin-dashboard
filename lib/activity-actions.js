// What each write ROUTE means, in words a person can read.
//
// "Jay wrote to /api/crm/properties/:id" is not an answer to "what did Jay do".
// This turns a method plus a path into "Updated CRM property" — one line per
// route, so a new route is named on purpose rather than appearing as a generic
// verb nobody can act on.
//
// WHAT A LABEL MAY CONTAIN. The route's meaning and nothing else. No note
// text, no resident names, no amounts, no free text of any kind: the phrase is
// chosen HERE, from this file, and never built from what the user typed. That
// is the same rule as phase 1 and it is the reason this is a lookup table and
// not a template.
//
// SYSTEM routes are the other half. Some writes are the dashboard talking to
// itself — the Command Center saves its board on every page load, for
// everybody, whether or not they have ever opened Maintenance. Those rows made
// Katrina, Rhoxie and Katie look like Maintenance users. They are labelled
// 'system' so they can still be audited, and the counts and "last section"
// leave them out.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActivityActions = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── System writes: automatic, not a person doing something ────────────────
  //
  // Each entry says WHY it is automatic, because "system" is a claim that stops
  // something being counted and it should be checkable.
  var SYSTEM = [
    // command-center.js runs ccInit() on DOMContentLoaded for every user, and
    // the chain ends in ccSaveState(). One row per page load, section
    // 'maintenance', for people who never opened it.
    { re: /^\/api\/maintenance\/command-center\/state$/, why: 'Command Center autosave, fires on every page load' },
    // The beacon from phase 2. It is already an event of its own; counting it
    // as a write as well would double every section change.
    { re: /^\/api\/activity\/view$/, why: 'the view beacon itself' },
    // Read-only probes. They are POSTs because the Reports API is, but nothing
    // changes.
    { re: /^\/api\/(maintenance\/probe-wo-window|collections\/probe-tenant-statuses|leasing\/probe-guest-cards|appfolio\/probe-catalogue)$/,
      why: 'read-only probe, POST only because the upstream API is' },
    // Marks a report as seen. Fired by opening the page, not by a decision.
    { re: /^\/api\/reports\/daily\/view$/, why: 'records that a report was opened, fired by the page' },
    // Retired 2026-10-05: both answer 410 and write nothing. Kept as system so
    // that if a forgotten caller does turn up, its rejections are not counted
    // as somebody working — a 410 is still a request, and the write logger
    // records on finish whatever the status was.
    { re: /^\/api\/triage\/log-session$/, why: 'retired 2026-10-05, answers 410' },
    { re: /^\/api\/lyndsay\/import$/, why: 'retired 2026-10-05, answers 410' },
  ];

  // ── Reads worth recording ─────────────────────────────────────────────────
  //
  // Phase 1 logged writes only, which answers "what did somebody change" and
  // not "what did somebody take". Pulling the whole BD CRM to a spreadsheet
  // changes nothing and is the single most consequential thing a person can do
  // in this dashboard with resident and prospect data.
  //
  // Matched on the path, so a new export route is recorded the day it is added
  // rather than the day somebody remembers to register it — the same reasoning
  // as sectionOf().
  var EXPORTS = [
    { re: /\/export\.csv$/i, label: 'Exported CSV', entity: 'export' },
    { re: /\/export\.pdf$/i, label: 'Exported PDF', entity: 'export' },
    { re: /\/export\.xlsx?$/i, label: 'Exported Excel', entity: 'export' },
    { re: /\/export\/csv$/i, label: 'Exported CSV', entity: 'export' },
    { re: /\/export(\/|$)/i, label: 'Exported data', entity: 'export' },
    { re: /\/download(\/|$)/i, label: 'Downloaded a file', entity: 'export' },
    { re: /\/generate(\/|$)/i, label: 'Generated a report', entity: 'report' },
  ];

  /** A GET that is worth a row: an export, a download, a generated report. */
  function describeRead(path) {
    var p = String(path || '').split('?')[0].split('#')[0];
    for (var i = 0; i < EXPORTS.length; i++) {
      if (EXPORTS[i].re.test(p)) {
        return { label: EXPORTS[i].label, entity: EXPORTS[i].entity, system: false, why: null };
      }
    }
    return null;
  }

  // ── Section ids → names people use ────────────────────────────────────────
  //
  // The id is the first path segment and is how the log stores it; 'crm' and
  // 'sixpm' are not what anyone calls those screens. ONE map, exported, so the
  // detail table, the timeline and anything built later all say the same word.
  //
  // An unmapped id falls back to a tidied version of itself rather than to a
  // placeholder: a new section should read as "Unit Turns", not as "Unknown",
  // the day it is added and before anybody edits this file.
  var SECTION_NAMES = {
    morning: 'Morning Report', tasks: 'Tasks', sops: 'SOP Library',
    platform: 'Platform Projects', email: 'Email / Cal', eod: 'EOD Report',
    maintenance: 'Maintenance', crm: 'BD CRM', 'bd-crm': 'BD CRM',
    reports: 'Daily Report', sixpm: '6 PM Report', kpi: 'KPI Report',
    kpirecaps: 'KPI Recaps', calls: 'Call Analyzer', evictions: 'Evictions',
    collections: 'Collections', accounting: 'Accounting', leasing: 'Leasing',
    vacancy: 'Vacancy Posting', marketing: 'Marketing', activity: 'Activity Logs',
    appfolio: 'AppFolio Reports', billable: 'Billable Labor Report',
    'lyndsay-queue': 'Lyndsay Message Queue', lyndsay: "Lyndsay's Tasks",
    assignments: 'Property Assignments', technicians: 'Technicians',
    operational: 'Operational Tasks', 'platform-projects': 'Platform Projects',
    'code-violations': 'Code Violations', asana: 'Asana', auth: 'Sign-in',
    meetings: 'Meetings', summary: 'Summary', sv: 'SimpleVoIP',
    triage: 'Email Triage', 'sop-review': 'SOP Review', sop: 'SOP Library',
  };
  function sectionLabel(id) {
    var k = String(id || '').trim().toLowerCase();
    if (!k) return null;
    if (SECTION_NAMES[k]) return SECTION_NAMES[k];
    return k.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // ── Collapsing a burst into one line ──────────────────────────────────────
  //
  // One click of "Sync from AppFolio" fires seven parallel requests from the
  // browser, one per report, and leaves seven rows in the same second. The log
  // is right — seven things happened — but the screen was unreadable, and what
  // Erick did was click a button once.
  //
  // Grouped for DISPLAY, never in the table. The rows stay as they are: this
  // is a reading aid, and an audit log that quietly discards rows is no longer
  // one. The CSV export is deliberately left ungrouped for the same reason.
  //
  // Only CONSECUTIVE rows, same person, same action, same minute. Consecutive
  // matters: two bursts an hour apart must not fold into each other just
  // because nothing happened in between.
  function groupRuns(rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      var last = out[out.length - 1];
      var min = String(r.at || '').slice(0, 16);           // to the minute
      if (last
        && last.user_email === r.user_email
        && last.action === r.action
        && last.event === r.event
        && last._min === min
        && r.action) {                                     // unlabelled rows never fold
        last.groupCount = (last.groupCount || 1) + 1;
        return;
      }
      out.push(Object.assign({}, r, { _min: min, groupCount: 1 }));
    });
    return out.map(function (r) { delete r._min; return r; });
  }

  function systemReason(path) {
    var p = String(path || '').split('?')[0];
    for (var i = 0; i < SYSTEM.length; i++) if (SYSTEM[i].re.test(p)) return SYSTEM[i].why;
    return null;
  }
  function isSystem(path) { return systemReason(path) !== null; }

  // ── The catalogue ─────────────────────────────────────────────────────────
  //
  // [method, path pattern, phrase, entity type]. ':x' matches one segment.
  // Order matters: the first match wins, so a specific route goes above the
  // general one it would otherwise be swallowed by.
  var ACTIONS = [
    // Tasks
    ['POST',   '/api/tasks',                          'Created task', 'task'],
    ['POST',   '/api/tasks/:id/done',                 'Marked task done', 'task'],
    ['POST',   '/api/tasks/:id/notes',                'Added task note', 'task'],
    ['POST',   '/api/tasks/bulk-import',              'Imported tasks in bulk', 'task'],
    ['POST',   '/api/tasks/asana-backfill',           'Backfilled tasks from Asana', 'task'],
    ['POST',   '/api/tasks/asana-cleanup',            'Cleaned up Asana tasks', 'task'],
    ['PUT',    '/api/tasks/:id',                      'Edited task', 'task'],
    ['DELETE', '/api/tasks/:id',                      'Deleted task', 'task'],
    ['POST',   '/api/operational',                    'Created operational task', 'task'],
    ['POST',   '/api/operational/:id/done',           'Marked operational task done', 'task'],
    ['POST',   '/api/operational/:id/notes',          'Added operational task note', 'task'],
    ['PUT',    '/api/operational/:id',                'Edited operational task', 'task'],
    ['DELETE', '/api/operational/:id',                'Deleted operational task', 'task'],
    ['POST',   '/api/lyndsay/tasks/:id/done',         "Marked Lyndsay's task done", 'task'],
    ['DELETE', '/api/lyndsay/tasks/:id/done',         "Reopened Lyndsay's task", 'task'],
    ['POST',   '/api/asana/import',                   'Imported from Asana', 'task'],
    ['PATCH',  '/api/asana/tasks/:gid',               'Updated Asana task', 'task'],
    ['POST',   '/api/asana/tasks/:gid/comments',      'Commented on Asana task', 'task'],

    // BD CRM
    ['PATCH',  '/api/crm/properties/:id/assign',      'Reassigned CRM property', 'crm_property'],
    ['PATCH',  '/api/crm/properties/bulk-assign',     'Bulk-reassigned CRM properties', 'crm_property'],
    ['PATCH',  '/api/crm/properties/:id',             'Updated CRM property status', 'crm_property'],
    ['PUT',    '/api/crm/properties/:id/dm-review',   'Added DM review note', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/appointments', 'Logged CRM appointment', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/follow-ups',  'Logged CRM follow-up', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/inspections', 'Logged CRM inspection', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/phone-shops', 'Logged phone shop', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/online-shops', 'Logged online shop', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/outreach-drafts', 'Drafted CRM outreach', 'crm_property'],
    ['POST',   '/api/crm/properties/:id/new-phone-number', 'Added CRM phone number', 'crm_property'],
    ['PATCH',  '/api/crm/appointments/:id',           'Updated CRM appointment', 'crm_appointment'],
    ['PATCH',  '/api/crm/phone-shops/:id',            'Updated phone shop', 'crm_phone_shop'],
    ['POST',   '/api/crm/bd-agents',                  'Added BD agent', 'bd_agent'],
    ['PATCH',  '/api/crm/bd-agents/:id/status',       'Changed BD agent status', 'bd_agent'],
    ['PATCH',  '/api/crm/bd-agents/:id',              'Updated BD agent', 'bd_agent'],
    ['POST',   '/api/crm/gb-rotation/assign',         'Assigned Google Business rotation', 'crm_property'],
    ['POST',   '/api/crm/dm-reviews/cleanup',         'Cleaned up DM reviews', 'crm_property'],
    ['POST',   '/api/crm/import',                     'Imported CRM properties', 'crm_property'],
    ['POST',   '/api/crm/import-costar',              'Imported CoStar data', 'crm_property'],
    ['POST',   '/api/crm/bulk-import',                'Bulk-imported CRM data', 'crm_property'],
    ['PUT',    '/api/crm/targeted-companies',         'Updated targeted companies', 'crm_property'],

    // Collections & evictions
    ['POST',   '/api/collections/decision-queue/decide', 'Decided a collections case', 'collections_case'],
    ['POST',   '/api/collections/generate',           'Generated collections report', 'report'],
    ['POST',   '/api/evictions/completed',            'Marked eviction complete', 'eviction'],
    ['DELETE', '/api/evictions/completed/:id',        'Reopened eviction', 'eviction'],
    ['POST',   '/api/evictions/session',              'Started eviction session', 'eviction'],
    ['DELETE', '/api/evictions/session',              'Ended eviction session', 'eviction'],
    ['POST',   '/api/evictions/sync',                 'Synced evictions from AppFolio', 'sync'],

    // Maintenance
    ['POST',   '/api/maintenance/sync',               'Synced work orders from AppFolio', 'sync'],
    ['POST',   '/api/maintenance/sync/:what',         'Synced maintenance data from AppFolio', 'sync'],
    ['POST',   '/api/maintenance/reconcile',          'Reconciled work orders', 'work_order'],
    ['DELETE', '/api/maintenance/sops/:id',           'Deleted maintenance SOP', 'sop'],
    ['POST',   '/api/technicians',                    'Added technician', 'technician'],
    ['PUT',    '/api/technicians/:id',                'Updated technician', 'technician'],
    ['DELETE', '/api/technicians/:id',                'Removed technician', 'technician'],
    ['POST',   '/api/assignments',                    'Set property assignment', 'assignment'],
    ['PUT',    '/api/assignments/:property',          'Updated property assignment', 'assignment'],
    ['DELETE', '/api/assignments/:property',          'Removed property assignment', 'assignment'],
    ['POST',   '/api/assignments/upload',             'Uploaded property assignments', 'assignment'],
    ['POST',   '/api/appfolio/schedule',              'Scheduled work order', 'work_order'],
    ['DELETE', '/api/appfolio/schedule/:wo',          'Unscheduled work order', 'work_order'],
    ['POST',   '/api/appfolio/upload',                'Uploaded AppFolio export', 'upload'],
    ['POST',   '/api/appfolio/reports/sync-all',      'Synced all AppFolio reports', 'sync'],
    ['POST',   '/api/appfolio/reports/:id/sync',      'Synced an AppFolio report', 'sync'],
    ['POST',   '/api/code-violations/import',         'Imported code violations', 'code_violation'],
    ['POST',   '/api/code-violations/watchlist',      'Added to code-violation watchlist', 'code_violation'],
    ['PATCH',  '/api/code-violations/watchlist/:id',  'Updated code-violation watchlist', 'code_violation'],
    ['POST',   '/api/code-violations/:key/resolve-import', 'Resolved code-violation import', 'code_violation'],
    ['PATCH',  '/api/code-violations/:key',           'Updated code violation', 'code_violation'],

    // Leasing & marketing
    ['POST',   '/api/leasing/submissions',            'Submitted leasing goal board', 'leasing_submission'],
    ['PATCH',  '/api/leasing/submissions/:id',        'Reviewed leasing goal board', 'leasing_submission'],
    ['POST',   '/api/leasing/sync/run-now',           'Ran leasing sync now', 'sync'],
    ['POST',   '/api/leasing/sync/:what',             'Synced leasing data from AppFolio', 'sync'],
    ['POST',   '/api/leasing/sync',                   'Synced guest cards from AppFolio', 'sync'],
    ['PUT',    '/api/marketing/:property',            'Edited marketing link', 'marketing'],
    ['POST',   '/api/vacancy/applied',                'Marked vacancy posting applied', 'vacancy'],

    // Reports & billing
    ['POST',   '/api/billable/generate',              'Generated Billable Labor Report', 'report'],
    ['POST',   '/api/billable/email',                 'Sent Billable Labor Report', 'report'],
    ['POST',   '/api/billable/upload/:slot',          'Uploaded billable CSV', 'upload'],
    ['POST',   '/api/billable/upload-workbook',       'Uploaded billable workbook', 'upload'],
    ['POST',   '/api/reports/daily/generate',         "Generated today's report", 'report'],
    ['POST',   '/api/reports/daily-6pm/generate',     'Generated the 6 PM report', 'report'],
    ['POST',   '/api/reports/daily/signoff',          'Signed off on the daily report', 'report'],
    ['PATCH',  '/api/reports/daily/:id/section',      'Edited a daily report section', 'report'],
    ['POST',   '/api/reports/eod-email/send',         'Sent the EOD email', 'report'],
    ['POST',   '/api/kpi-recaps/:id/approve',         'Approved KPI recap', 'kpi_recap'],
    ['POST',   '/api/kpi-recaps/run-now',             'Generated KPI recap', 'kpi_recap'],
    ['POST',   '/api/sync/all',                       'Ran a full sync', 'sync'],

    // SOPs
    ['POST',   '/api/sops',                           'Created SOP', 'sop'],
    ['PATCH',  '/api/sops/:id',                       'Edited SOP', 'sop'],
    ['DELETE', '/api/sops/:id',                       'Deleted SOP', 'sop'],
    ['POST',   '/api/sops/bulk-import',               'Bulk-imported SOPs', 'sop'],
    ['PATCH',  '/api/sop/documents/:id',              'Edited SOP document', 'sop'],
    ['POST',   '/api/sop/documents/:id/reviewed',     'Marked SOP reviewed', 'sop'],
    ['PATCH',  '/api/sop-review/:id',                 'Updated SOP review', 'sop'],
    ['POST',   '/api/tools/convert-sops',             'Converted SOP files', 'sop'],

    // Email & triage
    ['POST',   '/api/email/:id/handled',              'Marked email handled', 'email'],
    ['POST',   '/api/email/refresh-now',              'Refreshed the inbox', 'email'],
    ['POST',   '/api/email/auto-move/rules',          'Created an auto-move rule', 'email_rule'],
    ['PATCH',  '/api/email/auto-move/rules/:id',      'Edited an auto-move rule', 'email_rule'],
    ['DELETE', '/api/email/auto-move/rules/:id',      'Deleted an auto-move rule', 'email_rule'],
    ['POST',   '/api/email/auto-move/run',            'Ran auto-move rules', 'email_rule'],
    ['POST',   '/api/email/auto-move/toggle',         'Toggled auto-move', 'email_rule'],
    ['POST',   '/api/email/setup-outlook-rules',      'Set up Outlook rules', 'email_rule'],
    ['POST',   '/api/email/lyndsay/message-rules',    "Updated Lyndsay's message rules", 'email_rule'],
    ['POST',   '/api/email/inbox-tracking/sync-excel', 'Synced inbox tracking', 'sync'],
    ['POST',   '/api/lyndsay-queue',                  "Queued a message for Lyndsay", 'message'],
    ['POST',   '/api/lyndsay-queue/:id/sent',         'Marked queued message sent', 'message'],
    ['POST',   '/api/lyndsay-queue/bulk-import',      'Bulk-imported queued messages', 'message'],
    ['POST',   '/api/lyndsay-queue/from-meeting',     'Queued messages from a meeting', 'message'],

    // Calls
    ['POST',   '/api/calls/grade',                    'Graded a call', 'call'],
    ['POST',   '/api/calls/flag',                     'Flagged a call', 'call'],
    ['PATCH',  '/api/calls/flag/:recording_id',       'Updated a call flag', 'call'],
    ['DELETE', '/api/calls/flag/:recording_id',       'Removed a call flag', 'call'],
    ['POST',   '/api/calls/:recording_id/coaching-reviews', 'Added a coaching review', 'call'],
    ['DELETE', '/api/calls/:recording_id/coaching-reviews', 'Removed a coaching review', 'call'],
    ['PATCH',  '/api/calls/rubric-suggestions/:id',   'Updated a rubric suggestion', 'call'],
    ['POST',   '/api/capture-transcripts',            'Captured call transcripts', 'call'],
    ['POST',   '/api/meetings/capture',               'Captured a meeting', 'meeting'],
    ['POST',   '/api/sv/archive/numbers',             'Archived SimpleVoIP numbers', 'call'],
    ['POST',   '/api/sv/archive/backfill',            'Backfilled SimpleVoIP archive', 'call'],
    ['POST',   '/api/sv/grade/backfill',              'Backfilled call grades', 'call'],

    // Accounting
    ['POST',   '/api/accounting/bills',               'Added a bill', 'bill'],
    ['PATCH',  '/api/accounting/bills/:id',           'Updated a bill', 'bill'],
    ['POST',   '/api/accounting/vendors',             'Added a vendor', 'vendor'],
    ['PATCH',  '/api/accounting/vendors/:id',         'Updated a vendor', 'vendor'],
    ['POST',   '/api/accounting/tasks',               'Created an accounting task', 'task'],
    ['PATCH',  '/api/accounting/tasks/:id',           'Updated an accounting task', 'task'],
    ['DELETE', '/api/accounting/tasks/:id',           'Deleted an accounting task', 'task'],

    // Platform projects
    ['POST',   '/api/platform-projects',              'Created platform project', 'project'],
    ['PUT',    '/api/platform-projects/:id',          'Edited platform project', 'project'],
    ['DELETE', '/api/platform-projects/:id',          'Deleted platform project', 'project'],
    ['POST',   '/api/platform-projects/:id/subtasks', 'Added project subtask', 'project'],
    ['PUT',    '/api/platform-projects/:id/subtasks/:subId', 'Edited project subtask', 'project'],
    ['DELETE', '/api/platform-projects/:id/subtasks/:subId', 'Deleted project subtask', 'project'],
    ['POST',   '/api/platform-projects/bulk-import',  'Bulk-imported platform projects', 'project'],

    // Rebrand review. These come from a public token link, not a dashboard
    // session, so activityActor() finds no user and nothing is logged in
    // practice — named anyway so a row is readable if one ever arrives.
    ['PUT',    '/api/review/:token/docs',             'Saved a rebrand review answer', 'rebrand_review'],
    ['DELETE', '/api/review/:token/docs',             'Cleared a rebrand review answer', 'rebrand_review'],

    // Session. Logged as their own events already; named so a row is readable
    // if one ever arrives through this path.
    ['POST',   '/api/auth/login',                     'Signed in', 'session'],
    ['POST',   '/api/auth/logout',                    'Signed out', 'session'],
    ['POST',   '/api/auth/reset-password',            'Reset a password', 'session'],
  ];

  // Compile once. ':name' matches a single segment and nothing else, so
  // /api/tasks/:id cannot swallow /api/tasks/:id/notes.
  var COMPILED = ACTIONS.map(function (a) {
    var pattern = '^' + a[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:[A-Za-z_]+/g, '[^/]+') + '$';
    return { method: a[0], re: new RegExp(pattern), label: a[2], entity: a[3], path: a[1] };
  });

  /**
   * @returns {{label, entity, system, why}|null}
   *   null when the route has no entry — which the test treats as a failure,
   *   not as a default.
   */
  function describe(method, path) {
    var p = String(path || '').split('?')[0].split('#')[0];
    var why = systemReason(p);
    if (why) return { label: null, entity: null, system: true, why: why };
    var m = String(method || '').toUpperCase();
    for (var i = 0; i < COMPILED.length; i++) {
      if (COMPILED[i].method === m && COMPILED[i].re.test(p)) {
        return { label: COMPILED[i].label, entity: COMPILED[i].entity, system: false, why: null };
      }
    }
    return null;
  }

  return {
    describe: describe,
    describeRead: describeRead,
    sectionLabel: sectionLabel,
    SECTION_NAMES: SECTION_NAMES,
    groupRuns: groupRuns,
    EXPORTS: EXPORTS,
    isSystem: isSystem,
    systemReason: systemReason,
    ACTIONS: ACTIONS,
    SYSTEM: SYSTEM,
  };
}));
