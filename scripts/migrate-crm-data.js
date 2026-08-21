#!/usr/bin/env node
/**
 * BD CRM Data Migration
 * Extracts property data from Business_Development_CRM.html and bulk-inserts
 * into Supabase via the dashboard's /api/crm/bulk-import endpoint.
 *
 * Usage:
 *   node scripts/migrate-crm-data.js <path-to-html> [dashboard-url]
 *
 * Examples:
 *   # Local dev
 *   node scripts/migrate-crm-data.js "C:\Users\artur\Downloads\Business_Development_CRM.html"
 *
 *   # Cloud (Render)
 *   node scripts/migrate-crm-data.js "C:\...\Business_Development_CRM.html" https://ai-admin-dashboard-jkde.onrender.com
 *
 * Prerequisites:
 *   - SUPABASE_SERVICE_ROLE_KEY must be set in .env (or environment)
 *   - Run the SQL migration 001_bd_crm.sql in Supabase first
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const htmlPath     = process.argv[2];
const dashboardUrl = (process.argv[3] || 'http://localhost:3001').replace(/\/$/, '');

if (!htmlPath) {
  console.error('Usage: node scripts/migrate-crm-data.js <path-to-html> [dashboard-url]');
  process.exit(1);
}
if (!fs.existsSync(htmlPath)) {
  console.error(`File not found: ${htmlPath}`);
  process.exit(1);
}

// ── 1. Extract data from the HTML ─────────────────────────────────────────────
// The CRM HTML stores its data in a JavaScript variable. We look for the
// assignment of the properties array and eval it in a sandbox.
console.log(`Reading: ${htmlPath}`);
const html = fs.readFileSync(htmlPath, 'utf8');

// Try to find the data variable — common patterns in offline CRM HTMLs:
//   var properties = [...];
//   const properties = [...];
//   let propertiesData = [...];
//   window.crmData = { properties: [...] };
let rawProperties = null;

// Pattern 1: var/const/let <name> = [ ... ] (array of property objects)
const arrayMatch = html.match(/(?:var|const|let)\s+(\w+)\s*=\s*(\[[\s\S]*?\]);/);
if (arrayMatch) {
  try {
    const fn = new Function(`return ${arrayMatch[2]}`);
    const data = fn();
    if (Array.isArray(data) && data.length > 0 && data[0].propertyName !== undefined) {
      rawProperties = data;
      console.log(`Found ${data.length} properties in variable '${arrayMatch[1]}'`);
    }
  } catch {}
}

// Pattern 2: JSON embedded in a script tag
if (!rawProperties) {
  const jsonMatch = html.match(/<script[^>]*>\s*(?:var|const|let)\s+\w+\s*=\s*JSON\.parse\('([\s\S]*?)'\)/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1].replace(/\\'/g, "'"));
      if (Array.isArray(data)) { rawProperties = data; console.log(`Found ${data.length} properties via JSON.parse`); }
    } catch {}
  }
}

if (!rawProperties || rawProperties.length === 0) {
  console.error('Could not extract property data from HTML.');
  console.error('The script looks for a JavaScript array assigned to a variable.');
  console.error('If the HTML uses a different pattern, contact Arturo to update this script.');
  process.exit(1);
}

// ── 2. Map to Supabase schema ─────────────────────────────────────────────────
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}
function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}
function toBool(v) { return !!v; }
function toStr(v) { return (v === null || v === undefined) ? null : String(v).trim() || null; }

const properties    = [];
const phoneShops    = [];
const onlineShops   = [];
const followUps     = [];
const outreachDrafts = [];

for (const raw of rawProperties) {
  // Generate a stable UUID from the original index/id if available
  const { randomUUID } = require('crypto');
  const propId = randomUUID();

  properties.push({
    id:                 propId,
    property_name:      toStr(raw.propertyName),
    address:            toStr(raw.address),
    city:               toStr(raw.city),
    state:              toStr(raw.state) || 'TX',
    zip:                toStr(raw.zip),
    submarket:          toStr(raw.submarket),
    style:              toStr(raw.style),
    year_built:         toInt(raw.yearBuilt),
    asset_class:        toStr(raw.assetClass),
    units:              toInt(raw.units),
    vacancy_pct:        toNum(raw.vacancyPct),
    avg_asking_unit:    toNum(raw.avgAskingUnit),
    avg_unit_sf:        toNum(raw.avgUnitSF),
    management_company: toStr(raw.managementCompany),
    management_type:    toStr(raw.managementType),
    owner_name:         toStr(raw.ownerName),
    owner_contact_name: toStr(raw.ownerContactName),
    owner_phone:        toStr(raw.ownerPhone),
    owner_email:        toStr(raw.ownerEmail),
    owner_address:      toStr(raw.ownerAddress),
    assigned_to:        toStr(raw.assignedTo),
    phone_assignee:     toStr(raw.phoneAssignee),
    phone_assignee3:    toStr(raw.phoneAssignee3),
    online_dm_assignee: toStr(raw.onlineDmAssignee),
    rop_status:         toStr(raw.ropStatus),
    lead_score_override: toInt(raw.leadScoreOverride),
    lyndsay_reviewed:   toBool(raw.lyndsayReviewed),
    notes:              toStr(raw.notes),
  });

  // Sub-arrays
  for (const s of (raw.phoneShops || [])) {
    phoneShops.push({
      id:          randomUUID(),
      property_id: propId,
      shop_date:   toStr(s.date),
      agent_name:  toStr(s.agent),
      score:       toNum(s.score),
      notes:       toStr(s.notes),
    });
  }
  for (const s of (raw.onlineShops || [])) {
    onlineShops.push({
      id:          randomUUID(),
      property_id: propId,
      shop_date:   toStr(s.date),
      platform:    toStr(s.platform),
      score:       toNum(s.score),
      notes:       toStr(s.notes),
    });
  }
  for (const f of (raw.followUps || [])) {
    followUps.push({
      id:              randomUUID(),
      property_id:     propId,
      follow_up_date:  toStr(f.date),
      method:          toStr(f.method),
      contact_name:    toStr(f.contactName),
      outcome:         toStr(f.outcome),
      next_action:     toStr(f.nextAction),
      completed:       toBool(f.completed),
      notes:           toStr(f.notes),
    });
  }
  for (const d of (raw.outreachDrafts || [])) {
    outreachDrafts.push({
      id:          randomUUID(),
      property_id: propId,
      channel:     toStr(d.channel),
      subject:     toStr(d.subject),
      body:        toStr(d.body || d.content),
      status:      toStr(d.status) || 'draft',
      notes:       toStr(d.notes),
    });
  }
}

console.log(`Mapped: ${properties.length} properties, ${phoneShops.length} phone shops, ${onlineShops.length} online shops, ${followUps.length} follow-ups, ${outreachDrafts.length} outreach drafts`);

// ── 3. Send to bulk-import endpoint ──────────────────────────────────────────
const CHUNK = 500; // Supabase handles up to 1000 rows per call; 500 is safe
async function importChunked(endpoint, table, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const body = JSON.stringify({ [table]: chunk });
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    const json = await r.json();
    if (!r.ok || json.results?.[table]?.error) {
      throw new Error(`${table} chunk ${i}–${i+chunk.length}: ${json.results?.[table]?.error || json.error}`);
    }
    console.log(`  ${table}: imported ${i + chunk.length}/${rows.length}`);
  }
}

(async () => {
  const endpoint = `${dashboardUrl}/api/crm/bulk-import`;
  console.log(`\nImporting to: ${endpoint}`);

  try {
    await importChunked(endpoint, 'properties',     properties);
    await importChunked(endpoint, 'phone_shops',    phoneShops);
    await importChunked(endpoint, 'online_shops',   onlineShops);
    await importChunked(endpoint, 'follow_ups',     followUps);
    await importChunked(endpoint, 'outreach_drafts', outreachDrafts);
    console.log('\n✅ Migration complete.');
  } catch (err) {
    console.error(`\n❌ Migration failed: ${err.message}`);
    process.exit(1);
  }
})();
