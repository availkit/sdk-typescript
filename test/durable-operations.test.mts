import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {inspect} from 'node:util';
import {createNodeClient,prepareNodeOperation,executeNodeOperation,NodeOperationIntent,FileOperationStore,OperationStoreError} from '../src/node.ts';
import {SQLiteOperationStore} from '../src/operation-sqlite.ts';
const ID='a'.repeat(32),WS='1'.repeat(32),OFF='2'.repeat(32),KEY='synthetic-durable-original-key';
const body={offeringId:OFF,start:'2030-01-07T09:00:00Z'};
const options={baseUrl:'https://api.availkit.com',workspaceId:WS,credential:'A'.repeat(43)};
const original=async()=>prepareNodeOperation(await createNodeClient(options),{environment:'test',operation:'book',body,idempotencyKey:KEY});
const factories=[FileOperationStore,SQLiteOperationStore];
function privateDir(){return fs.mkdtempSync(join(tmpdir(),'availkit-durable-'));}
async function exited(child:ReturnType<typeof spawn>):Promise<number|null>{return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}

test('both stores retain original and unknown across reopen, CAS, explicit replay, terminal states',async()=>{
  for(const Factory of factories){const directory=privateDir();let store=new Factory(directory);try{
    const intent=await original();const record=store.create(ID,intent);assert.equal(record.state,'prepared');assert.equal(store.create(ID,intent).revision,0);
    const changed=NodeOperationIntent.fromPrivate(intent.exportPrivate().replace(KEY,KEY+'2'));assert.throws(()=>store.create(ID,changed),{code:'conflict'});
    const admitted=store.begin(ID,0,intent);assert.equal(admitted.state,'unknown');assert.equal(admitted.active,true);store.close();store=new Factory(directory);
    const row=store.read(ID)!;assert.equal(row.original().exportPrivate(),intent.exportPrivate());assert.throws(()=>store.begin(ID,row.revision,intent,{replay:true}),{code:'claim_active'});
    const released=store.releaseInterrupted(ID,row.revision,true),replay=store.begin(ID,released.revision,row.original(),{replay:true});
    assert.throws(()=>store.settle(ID,replay.revision,admitted.attemptToken()!,'confirmed'),{code:'conflict'});
    const done=store.settle(ID,replay.revision,replay.attemptToken()!,'confirmed');assert.equal(done.state,'confirmed');assert.equal(done.active,false);
    assert.throws(()=>store.begin(ID,done.revision,intent,{replay:true}),{code:'invalid_transition'});assert.ok(!inspect(done).includes(KEY));assert.ok(!JSON.stringify(done).includes(OFF));
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}}
});

test('one actual injected send, interruption and exact explicit original replay',async()=>{
  for(const Factory of factories){const directory=privateDir();let store=new Factory(directory);try{
    const sends:Array<{url:string,body:unknown,key:string|undefined}>=[];
    const client=await createNodeClient({...options,fetch:async(url,init)=>{sends.push({url,body:init.body,key:(init.headers as Record<string,string>)['Idempotency-Key']});throw new Error('private-transport-detail');}});
    const intent=prepareNodeOperation(client,{environment:'test',operation:'book',body,idempotencyKey:KEY});store.create(ID,intent);const first=store.begin(ID,0,intent);
    await assert.rejects(executeNodeOperation(client,'test',intent),{outcome:'unknown'});assert.equal(sends.length,1);
    store.close();store=new Factory(directory);const row=store.read(ID)!;assert.equal(sends.length,1);
    const ready=store.releaseInterrupted(ID,row.revision,true);const replay=store.begin(ID,ready.revision,row.original(),{replay:true});
    await assert.rejects(executeNodeOperation(client,'test',replay.original()),{outcome:'unknown'});assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);assert.equal(first.original().exportPrivate(),replay.original().exportPrivate());
    const other=await createNodeClient({...options,workspaceId:'9'.repeat(32),fetch:async()=>{throw Error('must-not-send');}});
    await assert.rejects(executeNodeOperation(other,'test',intent),{code:'intent_scope_mismatch'});await assert.rejects(executeNodeOperation(client,'live',intent),{code:'intent_scope_mismatch'});assert.equal(sends.length,2);
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}}
});

