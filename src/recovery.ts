import { AvailKitError } from './errors.ts';
import { JsonTransport, type Fetch } from './transport.ts';
import { humanSchemas } from './human-contract.ts';
import type { HumanRegistrationStart, HumanSessionIssued } from './human-contract.ts';
import { recoverySchemas } from './recovery-contract.ts';
import type { RecoveryProfileV2, RecoveryStartV2, RecoveryFinishV2 } from './recovery-contract.ts';
export type { RecoveryProfileV2, RecoveryStartV2, RecoveryFinishV2 } from './recovery-contract.ts';
const schemas={...humanSchemas,...recoverySchemas};
type Schema = Record<string, any>;
/** Finite validator for the maintained human contract's JSON-Schema subset. */
function matches(schema: Schema, value: unknown, depth=0): boolean {
  if(depth>32)return false;
  if(schema.$ref)return matches(schemas[schema.$ref.split('/').at(-1)] as Schema,value,depth+1);
  if('const'in schema&&value!==schema.const)return false;
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(schema.anyOf&&!schema.anyOf.some((s:Schema)=>matches(s,value,depth+1)))return false;
  if(schema.oneOf&&schema.oneOf.filter((s:Schema)=>matches(s,value,depth+1)).length!==1)return false;
  if(Array.isArray(schema.type))return schema.type.some((t:string)=>matches({...schema,type:t},value,depth+1));
  if(schema.type==='null')return value===null;
  if(schema.type==='object'){
    if(value===null||typeof value!=='object'||Array.isArray(value))return false;
    const v=value as Record<string,unknown>,props=schema.properties??{};
    if((schema.required??[]).some((k:string)=>!Object.hasOwn(v,k)))return false;
    for(const [k,x]of Object.entries(v)){if(Object.hasOwn(props,k)){if(!matches(props[k],x,depth+1))return false;}else if(schema.additionalProperties===false)return false;}
  }
  if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??65536))return false;
    if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)return false;
    if(schema.items&&!value.every(x=>matches(schema.items,x,depth+1)))return false;
  }
  if(schema.type==='string'){
    if(typeof value!=='string'||[...value].length<(schema.minLength??0)||[...value].length>(schema.maxLength??1048576))return false;
    if(schema.pattern&&!new RegExp(schema.pattern,'u').test(value))return false;
    if(schema.format==='date-time'&&!Number.isFinite(Date.parse(value)))return false;
  }
  if(schema.type==='boolean'&&typeof value!=='boolean')return false;
  if(schema.type==='integer'||schema.type==='number'){
    if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))return false;
  }
  return true;
}
export interface RecoveryClientOptions { baseUrl:string; fetch?:Fetch; timeoutMs?:number; maxResponseBytes?:number }
/** Same-origin current recovery protocol. Each mutation invokes fetch once; there is no retry/replay contract.
 * After an unknown finish retain the new authenticator, inspect HumanClient.session(), or sign in normally.
 * The caller must retain unresolved security state; a new call is never an automatic recovery action. */
export class RecoveryClient {
  #http:JsonTransport;
  constructor(options:RecoveryClientOptions) {
    let url:URL;try{url=new URL(options.baseUrl);}catch{throw new AvailKitError('input','invalid_base_url');}
    const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(!(url.protocol==='https:'||url.protocol==='http:'&&loopback)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||typeof location!=='undefined'&&url.origin!==location.origin)throw new AvailKitError('input','invalid_base_url');
    // Explicit fields keep accidental headers/bearer/cookie overrides out of the transport.
    this.#http=new JsonTransport({baseUrl:url.origin+'/v2/human/recovery/',fetch:options.fetch,timeoutMs:options.timeoutMs,maxResponseBytes:options.maxResponseBytes,credentials:'same-origin',requireNoStore:true,maxRequestBytes:65536});
  }
  private async call<T>(method:string,path:string,input:Schema|null,output:Schema,body?:unknown):Promise<T> {
    if(input&&!matches(input,body))throw new AvailKitError('input','invalid_input');
    return this.#http.request(method,path,200,(value):value is T=>matches(output,value),body);
  }
  // BEGIN GENERATED METHODS
  profile(): Promise<RecoveryProfileV2> { return this.call("GET", "profile", null, {"$ref": "#/components/schemas/RecoveryProfileV2"}, undefined); }
  start(body: RecoveryStartV2): Promise<HumanRegistrationStart> { return this.call("POST", "start", {"$ref": "#/components/schemas/RecoveryStartV2"}, {"$ref": "#/components/schemas/HumanRegistrationStart"}, body); }
  finish(body: RecoveryFinishV2): Promise<HumanSessionIssued> { return this.call("POST", "finish", {"$ref": "#/components/schemas/RecoveryFinishV2"}, {"$ref": "#/components/schemas/HumanSessionIssued"}, body); }
  // END GENERATED METHODS
}
