/* ============================================================================
 * Maintenance Coordinator — Daily Command Center
 * ============================================================================
 * Ported from reference/maintenance_coordinator_daily_11.html, the standalone
 * tool Erick has been running outside the dashboard. The detection logic — 22
 * task categories, the column matcher, the work-order merge, the inspection and
 * hours audits — is carried across as it was rather than rewritten: it encodes
 * a lot of hard-won operational knowledge, and a rewrite would silently change
 * which work orders get flagged.
 *
 * What did change, and why:
 *
 *  - COORD_NAME is Erick, not Arturo. It decides which inspections raise a
 *    "review and re-mark done" task: the rule is "marked done by someone other
 *    than the Coordinator". Left as Arturo, every inspection Erick completed
 *    would flag itself for his own review and every one of Arturo's would pass
 *    silently — the category inverted.
 *
 *  - The "Export to Dashboard" and localhost:3000 "Refresh" buttons are gone.
 *    They existed to push tasks from a standalone page into this dashboard.
 *    The page is now inside it, so there is nothing to push. Export / Import
 *    activity stay: they are how a day's progress moves between devices.
 *
 *  - SheetJS and PapaParse load on first use rather than on page load,
 *    mirroring loadLeaflet(). This is one tab of twelve and most sessions never
 *    open it; a blocking script tag would cost every one of them.
 *
 *  - The workbook template was a 10KB base64 string inside the script. It is
 *    now a real file in public/, which is what it always was.
 *
 * Relies on $ / $$ / esc / toast from app.js, loaded before this file.
 * ========================================================================== */

/* ---------------- config ---------------- */
const CC_TODAY = new Date();
const CC_REPORT_NAMES = { bill:'Work Order Billable', labor:'Labor Summary', cf:'Custom Fields', wo:'All Work Orders', inv:'Inventory Usage', insp:'Inspection Detail', realmx:'Realm-X Workflows', audit:'Audit (unbilled)' };
const CC_TODAY_KEY = CC_TODAY.toISOString().slice(0, 10);
const CC_TRANSLATION_CUTOFF = new Date('2026-06-10T00:00:00');
const CC_INSPECTION_CUTOFF = new Date('2026-06-23T00:00:00');
const CC_COORD_NAME = 'Erick';
const CC_LOW_HOURS = 6;
const CC_LABOR_RATES = 'Standard override: $34/hr for most techs; Josue $42/hr; Raul $50/hr.';
const CC_STD_REMINDER = 'Then remind the tech about any policy violation and update the work-order notes.';
const CC_BASE = 'https://metricpropertymanagement.appfolio.com';
const CC_EMERGENCY_KW = ['no ac','no a/c','no air','not cooling','no cooling','no heat','not heating','flood','flooding',' gas ','gas leak',' leak','burst','fire','smoke','injury','blood',' secure','break in','broken door','broken window','no hot water','sewage','sewer','overflow','backed up','backup','outage','electrical hazard','spark','lockout','exposed wire','carbon monoxide','co detector','refrigerator not','fridge not','freezer not','will not lock',"won't lock"];
const CC_STOP = new Set('the a an is in to of and for on at please need needs not no it with this that my our your has have been was were are am be do does did will would should can could i we you they he she him her them as by or but if so then there here out up down off over under'.split(' '));
const CC_PEST = ['bug','bugs','roach','cockroach','rodent','rat','rats','mice','mouse','pest','pests','ants','ant','termite','termites','spider','spiders','infestation','infested','exterminat','flea','fleas','wasp','wasps','bees','bee','silverfish','gnats'];
const CC_PEST_RE = new RegExp('\\b(' + CC_PEST.join('|') + ')\\b', 'i');

/* Column candidates, matched against normalised headers. */
const CC_COLS = {
  woId:['workorderid'], woNum:['workordernumber','workorder#','workorder'],
  workflowName:['workflowname','workflow','flowname'],
  dueDate:['duedate','dueon','targetdate','scheduleddate','due'],
  srId:['servicerequestid'], link:['url','link','workorderurl','workorderlink'],
  status:['workorderstatus','status','wostatus'],
  property:['property','propertyname'], unit:['unit','unitname'],
  tech:['assigneduser','assignee','assignedto','technician','maintenancetech','assigned'],
  vendor:['vendor','assignedvendor','vendorname'],
  issue:['workorderissue','workorderissues','category','problemcategory'],
  wotype:['workordertype'], priority:['priority','urgency'],
  created:['createddate','created','createdat','datecreated','createdon'],
  completedOn:['workcompletedon','workcompleted','completedon','datecompleted'],
  startTime:['starttime','timerstart','startedat','timestarted','laborstart','startdatetime','clockin'],
  endTime:['endtime','timerstop','endedat','timeended','laborend','stoptime','enddatetime','clockout'],
  laborDate:['labordate'], laborTech:['maintenancetech','maintenancetechnician'],
  amount:['amount'], invAddedOn:['inventoryaddedon'], cost:['cost'], salePrice:['saleprice'],
  itemName:['itemname'], category:['category'],
  completedBy:['completedby','doneby','markedcompletedby','submittedby','inspectedby','markeddoneby','completeduser'],
  inspector:['inspector','assignedtechnician'],
  template:['inspectiontemplate','template','inspectionname','inspectiontype'],
  inspId:['inspectionid','inspectionnumber'],
  hours:['workedhours','billablehours','hours','laborhours','totalhours'],
  afterhours:['markedafterhours','afterhours'], codeviolation:['codeviolation'],
  lifesafety:['lifesafetyissue','lifesafety'],
  parts:['partsneededorderedtracking','partsneeded','partsstatus','partstatus'],
  estcompletion:['estimatedcompletiontime','estcompletiontime'],
  billtype:['billabletype'], quantity:['quantity','qty'],
  unbilled:['unbilledamount','unbilled'],
  desc:['description','jobdescription','notes','completionnotes','summary'],
  ageDays:['age','daysopen','days','agedays'],
};

/* ---------------- state ---------------- */
const ccReports = {};
let CC_TASKS = [];
let ccChecks = ccLoadChecks();
let ccLibsPromise = null;

/* Same shape as loadLeaflet(): fetched once, on first use, and a failed CDN
   leaves the promise unset so a retry is possible. */
function ccLoadLibs() {
  if (window.XLSX && window.Papa) return Promise.resolve();
  if (ccLibsPromise) return ccLibsPromise;
  const one = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
  ccLibsPromise = Promise.all([
    window.XLSX ? Promise.resolve() : one('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),
    window.Papa ? Promise.resolve() : one('https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js'),
  ]).catch(err => { ccLibsPromise = null; throw err; });
  return ccLibsPromise;
}

function ccNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/* Checks are per-day and yesterday's are dropped on load, so the board resets
   each morning the way the routine does. */
function ccLoadChecks() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('mcc_checks_') && k !== 'mcc_checks_' + CC_TODAY_KEY)
      .forEach(k => localStorage.removeItem(k));
    return JSON.parse(localStorage.getItem('mcc_checks_' + CC_TODAY_KEY) || '{}');
  } catch { return {}; }
}
function ccSaveChecks() {
  try { localStorage.setItem('mcc_checks_' + CC_TODAY_KEY, JSON.stringify(ccChecks)); } catch { /* private mode */ }
}

