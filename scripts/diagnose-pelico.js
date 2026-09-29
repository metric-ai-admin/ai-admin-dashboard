#!/usr/bin/env node
//
// Why is Marvin Pelico not in leasing_leads?
//
//   node scripts/diagnose-pelico.js
//
// READ ONLY. Calls the AppFolio Reports API and reads Supabase; writes to
// neither. Run on Render Shell, where APPFOLIO_REPORTS_CLIENT_ID lives.
//
// WHAT IS ALREADY KNOWN, so this only has to settle what is left:
//
//   - Pelico (8c9ad2bd-…) is absent from leasing_leads by id AND by name.
//   - Santos, Maynor F. (44680bdd-…, guest card 8931) IS there: Hyde Park
//     Square, week 2026-09-26, first_contact_date 2026-09-25, Facebook
//     Marketplace, last synced by the 05:30 cron today.
//   - Both ids are UUID v1, so they carry their creation time: Pelico
//     2026-09-24T14:38:03Z, Santos 2026-09-24T14:43:12Z — 308 seconds apart,
//     same clock_seq and same node. Consecutive cards from one machine.
//   - Guest card 8930 does not exist in our table. It is the number between
//     8929 and 8931, and Pelico was created between them. That makes 8930 a
//     good GUESS for Pelico and nothing more: 8918, 8919, 8922, 8937 and 8941
//     are missing too, so gaps in that range are ordinary.
//   - The cron's window is today-7..today = 2026-09-22..2026-09-29, and
//     Pelico's first contact date is 2026-09-24. So the range filter is NOT
//     the explanation unless the report reports a different date for him.
//
// That leaves two candidates, which is what this script separates:
//
//   a) he is not in the pull at all — guest_card_inquiries returns ACTIVE cards
//      only (established 2026-09-28 from the AppFolio UI), so a card that went
//      inactive simply stops being returned; or
//   b) he is in the pull but the sync drops him — a property that is not
//      "active" (property_visibility filters PROPERTIES), a missing or
//      different first_contact_date, or a mapping that yields no usable day.
//
// Output masks emails and phones. Names and dates stay: they are the point.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const PELICO = '8c9ad2bd-b825-11f1-9ece-0269bfa09cb1';
const SANTOS = '44680bdd-b826-11f1-9ece-0269bfa09cb1';
const INQUIRIES = '/api/v2/reports/guest_card_inquiries.json';
const GUEST_CARDS = '/api/v2/reports/guest_cards.json';

const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const subdomain = process.env.APPFOLIO_SUBDOMAIN || 'metricpropertymanagement';
if (!id || !secret) {
  console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set in this shell.');
  console.error('Run this on Render Shell for the dashboard service.');
  process.exit(2);
}
const AUTH = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
const HOST = `https://${subdomain}.appfolio.com`;

const maskEmail = t => String(t || '').replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g, (m, d) => `${m[0]}***@${d}`);
const maskPhone = t => String(t || '').replace(/\(?\+?\d[\d\s().-]{5,}\d\)?/g, m => {
  const d = m.replace(/\D/g, '');
  return (d.length < 7 || d.length > 15) ? m : `***-***-${d.slice(-4)}`;
});
const SENSITIVE = /email|phone|mobile|cell/i;
function show(row, indent = '    ') {
  if (!row) return console.log(indent + '(nada)');
  for (const [k, v] of Object.entries(row)) {
    if (v == null || String(v).trim() === '') continue;
    const s = SENSITIVE.test(k) ? maskPhone(maskEmail(v)) : String(v);
    console.log(`${indent}${k.padEnd(26)} ${s.slice(0, 120)}`);
  }
}

