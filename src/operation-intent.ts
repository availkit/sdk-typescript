import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import type {Booking, BookingInput, RescheduleInput} from './index.ts';
import type {NodeAvailKitClient} from './node.ts';
import {AvailKitError} from './errors.ts';

export type NodeOperationInput = {environment:'test'|'live'; idempotencyKey:string} & (
  {operation:'book'; body:BookingInput} | {operation:'cancel'; bookingId:string} |
  {operation:'rescheduleBooking'; bookingId:string; body:RescheduleInput});
interface Original {
  version:1; baseUrl:string; workspaceId:string; environment:'test'|'live';
  credentialFingerprint:string; operation:'book'|'cancel'|'rescheduleBooking';
  path:string; body:string; idempotencyKey:string; createdAt:string;
}
function invalid():never {throw new AvailKitError('input','invalid_intent');}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const metadataTime=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)&&time(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{32}$/.test(v);
const time=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);
function body(operation:Original['operation'], value:unknown):string {
  if(!object(value))invalid();
  if(operation==='cancel'){if(!exact(value,[]))invalid();return '{}';}
  if(operation==='book'){
    if(!exact(value,Object.hasOwn(value,'customerId')?['offeringId','start','customerId']:['offeringId','start'])||!id(value.offeringId)||!time(value.start)||Object.hasOwn(value,'customerId')&&!id(value.customerId))invalid();
    return JSON.stringify({offeringId:value.offeringId,start:value.start,...(Object.hasOwn(value,'customerId')?{customerId:value.customerId}:{})});
  }
  if(!exact(value,['expectedStart','start'])||!time(value.expectedStart)||!time(value.start))invalid();
  return JSON.stringify({expectedStart:value.expectedStart,start:value.start});
}
function validate(value:unknown):Original {
  if(!object(value)||!exact(value,['version','baseUrl','workspaceId','environment','credentialFingerprint','operation','path','body','idempotencyKey','createdAt']))invalid();
  const v=value as unknown as Original;
  let url:URL;try{url=new URL(v.baseUrl);}catch{invalid();}
  if(v.version!==1||typeof v.baseUrl!=='string'||v.baseUrl!==url.href.replace(/\/$/,'')||url.pathname!=='/'||url.search||url.hash||url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))||!id(v.workspaceId)||!['test','live'].includes(v.environment)||typeof v.credentialFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(v.credentialFingerprint)||!['book','cancel','rescheduleBooking'].includes(v.operation)||typeof v.body!=='string'||Buffer.byteLength(v.body)>16384||typeof v.idempotencyKey!=='string'||!/^[\x20-\x7e]{16,128}$/.test(v.idempotencyKey)||v.idempotencyKey.trim()!==v.idempotencyKey||!metadataTime(v.createdAt))invalid();
  const path=v.operation==='book'?'/bookings':v.operation==='cancel'?/^\/bookings\/[0-9a-f]{32}\/cancel$/.test(v.path):/^\/bookings\/[0-9a-f]{32}\/reschedule$/.test(v.path);
  if(v.operation==='book'?v.path!==path:!path)invalid();
  let parsed:unknown;try{parsed=JSON.parse(v.body);}catch{invalid();}
  // Existing methods serialize these closed shapes; require the exact bytes they send.
  if(body(v.operation,parsed)!==v.body)invalid();
  return {...v};
}
/** Immutable private Node workspace original. No key, raw response or diagnostic payload. */
export class NodeOperationIntent {
  #original:Original;
  private constructor(value:Original){this.#original=Object.freeze(validate(value));}
  static fromPrivate(data:string):NodeOperationIntent {
    if(typeof data!=='string'||Buffer.byteLength(data)>64512)invalid();
    let v:unknown;try{v=JSON.parse(data);}catch{invalid();}
    return new NodeOperationIntent(validate(v));
  }
  exportPrivate():string{return JSON.stringify(this.#original);}
  binding():string{return createHash('sha256').update(this.exportPrivate()).digest('hex');}
  assertWindow():void {
    const age=Date.now()-Date.parse(this.#original.createdAt);
    if(age<0||age>=86400000)throw new AvailKitError('input','intent_expired');
  }
  [inspect.custom]():string{return '<AvailKit NodeOperationIntent (private)>';}
  toJSON():string{return '<AvailKit NodeOperationIntent (private)>';}
}
/** Pure preparation. The environment label cannot establish the credential's actual environment. */
export function prepareNodeOperation(client:NodeAvailKitClient,input:NodeOperationInput):NodeOperationIntent {
  try{
  const scope=client.operationScope;
  const path=input.operation==='book'?'/bookings':`/bookings/${input.bookingId}/${input.operation==='cancel'?'cancel':'reschedule'}`;
  return NodeOperationIntent.fromPrivate(JSON.stringify({version:1,...scope,environment:input.environment,operation:input.operation,path,body:body(input.operation,input.operation==='cancel'?{}:input.body),idempotencyKey:input.idempotencyKey,createdAt:new Date().toISOString()}));
  }catch{invalid();}
}
/** One explicit SDK call, with exact original scope/body/key. Never consults a store or retries. */
export async function executeNodeOperation(client:NodeAvailKitClient,environment:'test'|'live',intent:NodeOperationIntent):Promise<Booking> {
  if(!(intent instanceof NodeOperationIntent))invalid();
  const v=validate(JSON.parse(intent.exportPrivate())),scope=client.operationScope;
  if(v.baseUrl!==scope.baseUrl||v.workspaceId!==scope.workspaceId||v.credentialFingerprint!==scope.credentialFingerprint||v.environment!==environment)throw new AvailKitError('input','intent_scope_mismatch');
  intent.assertWindow();
  const parsed=JSON.parse(v.body);
  if(v.operation==='book')return client.book(parsed,v.idempotencyKey);
  const bookingId=v.path.split('/')[2];
  if(v.operation==='cancel')return client.cancel(bookingId,v.idempotencyKey);
  return client.rescheduleBooking(bookingId,parsed,v.idempotencyKey);
}
