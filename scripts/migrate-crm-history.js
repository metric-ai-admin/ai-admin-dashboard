#!/usr/bin/env node
/**
 * BD CRM History Migration
 * Extracts historical work records from Business Development CRM.html
 * (PRELOADED_DB.properties + PROGRESS_* snapshot variables) and inserts
 * them into Supabase via the dashboard's REST API.
 *
 * Usage:
 *   node scripts/migrate-crm-history.js <path-to-html> [dashboard-url]
 *
 * Examples:
 *   node scripts/migrate-crm-history.js "data/Business Development CRM.html"
 *   node scripts/migrate-crm-history.js "data/Business Development CRM.html" https://ai-admin-dashboard-jkde.onrender.com
 *
 * Sources extracted:
 *   - PRELOADED_DB.properties  (live data)
 *   - PROGRESS_LYNDSAY_2026_07_14
 *   - PROGRESS_ERICK_2026_07_17
 *   - PROGRESS_TEAM_2026_07_21  (array of 3 agent snapshots)
 *
 * For dm_reviews with multiple snapshots per property:
 *   winner = most filled fields; tie-break = most recent exportedAt
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const htmlPath     = process.argv[2];
const dashboardUrl = (process.argv[3] || 'http://localhost:3001').replace(/\/$/, '');

if (!htmlPath) {
  console.error('Usage: node scripts/migrate-crm-history.js <path-to-html> [dashboard-url]');
  process.exit(1);
}
const resolvedHtml = path.isAbsolute(htmlPath) ? htmlPath : path.join(process.cwd(), htmlPath);
if (!fs.existsSync(resolvedHtml)) {
  console.error('File not found:', resolvedHtml);
  process.exit(1);
}

// ── 1. Extraction helpers ─────────────────────────────────────────────────────

function walkBraces(html, startPos) {
  let pos = startPos;
  while (pos < html.length && /\s/.test(html[pos])) pos++;
  const opener = html[pos];
  const closer = opener === '[' ? ']' : opener === '{' ? '}' : null;
  if (!closer) return null;
  let depth = 0, inStr = false, strChar = '', i = pos;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; }
      else if (ch === opener) depth++;
      else if (ch === closer) { depth--; if (depth === 0) break; }
    }
  }
  try { return JSON.parse(html.slice(pos, i + 1)); } catch { return null; }
}

function extractVar(html, name) {
  const marker = `const ${name} =`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  return walkBraces(html, start + marker.length);
}

function extractPreloadedDB(html) {
  const marker = 'const PRELOADED_DB =';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('PRELOADED_DB not found in HTML');
  const openBrace = html.indexOf('{', start + marker.length);
  return walkBraces(html, openBrace);
}

// ── 2. Fuzzy name matching ────────────────────────────────────────────────────

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function buildIndex(supabaseProps) {
  const index = {};
  for (const p of supabaseProps) {
    index[norm(p.property_name)] = p;
  }
  return index;
}

function fuzzyMatch(name, index) {
  const n = norm(name);
  if (index[n]) return index[n];
  // Substring match: source contains target or vice versa
  for (const [key, prop] of Object.entries(index)) {
    if (n.includes(key) || key.includes(n)) return prop;
  }
  return null;
}

// ── 3. Field mappers ──────────────────────────────────────────────────────────

function toStr(v)  { return (v == null || v === '') ? null : String(v).trim() || null; }
function toBool(v) { if (v == null || v === '') return null; return v === true || v === 'yes' || v === 'true'; }
function toNum(v)  { const n = parseFloat(String(v||'').replace(/[^0-9.-]/g,'')); return isNaN(n) ? null : n; }

function mapPhoneShop(s, propertyId, agentName) {
  return {
    property_id:  propertyId,
    shop_date:    toStr(s.date),
    agent_name:   toStr(s.agent || s.callerName || agentName),
    score:        toNum(s.score),
    notes:        JSON.stringify({
      connection: toStr(s.connection),
      appointment_set: toStr(s.appointmentSet),
      text: toStr(s.notes),
    }),
  };
}

function mapOnlineShop(s, propertyId, agentName) {
  const noteParts = [toStr(s.agent || agentName), toStr(s.notes)].filter(Boolean);
  return {
    property_id:  propertyId,
    shop_date:    toStr(s.date),
    platform:     toStr(s.contactType || s.platform),
    score:        toNum(s.score),
    notes:        noteParts.join(' — ') || null,
  };
}

function mapFollowUp(f, propertyId) {
  return {
    property_id:     propertyId,
    follow_up_date:  toStr(f.date),
    method:          toStr(f.type || f.method),
    contact_name:    toStr(f.linkedTo || f.contact_name),
    outcome:         toStr(f.outcome),
    next_action:     toStr(f.nextAction || f.next_action),
    completed:       toBool(f.completed),
    notes:           toStr(f.notes),
  };
}

function mapInspection(ins, propertyId) {
  return {
    property_id:            propertyId,
    visited_date:           toStr(ins.date || ins.visited_date),
    visited_time:           toStr(ins.time || ins.visited_time),
    office_open:            toBool(ins.officeOpen          ?? ins.office_open),
    office_hours_posted:    toBool(ins.hoursPosted         ?? ins.office_hours_posted),
    phone_posted:           toBool(ins.phonePosted         ?? ins.phone_posted),
    phone_test_result:      toStr(ins.phoneTestResult      || ins.phone_test_result),
    website_posted:         toBool(ins.websitePosted       ?? ins.website_posted),
    tour_instructions_clear:toBool(ins.tourInstructionsClear ?? ins.tour_instructions_clear),
    building_condition:     toStr(ins.buildingCondition    || ins.building_condition),
    grounds_condition:      toStr(ins.groundsCondition     || ins.grounds_condition),
    pool_condition:         toStr(ins.poolCondition        || ins.pool_condition),
    trash_condition:        toStr(ins.trashCondition       || ins.trash_condition),
    rop_sign_posted:        toBool(ins.ropSignPosted        ?? ins.rop_sign_posted),
    notes:                  toStr(ins.notes),
  };
}

// Count filled (non-null, non-empty-object) values in a ratings object
function countFilled(ratings) {
  let n = 0;
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const v of Object.values(obj)) {
      if (v == null || v === '') continue;
      if (typeof v === 'object' && !Array.isArray(v)) { walk(v); }
      else { n++; }
    }
  }
  walk(ratings);
  return n;
}

function mapDMReview(dm, propertyId) {
  const r = dm.ratings || {};
  // HTML uses 'floorplans'; Supabase column is 'floorplan_scores'
  const website_scores   = r.website    || {};
  const floorplan_scores = r.floorplans || r.floorplan || {};
  const gbp_scores       = r.gbp        || {};
  const facebook_scores  = r.facebook   || {};
  const ils_scores       = r.ils        || {};
  const audit_notes      = toStr(dm.auditNotes || dm.audit_notes || (dm.notes && typeof dm.notes === 'string' ? dm.notes : null));
  const ai_filled        = !!(dm.aiFilled && Object.values(dm.aiFilled).some(v => v && typeof v === 'object' && Object.keys(v).length > 0));

  // Compute overall_score the same way server.js does
  const allScores = [website_scores, floorplan_scores, gbp_scores, facebook_scores, ils_scores]
    .flatMap(section => Object.values(section || {}))
    .filter(v => typeof v === 'number' && !isNaN(v));
  const overall_score = allScores.length
    ? parseFloat((allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2))
    : null;

  return {
    property_id:      propertyId,
    website_scores,
    floorplan_scores,
    gbp_scores,
    facebook_scores,
    ils_scores,
    overall_score,
    audit_notes,
    ai_filled,
  };
}

// ── 4. Collect all records from all sources ───────────────────────────────────

function collectFromProperties(propsObj, agentName, exportedAt, out) {
  for (const [propKey, p] of Object.entries(propsObj || {})) {
    if (!p || typeof p !== 'object') continue;
    // PRELOADED_DB keys properties by ID (prop_xxxxx); PROGRESS keys by display name.
    // Use the human-readable name for fuzzy matching.
    const propName = (typeof p.propertyName === 'string' && p.propertyName) ? p.propertyName : propKey;
    const key = norm(propName);

    // phoneShops
    for (const s of (p.phoneShops || p.phone_shops || [])) {
      out.phoneShops.push({ _key: key, _name: propName, record: s, agentName });
    }
    // onlineShops
    for (const s of (p.onlineShops || p.online_shops || [])) {
      out.onlineShops.push({ _key: key, _name: propName, record: s, agentName });
    }
    // followUps
    for (const f of (p.followUps || p.follow_ups || [])) {
      out.followUps.push({ _key: key, _name: propName, record: f });
    }
    // inspections
    for (const ins of (p.inspections || [])) {
      out.inspections.push({ _key: key, _name: propName, record: ins });
    }
    // outreachDrafts
    for (const d of (p.outreachDrafts || p.outreach_drafts || [])) {
      out.outreachDrafts.push({ _key: key, _name: propName, record: d });
    }
    // dmReview — collect all snapshots; winner chosen later
    const dm = p.dmReview || p.dm_review;
    if (dm && typeof dm === 'object' && dm.ratings) {
      const filled = countFilled(dm.ratings);
      if (filled > 0) {
        if (!out.dmSnapshots[key]) out.dmSnapshots[key] = { _name: propName, candidates: [] };
        out.dmSnapshots[key].candidates.push({ dm, filled, exportedAt: exportedAt || '1970-01-01' });
      }
    }
  }
}

// ── 5. Dashboard API helpers ──────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const url = `${dashboardUrl}${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchAllProperties() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(`/api/crm/properties?limit=200&page=${page}`);
    const batch = data.properties || [];
    all.push(...batch);
    if (page >= (data.pages || 1)) break;
    page++;
  }
  return all;
}

// ── 6. Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nReading: ${resolvedHtml}`);
  const html = fs.readFileSync(resolvedHtml, 'utf8');

  // Extract all sources
  const db     = extractPreloadedDB(html);
  const lyndsay = extractVar(html, 'PROGRESS_LYNDSAY_2026_07_14');
  const erick   = extractVar(html, 'PROGRESS_ERICK_2026_07_17');
  const team    = extractVar(html, 'PROGRESS_TEAM_2026_07_21');

  // Flatten all snapshots into a list of { agentName, exportedAt, properties }
  const snapshots = [];
  snapshots.push({ agentName: null, exportedAt: null, properties: db.properties || {} });
  if (lyndsay) snapshots.push({ agentName: lyndsay.exportedBy, exportedAt: lyndsay.exportedAt, properties: lyndsay.properties || {} });
  if (erick)   snapshots.push({ agentName: erick.exportedBy,   exportedAt: erick.exportedAt,   properties: erick.properties   || {} });
  if (Array.isArray(team)) {
    for (const snap of team) {
      snapshots.push({ agentName: snap.exportedBy, exportedAt: snap.exportedAt, properties: snap.properties || {} });
    }
  }

  console.log(`Loaded ${snapshots.length} sources (PRELOADED_DB + PROGRESS_*)`);

  // Accumulate all records
  const out = { phoneShops: [], onlineShops: [], followUps: [], inspections: [], outreachDrafts: [], dmSnapshots: {} };
  for (const { agentName, exportedAt, properties } of snapshots) {
    collectFromProperties(properties, agentName, exportedAt, out);
  }

  // Dedup by original HTML id within each type
  function dedup(arr, idField = 'id') {
    const seen = new Set();
    return arr.filter(item => {
      const id = item.record[idField];
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
  }
  out.phoneShops    = dedup(out.phoneShops,    'id');
  out.onlineShops   = dedup(out.onlineShops,   'id');
  out.followUps     = dedup(out.followUps,     'id');
  out.inspections   = dedup(out.inspections,   'id');
  out.outreachDrafts= dedup(out.outreachDrafts,'id');

  // Pick dm_review winner per property: most filled, then most recent
  const dmWinners = {};
  for (const [key, { _name, candidates }] of Object.entries(out.dmSnapshots)) {
    candidates.sort((a, b) => b.filled - a.filled || b.exportedAt.localeCompare(a.exportedAt));
    dmWinners[key] = { _name, dm: candidates[0].dm, filled: candidates[0].filled };
  }

  console.log('\n── Extracted record counts ──────────────────────────────────────');
  console.log(`phone_shops:     ${out.phoneShops.length}`);
  console.log(`online_shops:    ${out.onlineShops.length}`);
  console.log(`follow_ups:      ${out.followUps.length}`);
  console.log(`inspections:     ${out.inspections.length}`);
  console.log(`outreach_drafts: ${out.outreachDrafts.length}`);
  console.log(`dm_reviews:      ${Object.keys(dmWinners).length} unique properties`);

  // Fetch Supabase properties for ID lookup
  console.log('\nFetching properties from dashboard…');
  const supaProps = await fetchAllProperties();
  console.log(`  ${supaProps.length} properties loaded`);
  const propIndex = buildIndex(supaProps);

  // ── Insert helper: POST to REST endpoint ──────────────────────────────────
  const summary = {
    phone_shops:     { inserted: 0, skipped: 0, errors: [] },
    online_shops:    { inserted: 0, skipped: 0, errors: [] },
    follow_ups:      { inserted: 0, skipped: 0, errors: [] },
    inspections:     { inserted: 0, skipped: 0, errors: [] },
    outreach_drafts: { inserted: 0, skipped: 0, errors: [] },
    dm_reviews:      { inserted: 0, skipped: 0, errors: [] },
    unmatched:       [],
  };

  async function insertRecords(items, tableName, endpoint, mapper) {
    const stat = summary[tableName];
    for (const item of items) {
      const prop = fuzzyMatch(item._name, propIndex);
      if (!prop) {
        stat.skipped++;
        if (!summary.unmatched.includes(item._name)) summary.unmatched.push(item._name);
        continue;
      }
      try {
        const body = mapper(item.record, prop.id, item.agentName);
        await apiFetch(endpoint(prop.id), { method: 'POST', body: JSON.stringify(body) });
        stat.inserted++;
      } catch (err) {
        stat.errors.push(`${item._name}: ${err.message}`);
      }
    }
  }

  // ── phone_shops ──
  console.log('\nInserting phone_shops…');
  await insertRecords(out.phoneShops, 'phone_shops',
    id => `/api/crm/properties/${id}/phone-shops`,
    (r, pid, agent) => mapPhoneShop(r, pid, agent)
  );

  // ── online_shops ──
  console.log('Inserting online_shops…');
  await insertRecords(out.onlineShops, 'online_shops',
    id => `/api/crm/properties/${id}/online-shops`,
    (r, pid, agent) => mapOnlineShop(r, pid, agent)
  );

  // ── follow_ups ──
  console.log('Inserting follow_ups…');
  await insertRecords(out.followUps, 'follow_ups',
    id => `/api/crm/properties/${id}/follow-ups`,
    (r, pid) => mapFollowUp(r, pid)
  );

  // ── inspections ──
  console.log('Inserting inspections…');
  await insertRecords(out.inspections, 'inspections',
    id => `/api/crm/properties/${id}/inspections`,
    (r, pid) => mapInspection(r, pid)
  );

  // ── outreach_drafts ──
  console.log('Inserting outreach_drafts…');
  await insertRecords(out.outreachDrafts, 'outreach_drafts',
    id => `/api/crm/properties/${id}/outreach-drafts`,
    (r, pid) => ({
      property_id: pid,
      channel: toStr(r.channel),
      subject:  toStr(r.subject),
      body:     toStr(r.body || r.content),
      status:   toStr(r.status) || 'draft',
      notes:    toStr(r.notes),
    })
  );

  // ── dm_reviews (upsert via PUT) ──
  console.log('Inserting dm_reviews…');
  for (const [key, { _name, dm }] of Object.entries(dmWinners)) {
    const prop = fuzzyMatch(_name, propIndex);
    if (!prop) {
      summary.dm_reviews.skipped++;
      if (!summary.unmatched.includes(_name)) summary.unmatched.push(_name);
      continue;
    }
    try {
      const body = mapDMReview(dm, prop.id);
      await apiFetch(`/api/crm/properties/${prop.id}/dm-review`, {
        method: 'PUT',
        body: JSON.stringify({
          website:   body.website_scores,
          floorplan: body.floorplan_scores,
          gbp:       body.gbp_scores,
          facebook:  body.facebook_scores,
          ils:       body.ils_scores,
          audit_notes: body.audit_notes,
        }),
      });
      summary.dm_reviews.inserted++;
    } catch (err) {
      summary.dm_reviews.errors.push(`${_name}: ${err.message}`);
    }
  }

  // ── Final report ──────────────────────────────────────────────────────────
  console.log('\n══ Migration Summary ════════════════════════════════════════════');
  for (const [table, stat] of Object.entries(summary)) {
    if (table === 'unmatched') continue;
    const errLine = stat.errors.length ? ` | ❌ ${stat.errors.length} errors` : '';
    console.log(`  ${table.padEnd(16)}: ✅ ${stat.inserted} inserted, ⏭ ${stat.skipped} skipped${errLine}`);
    for (const e of stat.errors) console.log(`    ↳ ${e}`);
  }
  if (summary.unmatched.length) {
    console.log(`\n  Unmatched properties (${summary.unmatched.length}):`);
    summary.unmatched.forEach(n => console.log(`    - ${n}`));
  }
  console.log('\n✅ Done.');
})();
