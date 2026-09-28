const XLSX=require('xlsx');
const OUT=process.argv[2];
const mk=(title,headers,rows)=>XLSX.utils.aoa_to_sheet([
  [title],['Metric Property Management'],['Date Range: 09/01/2026 - 09/28/2026'],[],['Generated 09/28/2026'],
  headers, ...rows]);
const wb=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, mk('Work Order Labor',
  ['Work Order Number','Date','Maintenance Tech','Property','Unit','Start Time','End Time','Worked Hours'],
  [['23172-1','09/22/2026','Carlos Portilla','Hyde Park Square','206','08:00','09:00','1.0'],
   ['23173-1','09/22/2026','Alex Worley (Hidden)','Hyde Park Square','207','09:00','11:00','2.0'],
   ['99999-1','09/22/2026','Ghost','513 Wolf Ridge','W-1','08:00','17:00','9.0']]),
  'Maintenance - Work Order Labor ');
const bd=['Group','count(Work Order Number)','Unit','Vendor','Billable Type','Created Date','Description','GL Account','Quantity','Rate','Amount','Worked Hours','Billable Hours','Work Order Status','Billed Amount','Unbilled Amount'];
XLSX.utils.book_append_sheet(wb, mk('MDaily',bd,[
  ['-> Hyde Park Square','12','','','','','','','','','$3,600.00','14.4','12.0','','$3,600.00','$0.00'],
  ['','22884-1','5-224','Acme','Tenant','09/22/2026','Leak under sink','6595','1','300','$300.00','1.2','1.0','Completed','$300.00','$0.00'],
  ['','22879-1','3-101','Acme','Owner','09/22/2026','Door lock','6595','1','200','$200.00','1','1','Ready to Bill','$0.00','$200.00'],
  ['','','','','','','','','','','$500.00','2.2','2.0','','$300.00','$200.00']]),'MDaily - Work Order Billable');
XLSX.utils.book_append_sheet(wb, mk('MWeekly',bd,[
  ['-> Sunset Palms','3','','','','','','','','','$500.00','2','2','','$0.00','$500.00'],
  ['','24001-1','12','Bright','Owner','09/21/2026','Roof','6595','1','500','$500.00','2','2','Work Done','$0.00','$500.00']]),'MWeekly - Work Order Billable D');
XLSX.utils.book_append_sheet(wb, mk('MMonthly',bd,[
  ['-> The Chateau','2','','','','','','','','','$900.00','3','3','','$900.00','$0.00'],
  ['','22990-1','A-1','Acme','Owner','09/15/2026','Panel','6595','1','900','$900.00','3','3','Completed','$900.00','$0.00']]),'MMonthly - Work Order Billable');
XLSX.writeFile(wb, OUT);
const back=XLSX.readFile(OUT);
console.log('sheets:', JSON.stringify(back.SheetNames));
const aoa=XLSX.utils.sheet_to_json(back.Sheets['MDaily - Work Order Billable'],{header:1,raw:false,defval:''});
console.log('rows:', aoa.length);
aoa.slice(0,7).forEach((r,i)=>console.log('  row '+i+' ('+r.length+' cells): '+JSON.stringify(r).slice(0,80)));
