/** Guest-facing transport. No workspace API key or account cookie is accepted. */
import {AvailKitError} from './errors.ts';
import {JsonTransport} from './transport.ts';
import {customerInput} from './index.ts';
import type {CustomerInput,Availability,AvailabilityQuery,Page,PageQuery,RescheduleInput,Fetch} from './index.ts';
export interface PublicPage {id:string;title:string;environment:'test'|'live';emailNotifications?:boolean}
export interface PublicOffering {id:string;name:string;durationMinutes:number;timeZone:string}
export interface PublicBookingInput {offeringId:string;start:string;contact:CustomerInput}
export interface PublicBooking {id:string;start:string;end:string;status:'confirmed'|'cancelled';offering:PublicOffering;page:PublicPage;pageEnabled:boolean}
export interface BookingPageSettings {pageId:string|null;title:string;enabled:boolean;needsRepublish:boolean}
export interface BookingPageInput {title:string;enabled:boolean}
export interface PublicClientOptions {baseUrl:string;pageId:string;fetch?:Fetch;timeoutMs?:number;maxResponseBytes?:number}
const fail=(code:string):never=>{throw new AvailKitError('input',code);};
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{32}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Boolean(v.trim())&&[...v].length<=max&&!/\p{Cc}/u.test(v);
const instant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);
const token=(v:string)=>{if(!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v))fail('invalid_guest_access');return v;};
const segment=(v:string)=>id(v)?v:fail('invalid_id');
export const isBookingPageSettings=(v:unknown):v is BookingPageSettings=>record(v)&&exact(v,['pageId','title','enabled','needsRepublish'])&&(v.pageId===null||id(v.pageId))&&text(v.title,160)&&typeof v.enabled==='boolean'&&typeof v.needsRepublish==='boolean';
const page=(v:unknown):v is PublicPage=>record(v)&&exact(v,['id','title','environment',...(Object.hasOwn(v,'emailNotifications')?['emailNotifications']:[])])&&(v.emailNotifications===undefined||typeof v.emailNotifications==='boolean')&&id(v.id)&&text(v.title,160)&&['test','live'].includes(v.environment as string);
const offering=(v:unknown):v is PublicOffering=>record(v)&&exact(v,['id','name','durationMinutes','timeZone'])&&id(v.id)&&text(v.name,160)&&Number.isSafeInteger(v.durationMinutes)&&Number(v.durationMinutes)>=1&&Number(v.durationMinutes)<=1440&&text(v.timeZone,100);
const booking=(v:unknown):v is PublicBooking=>record(v)&&exact(v,['id','start','end','status','offering','page','pageEnabled'])&&id(v.id)&&instant(v.start)&&instant(v.end)&&Date.parse(v.end)>Date.parse(v.start)&&['confirmed','cancelled'].includes(v.status as string)&&offering(v.offering)&&page(v.page)&&typeof v.pageEnabled==='boolean';
/** Generate before send; keep private with the exact request/key. */
export function newGuestToken():string{
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function publicBookingInput(body:PublicBookingInput):Readonly<PublicBookingInput>{
  if(!record(body)||!exact(body as unknown as Record<string,unknown>,['offeringId','start','contact'])||!id(body.offeringId)||!instant(body.start))fail('invalid_input');
  return Object.freeze({offeringId:body.offeringId,start:body.start,contact:customerInput(body.contact)});
}
export class PublicBookingClient {
  #http:JsonTransport;readonly pageId:string;
  constructor(options:PublicClientOptions){
    let base!:URL;try{base=new URL(options.baseUrl);}catch{fail('invalid_base_url');}
    if(base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/')fail('invalid_base_url');
    this.pageId=segment(options.pageId);
    this.#http=new JsonTransport({baseUrl:base.origin+'/v1/public/pages/'+this.pageId,fetch:options.fetch,credentials:'omit',requireNoStore:true,timeoutMs:options.timeoutMs??2000,maxResponseBytes:options.maxResponseBytes??262144,maxRequestBytes:65536});
  }
  getPage():Promise<PublicPage>{return this.#http.request('GET','',200,(v):v is PublicPage=>page(v)&&v.id===this.pageId);}
  listOfferings(query:PageQuery={}):Promise<Page<PublicOffering>>{
    if(Object.keys(query).some(k=>!['after','limit'].includes(k))||query.limit!==undefined&&(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>100))fail('invalid_query');
    const params=new URLSearchParams();if(query.after!==undefined)params.set('after',segment(query.after));if(query.limit!==undefined)params.set('limit',String(query.limit));
    return this.#http.request('GET','/offerings'+(params.size?'?'+params:''),200,(v):v is Page<PublicOffering>=>record(v)&&exact(v,['items','nextAfter'])&&Array.isArray(v.items)&&v.items.length<=(query.limit??25)&&v.items.every(offering)&&(v.nextAfter===null||id(v.nextAfter)&&v.items.length>0&&v.items.at(-1)?.id===v.nextAfter)&&v.items.every((item,i,a)=>i===0||item.id>a[i-1].id)&&v.items.every(item=>query.after===undefined||item.id>query.after));
  }
  availability(query:AvailabilityQuery):Promise<Availability>{
    if(!record(query)||!exact(query as unknown as Record<string,unknown>,['offeringId','from','to'])||!id(query.offeringId)||!instant(query.from)||!instant(query.to)||Date.parse(query.to)<=Date.parse(query.from)||Date.parse(query.to)-Date.parse(query.from)>7*86400000)fail('invalid_range');
    const params=new URLSearchParams({...query});
    return this.#http.request('GET','/availability?'+params,200,(v):v is Availability=>record(v)&&exact(v,['slots'])&&Array.isArray(v.slots)&&v.slots.length<=256&&v.slots.every((s,i,a)=>record(s)&&exact(s,['start','end','remainingCapacity'])&&instant(s.start)&&instant(s.end)&&Date.parse(s.end)>Date.parse(s.start)&&Date.parse(s.start)>=Date.parse(query.from)&&Date.parse(s.end)<=Date.parse(query.to)&&Number.isSafeInteger(s.remainingCapacity)&&Number(s.remainingCapacity)>0&&(i===0||Date.parse(s.start)>Date.parse(a[i-1].start))));
  }
  book(body:PublicBookingInput,key:string,access:{bookingToken:string;contactToken:string}):Promise<PublicBooking>{
    const frozen=publicBookingInput(body);
    return this.#http.request('POST','/bookings',201,(v):v is PublicBooking=>booking(v)&&v.page.id===this.pageId&&v.offering.id===frozen.offeringId&&Date.parse(v.start)===Date.parse(frozen.start),frozen,key,{'Authorization':'Booking '+token(access.bookingToken),'X-AvailKit-Contact-Token':token(access.contactToken)});
  }
  getBooking(bookingId:string,bookingToken:string):Promise<PublicBooking>{
    return this.#http.request('GET','/bookings/'+segment(bookingId),200,(v):v is PublicBooking=>booking(v)&&v.id===bookingId&&v.page.id===this.pageId,undefined,undefined,{Authorization:'Booking '+token(bookingToken)});
  }
  cancel(bookingId:string,key:string,bookingToken:string):Promise<PublicBooking>{
    return this.#http.request('POST','/bookings/'+segment(bookingId)+'/cancel',200,(v):v is PublicBooking=>booking(v)&&v.id===bookingId&&v.page.id===this.pageId&&v.status==='cancelled',{},key,{Authorization:'Booking '+token(bookingToken)});
  }
  reschedule(bookingId:string,body:RescheduleInput,key:string,bookingToken:string):Promise<PublicBooking>{
    if(!record(body)||!exact(body as unknown as Record<string,unknown>,['expectedStart','start'])||!instant(body.expectedStart)||!instant(body.start))fail('invalid_input');
    const frozen=Object.freeze({expectedStart:body.expectedStart,start:body.start});
    return this.#http.request('POST','/bookings/'+segment(bookingId)+'/reschedule',200,(v):v is PublicBooking=>booking(v)&&v.id===bookingId&&v.page.id===this.pageId&&Date.parse(v.start)===Date.parse(frozen.start),frozen,key,{Authorization:'Booking '+token(bookingToken)});
  }
}