test('independent processes race for one revision and retain abrupt admission',async()=>{
  for(const Factory of factories){const directory=privateDir();let store=new Factory(directory);try{
    const intent=await original();store.create(ID,intent);store.close();
    fs.writeFileSync(join(directory,'original.json'),intent.exportPrivate(),{mode:0o600});
    const workerEnv={...process.env};delete workerEnv.NODE_TEST_CONTEXT;
    const children=[0,1].map(()=>spawn(process.execPath,['--max-old-space-size=96',new URL('./durable-worker.mts',import.meta.url).pathname,directory,Factory===FileOperationStore?'file':'sqlite'],{stdio:['pipe','pipe','pipe'],env:workerEnv}));
    const exits=children.map(exited);
    try{
      await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{let ready=false;let diagnostic='';child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(0,3000);});const timer=setTimeout(()=>reject(Error('worker readiness deadline')),5000);child.stdout!.once('data',()=>{ready=true;clearTimeout(timer);resolve();});child.once('exit',(code,signal)=>{clearTimeout(timer);if(!ready)reject(Error('worker exited before ready: '+code+':'+signal+':'+diagnostic));});child.once('error',error=>{clearTimeout(timer);reject(error);});})));
      children.forEach(child=>child.stdin!.end('go'));const results=await Promise.all(exits);assert.deepEqual(results.sort(),[17,18]);
    }finally{for(const child of children)if(child.exitCode===null)child.kill();await Promise.allSettled(exits);}
    store=new Factory(directory);const row=store.read(ID)!;assert.equal(row.state,'unknown');assert.equal(row.active,true);assert.equal(row.attempts,1);
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}}
});

