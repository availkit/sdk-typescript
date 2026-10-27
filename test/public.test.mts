import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicBookingClient,newGuestToken,AvailKitClient,AvailKitError} from '../src/index.ts';
const pageId='1'.repeat(32),offeringId='2'.repeat(32),bookingId='3'.repeat(32);
const page={id:pageId,title:'Test studio',environment:'test' as const};
const offering={id:offeringId,name:'Visit',durationMinutes:30,timeZone:'UTC'};
const booking={id:bookingId,start:'2030-12-01T09:00:00Z',end:'2030-12-01T09:30:00Z',status:'confirmed' as const,offering,page,pageEnabled:true};
const body={offeringId,start:booking.start,contact:{displayName:'Synthetic guest',email:'guest@example.invalid'}};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
test('public browsing has no credential/cookie and preserves bounded pagination',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[];
  const client=new PublicBookingClient({baseUrl:'https://studio.example.invalid',pageId,fetch:async(url,init)=>{calls.push({url,init});return json(url.includes('/offerings')?{items:[offering],nextAfter:null}:page);}});
  assert.deepEqual(await client.getPage(),page);assert.deepEqual(await client.listOfferings({limit:1}),{items:[offering],nextAfter:null});
  assert(calls[1].url.endsWith('/offerings?limit=1'));
  for(const c of calls){assert.equal(c.init.credentials,'omit');assert.equal(c.init.redirect,'error');assert.equal(c.init.cache,'no-store');assert.equal(new Headers(c.init.headers).get('Authorization'),null);}
});
test('public booking sends distinct least-privilege headers and exact intent once',async()=>{
  const access={bookingToken:newGuestToken(),contactToken:newGuestToken()},key='public-client-fixed-key';let sends=0;
  assert.notEqual(access.bookingToken,access.contactToken);
  const client=new PublicBookingClient({baseUrl:'http://localhost',pageId,fetch:async(url,init)=>{sends++;assert(url.endsWith('/bookings'));assert.equal(new Headers(init.headers).get('Authorization'),'Booking '+access.bookingToken);assert.equal(new Headers(init.headers).get('X-AvailKit-Contact-Token'),access.contactToken);assert.equal(new Headers(init.headers).get('Idempotency-Key'),key);assert.deepEqual(JSON.parse(String(init.body)),body);return json(booking,201);}});
  assert.deepEqual(await client.book(body,key,access),booking);assert.equal(sends,1);
});
test('guest capabilities cannot silently become a workspace credential or browser session',async()=>{
  for(const field of ['customerId','resourceId','email','contact','secret']){
    let sends=0;const client=new PublicBookingClient({baseUrl:'http://localhost',pageId,fetch:async()=>{sends++;return json({...booking,[field]:'private'});}});
    await assert.rejects(client.getBooking(bookingId,newGuestToken()),e=>e instanceof AvailKitError&&e.kind==='protocol');assert.equal(sends,1);
  }
});
test('public mutation transport loss is unknown and diagnostics never retain private material',async()=>{
  const access={bookingToken:newGuestToken(),contactToken:newGuestToken()};let sends=0;
  const client=new PublicBookingClient({baseUrl:'http://localhost',pageId,fetch:async()=>{sends++;throw Error(JSON.stringify({access,body}));}});
  await assert.rejects(client.book(body,'public-client-loss-key',access),e=>{
    assert(e instanceof AvailKitError);assert.equal(e.outcome,'unknown');
    const dump=JSON.stringify(e);assert(!dump.includes(access.bookingToken));assert(!dump.includes(access.contactToken));assert(!dump.includes(body.contact.email));return true;
  });assert.equal(sends,1);
});
test('public input errors refuse before dispatch, including malformed capability and foreign fields',async()=>{
  let sends=0;const client=new PublicBookingClient({baseUrl:'http://localhost',pageId,fetch:async()=>{sends++;return json({});}});
  for(const run of [()=>client.book({...body,customerId:'1'}as never,'public-client-input-key',{bookingToken:newGuestToken(),contactToken:newGuestToken()}),()=>client.getBooking(bookingId,'Bearer synthetic-secret'),()=>client.availability({offeringId,from:'2030-02-30T09:00:00Z',to:'2030-03-01T09:00:00Z'}),()=>client.listOfferings({limit:101})])assert.throws(run,e=>e instanceof AvailKitError&&e.outcome==='not_sent');
  assert.equal(sends,0);
});
test('scoped move/cancel preserve explicit body/key and never request contact proof',async()=>{
  const token=newGuestToken();let calls=0;
  const client=new PublicBookingClient({baseUrl:'http://localhost',pageId,fetch:async(url,init)=>{calls++;const headers=new Headers(init.headers);assert.equal(headers.get('Authorization'),'Booking '+token);assert.equal(headers.get('X-AvailKit-Contact-Token'),null);return json(url.endsWith('/cancel')?{...booking,status:'cancelled'}:{...booking,start:'2030-12-01T10:00:00Z',end:'2030-12-01T10:30:00Z'});}});
  await client.reschedule(bookingId,{expectedStart:booking.start,start:'2030-12-01T10:00:00Z'},'public-client-move-key',token);await client.cancel(bookingId,'public-client-cancel-key',token);assert.equal(calls,2);
});
test('publication remains explicit workspace authority; invalid settings send nothing',async()=>{
  let sends=0;const client=new AvailKitClient({baseUrl:'http://localhost',workspaceId:'4'.repeat(32),credential:'synthetic-management-only',fetch:async(_url,init)=>{sends++;assert.equal(new Headers(init.headers).get('Authorization'),'Bearer synthetic-management-only');return json({pageId,title:'Test studio',enabled:true,needsRepublish:false});}});
  assert.throws(()=>client.replaceBookingPage({title:'',enabled:true}));assert.equal(sends,0);
  await client.replaceBookingPage({title:'Test studio',enabled:true});assert.equal(sends,1);
});