function ccMapColumns(headers) {
  const map = {};
  const nh = headers.map(h => ({ raw: h, n: ccNorm(h) }));
  for (const field in CC_COLS) {
    for (const cand of CC_COLS[field]) {
      const hit = nh.find(h => h.n === cand) || nh.find(h => h.n.includes(cand) && cand.length > 3);
      if (hit) { map[field] = hit.raw; break; }
    }
  }
  return map;
}
function ccVal(row, map, field) { const c = map[field]; return c ? String(row[c] ?? '').trim() : ''; }
function ccTruthy(v) { const s = String(v || '').trim().toLowerCase(); return s !== '' && !['no','false','n','0','-','—','none','n/a'].includes(s); }
function ccParseDate(s) { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d; }
function ccDaysOld(d) { return d ? Math.floor((CC_TODAY - d) / 86400000) : null; }
function ccNum(v) { const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function ccHourOf(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
  if (m) { let h = parseInt(m[1], 10) % 12; if (/p/i.test(m[3])) h += 12; return h; }
  m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) { const h = parseInt(m[1], 10); return (h >= 0 && h <= 23) ? h : null; }
  return null;
}

/* ---------------- file intake ---------------- */
function ccNorm0(v) { return String(v == null ? '' : v).trim(); }

/* AppFolio exports carry five rows of report metadata before the real header,
   so the header is found by scoring rows against known column names rather than
   assumed to be first. Confirmed against the sample workbook: every tab puts it
   on row 6. */
function ccFindHeaderRow(aoa) {
  const TOKENS = ['work order','property','unit ','status','priority','maintenance tech','worked hours','billable hours','marked after hours','start time','end time','timer','code violation','life safety','parts needed','estimated completion','item name','inspection name','marked done','quantity','sale price','service request','unbilled','billed amount','assigned user','created','vendor','labor date','inventory added','description'];
  let best = -1, bestScore = 0;
  const lim = Math.min(aoa.length, 80);
  for (let i = 0; i < lim; i++) {
    const cells = (aoa[i] || []).map(c => ccNorm0(c).toLowerCase());
    if (cells.filter(c => c !== '').length < 4) continue;
    let score = 0;
    cells.forEach(c => { if (c && TOKENS.some(t => c === t.trim() || c.includes(t.trim()))) score++; });
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best === -1) {
    for (let i = 0; i < lim; i++) { if ((aoa[i] || []).filter(c => ccNorm0(c) !== '').length >= 5) { best = i; break; } }
  }
  return best;
}
function ccAoaToReport(aoa) {
  if (!aoa || !aoa.length) return null;
  const h = ccFindHeaderRow(aoa); if (h < 0) return null;
  const headerRow = aoa[h] || [];
  const cols = [], seen = {};
  headerRow.forEach((c, idx) => {
    const name = ccNorm0(c);
    if (!name || name === ' ' || seen[name]) return;
    seen[name] = 1; cols.push({ idx, name });
  });
  if (cols.length < 2) return null;
  const headers = cols.map(c => c.name), rows = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || !r.some(c => ccNorm0(c) !== '')) continue;
    const rec = {}; cols.forEach(c => { rec[c.name] = ccNorm0(r[c.idx]); });
    rows.push(rec);
  }
  return { headers, rows };
}

/* Every tab is routed by what its columns are, not by its name, so a renamed
   sheet still lands in the right slot. */
function ccDetectReport(headers) {
  const H = headers.map(ccNorm);
  const has = c => H.some(h => h.includes(c));
  if (has('inspectionname') || has('markeddoneby') || has('markeddoneon') || has('inspectiontemplate') || has('inspectionstatus') || (has('template') && (has('inspector') || has('completedby')))) return 'insp';
  if (has('inventoryaddedon') || has('inventorylocation') || (has('itemname') && has('saleprice'))) return 'inv';
  if (has('workflow')) return 'realmx';
  if (has('billabletype')) return 'bill';
  if (has('starttime') || has('timerstart')) return 'labor';
  if (has('unbilledamount')) return 'audit';
  if (has('markedafterhours') || has('workedhours') || has('billablehours')) return 'bill';
  if (has('codeviolation') || has('lifesafetyissue') || has('partsneededordered')) return 'cf';
  if (has('jobdescription') || has('primaryresident') || has('priority') || has('assigneduser')) return 'wo';
  return null;
}
function ccIngest(headers, rawRows, fallbackKey) {
  const rows = rawRows.filter(r => Object.values(r).some(v => String(v).trim() !== ''));
  if (!rows.length) return null;
  const map = ccMapColumns(headers);
  const key = ccDetectReport(headers) || fallbackKey;
  if (!key) return null;
  ccReports[key] = { rows, map, headers };
  return key;
}

async function ccLoadFile(file) {
  const el = $('#cc-status');
  const name = ((file && file.name) || '').toLowerCase();
  if (el) el.textContent = 'Reading ' + (file?.name || 'file') + '…';
  try {
    await ccLoadLibs();
  } catch (err) {
    if (el) el.textContent = '';
    return toast('Spreadsheet library unavailable — check the connection and try again.', 'error');
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const fr = new FileReader();
    fr.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        let loaded = 0; const routed = [];
        wb.SheetNames.forEach(sn => {
          const ws = wb.Sheets[sn]; if (!ws) return;
          const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
          const rep = ccAoaToReport(aoa);
          if (rep && rep.rows.length) {
            const rk = ccIngest(rep.headers, rep.rows, null);
            if (rk) { loaded++; routed.push(CC_REPORT_NAMES[rk] || sn); }
          }
        });
        if (loaded) {
          if (el) el.innerHTML = `<b>✓ Loaded ${loaded} tab${loaded === 1 ? '' : 's'}:</b> ` + routed.map(esc).join(' · ');
          ccRenderSlots();
          toast(`Loaded ${loaded} tab${loaded === 1 ? '' : 's'}`, 'success');
        } else {
          if (el) el.textContent = 'No readable report tabs were found in that workbook.';
          toast('No readable report tabs in that workbook', 'error');
        }
      } catch (err) {
        if (el) el.textContent = '';
        toast('Could not read that Excel file: ' + err.message, 'error');
      }
    };
    fr.readAsArrayBuffer(file);
  } else {
    Papa.parse(file, { header: false, skipEmptyLines: false, complete: res => {
      const rep = ccAoaToReport(res.data || []);
      const rk = rep && rep.rows.length ? ccIngest(rep.headers, rep.rows, null) : null;
      if (rk) {
        if (el) el.innerHTML = `<b>✓ Loaded:</b> ${esc(CC_REPORT_NAMES[rk] || rk)}`;
        ccRenderSlots(); toast('Loaded ' + (CC_REPORT_NAMES[rk] || rk), 'success');
      } else {
        if (el) el.textContent = 'That file had no readable data rows.';
        toast('No readable data rows in that file', 'error');
      }
    } });
  }
}

/* Which tabs are in hand, so a missing one is visible before Generate rather
   than as a silently thinner task list afterwards. */
