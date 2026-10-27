import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicBookingClient, AvailKitClient, AvailKitError, HumanClient, RecoveryClient } from '../src/index.ts';
import { BusinessExportClient } from '../src/business-export.ts';
import { runCli } from '../src/cli.mts';
const id=(n:number)=>n.toString(16).padStart(32,'0');
const resource={id:id(1),name:'Café_%',timeZone:'UTC',capacity:1,archived:false};
const offering={id:id(2),name:'Visit',resourceId:id(1),durationMinutes:30,archived:false};
const json=(body:unknown,status=200,media='application/json')=>new Response(JSON.stringify(body),{status,headers:{'content-type':media,'cache-control':'no-store'}});
const opts={baseUrl:'http://localhost:43000',workspaceId:id(10),credential:'current-sdk-synthetic-only'};

test('catalog lifecycle and literal search use the accepted routes and typed archive state',async()=>{
  const calls:Array<[string,string,unknown]>=[];
  const client=new AvailKitClient({...opts,fetch:async(url,init)=>{
    const path=new URL(url);calls.push([init.method!,path.pathname+path.search,init.body?JSON.parse(String(init.body)):undefined]);
    if(init.method==='GET')return json({items:[resource],nextAfter:null});
    return json({...resource,...(JSON.parse(String(init.body))),archived:path.pathname.endsWith('/archive')});
  }});
  await client.replaceResource(resource.id,{name:'Changed',capacity:1,timeZone:'UTC'});
  assert((await client.archiveResource(resource.id)).archived);
  const query={limit:2,q:'é_%'};await client.listResources(query);
  assert.equal(new URL('http://example'+calls[2][1]).searchParams.get('q'),'é_%');
  assert.deepEqual(calls.map(c=>c[0]),['PUT','POST','GET']);
  let sends=0;const bad=new AvailKitClient({...opts,fetch:async()=>{sends++;return json({});}});
  await assert.rejects(async()=>bad.listResources({q:'\n'}),e=>e instanceof AvailKitError&&e.outcome==='not_sent');assert.equal(sends,0);
});

test('bounded collection iteration preserves search and rejects a partial export at budget exhaustion',async()=>{
  let calls=0;const c=new AvailKitClient({...opts,fetch:async(url)=>{calls++;const u=new URL(url);assert.equal(u.searchParams.get('q'),'Café');const after=u.searchParams.get('after');return json({items:[{...resource,id:after?id(2):id(1)}],nextAfter:after?null:id(1)});}});
  const pages=[];for await(const p of c.resourcePages({limit:1,q:'Café'},{maxPages:2}))pages.push(p);
  assert.equal(calls,2);assert.equal(pages.length,2);calls=0;
  await assert.rejects(async()=>{for await(const _ of c.resourcePages({limit:1,q:'Café'},{maxPages:1})){}},e=>e instanceof AvailKitError&&e.code==='page_budget_exhausted');assert.equal(calls,1);
});

test('event retention metadata is required and expired cursors never silently restart',async()=>{
  let calls=0;const c=new AvailKitClient({...opts,fetch:async()=>{calls++;return json({events:[],nextAfter:12,retentionFloor:12,highWater:12});}});
  assert.equal((await c.events()).retentionFloor,12);assert.equal(calls,1);
  const bad=new AvailKitClient({...opts,fetch:async()=>json({events:[],nextAfter:0})});
  await assert.rejects(bad.events(),e=>e instanceof AvailKitError&&e.kind==='protocol');
  const expired=new AvailKitClient({...opts,fetch:async()=>json({error:{code:'event_cursor_expired',message:opts.credential}},409)});
  await assert.rejects(expired.events({after:1}),e=>e instanceof AvailKitError&&e.code==='event_cursor_expired'&&e.outcome==='rejected');
});

test('problem responses and malformed/lost mutation responses have safe explicit outcomes and send once',async()=>{
  for(const status of [400,403,503]){
    let calls=0;const c=new AvailKitClient({...opts,fetch:async()=>{calls++;return json({type:'urn:availkit:problem',title:opts.credential,status,detail:opts.credential,code:status===503?'unavailable':'scope_denied',request_id:'private'},status,'application/problem+json');}});
    await assert.rejects(c.archiveOffering(offering.id),e=>{assert(e instanceof AvailKitError);assert.equal(e.outcome,status===503?'unknown':'rejected');assert(!JSON.stringify(e).includes(opts.credential));return true;});assert.equal(calls,1);
  }
  const reflected=new AvailKitClient({...opts,fetch:async()=>json({error:{code:opts.credential,message:opts.credential}},409)});
  await assert.rejects(reflected.archiveResource(resource.id),e=>e instanceof AvailKitError&&e.code==='api_error'&&e.outcome==='unknown');
});

