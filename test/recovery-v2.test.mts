import assert from 'node:assert/strict';
import test from 'node:test';
import {RecoveryClient,HumanClient,AvailKitError} from '../src/index.ts';
import {RecoveryClient as HumanExport} from '../src/human.ts';
import type {RecoveryFinishV2} from '../src/recovery.ts';
const baseUrl='https://app.example.invalid',secret='private-recovery-marker',code='A'.repeat(43),id='a'.repeat(32);
const profile={version:2,rp_id:'app.example.invalid',recovery_available:true,notice_delivery:'email_queued'};
const credential:RecoveryFinishV2['credential']={id:'AA',rawId:'AA',type:'public-key',extensions:{},response:{clientDataJSON:'AA',attestationObject:'AA'}};
const session={account_id:id,csrf_token:code,recent_until:2000000000000};
const options={publicKey:{challenge:'AA',rp:{id:'app.example.invalid',name:'AvailKit'},user:{id:'AA',name:'Account',displayName:'Account'},pubKeyCredParams:[{type:'public-key',alg:-7}]}};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});

test('v2 profile uses the dedicated cookie transport and ignores accidental bearer/header overrides',async()=>{
  assert.equal(RecoveryClient,HumanExport);let sends=0;
  const client=new RecoveryClient({baseUrl,headers:{Authorization:secret},credentials:'include',fetch:async(url:string,init:RequestInit)=>{
    sends++;assert.equal(url,baseUrl+'/v2/human/recovery/profile');assert.equal(init.method,'GET');assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
    assert.equal(new Headers(init.headers).get('Authorization'),null);assert.equal(new Headers(init.headers).get('Idempotency-Key'),null);return json(profile);
  }}as never);
  assert.deepEqual(await client.profile(),profile);assert.equal(sends,1);assert.equal(JSON.stringify(client),'{}');
});

test('legacy human profile/disabled-recovery behavior remains independent of v2 availability',async()=>{
  const old={profile:'production-v1',rp_id:'app.example.invalid',recovery_available:false,preview_mailbox:false};
  const human=new HumanClient({baseUrl,fetch:async()=>json(old)});assert.deepEqual(await human.browser(),old);
  assert(!('recoveryStart'in human)&&!('recoveryFinish'in human));
  const wrong=new HumanClient({baseUrl,fetch:async()=>json({...old,recovery_available:true})});await assert.rejects(wrong.browser(),e=>e instanceof AvailKitError&&e.kind==='protocol');
  const recovery=new RecoveryClient({baseUrl,fetch:async()=>json({...profile,recovery_available:false,notice_delivery:'unavailable'})});assert.equal((await recovery.profile()).recovery_available,false);
});

test('recovery start and finish send exact unkeyed closed inputs once and preserve normal library options',async()=>{
  const seen:Array<{url:string,init:RequestInit}>=[];
  const client=new RecoveryClient({baseUrl,fetch:async(url,init)=>{seen.push({url,init});return url.endsWith('/start')?json({ceremony_id:id,options}):json(session);}});
  const start=await client.start({email:'owner@example.com',code});assert.deepEqual(start.options,options);
  const finished=await client.finish({ceremony_id:start.ceremony_id,credential});assert.deepEqual(finished,session);
  assert.deepEqual(seen.map(s=>new URL(s.url).pathname),['/v2/human/recovery/start','/v2/human/recovery/finish']);
  assert.deepEqual(JSON.parse(String(seen[0].init.body)),{email:'owner@example.com',code});assert.deepEqual(JSON.parse(String(seen[1].init.body)),{ceremony_id:id,credential});
  for(const s of seen){assert.equal(s.init.method,'POST');assert.equal(new Headers(s.init.headers).get('X-CSRF-Token'),null);assert.equal(new Headers(s.init.headers).get('Idempotency-Key'),null);}
});

