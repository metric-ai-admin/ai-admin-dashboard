require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WOS = require('./lib/work-order-status.js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const ct=v=>v?new Date(v).toLocaleString('en-US',{timeZone:'America/Chicago',hour12:false}):'—';
(async()=>{
  const {data}=await db.from('maintenance_work_orders')
    .select('work_order_number,work_order_id,status,property_name,unit,issue,created_at_appfolio,updated_at,last_seen_in_feed,completed_on')
    .eq('status', WOS.UNKNOWN || 'Unknown — not in feed');
  console.log('rows in Unknown:',(data||[]).length);
  const rows=(data||[]).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
  console.log('\nnewest 8 by updated_at:');
  rows.slice(0,8).forEach(r=>console.log('  '+String(r.work_order_number).padEnd(10),
    'woId '+String(r.work_order_id).padEnd(7),
    '| updated '+ct(r.updated_at),
    '| created '+String(r.created_at_appfolio||'').slice(0,10),
    '| last seen '+ct(r.last_seen_in_feed),
    '|', String(r.property_name||'').slice(0,22)));
  // Which became Unknown yesterday afternoon?
  const y=rows.filter(r=>String(r.updated_at||'')>='2026-10-06T17:00:00Z');
  console.log('\nbecame Unknown after 2026-10-06 12:00 CT:',y.length);
  y.forEach(r=>console.log('  '+r.work_order_number,'woId',r.work_order_id,'|',ct(r.updated_at),'|',String(r.issue||'').slice(0,50)));
  // cc_daily_state last night
  const {data:st}=await db.from('cc_daily_state').select('*').order('state_date',{ascending:false}).limit(3);
  console.log('\ncc_daily_state newest rows:');
  (st||[]).forEach(r=>console.log('  '+r.state_date,'| tasks',r.total_tasks,'| done',r.completed_tasks,
    '| manual',r.completed_manual,'| auto',r.completed_auto,'| routine',r.completed_routine,
    '| board_opened',r.board_opened,'| updated',ct(r.updated_at)));
})();
