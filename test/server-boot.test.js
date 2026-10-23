// Does server.js actually start?
//
// WHY THIS EXISTS. On 2026-10-23 a deploy exited 1 on every Render boot with
//
//   ReferenceError: Cannot access 'CRM_CONFIGURED' before initialization
//
// because a new deactivatedRefresh(true) ran at module level, three thousand
// lines above the `const CRM_CONFIGURED = ...` it reads. A const is in the
// temporal dead zone until its own line runs; the function declaration around
// it hoists, so nothing looked wrong.
//
// 124 suites passed. `node --check` passed — it only parses. boot-smoke.test.js
// executes the FRONT-END bundle in jsdom and never loads server.js. So the
// entire server could fail to start and the suite was green. This is the
// missing layer, and it is the same layer boot-smoke added for app.js after a
// module-level call broke that bundle on 2026-09-23.
//
// HOW IT STAYS AWAY FROM PRODUCTION. server.js calls require('dotenv').config(),
// which reads `.env` from the CURRENT WORKING DIRECTORY — and this repo's .env
// is production: the service-role key, the Graph secrets, the Asana token.
// So the child is spawned from a temp directory holding an EMPTY .env, and
// given an explicit environment of its own. Every path in server.js resolves
// through __dirname, so the different cwd changes nothing else.
//
// Belt and braces on top of that: ENABLE_CRONS is unset (cron-guard requires
// the exact string "true"), and the Supabase URL points at a host that does
// not exist. The boot must survive that — a server that only starts when the
// database answers is a server that cannot start during an outage.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const results = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

// A port nothing else is on. Not 3000: a dev server on the laptop would make
// the boot fail with EADDRINUSE and look like a code fault.
const PORT = 39411 + (process.pid % 97);

function bootServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
  // The empty .env dotenv will find instead of the real one.
  fs.writeFileSync(path.join(dir, '.env'), '', 'utf8');

  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    env: {
      // A floor, not an inheritance: PATH so node can run, and nothing of ours.
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,     // Windows needs it for sockets
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // Unreachable on purpose. Shaped like a URL so config parsing runs.
      SUPABASE_URL: 'https://boot-test.invalid',
      SUPABASE_ANON_KEY: 'boot-test-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'boot-test-service',
      JWT_SECRET: 'boot-test-secret',
      // APP_BASE_URL stays localhost so the keep-alive self-ping is skipped.
      APP_BASE_URL: 'http://127.0.0.1:' + PORT,
      // ENABLE_CRONS deliberately absent.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });

  return new Promise(resolve => {
    let done = false;
    // WAIT FOR THE CHILD TO BE GONE BEFORE RESOLVING.
    //
    // Killing it and resolving immediately let the parent reach process.exit()
    // while libuv was still tearing down the child's pipes. On Windows that
    // aborts with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and
    // the process exits 127 — every assertion passing, the suite reporting a
    // failure, and nothing in the output explaining why.
    // Assigned once the timers below exist; the listeners that call finish()
    // only fire on a later tick, so it is always set by then.
    let cleanupTimers = () => {};
    const finish = r => {
      if (done) return;
      done = true;
      cleanupTimers();
      const cleanup = () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
        resolve(r);
      };
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      if (child.exitCode !== null || child.signalCode !== null) return cleanup();
      child.once('close', cleanup);
      try { child.kill(); } catch (e) { return cleanup(); }
      // If it will not go, do not hang the suite over a temp directory.
      setTimeout(cleanup, 3000);
    };

    child.on('exit', code => finish({ booted: false, code, out, err }));
    child.on('error', e => finish({ booted: false, code: null, out, err: err + e.message }));

    // Booted means it SAID so. Waiting a fixed time and assuming success would
    // pass for a process that is still crashing.
    // BOTH STREAMS. logLine() writes to stderr, so the "listening" line this
    // waits for does not arrive on stdout — watching only stdout timed out on
    // a server that had started perfectly well.
    // BOTH STREAMS, THEN A BEAT. logLine() writes to stderr, so the
    // "listening" line does not arrive on stdout — watching only stdout timed
    // out on a server that had started fine. And cron-guard defers its summary
    // to the next tick so every module-level schedule() has run, so finishing
    // the instant "listening" appears cut the log off before it. Half a second
    // of grace collects the rest of startup; an exception thrown after listen
    // lands in it too.
    const poll = setInterval(() => {
      if (/listening on http/i.test(out + err)) {
        clearInterval(poll);
        // Then ask it something before killing it. Boot proves the process
        // survived `require`; a real request proves the routes were actually
        // registered on the app, which is a different claim.
        setTimeout(async () => {
          const hit = async (p, opts) => {
            try {
              const res = await fetch('http://127.0.0.1:' + PORT + p, opts);
              return res.status;
            } catch (e) { return 'unreachable: ' + e.message; }
          };
          const probe = {
            setActive: await hit('/api/auth/admin/set-active', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ username: 'nobody', active: false }),
            }),
            // A route behind no auth at all, so "the server refuses
            // everything" can be told apart from "this route is guarded".
            health: await hit('/health', {}),
          };
          finish({ booted: true, code: null, out, err, probe });
        }, 500);
      }
    }, 100);

    // CLEARED ON EVERY PATH. Without process.exit() to cut the process short,
    // a live 45s handle keeps the event loop open — the suite still passed and
    // took 45 seconds to say so. unref() alone would not do: the handle must
    // not fire after a successful boot either.
    const bail = setTimeout(() => {
      clearInterval(poll);
      finish({ booted: false, code: 'timeout', out, err });
    }, 45000);
    const clearTimers = () => { clearInterval(poll); clearTimeout(bail); };
    child.once('close', clearTimers);
    cleanupTimers = clearTimers;
  });
}

