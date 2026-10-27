import { AvailKitError } from './errors.ts';
import { JsonTransport, type Fetch } from './transport.ts';
import { humanSchemas } from './human-contract.ts';
import type { HumanEmpty, HumanEmail, HumanEmailProof, HumanRemoveCredential, HumanIssueKey, HumanFinish, HumanRevokeKey, HumanRevokedKey, HumanMemberList, HumanMemberGrant, HumanMemberNarrow, HumanMemberRemove, HumanMembership, HumanMembershipPage, HumanSubjectExportInput, HumanBrowserProfile, HumanCredentialList, HumanKeyMetadataList, HumanIssuedKey, HumanSessionIssued, HumanSessionState, HumanRegistrationStart, HumanAuthenticationStart, HumanEmailSelection, HumanPasskeyAdded, HumanPasskeyRemoved, HumanLoggedOut, HumanRecoveryCodes, HumanWorkspaceBootstrapped, HumanSubjectExport, HumanSubjectErased, HumanSpoolPruned } from './human-contract.ts';
export type * from './human-contract.ts';
type Schema = Record<string, any>;
/** Finite validator for the maintained human contract's JSON-Schema subset. */
function matches(schema: Schema, value: unknown, depth=0): boolean {
  if(depth>32)return false;
  if(schema.$ref)return matches(humanSchemas[schema.$ref.split('/').at(-1)] as Schema,value,depth+1);
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
export interface HumanClientOptions { baseUrl: string; fetch?: Fetch; timeoutMs?: number; maxResponseBytes?: number }
/** Browser same-origin cookies, no bearer authority; ceremonies are explicit. */
export class HumanClient {
  #http:JsonTransport; #csrf:string|undefined;
  constructor(options:HumanClientOptions){
    let url:URL;try{url=new URL(options.baseUrl);}catch{throw new AvailKitError('input','invalid_base_url');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||typeof location!=='undefined'&&url.origin!==location.origin)throw new AvailKitError('input','invalid_base_url');
    this.#http=new JsonTransport({...options,baseUrl:url.origin+'/v1/human/',credentials:'same-origin',requireNoStore:true,maxRequestBytes:65536});
  }
  private async call<T>(method:string,path:string,status:number,input:Schema|null,output:Schema,body?:unknown,idempotencyKey?:string):Promise<T>{
    if(input&&!matches(input,body))throw new AvailKitError('input','invalid_input');
    const value=await this.#http.request(method,path,status,(x):x is T=>matches(output,x),body,idempotencyKey,this.#csrf?{'X-CSRF-Token':this.#csrf}:undefined);
    if(value&&typeof value==='object'&&'csrf_token'in value&&typeof value.csrf_token==='string')this.#csrf=value.csrf_token;
    if(path==='logout'||path==='logout-all'||path==='privacy/erase')this.#csrf=undefined;
    return value;
  }
  // BEGIN GENERATED METHODS
  browser(): Promise<HumanBrowserProfile> { return this.call("GET", "browser", 200, null, {"$ref": "#/components/schemas/HumanBrowserProfile"}, undefined, undefined); }
  session(): Promise<HumanSessionState> { return this.call("GET", "session", 200, null, {"$ref": "#/components/schemas/HumanSessionState"}, undefined, undefined); }
  credentials(): Promise<HumanCredentialList> { return this.call("GET", "credentials", 200, null, {"$ref": "#/components/schemas/HumanCredentialList"}, undefined, undefined); }
  keys(): Promise<HumanKeyMetadataList> { return this.call("GET", "keys", 200, null, {"$ref": "#/components/schemas/HumanKeyMetadataList"}, undefined, undefined); }
  issueKey(body: HumanIssueKey, idempotencyKey: string): Promise<HumanIssuedKey> { return this.call("POST", "keys", 200, {"$ref": "#/components/schemas/HumanIssueKey"}, {"$ref": "#/components/schemas/HumanIssuedKey"}, body, idempotencyKey); }
  enrollStart(body: HumanEmail): Promise<HumanRegistrationStart> { return this.call("POST", "enroll/start", 200, {"$ref": "#/components/schemas/HumanEmail"}, {"$ref": "#/components/schemas/HumanRegistrationStart"}, body, undefined); }
  enrollFinish(body: HumanFinish): Promise<HumanSessionIssued> { return this.call("POST", "enroll/finish", 200, {"$ref": "#/components/schemas/HumanFinish"}, {"$ref": "#/components/schemas/HumanSessionIssued"}, body, undefined); }
  loginStart(body: HumanEmail): Promise<HumanEmailSelection> { return this.call("POST", "login/start", 200, {"$ref": "#/components/schemas/HumanEmail"}, {"$ref": "#/components/schemas/HumanEmailSelection"}, body, undefined); }
  loginProve(body: HumanEmailProof): Promise<HumanAuthenticationStart> { return this.call("POST", "login/prove", 200, {"$ref": "#/components/schemas/HumanEmailProof"}, {"$ref": "#/components/schemas/HumanAuthenticationStart"}, body, undefined); }
  loginFinish(body: HumanFinish): Promise<HumanSessionIssued> { return this.call("POST", "login/finish", 200, {"$ref": "#/components/schemas/HumanFinish"}, {"$ref": "#/components/schemas/HumanSessionIssued"}, body, undefined); }
  addStart(body: HumanEmpty): Promise<HumanRegistrationStart> { return this.call("POST", "add/start", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanRegistrationStart"}, body, undefined); }
  addFinish(body: HumanFinish): Promise<HumanPasskeyAdded> { return this.call("POST", "add/finish", 200, {"$ref": "#/components/schemas/HumanFinish"}, {"$ref": "#/components/schemas/HumanPasskeyAdded"}, body, undefined); }
  reauthStart(body: HumanEmpty): Promise<HumanAuthenticationStart> { return this.call("POST", "reauth/start", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanAuthenticationStart"}, body, undefined); }
  reauthFinish(body: HumanFinish): Promise<HumanSessionIssued> { return this.call("POST", "reauth/finish", 200, {"$ref": "#/components/schemas/HumanFinish"}, {"$ref": "#/components/schemas/HumanSessionIssued"}, body, undefined); }
  removeCredential(body: HumanRemoveCredential): Promise<HumanPasskeyRemoved> { return this.call("POST", "credentials/remove", 200, {"$ref": "#/components/schemas/HumanRemoveCredential"}, {"$ref": "#/components/schemas/HumanPasskeyRemoved"}, body, undefined); }
  replaceRecoveryCodes(body: HumanEmpty): Promise<HumanRecoveryCodes> { return this.call("POST", "recovery/codes", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanRecoveryCodes"}, body, undefined); }
  logout(body: HumanEmpty): Promise<HumanLoggedOut> { return this.call("POST", "logout", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanLoggedOut"}, body, undefined); }
  logoutAll(body: HumanEmpty): Promise<HumanLoggedOut> { return this.call("POST", "logout-all", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanLoggedOut"}, body, undefined); }
  bootstrap(body: HumanEmpty): Promise<HumanWorkspaceBootstrapped> { return this.call("POST", "bootstrap", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanWorkspaceBootstrapped"}, body, undefined); }
  revokeKey(body: HumanRevokeKey): Promise<HumanRevokedKey> { return this.call("POST", "keys/revoke", 200, {"$ref": "#/components/schemas/HumanRevokeKey"}, {"$ref": "#/components/schemas/HumanRevokedKey"}, body, undefined); }
  listMembers(body: HumanMemberList): Promise<HumanMembershipPage> { return this.call("POST", "members/list", 200, {"$ref": "#/components/schemas/HumanMemberList"}, {"$ref": "#/components/schemas/HumanMembershipPage"}, body, undefined); }
  grantMember(body: HumanMemberGrant, idempotencyKey: string): Promise<HumanMembership> { return this.call("POST", "members/grant", 201, {"$ref": "#/components/schemas/HumanMemberGrant"}, {"$ref": "#/components/schemas/HumanMembership"}, body, idempotencyKey); }
  narrowMember(body: HumanMemberNarrow, idempotencyKey: string): Promise<HumanMembership> { return this.call("POST", "members/narrow", 200, {"$ref": "#/components/schemas/HumanMemberNarrow"}, {"$ref": "#/components/schemas/HumanMembership"}, body, idempotencyKey); }
  removeMember(body: HumanMemberRemove, idempotencyKey: string): Promise<HumanMembership> { return this.call("POST", "members/remove", 200, {"$ref": "#/components/schemas/HumanMemberRemove"}, {"$ref": "#/components/schemas/HumanMembership"}, body, idempotencyKey); }
  exportSubject(body: HumanSubjectExportInput): Promise<HumanSubjectExport> { return this.call("POST", "privacy/export", 200, {"$ref": "#/components/schemas/HumanSubjectExportInput"}, {"$ref": "#/components/schemas/HumanSubjectExport"}, body, undefined); }
  eraseSubject(body: HumanEmpty): Promise<HumanSubjectErased> { return this.call("POST", "privacy/erase", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanSubjectErased"}, body, undefined); }
  pruneSpool(body: HumanEmpty): Promise<HumanSpoolPruned> { return this.call("POST", "privacy/spool-prune", 200, {"$ref": "#/components/schemas/HumanEmpty"}, {"$ref": "#/components/schemas/HumanSpoolPruned"}, body, undefined); }
  // END GENERATED METHODS
}

// V2 is additive; legacy browser availability and disabled v1 recovery stay unchanged.
export { RecoveryClient } from './recovery.ts';
export type { RecoveryClientOptions, RecoveryProfileV2, RecoveryStartV2, RecoveryFinishV2 } from './recovery.ts';
