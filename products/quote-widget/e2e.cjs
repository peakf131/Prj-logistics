/* node e2e.cjs: browser test of the COSO site demo, the widget against the real worker code, and the admin page */
const {chromium}=require('playwright');const http=require('http');const fs=require('fs');const path=require('path');
fs.copyFileSync(path.resolve('dist/worker.js'),path.resolve('dist/worker.mjs'));
(async()=>{
 // 1) offline preview (sales page)
 const b=await chromium.launch();const errs=[];
 let p=await b.newPage({viewport:{width:1280,height:860}});p.on('pageerror',e=>errs.push('preview: '+e.message));
 await p.goto('file://'+path.resolve('../coso/dist/preview.html'));await p.waitForTimeout(500);
 const sh=p.locator('#iq-demo');
 await sh.locator('#qf').fill('reading');await p.waitForTimeout(400);await sh.locator('#lf li').first().click();
 await sh.locator('#qt').fill('heathrow');await p.waitForTimeout(400);await p.keyboard.press('Enter');
 await sh.locator('input[name=veh][value=lwb]').check({force:true});
 await sh.locator('#go').click();await p.waitForTimeout(600);
 console.log('offline price:',(await sh.locator('.big').textContent()),'|',(await sh.locator('.trip .meta').textContent()));
 await p.screenshot({path:'shot-preview.png'});
 await sh.locator('#bk').click();await sh.locator('#cn').fill('Anna Smith');await sh.locator('#cp').fill('07123 456789');await sh.locator('#ce').fill('anna@example.com');await sh.locator('#ck').check();
 await sh.locator('#sb').click();await p.waitForTimeout(800);console.log('offline done:',await sh.locator('.ref').textContent());
 await p.close();
 for(const [w,f] of [[390,'shot-mobile.png']]){const m=await b.newPage({viewport:{width:w,height:844}});await m.goto('file://'+path.resolve('../coso/dist/preview.html'));await m.waitForTimeout(500);console.log('mobile scrollWidth',await m.evaluate(()=>document.documentElement.scrollWidth));await m.screenshot({path:f,fullPage:true});await m.close()}
 // 2) online: real worker code behind a local server, outside services faked
 const W=(await import(path.resolve('dist/worker.mjs'))).default;
 const realFetch=globalThis.fetch;
 globalThis.fetch=async(u,i)=>{u=String(u);const J=o=>new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json'}});
  if(u.includes('photon'))return J({features:[{properties:{countrycode:'GB',housenumber:'14',street:'Broad Street',city:'Reading',postcode:'RG1 2BH'},geometry:{coordinates:[-0.973,51.456]}},{properties:{countrycode:'GB',name:'Heathrow Terminal 5',city:'Hounslow',postcode:'TW6 2GA'},geometry:{coordinates:[-0.488,51.472]}}]});
  if(u.includes('osrm'))return J({routes:[{distance:45000,duration:2700,geometry:{coordinates:[[-0.973,51.456],[-0.7,51.47],[-0.488,51.472]]}}]});
  return realFetch(u,i)};
 const env={QUOTE:null,TEST_OUTBOX:[]};const kvm=new Map();env.QUOTE={get:async k=>kvm.has(k)?kvm.get(k).v:null,put:async(k,v,o)=>kvm.set(k,{v,meta:o&&o.metadata}),delete:async k=>kvm.delete(k),list:async({prefix})=>({keys:[...kvm.keys()].filter(k=>k.startsWith(prefix)).map(k=>({name:k,metadata:kvm.get(k).meta}))})};
 const srv=http.createServer(async(rq,rs)=>{
  if(rq.url==='/host.html'){rs.setHeader('Content-Type','text/html');rs.end('<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:Georgia;background:#f3f3f3;padding:20px"><h1>Some courier site</h1><div data-prj-quote></div><script src="/widget.js" data-tenant="demo" async></script></body>');return}
  let body='';for await(const c of rq)body+=c;
  const r=await W.fetch(new Request('http://localhost:8787'+rq.url,{method:rq.method,headers:rq.headers,body:['GET','HEAD'].includes(rq.method)?undefined:body}),env,{waitUntil:x=>x});
  rs.writeHead(r.status,Object.fromEntries(r.headers));rs.end(Buffer.from(await r.arrayBuffer()))});
 await new Promise(r=>srv.listen(8787,r));
 p=await b.newPage({viewport:{width:900,height:900}});p.on('pageerror',e=>errs.push('online: '+e.message));
 await p.goto('http://localhost:8787/host.html');await p.waitForTimeout(800);
 const q=p.locator('[data-prj-quote]');
 await q.locator('#qf').fill('broad street');await p.waitForTimeout(700);await q.locator('#lf li').first().click();
 await q.locator('#qt').fill('heathrow');await p.waitForTimeout(700);await q.locator('#lt li').nth(1).click();
 await q.locator('#qa').check();await q.locator('#go').click();await p.waitForTimeout(1200);
 console.log('online price:',await q.locator('.big').textContent(),'|',await q.locator('.trip .meta').textContent());
 await p.screenshot({path:'shot-online.png',fullPage:true});
 await q.locator('#bk').click();await q.locator('#cn').fill('Tom Brown');await q.locator('#cp').fill('07700 900123');await q.locator('#ce').fill('tom@example.com');await q.locator('#cg').fill('3 boxes');await q.locator('#ck').check();
 await p.waitForTimeout(3100);await q.locator('#sb').click();await p.waitForTimeout(1000);
 console.log('online done:',await q.locator('.ref').textContent(),'| emails:',env.TEST_OUTBOX.length,'| leads:',[...kvm.keys()].filter(k=>k.startsWith('lead:')).length);
 // admin page loads and signs in
 env.ADMIN_KEY='test-admin-key-1';const a=await b.newPage();a.on('pageerror',e=>errs.push('admin: '+e.message));await a.goto('http://localhost:8787/admin');await a.fill('#key','test-admin-key-1');await a.click('#lf button');await a.waitForTimeout(600);
 await a.click('#new');await a.fill('#f_id','swift');await a.fill('#f_name','Swift Couriers');await a.fill('#f_email','jobs@swift.example');await a.click('#save');await a.waitForTimeout(600);
 console.log('admin save:',await a.textContent('#em'),'| leads rows:',await a.locator('#ll tr').count());await a.screenshot({path:'shot-admin.png',fullPage:true});
 srv.close();console.log('errors',errs);await b.close();})();