test('future/expired originals, capacity, private permissions and malformed data fail closed',async()=>{
  for(const Factory of factories){for(const age of [-60000,86400001]){const directory=privateDir();const store=new Factory(directory);try{
    const data=JSON.parse((await original()).exportPrivate());data.createdAt=new Date(Date.now()-age).toISOString();const intent=NodeOperationIntent.fromPrivate(JSON.stringify(data));store.create(ID,intent);assert.throws(()=>store.begin(ID,0,intent),{code:'intent_window'});assert.equal(store.read(ID)!.state,'prepared');
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}}
    const directory=privateDir();const store=new Factory(directory);try{const intent=await original();for(let n=0;n<128;n++)store.create(n.toString(16).padStart(32,'0'),intent);assert.throws(()=>store.create(ID,intent),{code:'capacity'});}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
  }
  const directory=privateDir();try{fs.chmodSync(directory,0o755);assert.throws(()=>new FileOperationStore(directory),{code:'invalid_storage'});fs.chmodSync(directory,0o700);fs.writeFileSync(join(directory,ID+'.json'),'{"secret":"do-not-reflect"}',{mode:0o600});const store=new FileOperationStore(directory);try{assert.throws(()=>store.read(ID),(e:unknown)=>e instanceof OperationStoreError&&e.code==='invalid_record'&&!String(e).includes('do-not-reflect'));}finally{store.close();}}finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('unfinished private snapshot and crash lock are retained, never automatically reclaimed',()=>{
  const directory=privateDir();const store=new FileOperationStore(directory);try{fs.mkdirSync(join(directory,'.lock'),{mode:0o700});fs.writeFileSync(join(directory,'.pending'),'private interrupted original',{mode:0o600});assert.throws(()=>store.recoverLock(true),{code:'repair_required'});assert.ok(fs.existsSync(join(directory,'.pending')));assert.ok(fs.existsSync(join(directory,'.lock')));assert.throws(()=>store.read(ID),{code:'busy'});}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});


test('workspace create/move/cancel dispatch the retained exact closed body and key',async()=>{
  const booking={id:'3'.repeat(32),offeringId:OFF,resourceId:'4'.repeat(32),start:body.start,end:'2030-01-07T09:30:00Z',status:'confirmed'};
  const sent:Array<{url:string,body:unknown,key:string}>=[];
  let current=booking;
  const client=await createNodeClient({...options,fetch:async(url,init)=>{
    sent.push({url,body:init.body,key:(init.headers as Record<string,string>)['Idempotency-Key']});
    if(url.endsWith('/cancel'))current={...current,status:'cancelled'};
    if(url.endsWith('/reschedule'))current={...current,start:'2030-01-07T10:00:00.123456Z',end:'2030-01-07T10:30:00.123456Z'};
    return new Response(JSON.stringify(current),{status:url.endsWith('/bookings')?201:200,headers:{'content-type':'application/json'}});
  }});
  const originals=[prepareNodeOperation(client,{environment:'test',operation:'book',body,idempotencyKey:KEY}),
    prepareNodeOperation(client,{environment:'test',operation:'rescheduleBooking',bookingId:booking.id,body:{expectedStart:body.start,start:'2030-01-07T10:00:00.123456Z'},idempotencyKey:KEY+'-move'}),
    prepareNodeOperation(client,{environment:'test',operation:'cancel',bookingId:booking.id,idempotencyKey:KEY+'-cancel'})];
  for(const original of originals){const retained=NodeOperationIntent.fromPrivate(original.exportPrivate());await executeNodeOperation(client,'test',retained);const wire=sent.at(-1)!,v=JSON.parse(retained.exportPrivate());assert.equal(wire.body,v.body);assert.equal(wire.key,v.idempotencyKey);assert.ok(wire.url.endsWith(v.path));assert.ok(!retained.exportPrivate().includes(options.credential));}
  assert.equal(sent.length,3);
});

test('symlink components, FIFO leaves and broad file modes refuse before reading',()=>{
  const outer=privateDir();try{
    const directory=join(outer,'store');fs.mkdirSync(directory,{mode:0o700});fs.symlinkSync(directory,join(outer,'linked'));
    for(const Factory of factories)assert.throws(()=>new Factory(join(outer,'linked')),{code:'invalid_storage'});
    const store=new FileOperationStore(directory);try{execFileSync('mkfifo',['-m','600',join(directory,ID+'.json')]);assert.throws(()=>store.read(ID),{code:'invalid_storage'});fs.unlinkSync(join(directory,ID+'.json'));fs.writeFileSync(join(directory,ID+'.json'),'{}',{mode:0o644});assert.throws(()=>store.read(ID),{code:'invalid_storage'});}finally{store.close();}
    const dbdir=join(outer,'db');fs.mkdirSync(dbdir,{mode:0o700});execFileSync('mkfifo',['-m','600',join(dbdir,'operations.sqlite')]);assert.throws(()=>new SQLiteOperationStore(dbdir),{code:'invalid_storage'});
  }finally{fs.rmSync(outer,{recursive:true,force:true});}
});


test('lost original followed by rejected403/409 replay retains logical UNKNOWN',async()=>{
  for(const Factory of factories)for(const status of [403,409]){
    const directory=privateDir();const store=new Factory(directory);try{
      const sends:Array<{url:string,body:unknown,key:string}>=[];
      const client=await createNodeClient({...options,fetch:async(url,init)=>{sends.push({url,body:init.body,key:(init.headers as Record<string,string>)['Idempotency-Key']});if(sends.length===1)throw Error('lost acknowledgment');return new Response(JSON.stringify({error:{code:status===403?'capability_denied':'version_conflict',message:'synthetic rejection'}}),{status,headers:{'content-type':'application/json'}});}});
      const original=prepareNodeOperation(client,{environment:'test',operation:'book',body,idempotencyKey:KEY}),bytes=original.exportPrivate();
      store.create(ID,original);const first=store.begin(ID,0,original);await assert.rejects(executeNodeOperation(client,'test',original),{outcome:'unknown'});
      const ready=store.settle(ID,first.revision,first.attemptToken()!,'unknown'),replay=store.begin(ID,ready.revision,ready.original(),{replay:true});
      await assert.rejects(executeNodeOperation(client,'test',replay.original()),{outcome:'rejected',status});
      const retained=store.settle(ID,replay.revision,replay.attemptToken()!,'rejected');
      assert.equal(retained.state,'unknown');assert.equal(retained.active,false);assert.equal(retained.original().exportPrivate(),bytes);assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);
      const secondId='b'.repeat(32),initial=store.create(secondId,original),one=store.begin(secondId,initial.revision,original);assert.equal(store.settle(secondId,one.revision,one.attemptToken()!,'rejected').state,'rejected');
    }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
  }
});