async function report(path, body, label) {
  let url = HOST + path, rows = [];
  for (let p = 0; p < 40; p++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`);
    const json = JSON.parse(text);
    rows.push(...(json.results || []));
    const next = json.next_page_url || json.nextPageUrl;
    if (!next) break;
    url = next.replace(/\/\/[^@]*@/, '//');
    body = null;
    await new Promise(r => setTimeout(r, 2200));   // the shared rate limit
  }
  return rows;
}

const find = (rows, uuid, namePart) => rows.filter(r =>
  String(r.guest_card_uuid) === uuid
  || (namePart && new RegExp(namePart, 'i').test(String(r.name || ''))));

(async () => {
  // The exact call the 05:30 cron makes.
  console.log('=== A. EL PULL QUE HACE EL CRON (guest_card_inquiries, property_visibility=active)');
  const active = await report(INQUIRIES, { property_visibility: 'active' }, 'inquiries/active');
  console.log(`   filas: ${active.length}`);
  const pelicoActive = find(active, PELICO, 'pelico');
  const santosActive = find(active, SANTOS, 'maynor');
  console.log(`   Pelico presente: ${pelicoActive.length ? 'SÍ' : 'NO'}`);
  console.log(`   Santos presente: ${santosActive.length ? 'SÍ' : 'NO'}   <- control: debe ser SÍ`);
  if (pelicoActive.length) { console.log('   fila de Pelico:'); show(pelicoActive[0]); }
  if (santosActive.length) { console.log('   fila de Santos (para comparar):'); show(santosActive[0]); }

  // If active-only hides him, all-properties will not bring him back (that
  // parameter governs properties) — but it costs one call to prove it rather
  // than assume it, which is the mistake this whole thread keeps punishing.
  console.log('\n=== B. ¿LO ESCONDE property_visibility=active? (mismo informe, all)');
  const all = await report(INQUIRIES, { property_visibility: 'all' }, 'inquiries/all');
  const pelicoAll = find(all, PELICO, 'pelico');
  console.log(`   filas: ${all.length} (active traía ${active.length})`);
  console.log(`   Pelico presente con "all": ${pelicoAll.length ? 'SÍ' : 'NO'}`);
  if (pelicoAll.length) { console.log('   fila:'); show(pelicoAll[0]); }

  console.log('\n=== C. ¿ESTÁ EN EL OTRO INFORME? (guest_cards, all)');
  const cards = await report(GUEST_CARDS, { property_visibility: 'all' }, 'guest_cards/all');
  const pelicoCard = find(cards, PELICO, 'pelico');
  console.log(`   filas: ${cards.length}`);
  console.log(`   Pelico presente: ${pelicoCard.length ? 'SÍ' : 'NO'}`);
  if (pelicoCard.length) {
    console.log('   fila:'); show(pelicoCard[0]);
    const st = Object.entries(pelicoCard[0]).filter(([k]) => /status|active|archiv|delet|merge/i.test(k));
    if (st.length) console.log('   campos de estado:', JSON.stringify(Object.fromEntries(st)));
  }

  console.log('\n=== D. ¿QUÉ SERÍA LA TARJETA 8930?');
  const pool = [...all, ...cards];
  const g8930 = pool.filter(r => String(r.guest_card_id) === '8930');
  if (!g8930.length) console.log('   8930 no aparece en ningún informe — ni activa ni con "all".');
  else { console.log(`   8930 encontrada (${g8930.length}):`); show(g8930[0]); }

  console.log('\n=== E. ¿HAY RELACIÓN ENTRE PELICO Y SANTOS?');
  const santosAll = find(all, SANTOS, 'maynor')[0] || find(cards, SANTOS, 'maynor')[0];
  const pelicoAny = pelicoAll[0] || pelicoCard[0] || pelicoActive[0];
  if (!pelicoAny) console.log('   Pelico no aparece en ningún informe, así que no hay fila que comparar.');
  else if (!santosAll) console.log('   Santos no aparece — inesperado.');
  else {
    const keys = [...new Set([...Object.keys(pelicoAny), ...Object.keys(santosAll)])];
    console.log('   campos donde COINCIDEN (posible duplicado o misma consulta):');
    let shared = 0;
    for (const k of keys) {
      const a = pelicoAny[k], b = santosAll[k];
      if (a == null || String(a).trim() === '') continue;
      if (String(a) === String(b)) {
        const s = SENSITIVE.test(k) ? maskPhone(maskEmail(a)) : String(a);
        console.log(`     ${k.padEnd(26)} ${s.slice(0, 80)}`);
        shared++;
      }
    }
    if (!shared) console.log('     (ninguno)');
    console.log('   campos donde DIFIEREN:');
    for (const k of keys) {
      const a = pelicoAny[k], b = santosAll[k];
      if (String(a ?? '') === String(b ?? '')) continue;
      const f = v => SENSITIVE.test(k) ? maskPhone(maskEmail(v)) : String(v ?? '-');
      console.log(`     ${k.padEnd(26)} Pelico=${f(a).slice(0, 44).padEnd(46)} Santos=${f(b).slice(0, 44)}`);
    }
  }

  console.log('\n=== F. ¿EL SYNC LO HABRÍA DESCARTADO POR FECHA?');
  const from = '2026-09-22', to = '2026-09-29';   // la ventana del cron de hoy
  if (!pelicoAny) console.log('   irrelevante: no está en el pull.');
  else {
    const fcd = pelicoAny.first_contact_date;
    const recv = pelicoAny.received;
    console.log(`   first_contact_date = ${fcd || '(vacío)'}`);
    console.log(`   received           = ${recv || '(vacío)'}`);
    const day = fcd || (recv ? String(recv).slice(0, 10) : null);
    console.log(`   día usado por inRange = ${day || 'NINGUNO → se descarta'}`);
    console.log(`   ventana ${from}..${to} → ${day && day >= from && day <= to ? 'DENTRO (no lo descarta)' : 'FUERA (lo descarta)'}`);
  }

  // What our own table says, so both halves are in one output.
  console.log('\n=== G. LO QUE TENEMOS EN SUPABASE');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  const { data: ours } = await db.from('leasing_leads')
    .select('appfolio_id,guest_card_id,name,week_ending,property,first_contact_date,source,synced_at,last_seen_in_report')
    .in('appfolio_id', [PELICO, SANTOS]);
  console.log(`   filas para los dos ids: ${(ours || []).length}`);
  (ours || []).forEach(r => console.log(`     gc=${r.guest_card_id} ${r.name} | ${r.week_ending} | ${r.property} | fcd=${r.first_contact_date} | seen=${r.last_seen_in_report || 'nunca'}`));

  console.log('\n=== CÓMO LEER ESTO');
  console.log('  A: Pelico NO y Santos SÍ  -> la tarjeta dejó de estar activa. El sync no');
  console.log('     puede insertar lo que el informe no devuelve; 67 sería el número real.');
  console.log('  B: aparece con "all"      -> lo esconde la visibilidad de PROPIEDAD, no su');
  console.log('     estado: su propiedad no cuenta como activa.');
  console.log('  C: solo en guest_cards    -> los dos informes no coinciden y el sync usa el');
  console.log('     que no lo trae.');
  console.log('  F: FUERA de la ventana    -> está en el pull y lo tira el filtro de fechas.');
  console.log('\n  No se escribió nada. Emails y teléfonos van enmascarados.');
})().catch(e => { console.error('\nfalló:', e.message); process.exitCode = 1; });
