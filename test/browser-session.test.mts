import test from 'node:test';
import assert from 'node:assert/strict';
import {AvailKitClient,AvailKitError} from '../src/index.ts';
const csrf='a'.repeat(43),workspace='1'.repeat(32),baseUrl='https://dashboard.example.invalid';
test('browser session transport binds environment, omits bearer and sends cookies/CSRF once',async()=>{
  const seen:Array<{url:string,init:RequestInit}>=[];
  const client=new AvailKitClient({baseUrl,workspaceId:workspace,browserSession:{environment:'test',csrfToken:csrf,principal:'2'.repeat(32)},fetch:async(url,init)=>{
    seen.push({url,init});return new Response(JSON.stringify({items:[],nextAfter:null}),{headers:{'content-type':'application/json','cache-control':'no-store'}});
  }});
  await client.listResources();assert.equal(seen.length,1);
  assert.equal(new URL(seen[0].url).pathname,`/v1/dashboard/test/workspaces/${workspace}/resources`);
  assert.equal(seen[0].init.credentials,'same-origin');assert.equal(seen[0].init.redirect,'error');
  assert.equal(new Headers(seen[0].init.headers).get('Authorization'),null);
  assert.equal(new Headers(seen[0].init.headers).get('X-CSRF-Token'),csrf);
  assert.equal(new Headers(seen[0].init.headers).get('X-AvailKit-Dashboard-Scope'),'2'.repeat(32));
});
test('browser session configuration refuses ambiguous credentials and invalid CSRF locally',()=>{
  for(const options of [
    {credential:'synthetic-secret',browserSession:{environment:'test',csrfToken:csrf,principal:'2'.repeat(32)}},
    {browserSession:{environment:'other',csrfToken:csrf,principal:'2'.repeat(32)}},
    {browserSession:{environment:'test',csrfToken:'short',principal:'2'.repeat(32)}},
  ]) assert.throws(()=>new AvailKitClient({baseUrl,workspaceId:workspace,...options} as never),e=>e instanceof AvailKitError&&e.kind==='input');
});
test('session mutation transport loss remains unknown and is not automatically resent',async()=>{
  let sends=0;
  const client=new AvailKitClient({baseUrl,workspaceId:workspace,browserSession:{environment:'live',csrfToken:csrf,principal:'2'.repeat(32)},fetch:async()=>{sends++;throw new Error('connection lost');}});
  await assert.rejects(client.createResource({name:'Synthetic',timeZone:'UTC',capacity:1}),e=>e instanceof AvailKitError&&e.outcome==='unknown');
  assert.equal(sends,1);
});

test('documented human validation rejection is rejected, never presented as a lost response',async()=>{
  const {HumanClient}=await import('../src/human.ts');
  let sends=0;
  const human=new HumanClient({baseUrl,fetch:async()=>{sends++;return new Response(JSON.stringify({type:'urn:availkit:problem',status:422,code:'validation_failed'}),{status:422,headers:{'content-type':'application/problem+json','cache-control':'no-store'}});}});
  await assert.rejects(human.enrollStart({email:'preview@example.com'}),e=>e instanceof AvailKitError&&e.kind==='api'&&e.code==='validation_failed'&&e.outcome==='rejected');
  assert.equal(sends,1);
});