const CC_SLOTS = [
  { key:'bill',  name:'Work Order Billable',  hint:'Status, property, unit, tech, vendor, hours, after-hours, unbilled.' },
  { key:'labor', name:'Labor Summary',        hint:'Timer start/end — powers the after-hours check and hours audit.' },
  { key:'insp',  name:'Inspection Detail',    hint:'Drives the inspection review and reminder tasks.' },
  { key:'inv',   name:'Inventory Usage',      hint:'Inventory totals; suppresses false part-needed flags.' },
  { key:'cf',    name:'Custom Fields',        hint:'Code violation, life safety, parts needed, estimated completion.' },
  { key:'audit', name:'Audit: unbilled',      hint:'Open work orders with labor not billed — the 30-day check.' },
  { key:'wo',    name:'All Work Orders',      hint:'Unassigned and new orders, priority, job description.' },
  { key:'realmx',name:'Realm-X Workflows',    hint:'Workflows assigned to you that are due or past due.' },
];
function ccRenderSlots() {
  const el = $('#cc-slots');
  if (!el) return;
  el.innerHTML = CC_SLOTS.map(s => {
    const rep = ccReports[s.key];
    return `<div class="cc-slot${rep ? ' ok' : ''}">
      <h4>${esc(s.name)}</h4>
      <p>${esc(s.hint)}</p>
      <div class="cc-slot-status">${rep ? `✓ ${rep.rows.length} rows` : 'not loaded'}</div>
    </div>`;
  }).join('');
}

/* ---------------- merge ---------------- */
/* One work order can appear in six reports under two different identifiers, so
   rows are folded together by whichever of woId / woNum they carry. */
function ccMergeWorkOrders() {
  const idx = new Map(); const all = new Set();
  function gc(woId, woNum, srId) {
    let o = (woId && idx.get('I' + woId)) || (woNum && idx.get('N' + woNum)) || null;
    if (!o) { o = { woId: woId || '', woNum: woNum || '', srId: srId || '', _src:{}, _hoursB:0, _unbB:0, _unbA:0, _af:false, _inv:false, _startAH:false, _haveStart:false }; all.add(o); }
    if (woId) { if (!o.woId) o.woId = woId; idx.set('I' + woId, o); }
    if (woNum) { if (!o.woNum) o.woNum = woNum; idx.set('N' + woNum, o); }
    if (srId && !o.srId) o.srId = srId;
    return o;
  }
  const STATIC = ['status','property','unit','tech','vendor','issue','wotype','priority','created','completedOn','startTime','endTime','desc','link','parts','estcompletion','codeviolation','lifesafety','ageDays','woNum'];
  ['wo','bill','cf','audit','labor','inv'].forEach(src => {
    const rep = ccReports[src]; if (!rep) return;
    rep.rows.forEach(row => {
      const woId = ccVal(row, rep.map, 'woId'), woNum = ccVal(row, rep.map, 'woNum'), srId = ccVal(row, rep.map, 'srId');
      if (!woId && !woNum) return;
      const o = gc(woId, woNum, srId); o._src[src] = true;
      STATIC.forEach(f => { const v = ccVal(row, rep.map, f); if (v && (o[f] === undefined || o[f] === '')) o[f] = v; });
      if (ccTruthy(ccVal(row, rep.map, 'afterhours'))) o._af = true;
      if (src === 'bill') {
        o._hoursB += ccNum(ccVal(row, rep.map, 'hours'));
        o._unbB += ccNum(ccVal(row, rep.map, 'unbilled'));
        const bt = ccNorm(ccVal(row, rep.map, 'billtype')), qty = ccNum(ccVal(row, rep.map, 'quantity'));
        if (/invent|material|part|supply/.test(bt) || (qty > 0 && bt !== '' && !/labor|hour|service/.test(bt))) o._inv = true;
      } else if (src === 'audit') { o._unbA += ccNum(ccVal(row, rep.map, 'unbilled')); }
      else if (src === 'inv') { o._inv = true; }
      const sh = ccHourOf(ccVal(row, rep.map, 'startTime'));
      if (sh != null) { o._haveStart = true; if (sh >= 18 || sh < 8) o._startAH = true; }
    });
  });
  return [...all].map(o => {
    o.hours = o._hoursB;
    o.unbilled = o._unbB > 0 ? o._unbB : o._unbA;
    o.afterhours = o._af ? 'yes' : '';
    o.inventory = o._inv ? 'yes' : '';
    return o;
  });
}

function ccWoLink(o) {
  if (o.link && /^https?:/i.test(o.link)) return o.link;
  if (o.srId && o.woId) return `${CC_BASE}/maintenance/service_requests/${encodeURIComponent(o.srId)}/work_orders/${encodeURIComponent(o.woId)}`;
  if (o.woId) return `${CC_BASE}/maintenance/work_orders/${encodeURIComponent(o.woId)}`;
  return null;
}
function ccInspLink(inspId) {
  return inspId ? (CC_BASE + '/maintenance/inspections/' + encodeURIComponent(inspId))
                : (CC_BASE + '/maintenance/inspections?filters%5Bstatus_list%5D=IN+PROGRESS');
}

/* ---------------- detectors ---------------- */
const ccStatusOf = o => (o.status || '').toLowerCase();
const ccIsCancelled = o => ccStatusOf(o).includes('cancel');
const ccIsWorkDone = o => ccStatusOf(o).includes('work done');
const ccIsReadyToBill = o => ccStatusOf(o).includes('ready to bill');
const ccIsCompleted = o => ccStatusOf(o).includes('complete');
const ccIsClosed = o => ccIsReadyToBill(o) || ccIsWorkDone(o) || ccIsCompleted(o) || ccIsCancelled(o);
const ccAssigned = o => ccTruthy(o.tech) || /assigned|scheduled|in[ -]?progress|work done|ready to bill|completed|waiting|on hold|estimate/.test(ccStatusOf(o));
const ccHasVendor = o => ccTruthy(o.vendor);

