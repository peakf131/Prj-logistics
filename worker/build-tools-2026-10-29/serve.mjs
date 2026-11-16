import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
process.removeAllListeners('warning');
function makeD1(){const db=new DatabaseSync(process.argv[3]||':memory:');const stmt=(sql,args=[])=>({bind:(...a)=>stmt(sql,a),all:async()=>({results:db.prepare(sql).all(...args)}),first:async()=>db.prepare(sql).get(...args)||null,run:async()=>{db.prepare(sql).run(...args);return{}},_exec:()=>/^\s*select/i.test(sql)?{results:db.prepare(sql).all(...args)}:(db.prepare(sql).run(...args),{results:[]})});return{prepare:s=>stmt(s),batch:async l=>{db.exec('BEGIN');try{const r=l.map(s=>s._exec());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}}
const worker=(await import('/tmp/gal/worker.mjs')).default;
const env={DB:makeD1(),SETUP_KEY:'setup-123',TEST_OUTBOX:[],TEST_TELEGRAM:[]};
http.createServer(async(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
  const r=await worker.fetch(new Request('http://localhost:'+process.argv[2]+req.url,{method:req.method,body:req.method==='POST'?body:undefined}),env,{waitUntil(){}});
  res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));})}).listen(+process.argv[2]);