(async () => {
  console.log('server boot');
  const r = await bootServer();

  t('server.js starts without throwing', () => {
    // The whole point. Print the real output on failure — a boot error is one
    // line and burying it would mean running this by hand to read it.
    assert.ok(r.booted, 'the server did not start (exit ' + r.code + ')\n'
      + '       stderr: ' + (r.err || '(none)').trim().split('\n').slice(0, 6).join('\n               ')
      + '\n       stdout: ' + (r.out || '(none)').trim().split('\n').slice(-4).join('\n               '));
  });

  t('nothing threw on the way up', () => {
    // A caught-and-logged failure is fine; an uncaught one is what exited 1.
    assert.ok(!/uncaughtException|unhandledRejection/i.test(r.err + r.out),
      'an exception escaped at startup:\n       ' + (r.err || r.out).slice(0, 400));
    assert.ok(!/ReferenceError|TypeError: Cannot read/i.test(r.err),
      'a reference error at startup:\n       ' + r.err.slice(0, 400));
  });

  t('it boots with the database unreachable', () => {
    // SUPABASE_URL points at .invalid. A server that only starts when Supabase
    // answers cannot start during an outage — which is when it is needed.
    assert.ok(r.booted, 'the boot depends on the database being reachable');
  });

  t('the temporal dead zone is gone, specifically', () => {
    assert.ok(!/before initialization/i.test(r.err + r.out),
      'something is still read before it is declared:\n       ' + (r.err || r.out).slice(0, 400));
  });

  t('crons did not register in the test boot', () => {
    // If this ever fails, the test env is firing the 2 AM grading and the 6 PM
    // email to Lyndsay from somebody's laptop.
    //
    // ASSERTED ON THE POSITIVE CONFIRMATION, not on the absence of a word.
    // The first version matched /ENABLE_CRONS.*true/ and failed on cron-guard's
    // own line — `ENABLE_CRONS is not "true" — 36 job(s) NOT scheduled` — which
    // is the message saying it did the right thing. A test that fires on the
    // all-clear is worse than no test.
    const log = r.out + r.err;
    assert.match(log, /job\(s\) NOT scheduled/,
      'cron-guard did not announce that it skipped the jobs — crons may be live');
  });

  t('the server answers, so the routes really registered', () => {
    assert.strictEqual(r.probe && r.probe.health, 200,
      '/health did not answer 200 — got ' + JSON.stringify(r.probe && r.probe.health));
  });

  t('set-active exists and refuses an unauthenticated caller', () => {
    // 404 would mean the route never registered; 500 would mean it ran and
    // fell over. 403 is the guard doing its job, and it needs no database to
    // say so.
    assert.strictEqual(r.probe && r.probe.setActive, 403,
      'expected 403 from requireMetricAdmin, got '
      + JSON.stringify(r.probe && r.probe.setActive));
  });

  // ---- the init order, in the source ------------------------------------------
  const src = fs.readFileSync(SERVER, 'utf8');

  t('the deny-list is primed after its dependencies, not at module level', () => {
    const decl = src.indexOf('const CRM_CONFIGURED =');
    const call = src.indexOf('deactivatedRefresh(true)');
    assert.ok(decl > 0 && call > 0, 'one of the two moved');
    assert.ok(call > decl,
      'deactivatedRefresh(true) runs before CRM_CONFIGURED is declared — this is '
      + 'the exact crash of 2026-10-23');
  });

  t('priming the list cannot take the server down', () => {
    const from = src.indexOf('function bootDeactivated');
    assert.ok(from > 0, 'bootDeactivated is gone');
    const body = src.slice(from, from + 400);
    assert.ok(/try \{/.test(body) && /catch/.test(body),
      'a failure priming the deny-list would be fatal again');
  });

  t('it is still primed at boot, not left to the first request', () => {
    const at = src.indexOf('app.listen(PORT, HOST');
    const body = src.slice(at, at + 400);
    assert.ok(/bootDeactivated\(\)/.test(body),
      'nothing primes the list — a restart hands one request window to a '
      + 'deactivated account');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  // exitCode, not exit(): let node close the handles it still owns. Calling
  // process.exit() here is what produced the 127 above.
  process.exitCode = fail ? 1 : 0;
})();
