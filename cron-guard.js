// =====================================================================
// node-cron, gated on ENABLE_CRONS.
//
// Require this instead of 'node-cron' anywhere a schedule is registered. It
// exposes the same schedule()/validate() surface, so call sites do not change.
//
// WHY, AND WHY THE LOGIC IS INVERTED.
//
// The MCP endpoint moved to its own Render service so Claude Desktop survives a
// dashboard deploy. Both services run the same server.js, which registers ten
// cron jobs at module level — the 6 PM EOD email to Lyndsay, the 2 AM call
// grading, the 6 PM report, the 17:45 wo_completed sync, the SimpleVoIP
// archive, and the email refreshes. Two processes running them means Lyndsay
// gets the EOD twice, the grading bill doubles, and two writers race on the
// same rows.
//
// So crons are OFF unless ENABLE_CRONS is explicitly "true", and only the
// dashboard sets it. The failure mode of a missing or misspelled variable is
// "this service runs no crons", never "every cron runs twice" — the first is a
// quiet gap someone notices the next morning, the second sends duplicate mail
// to the CEO and spends real money. Arturo asked for it this way round on
// 2026-09-24, and it is the right way round.
//
// LOCAL DEVELOPMENT: unset means no crons, which is also what you want on a
// laptop. Set ENABLE_CRONS=true in .env if you are specifically testing one.
// =====================================================================

const cron = require('node-cron');

const ENABLE_CRONS = String(process.env.ENABLE_CRONS || '').trim().toLowerCase() === 'true';

// Registered names, so the boot log says what was skipped rather than leaving a
// silent absence someone has to infer from a missing email.
const skipped = [];

let announced = false;
function announceOnce() {
  if (announced) return;
  announced = true;
  // Deferred to the next tick so every module-level schedule() call has run and
  // the list is complete when it prints.
  setImmediate(() => {
    if (ENABLE_CRONS) console.log(`[cron] ENABLE_CRONS=true — ${registered} scheduled job(s) active`);
    else console.log(`[cron] ENABLE_CRONS is not "true" — ${skipped.length} job(s) NOT scheduled on this service: ${skipped.join(', ')}`);
  });
}

let registered = 0;

/**
 * Same signature as node-cron's schedule(). Returns null when disabled — the
 * call sites here never use the returned task, and a null is more honest than a
 * stub that pretends to be scheduled.
 */
function schedule(expression, fn, options) {
  announceOnce();
  if (!ENABLE_CRONS) {
    skipped.push(String(expression));
    return null;
  }
  registered++;
  return cron.schedule(expression, fn, options);
}

module.exports = {
  schedule, validate: cron.validate, ENABLE_CRONS,
  // Read by /health so a deploy can be CONFIRMED to have picked ENABLE_CRONS
  // up, rather than discovered the next morning when no EOD email arrives.
  // Counts only — no secret, and nothing an unauthenticated caller can use.
  stats: () => ({ enabled: ENABLE_CRONS, scheduled: registered, skipped: skipped.length }),
};