function ccPartsAction(raw) {
  const n = ccNorm(raw);
  if (n.includes('notinshop')) return 'Part needed, not in shop — add details to the notes, then follow up.';
  if (n.includes('homedepot') || n.includes('nexttrip')) return 'Will buy next Home Depot trip — remind the tech in the notes and tag them.';
  if (n.includes('pendingarrival') || (n.includes('ordered') && n.includes('pending'))) return 'Ordered, pending arrival — check with the supplier that the part is on the way, then update the notes.';
  if (n.includes('arrived')) return 'Parts arrived — notify the tech (tag them) the part is in, update the notes, and schedule the install.';
  if (n.includes('supervisor') || n.includes('approval')) return 'Pending supervisor approval — tag the supervisor in the notes asking for approval and link the order.';
  return null;
}
const CC_PART_USE = ['replaced','installed','reinstalled','re-installed','swapped','changed out','change out','put in a new','installed a new','installed new','replaced the','replaced with','new part','replacement part','mounted a new'];
function ccPartTrigger(t) {
  if (!t) return null;
  const s = ' ' + t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  return CC_PART_USE.find(k => s.includes(k)) || null;
}
const CC_APPLIANCE_KW = ['refrigerator','fridge','stove','oven','range','dishwasher','microwave','washer','dryer','water heater','disposal','freezer','a/c unit','ac unit','furnace'];
function ccApplianceMoved(desc) {
  if (!desc) return null;
  const s = ' ' + desc.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const ap = CC_APPLIANCE_KW.find(a => s.includes(' ' + a)); if (!ap) return null;
  const verb = /(took|take|taken|taking|moved|move|moving|swap|swapped|transfer|transferr?ed|borrow|borrowed|relocat|pull|pulled|using|used|grab|grabbed)/.test(s);
  const between = /(from (unit|apt|apartment|#|\d)|out of (unit|apt|apartment|#|\d)|another (unit|apt|apartment)|other (unit|apt|apartment)|different (unit|apt|apartment)|to (unit|apt|apartment|#|\d).*(use|install|put)|use (it )?in (unit|apt|apartment|#|\d))/.test(s);
  return (verb && between) ? ap : null;
}
function ccUnitsInText(t) {
  if (!t) return [];
  const found = new Set();
  const re = /(?:\bunit\b|\bapt\.?\b|\bapartment\b|#)\s*#?\s*([0-9]{1,4}(?:-[0-9]{1,4})?[a-z]?)\b/gi;
  let m; while ((m = re.exec(t))) found.add(m[1].toLowerCase());
  return [...found];
}
const ccIsGrounds = o => /grounds|groundskeep|valet trash|leaf|landscap/.test(((o.issue || '') + ' ' + (o.wotype || '') + ' ' + (o.desc || '')).toLowerCase());
const ccIsUnitTurn = o => /unit turn|make ready|turn/.test(((o.wotype || '') + ' ' + (o.issue || '')).toLowerCase());
function ccClosedEarly(o) { const c = ccParseDate(o.completedOn); if (!c) return false; const d = c.getDay(); return d >= 1 && d <= 4; }
const ccLooksEmergency = t => { const s = ' ' + String(t || '').toLowerCase() + ' '; return CC_EMERGENCY_KW.some(k => s.includes(k)); };
function ccDescSig(d) {
  if (!d) return '';
  const w = d.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(x => x.length > 2 && !CC_STOP.has(x));
  return [...new Set(w)].sort().slice(0, 4).join(' ');
}

/* ---------------- categories ---------------- */
const CC_CATS = [
  { key:'urgent',      label:'Urgent work orders — review',        tone:'red',    desc:'Marked urgent. Check notes for completion, follow up with the tech, and update the resident daily.' },
  { key:'afterhours',  label:'After-hours marked in error',        tone:'red',    desc:'After-hours needs BOTH an after-hours timer start AND an urgent order.' },
  { key:'realmx',      label:'Realm-X workflows — due & past due',  tone:'red',    desc:'Workflows assigned to you that are due today or overdue. Complete them in AppFolio.' },
  { key:'code',        label:'Code violations & life safety',      tone:'red',    desc:'Read notes and follow up. Code violations are time-sensitive — email photos to the code officer on resolution.' },
  { key:'assign',      label:'Assign work orders',                 tone:'navy',   desc:'Every work order must be assigned — by priority, property, and tech skill.' },
  { key:'cancelbucket',label:'Cancelled, still unassigned',        tone:'grey',   desc:'Clear from the Unassigned bucket without un-cancelling.' },
  { key:'waiting',     label:'Waiting status — audit',             tone:'gold',   desc:'Completed work held for a billing issue — a QC concern or missing photos/detail.' },
  { key:'inspreview',  label:'Inspections to review & re-mark done', tone:'blue', desc:'Marked done by someone other than ' + CC_COORD_NAME + ' — review, create work orders, then re-mark Done.' },
  { key:'insppending', label:'Pending inspections — remind tech',   tone:'gold',   desc:'Not started or not completed. WhatsApp the tech to finish; the Coordinator marks it Done afterward.' },
  { key:'hours',       label:'Low hours — remind tech',            tone:'gold',   desc:'Under ' + CC_LOW_HOURS + ' hours logged the previous business day.' },
  { key:'parts',       label:'Parts needed / ordered',             tone:'teal',   desc:'Follow up by parts status.' },
  { key:'partinv',     label:'Part used but no inventory',         tone:'teal',   desc:'Description mentions a part, but no inventory is on the order.' },
  { key:'pest',        label:'Pest / rodent — add vendor',         tone:'teal',   desc:"Vendor isn't It's Bugs R Us." },
  { key:'duplicates',  label:'Possible duplicates',                tone:'purple', desc:'Same property + unit and a similar description.' },
  { key:'addunit',     label:'Add unit to work order',             tone:'blue',   desc:'Description names a unit but the Unit field is blank.' },
  { key:'splitunit',   label:'Multiple units on one WO',           tone:'red',    desc:'Break out into separate orders.' },
  { key:'missing',     label:'Missing work-order issue',           tone:'gold',   desc:'No issue/category set (includes unit turns).' },
  { key:'grounds',     label:'Grounds WO closed early',            tone:'gold',   desc:'Weekly grounds orders stay open all week; a fresh one is created each Monday.' },
  { key:'workdone',    label:'Work Done — QC & bill',              tone:'blue',   desc:'QC fully, then Ready to Bill (or No Need to Bill with a reason).' },
  { key:'aged',        label:'Unbilled over 30 days',              tone:'gold',   desc:"Hard cap — labor can't accumulate past 30 days." },
  { key:'cancellabor', label:'Cancelled with labor/inventory',     tone:'red',    desc:'Should never happen — investigate.' },
  { key:'appliance',   label:'Replace appliance moved between units', tone:'red', desc:'Verify the unit it was taken from gets a replacement work order.' },
];

function ccAddTask(list, cat, o, title, instr, extraMeta) {
  list.push({
    id: cat + ':' + (o.woId || o.srId || Math.random().toString(36).slice(2)),
    cat, title, instr,
    wo: { woId:o.woId, srId:o.srId, property:o.property, unit:o.unit, tech:o.tech, vendor:o.vendor, status:o.status, priority:o.priority },
    desc: o.desc || '', age: (o._age != null ? o._age : null), link: ccWoLink(o), extraMeta: extraMeta || null,
  });
}

function ccGenerate() {
  if (!Object.keys(ccReports).length) return toast('Load the Master Data File first', 'error');
  const wos = ccMergeWorkOrders();
  const list = [];
  wos.forEach(o => {
    const created = ccParseDate(o.created);
    const age = o.ageDays ? parseInt(o.ageDays) : ccDaysOld(created);
    o._age = age;
    const desc = o.desc || '';
    const inRich = o._src && (o._src.wo || o._src.bill);
    const inFlags = o._src && o._src.cf;
    const inLedger = o._src && (o._src.bill || o._src.audit);
    const actionable = !ccIsCompleted(o) && !ccIsCancelled(o);
    const blob = ((o.issue || '') + ' ' + desc);

    if (inLedger && age !== null && age > 7 && !ccIsCancelled(o) && (ccIsWorkDone(o) || (ccNum(o.unbilled) > 0 && !ccIsCompleted(o))))
      ccAddTask(list, 'flag7', o, 'Over 7 days in Work Done / unbilled',
        "Work Done and unbilled work orders should never sit past 7 days. QC fully and get it to Ready to Bill today. If the request isn't finished, QC the completed portion, mark it Ready to Bill, and open a new service request referencing the original.", age ? age + ' days old' : null);

    if (inRich) {
      if (ccIsCancelled(o) && !ccAssigned(o))
        ccAddTask(list, 'cancelbucket', o, 'Clear cancelled WO from Unassigned', 'Open the cancelled work order, click Edit, and assign it to the Maintenance Coordinator. It stays Cancelled but leaves the Unassigned bucket.');
      else if (!ccAssigned(o) && !ccHasVendor(o) && !ccIsClosed(o))
        ccAddTask(list, 'assign', o, 'Assign this work order', 'Assign by priority, property, and tech skill (see the skills matrix). Every work order must be assigned.');
      if (actionable && (o.priority || '').toLowerCase().includes('urgent'))
        ccAddTask(list, 'urgent', o, 'Urgent WO — check notes & follow up', 'Check the notes for completion and follow up with the tech as needed. Notes must tell the full picture. Reach out to the resident with an update (daily).');
      if (ccStatusOf(o).includes('waiting'))
        ccAddTask(list, 'waiting', o, 'Audit Waiting status', 'Waiting usually holds completed work with a billing issue — a QC concern or missing photos/detail. Check with the tech if needed to get it fully marked Ready to Bill.');
      if (CC_PEST_RE.test(blob) && actionable && !(o.vendor || '').toLowerCase().includes('bugs r us'))
        ccAddTask(list, 'pest', o, "Add It's Bugs R Us as the vendor", "Add It's Bugs R Us as the vendor so they get notified of this work order.");
      const units = actionable ? ccUnitsInText(desc) : [];
      if (units.length >= 2)
        ccAddTask(list, 'splitunit', o, 'Multiple units on one work order', 'The description references more than one unit (' + units.join(', ') + '). A work order should cover one unit — break this out into separate work orders.');
      else if (units.length === 1 && !ccTruthy(o.unit))
        ccAddTask(list, 'addunit', o, 'Add the unit to this work order', 'The description names a unit (' + units[0] + ') but the Unit field is blank. Edit the work order and add the unit.');
      const movedAp = actionable ? ccApplianceMoved(desc) : null;
      if (movedAp) {
        const hasReplacement = wos.some(x => x !== o && ccNorm(x.property) === ccNorm(o.property)
          && (' ' + String(x.desc || '').toLowerCase() + ' ').includes(movedAp)
          && /(replace|replacement|install|new |order(ed)?|deliver|purchase|buy)/.test(String(x.desc || '').toLowerCase()));
        if (!hasReplacement)
          ccAddTask(list, 'appliance', o, 'Replace the ' + movedAp + ' moved from another unit', 'This work order describes moving a ' + movedAp + ' out of another unit to use here. Confirm a work order exists to replace the missing ' + movedAp + ' in the unit it was taken from — if not, create one.');
      }
      if (!ccTruthy(o.issue) && actionable && (!created || created >= CC_TRANSLATION_CUTOFF))
        ccAddTask(list, 'missing', o, 'Set the work-order issue', ccIsUnitTurn(o) ? 'Unit-turn work order with no issue set. Edit it and add the most applicable work-order issue.' : 'This work order has no Work Order Issue set. Open it and select the correct issue/category.');
      if (ccIsGrounds(o) && (ccIsWorkDone(o) || ccIsReadyToBill(o) || ccIsCompleted(o)) && ccClosedEarly(o))
        ccAddTask(list, 'grounds', o, 'Grounds WO closed before Friday?', 'Weekly grounds orders stay open all week (a fresh one is auto-created each Monday). If this was closed before Friday, remind the tech to leave grounds open all week, then reopen a new work order and assign it to the tech.');
      if (ccIsWorkDone(o))
        ccAddTask(list, 'workdone', o, 'QC and mark Ready to Bill', 'QC the work order fully and mark it Ready to Bill. If no hours or inventory were used, click "Mark No Need to Bill" and add a reason why.');
      if (ccIsCancelled(o) && (ccNum(o.hours) > 0 || ccTruthy(o.inventory) || ccNum(o.unbilled) > 0))
        ccAddTask(list, 'cancellabor', o, 'Cancelled WO carries labor/inventory', "Cancelled work orders should never carry labor or inventory. Investigate — if work was actually done, it shouldn't be cancelled. QC and route it correctly.");
    }

    const ptrig = (o._src && o._src.bill && actionable && !ccTruthy(o.inventory)) ? ccPartTrigger(desc) : null;
    if (ptrig)
      ccAddTask(list, 'partinv', o, 'Part used but no inventory logged', 'The labor description below indicates a part was used ("' + ptrig + '") but there\'s no inventory on the work order. If a part was actually installed, message the tech on WhatsApp for details and add the inventory. If it was labor only, no action needed.', 'matched: "' + ptrig + '"');

    if (!ccIsCompleted(o)) {
      if (ccTruthy(o.codeviolation))
        ccAddTask(list, 'code', o, 'Code violation — review & follow up', 'Code violation. Read the notes and follow up as needed. Time-sensitive — keep notes current; on resolution, email photos to the code officer and attach the email to the work order.' + (o.desc ? '' : ' (Load the Work Order report for the description.)'));
      if (ccTruthy(o.lifesafety))
        ccAddTask(list, 'code', o, 'Life safety — review & follow up', 'Life-safety issue. Read the notes and follow up with priority.' + (o.desc ? '' : ' (Load the Work Order report for the description.)'));
    }
    if (inFlags) { const pa = ccPartsAction(o.parts); if (pa) ccAddTask(list, 'parts', o, 'Parts follow-up', pa, (o.parts || '').trim()); }

    const urgentish = (o.priority || '').toLowerCase().includes('urgent') || ccLooksEmergency(blob);
    if (ccTruthy(o.afterhours) && actionable && o._haveStart && !(o._startAH && urgentish)) {
      const why = [];
      if (!o._startAH) why.push('the timer was started during business hours (not 6 PM–8 AM)');
      if (!urgentish) why.push("it isn't marked urgent");
      ccAddTask(list, 'afterhours', o, 'After-hours marked in error', 'Marked after-hours but ' + why.join(' and ') + '. After-hours requires BOTH an after-hours timer start AND an urgent work order. QC it, convert to an in-house bill, and manually override the labor rate (unchecking "after hours" doesn\'t work). ' + CC_LABOR_RATES, o.startTime ? ('start ' + o.startTime) : null);
    }
    if (inLedger && !ccIsCancelled(o)) {
      const fromAudit = o._src && o._src.audit;
      if ((fromAudit || ccNum(o.unbilled) > 0) && age !== null && age > 30 && !ccIsReadyToBill(o) && !ccIsCompleted(o))
        ccAddTask(list, 'aged', o, 'Unbilled over 30 days', "Check this work order fully — if the work is complete, mark it Ready to Bill. We can't leave labor accumulated over 30 days. If the request isn't actually complete, QC the completed portion, mark it Ready to Bill, and open a NEW service request to finish the work, referencing the original.", age ? age + ' days old' : null);
    }
  });

  /* Duplicates: same property + unit + a similar description signature. */
  const dg = {};
  wos.forEach(o => {
    if (!(o._src && (o._src.wo || o._src.bill)) || ccIsCancelled(o)) return;
    const prop = ccNorm(o.property), unit = ccNorm(o.unit), sig = ccDescSig(o.desc);
    if (!prop || !unit || !sig) return;
    (dg[prop + '|' + unit + '|' + sig] = dg[prop + '|' + unit + '|' + sig] || []).push(o);
  });
  Object.values(dg).forEach(g => {
    const uq = [...new Map(g.map(o => [o.woId, o])).values()];
    if (uq.length < 2) return;
    list.push({
      id: 'dup:' + uq.map(o => o.woId).join('_'), cat: 'duplicates',
      title: 'Possible duplicate (' + uq.length + ' work orders)',
      instr: 'Same property + unit and a similar description. Review — cancel the most recent duplicate with a note referencing the open work order number.',
      wo: { property: uq[0].property, unit: uq[0].unit }, desc: '', age: null, link: null,
      group: uq.map(o => ({ woId:o.woId, srId:o.srId, status:o.status, age:o._age, desc:o.desc, link:ccWoLink(o) })),
    });
  });

  ccRealmXTasks(list);
  ccInspectionTasks(list);
  ccHoursAudit(list);

  /* A task id is category + work-order id, and completion is keyed on it. A work
     order flagged BOTH a code violation and a life-safety issue therefore
     produced two tasks under one id, and ticking either marked both done —
     quietly closing a life-safety follow-up nobody had read. Carried over from
     the standalone tool, where it does the same thing.
     Ids that do not collide keep their exact original form, so activity
     exported from that tool still matches on import. */
  const seenIds = new Map();
  list.forEach(t => {
    const n = (seenIds.get(t.id) || 0) + 1;
    seenIds.set(t.id, n);
    if (n > 1) t.id += '#' + n;
  });

  CC_TASKS = list;
  ccRenderTasks();
  ccRenderTotals();
  toast(list.length ? `${list.length} tasks generated` : 'Nothing flagged', list.length ? 'success' : 'info');
}

/* ---------------- realm-x / inspections / hours ---------------- */
function ccCleanTech(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim().replace(/\s*\(hidden\)$/i, '').trim().replace(/[\s,]+[-Cc]$/, '').trim();
}
const ccYmd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const ccFmtD = d => d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
const ccRound1 = x => Math.round(x * 10) / 10;
const ccMoney = x => '$' + Math.round(x).toLocaleString();
function ccWeekStart(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const ccMonthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);
function ccPrevBusinessDay(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); do { x.setDate(x.getDate() - 1); } while (x.getDay() === 0 || x.getDay() === 6); return x; }
function ccPropName(pn) { if (!pn) return ''; const x = String(pn), i = x.indexOf(' - '); return (i > 0 ? x.slice(0, i) : x).trim(); }

function ccRealmXTasks(list) {
  const rep = ccReports.realmx; if (!rep) return;
  const m = rep.map;
  const today = new Date(CC_TODAY.getFullYear(), CC_TODAY.getMonth(), CC_TODAY.getDate());
  rep.rows.forEach(r => {
    if (/done|complete|finished|closed|cancel/.test((ccVal(r, m, 'status') || '').toLowerCase())) return;
    const due = ccParseDate(ccVal(r, m, 'dueDate')); if (!due) return;
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    if (dueDay > today) return;
    const wf = ccVal(r, m, 'workflowName') || 'Realm-X workflow';
    const overdue = dueDay < today, days = Math.round((today - dueDay) / 86400000);
    const o = { woId: ccVal(r, m, 'woId'), woNum: ccVal(r, m, 'woNum'), srId: ccVal(r, m, 'srId'), property: ccVal(r, m, 'property'), unit: ccVal(r, m, 'unit'), tech: ccVal(r, m, 'tech') };
    list.push({
      id: 'realmx:' + wf + '|' + (o.woNum || ccVal(r, m, 'created') || wf), cat: 'realmx',
      title: (overdue ? 'Past due: ' : 'Due today: ') + wf,
      instr: 'Realm-X workflow assigned to you ' + (overdue ? ('is ' + days + ' day' + (days === 1 ? '' : 's') + ' past due') : 'is due today') + ' (due ' + ccFmtD(dueDay) + '). Complete it in AppFolio.',
      wo: o, desc: '', age: overdue ? days : null, link: ccWoLink(o),
    });
  });
}
function ccInspectionTasks(list) {
  const rep = ccReports.insp; if (!rep) return;
  const m = rep.map;
  rep.rows.forEach(r => {
    const created = ccParseDate(ccVal(r, m, 'created'));
    if (created && created < CC_INSPECTION_CUTOFF) return;
    const status = (ccVal(r, m, 'status') || '').toLowerCase(); if (!status) return;
    const prop = ccVal(r, m, 'property'), unit = ccVal(r, m, 'unit'), tmpl = ccVal(r, m, 'template'), inspId = ccVal(r, m, 'inspId');
    const completedBy = ccVal(r, m, 'completedBy'), inspector = ccVal(r, m, 'inspector');
    const link = ccInspLink(inspId);
    if (/done|complete|submitted|approved|finished/.test(status)) {
      if ((completedBy || '').toLowerCase().indexOf(CC_COORD_NAME.toLowerCase()) === -1)
        list.push({ id: 'insprev:' + (inspId || prop + unit + tmpl), cat: 'inspreview',
          title: 'Review inspection' + (tmpl ? ': ' + tmpl : ''),
          instr: 'Marked done by ' + (completedBy || 'a tech') + '. Review it, create work orders for any items needed, then re-mark it Done — the Maintenance Coordinator marks inspections done, not techs.',
          wo: { property: prop, unit, tech: completedBy }, desc: '', age: null, link });
    } else {
      list.push({ id: 'insppend:' + (inspId || prop + unit + tmpl), cat: 'insppending',
        title: 'Pending inspection' + (tmpl ? ': ' + tmpl : ''),
        instr: "This inspection isn't started/completed (status: " + status + '). Remind ' + (inspector || 'the tech') + ' on WhatsApp to complete it — the Coordinator marks it Done afterward.',
        wo: { property: prop, unit, tech: inspector }, desc: '', age: null, link });
    }
  });
}
function ccLaborLines() {
  const out = [], rep = ccReports.bill || ccReports.labor;
  if (!rep) return out;
  const useBill = !!ccReports.bill, m = rep.map;
  rep.rows.forEach(r => {
    const techs = String(ccVal(r, m, 'laborTech') || ccVal(r, m, 'tech') || '').split(/[,;/]| and /i).map(ccCleanTech).filter(Boolean);
    const date = ccParseDate(ccVal(r, m, 'laborDate')) || ccParseDate(ccVal(r, m, 'completedOn')) || ccParseDate(ccVal(r, m, 'created'));
    let inv = 0;
    if (useBill) { const bt = ccNorm(ccVal(r, m, 'billtype')); if (/invent|material|part|supply/.test(bt)) inv = ccNum(ccVal(r, m, 'amount')); }
    out.push({ techs, prop: ccVal(r, m, 'property'), date, hours: ccNum(ccVal(r, m, 'hours')), inv });
  });
  return out;
}
function ccInvLines() {
  const out = [], rep = ccReports.inv;
  if (!rep) return out;
  const m = rep.map;
  rep.rows.forEach(r => {
    const qty = ccNum(ccVal(r, m, 'quantity')), sale = ccNum(ccVal(r, m, 'salePrice')), cost = ccNum(ccVal(r, m, 'cost'));
    out.push({ prop: ccVal(r, m, 'property'), unit: ccVal(r, m, 'unit'),
      date: ccParseDate(ccVal(r, m, 'invAddedOn')) || ccParseDate(ccVal(r, m, 'created')),
      amount: qty * (sale || cost) });
  });
  return out;
}
/* Weekdays only: on a Monday the "previous business day" is Friday, and on a
   weekend there is no shift to audit. */
function ccHoursAudit(list) {
  if (CC_TODAY.getDay() < 1 || CC_TODAY.getDay() > 5) return;
  const lines = ccLaborLines(); if (!lines.length) return;
  const ws = ccWeekStart(CC_TODAY), pbd = ccPrevBusinessDay(CC_TODAY), key = ccYmd(pbd);
  const active = {}, prev = {};
  lines.forEach(l => l.techs.forEach(tech => {
    if (l.date && l.date >= ws) active[tech] = (active[tech] || 0) + l.hours;
    if (l.date && ccYmd(l.date) === key) prev[tech] = (prev[tech] || 0) + l.hours;
  }));
  Object.keys(active).forEach(tech => {
    const h = prev[tech] || 0;
    if (h < CC_LOW_HOURS)
      list.push({ id: 'hours:' + tech, cat: 'hours', title: tech + ' — ' + ccRound1(h) + 'h on ' + ccFmtD(pbd),
        instr: 'Only ' + ccRound1(h) + ' hours logged for ' + ccFmtD(pbd) + '. Reach out to ' + tech + ' and remind them to enter their hours in real time.',
        wo: { tech }, desc: '', age: null, link: null });
  });
}

/* ---------------- render ---------------- */
function ccRenderTasks() {
  const host = $('#cc-tasks'), sum = $('#cc-summary');
  if (!host) return;
  host.innerHTML = ''; if (sum) sum.innerHTML = '';
  if (!Object.keys(ccReports).length) {
    host.innerHTML = '<div class="empty-state">Load the Master Data File above, then press Generate today\'s tasks.</div>';
    return ccUpdateProgress();
  }
  if (!CC_TASKS.length) {
    host.innerHTML = '<div class="empty-state">Nothing flagged 🎉 — no tasks generated from the loaded reports.</div>';
    return ccUpdateProgress();
  }

  /* The 7-day flag is not one of CC_CATS: it renders above everything as its
     own banner, because it is the one thing that must not wait. */
  const flags = CC_TASKS.filter(t => t.cat === 'flag7');
  if (flags.length) {
    const a = document.createElement('div');
    a.className = 'cc-alert';
    a.innerHTML = `<div class="cc-alert-head"><span>⚠️</span><h4>Clear these first — over 7 days</h4>
      <span class="cc-count" id="cc-flag7count">${flags.filter(t => !ccChecks[t.id]).length} open</span></div>
      <p class="small">Work Done and unbilled work orders should never sit past 7 days.</p>`;
    flags.forEach(t => a.appendChild(ccTaskRow(t)));
    host.appendChild(a);
  }

  CC_CATS.forEach(cat => {
    let items = CC_TASKS.filter(t => t.cat === cat.key);
    if (!items.length) return;
    let descHtml = esc(cat.desc);
    if (cat.key === 'insppending') {
      items = items.slice().sort((a, b) => String(a.wo.tech || '~').localeCompare(String(b.wo.tech || '~')));
      const by = {}; items.forEach(t => { const k = t.wo.tech || 'Unassigned'; by[k] = (by[k] || 0) + 1; });
      const tally = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} (${v})`).join(' · ');
      if (tally) descHtml += ` &nbsp;|&nbsp; <b>By tech:</b> ${tally}`;
    }
    const open = items.filter(t => !ccChecks[t.id]).length;

    if (sum) {
      const pill = document.createElement('button');
      pill.className = 'cc-pill';
      pill.innerHTML = `${esc(cat.label)} <b>${open}</b>`;
      pill.onclick = () => $('#cc-cat-' + cat.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sum.appendChild(pill);
    }

    const c = document.createElement('div');
    c.className = 'cc-cat cc-tone-' + cat.tone;
    c.id = 'cc-cat-' + cat.key;
    c.innerHTML = `<div class="cc-cat-head"><span class="cc-acc"></span>
        <h4>${esc(cat.label)}</h4><span class="cc-count">${open} open</span><span class="cc-chev">▾</span></div>
      <div class="cc-cat-desc">${descHtml}</div><div class="cc-cat-body"></div>`;
    c.querySelector('.cc-cat-head').onclick = () => c.classList.toggle('collapsed');
    const body = c.querySelector('.cc-cat-body');
    items.forEach(t => body.appendChild(ccTaskRow(t)));
    host.appendChild(c);
  });
  ccUpdateProgress();
}

function ccTaskRow(t) {
  const done = !!ccChecks[t.id];
  const d = document.createElement('div');
  d.className = 'cc-task' + (done ? ' done' : '');
  const meta = [];
  if (t.wo.property) meta.push(`<span class="cc-chip">${esc(t.wo.property)}${t.wo.unit ? ' · ' + esc(t.wo.unit) : ''}</span>`);
  if (t.wo.tech) meta.push(`<span class="cc-chip">👤 ${esc(t.wo.tech)}</span>`);
  if (t.wo.vendor) meta.push(`<span class="cc-chip">🏢 ${esc(t.wo.vendor)}</span>`);
  if (t.wo.status) meta.push(`<span class="cc-chip">${esc(t.wo.status)}</span>`);
  if (t.wo.priority) meta.push(`<span class="cc-chip">${esc(t.wo.priority)}</span>`);
  if (t.age != null) meta.push(`<span class="cc-chip">${t.age}d old</span>`);
  if (t.extraMeta) meta.push(`<span class="cc-chip kpi">${esc(t.extraMeta)}</span>`);
  if (t.wo.woId) meta.push(`<span class="cc-chip">WO ${esc(t.wo.woId)}${t.wo.srId ? ' · SR ' + esc(t.wo.srId) : ''}</span>`);

  let extra = '';
  if ((t.cat === 'code' || t.cat === 'partinv' || t.cat === 'appliance') && t.desc)
    extra = `<div class="cc-detail">${esc(t.desc)}</div>`;
  if (t.group)
    extra = '<div class="cc-dups">' + t.group.map(m =>
      `<div class="cc-dup">${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">WO ${esc(m.woId)}</a>` : 'WO ' + esc(m.woId)}
       <span>${esc(m.status || '')}${m.age != null ? ' · ' + m.age + 'd' : ''}${m.desc ? ' · ' + esc(String(m.desc).slice(0, 70)) : ''}</span></div>`).join('') + '</div>';

  const openLink = t.group ? ''
    : (t.link ? `<a class="cc-open" href="${esc(t.link)}" target="_blank" rel="noopener">Open WO ↗</a>`
              : '<span class="cc-open muted">no link</span>');

  d.innerHTML = `<input type="checkbox" class="cc-tck"${done ? ' checked' : ''}>
    <div class="cc-body">
      <div class="cc-ttl">${esc(t.title)}</div>
      <div class="cc-meta">${meta.join('')}</div>
      <div class="cc-instr">${esc(t.instr)}</div>
      ${extra}
      <div class="cc-remind">${esc(CC_STD_REMINDER)}</div>
    </div>${openLink}`;

  d.querySelector('.cc-tck').addEventListener('change', e => {
    if (e.target.checked) ccChecks[t.id] = 1; else delete ccChecks[t.id];
    ccSaveChecks();
    d.classList.toggle('done', e.target.checked);
    ccRefreshCounts();
  });
  return d;
}

function ccRenderTotals() {
  const host = $('#cc-totals'), panel = $('#cc-totals-panel');
  if (!host || !panel) return;
  const lines = ccLaborLines(), invL = ccInvLines();
  if (!lines.length && !invL.length) { panel.classList.add('hidden'); return; }
  const ws = ccWeekStart(CC_TODAY), ms = ccMonthStart(CC_TODAY);
  const HtW = {}, HpW = {}, IpW = {}, HpM = {}, IpM = {};
  lines.forEach(l => {
    if (!l.date) return;
    const prop = ccPropName(l.prop);
    if (l.date >= ws) { l.techs.forEach(t => { HtW[t] = (HtW[t] || 0) + l.hours; }); if (prop) HpW[prop] = (HpW[prop] || 0) + l.hours; }
    if (l.date >= ms && prop) HpM[prop] = (HpM[prop] || 0) + l.hours;
  });
  /* Falls back to the billable report's inventory lines when the KPI Inventory
     Usage tab is missing, so the totals are not simply blank. */
  const invSrc = invL.length ? invL : lines.map(l => ({ prop: l.prop, date: l.date, amount: l.inv }));
  const noInvSrc = !invL.length;
  invSrc.forEach(l => {
    if (!l.date || !l.amount) return;
    const prop = ccPropName(l.prop); if (!prop) return;
    if (l.date >= ws) IpW[prop] = (IpW[prop] || 0) + l.amount;
    if (l.date >= ms) IpM[prop] = (IpM[prop] || 0) + l.amount;
  });
  const tbl = (title, obj, fmt, isInv) => {
    const rows = Object.entries(obj).filter(([k, v]) => k && v).sort((a, b) => b[1] - a[1]);
    if (!rows.length && !isInv) return '';
    const inner = rows.length
      ? rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join('')
      : `<tr><td colspan="2" class="muted"><i>${noInvSrc ? 'Load the Inventory Usage tab to populate inventory totals.' : 'No inventory used in this window.'}</i></td></tr>`;
    return `<div class="cc-ttbl"><h5>${esc(title)}</h5><table>${inner}</table></div>`;
  };
  host.innerHTML = tbl('Hours by tech — week to date', HtW, v => ccRound1(v) + 'h')
    + tbl('Hours by property — week to date', HpW, v => ccRound1(v) + 'h')
    + tbl('Inventory by property — week to date', IpW, ccMoney, true)
    + tbl('Hours by property — month to date', HpM, v => ccRound1(v) + 'h')
    + tbl('Inventory by property — month to date', IpM, ccMoney, true);
  panel.classList.remove('hidden');
}

function ccRefreshCounts() {
  const fc = $('#cc-flag7count');
  if (fc) fc.textContent = CC_TASKS.filter(t => t.cat === 'flag7' && !ccChecks[t.id]).length + ' open';
  const sum = $('#cc-summary');
  if (sum) sum.innerHTML = '';
  CC_CATS.forEach(cat => {
    const items = CC_TASKS.filter(t => t.cat === cat.key);
    if (!items.length) return;
    const open = items.filter(t => !ccChecks[t.id]).length;
    const c = $('#cc-cat-' + cat.key);
    if (c) c.querySelector('.cc-count').textContent = open + ' open';
    if (sum) {
      const pill = document.createElement('button');
      pill.className = 'cc-pill';
      pill.innerHTML = `${esc(cat.label)} <b>${open}</b>`;
      pill.onclick = () => $('#cc-cat-' + cat.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sum.appendChild(pill);
    }
  });
  ccUpdateProgress();
}

/* Progress counts the routine alongside the generated tasks, which is what
   makes it a measure of the day rather than of the spreadsheet. */
function ccUpdateProgress() {
  const all = [...$$('#tab-maintenance .cc-tck'), ...$$('#tab-maintenance .cc-rck')];
  const total = all.length, done = all.filter(c => c.checked).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const pctEl = $('#cc-pct'); if (pctEl) pctEl.textContent = pct + '%';
  const bar = $('#cc-bar'); if (bar) bar.style.width = pct + '%';
  const counts = $('#cc-counts');
  if (counts) counts.textContent = CC_TASKS.length
    ? `${CC_TASKS.filter(t => ccChecks[t.id]).length}/${CC_TASKS.length} report tasks done`
    : 'no tasks generated yet';
}

/* ---------------- standing routine ---------------- */
const CC_ROUTINE = [
  ['whereby','First thing daily: log in to Whereby as Warehouse Cashier all day','Stay logged in so techs can check out parts and reach you.'],
  ['dashboard','Check the dashboard for pending tasks','Open Assigned Tasks on the AppFolio dashboard and clear anything pending.'],
  ['texts','Check text messages assigned to you in Communication','Open Communication in AppFolio and answer any texts assigned to you.'],
  ['emergencies','Audit urgent / emergency work orders','Notes must tell the full picture; downgrade anything mis-flagged.'],
  ['assign-all','Assign every new work order','By priority, property, and tech skill. Keep Unassigned at zero.'],
  ['waiting','Audit the Waiting queue','Completed orders held for billing issues — clear QC concerns / missing detail.'],
  ['qc','QC the Work Done queue','Aim for zero left by end of day → Ready to Bill or No Need to Bill.'],
  ['inspections','Review & approve completed inspections','Review in-progress inspections, create work orders, and mark them completed.', CC_BASE + '/maintenance/inspections?filters%5Bstatus_list%5D=IN+PROGRESS'],
  ['residents','Update residents on open & escalated items','A quick AppFolio message — never a personal cell. Daily.'],
  ['whatsapp','Monitor the Metric Maintenance WhatsApp',"Turn field reports into work orders; techs don't create them."],
  ['parts','Work the parts follow-ups','Chase ordered/arrived parts; tag techs and the supplier.'],
];
function ccBuildRoutine() {
  const host = $('#cc-routine');
  if (!host) return;
  host.innerHTML = '';
  CC_ROUTINE.forEach(([id, title, sub, link]) => {
    const cid = 'routine:' + id, done = !!ccChecks[cid];
    const el = document.createElement('label');
    el.className = 'cc-check' + (done ? ' done' : '');
    el.innerHTML = `<input type="checkbox" class="cc-rck"${done ? ' checked' : ''}>
      <span class="cc-ct"><b>${esc(title)}</b><span>${esc(sub)}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</span></span>`;
    // Without this, following the link also toggles the checkbox the label wraps.
    el.querySelector('a')?.addEventListener('click', e => e.stopPropagation());
    el.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) ccChecks[cid] = 1; else delete ccChecks[cid];
      ccSaveChecks();
      el.classList.toggle('done', e.target.checked);
      ccUpdateProgress();
    });
    host.appendChild(el);
  });
}

/* ---------------- export / import ---------------- */
function ccExportActivity() {
  const data = { tool: 'mcc-activity', exportedAt: new Date().toISOString(), date: CC_TODAY_KEY, checks: ccChecks };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'maintenance-activity-' + CC_TODAY_KEY + '.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Activity exported', 'success');
}
function ccImportActivity(file) {
  const fr = new FileReader();
  fr.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      const c = (d && d.checks) ? d.checks : d;
      if (!c || typeof c !== 'object') return toast('That file does not look like an activity export', 'error');
      Object.assign(ccChecks, c);
      ccSaveChecks();
      ccBuildRoutine();
      if (CC_TASKS.length) ccRenderTasks(); else ccUpdateProgress();
      ccRefreshCounts();
      toast('Prior activity imported', 'success');
    } catch (err) { toast('Could not read that activity file: ' + err.message, 'error'); }
  };
  fr.readAsText(file);
}

/* ---------------- boot ---------------- */
function ccInit() {
  if (ccInit._done) return;
  const host = $('#cc-routine'); if (!host) return;
  ccInit._done = true;

  const stamp = $('#cc-today');
  if (stamp) stamp.textContent = CC_TODAY.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });

  ccBuildRoutine();
  ccRenderSlots();
  ccUpdateProgress();

  const drop = $('#cc-drop'), input = $('#cc-file');
  input?.addEventListener('change', e => { if (e.target.files[0]) ccLoadFile(e.target.files[0]); e.target.value = ''; });
  if (drop) {
    ['dragover','dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) ccLoadFile(f); });
  }
  $('#cc-generate')?.addEventListener('click', ccGenerate);
  $('#cc-clear')?.addEventListener('click', () => {
    for (const k in ccReports) delete ccReports[k];
    CC_TASKS = [];
    const st = $('#cc-status'); if (st) st.innerHTML = '';
    ccRenderSlots(); ccRenderTasks(); ccRenderTotals();
    toast('Loaded data cleared');
  });
  $('#cc-export')?.addEventListener('click', ccExportActivity);
  $('#cc-import')?.addEventListener('change', e => { if (e.target.files[0]) ccImportActivity(e.target.files[0]); e.target.value = ''; });
}

document.addEventListener('DOMContentLoaded', ccInit);
if (document.readyState !== 'loading') ccInit();