test('closed v2 input validation refuses extra proof/bearer fields locally without sends',async()=>{
  let sends=0;const client=new RecoveryClient({baseUrl,fetch:async()=>{sends++;return json(session);}});
  for(const body of [{email:'owner@example.com',code,extra:secret},{email:'owner@example.com',code:'short'}]) await assert.rejects(async()=>client.start(body as never),e=>e instanceof AvailKitError&&e.outcome==='not_sent');
  for(const body of [{ceremony_id:id,credential,code},{ceremony_id:'bad',credential},{ceremony_id:id,credential:{...credential,extra:secret}}]) await assert.rejects(async()=>client.finish(body as never),e=>e instanceof AvailKitError&&e.outcome==='not_sent');
  assert.equal(sends,0);
});

test('unknown start/finish outcomes are redacted and never trigger another request',async()=>{
  for(const method of ['start','finish']as const)for(const fault of ['transport','malformed','server','unrecognized','oversized']as const){
    let sends=0;const client=new RecoveryClient({baseUrl,maxResponseBytes:fault==='oversized'?32:1048576,fetch:async()=>{
      sends++;if(fault==='transport')throw new Error(secret);
      if(fault==='malformed')return new Response('{',{headers:{'content-type':'application/json','cache-control':'no-store'}});
      if(fault==='oversized')return json({private:secret.repeat(10)});
      return json({type:'urn:availkit:problem',status:fault==='server'?503:403,code:fault==='server'?'unavailable':secret,detail:secret},fault==='server'?503:403);
    }});
    const action=()=>method==='start'?client.start({email:'owner@example.com',code}):client.finish({ceremony_id:id,credential});
    await assert.rejects(async()=>action(),e=>{assert(e instanceof AvailKitError);assert.equal(e.outcome,'unknown');assert(!JSON.stringify(e).includes(secret));assert(!e.message.includes(secret));assert(!('cause'in e));return true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(sends,1);
  }
});

test('recognized current-authority rejection remains a safe known rejection',async()=>{
  let sends=0;const client=new RecoveryClient({baseUrl,fetch:async()=>{sends++;return json({type:'urn:availkit:problem',status:401,code:'credential_invalid',detail:secret},401);}});
  await assert.rejects(client.finish({ceremony_id:id,credential}),e=>e instanceof AvailKitError&&e.code==='credential_invalid'&&e.outcome==='rejected');assert.equal(sends,1);
});

test('total recovery deadline bounds fetch and body drain without a retry',async()=>{
  for(const stalled of ['fetch','body']){
    let sends=0;const client=new RecoveryClient({baseUrl,timeoutMs:20,fetch:async()=>{
      sends++;if(stalled==='fetch')return new Promise<Response>(()=>{});
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json','cache-control':'no-store'}});
    }});
    const began=Date.now();await assert.rejects(client.finish({ceremony_id:id,credential}),e=>e instanceof AvailKitError&&e.code==='timeout'&&e.outcome==='unknown');assert(Date.now()-began<1500);assert.equal(sends,1);
  }
});

test('profile validates availability/notice pairing, version, closed shape and no-store',async()=>{
  for(const value of [{...profile,version:1},{...profile,notice_delivery:'unavailable'},{...profile,recovery_available:false},{...profile,extra:secret}]){
    const client=new RecoveryClient({baseUrl,fetch:async()=>json(value)});await assert.rejects(client.profile(),e=>e instanceof AvailKitError&&e.kind==='protocol');
  }
  const missingCache=new RecoveryClient({baseUrl,fetch:async()=>new Response(JSON.stringify(profile),{headers:{'content-type':'application/json'}})});await assert.rejects(missingCache.profile(),e=>e instanceof AvailKitError&&e.kind==='protocol');
});

test('recovery configuration refuses cross-origin browser use and authority-bearing URLs',()=>{
  for(const url of ['http://public.example.invalid','https://user:secret@app.example.invalid','https://app.example.invalid/path','https://app.example.invalid/?secret=x','https://app.example.invalid/#secret','file:///private'])assert.throws(()=>new RecoveryClient({baseUrl:url}),e=>e instanceof AvailKitError&&e.outcome==='not_sent');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  try{Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:baseUrl}});assert.throws(()=>new RecoveryClient({baseUrl:'https://other.example.invalid'}),e=>e instanceof AvailKitError&&e.outcome==='not_sent');}
  finally{if(previous)Object.defineProperty(globalThis,'location',previous);else delete (globalThis as {location?:unknown}).location;}
});