test('human client keeps same-origin cookie authority, CSRF and request keys; recovery has no methods',async()=>{
  const csrf='a'.repeat(43);let calls=0;
  const client=new HumanClient({baseUrl:opts.baseUrl,fetch:async(_url,init)=>{
    calls++;assert.equal(init.credentials,'same-origin');assert(!new Headers(init.headers).has('Authorization'));
    if(init.method==='GET')return json({account_id:id(1),csrf_token:csrf,recent_until:2000000000000,scope:null,memberships:[]});
    assert.equal(new Headers(init.headers).get('X-CSRF-Token'),csrf);assert.equal(new Headers(init.headers).get('Idempotency-Key'),'sdk-current-intent-key');
    return json({type:'urn:availkit:problem',title:'Conflict',status:409,detail:'private',code:'secret_already_revealed',request_id:'opaque'},409,'application/problem+json');
  }});
  await client.session();
  await assert.rejects(client.issueKey({organization_id:id(1),workspace_id:id(2),environment:'test',kind:'secret',capabilities:1},'sdk-current-intent-key'),e=>e instanceof AvailKitError&&e.code==='secret_already_revealed');
  assert.equal(calls,2);assert(!('recoveryStart'in client)&&!('recoveryFinish'in client));
  await assert.rejects(client.enrollStart({email:'x'.repeat(255)}),e=>e instanceof AvailKitError&&e.outcome==='not_sent');assert.equal(calls,2);
});

test('private credential file config is usable, rejects loose files and never puts a secret in output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'availkit-sdk-current-')),file=join(root,'credential');await writeFile(file,opts.credential+'\n',{mode:0o600});
  const env={AVAILKIT_BASE_URL:opts.baseUrl,AVAILKIT_WORKSPACE_ID:opts.workspaceId,AVAILKIT_CREDENTIAL_FILE:file};
  await assert.rejects(runCli(['resource','get'],env,()=>assert.fail()),e=>e instanceof AvailKitError&&e.kind==='input');
  await chmod(file,0o644);await assert.rejects(runCli(['resource','list'],env,()=>assert.fail()),e=>e instanceof AvailKitError&&e.code==='invalid_credential_file');
});

test('current operation inventory covers every workspace and supported human method, with explicit deferred/operator boundaries',async()=>{
 const doc=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../contracts/api.openapi.json',import.meta.url),'utf8'));
 const coverage=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../coverage.json',import.meta.url),'utf8'));
 const ids=Object.values(doc.paths).flatMap((ms:any)=>Object.values(ms).map((op:any)=>op.operationId));assert.deepEqual(Object.keys(coverage).sort(),ids.sort());
 for(const row of Object.values(coverage) as any[]){if(row.status==='supported'){const [owner,method]=row.sdk.split('.');assert.equal(typeof (owner==='BusinessExportClient'?BusinessExportClient:owner==='HumanClient'?HumanClient:owner==='RecoveryClient'?RecoveryClient:owner==='PublicBookingClient'?PublicBookingClient:AvailKitClient).prototype[method],'function');if(owner==='AvailKitClient')assert.equal(typeof row.cli,'string');}}
 assert.equal(Object.values(coverage).filter((r:any)=>r.status==='deferred-disabled').length,2);
});

test('CLI entrypoint runs through an installed-style executable symlink',async()=>{
 const {symlink}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');const root=await mkdtemp(join(tmpdir(),'availkit-sdk-bin-')),link=join(root,'availkit');
 await symlink(new URL('../src/cli.mts',import.meta.url).pathname,link);const result=spawnSync(process.execPath,[link,'--help'],{encoding:'utf8',timeout:2000,maxBuffer:65536});assert.equal(result.status,0);assert.equal(result.stderr,'');assert.match(result.stdout,/Usage:/);assert.match(result.stdout,/resource create/);
});
