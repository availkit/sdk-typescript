import {randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {NodeOperationIntent} from './operation-intent.ts';
export type OperationState='prepared'|'unknown'|'confirmed'|'rejected';
export const MAX_RECORDS=128,MAX_BYTES=65536,MAX_REVISION=255,MAX_ATTEMPTS=64;
const codes=['invalid_input','invalid_storage','storage_failed','conflict','not_found','busy','capacity','invalid_record','claim_active','invalid_transition','intent_window','repair_required'] as const;
export class OperationStoreError extends Error {
  readonly code:typeof codes[number];
  constructor(code:typeof codes[number]){super(`AvailKit operation store error (${codes.includes(code)?code:'storage_failed'})`);this.name='OperationStoreError';this.code=codes.includes(code)?code:'storage_failed';}
}
export function fail(code:typeof codes[number]):never{throw new OperationStoreError(code);}
export function identifier(value:string):string{if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value))fail('invalid_input');return value;}
interface Row {version:1;intent:unknown;binding:string;revision:number;state:OperationState;claim:string|null;attempts:number;}
/** Safe default inspection; original/capability-bearing data requires explicit export. */
export class OperationRecord {
  #data:string;
  readonly revision:number;readonly state:OperationState;readonly attempts:number;readonly active:boolean;
  constructor(data:string){const row=decode(data);this.#data=data;this.revision=row.revision;this.state=row.state;this.attempts=row.attempts;this.active=row.claim!==null;Object.freeze(this);}
  original():NodeOperationIntent{return NodeOperationIntent.fromPrivate(JSON.stringify(JSON.parse(this.#data).intent));}
  attemptToken():string|null{return JSON.parse(this.#data).claim;}
  [inspect.custom]():string{return `<AvailKit OperationRecord state=${this.state} revision=${this.revision} active=${this.active}>`;}
  toJSON():unknown{return {state:this.state,revision:this.revision,attempts:this.attempts,active:this.active};}
}
function decode(data:string):Row {
  try{
    if(typeof data!=='string'||Buffer.byteLength(data)>MAX_BYTES)fail('invalid_record');
    const v=JSON.parse(data) as Row;
    if(v===null||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='attempts,binding,claim,intent,revision,state,version'||v.version!==1||!Number.isSafeInteger(v.revision)||v.revision<0||v.revision>MAX_REVISION||!Number.isSafeInteger(v.attempts)||v.attempts<0||v.attempts>MAX_ATTEMPTS||!['prepared','unknown','confirmed','rejected'].includes(v.state)||v.claim!==null&&(typeof v.claim!=='string'||!/^[0-9a-f]{64}$/.test(v.claim))||v.claim!==null&&v.state!=='unknown'||(v.state==='prepared')!==(v.attempts===0)||v.revision<v.attempts)fail('invalid_record');
    const original=NodeOperationIntent.fromPrivate(JSON.stringify(v.intent));
    if(original.binding()!==v.binding)fail('invalid_record');
    return v;
  }catch{fail('invalid_record');}
}
function encode(row:Row):string {const data=JSON.stringify(row);decode(data);return data;}
export interface OperationStore {
  create(id:string,original:NodeOperationIntent):OperationRecord;
  read(id:string):OperationRecord|null;
  begin(id:string,revision:number,original:NodeOperationIntent,options?:{replay?:boolean}):OperationRecord;
  settle(id:string,revision:number,token:string,state:'confirmed'|'rejected'|'unknown'):OperationRecord;
  releaseInterrupted(id:string,revision:number,acknowledgeWorkersJoined:true):OperationRecord;
  close():void;
}
export abstract class Store implements OperationStore {
  protected abstract transaction(id:string,change:(old:string|null)=>string|null):string|null;
  abstract close():void;
  create(id:string,original:NodeOperationIntent):OperationRecord {
    identifier(id);if(!(original instanceof NodeOperationIntent))fail('invalid_input');
    const binding=original.binding();
    const result=this.transaction(id,old=>{
      if(old!==null){if(decode(old).binding!==binding)fail('conflict');return old;}
      return encode({version:1,intent:JSON.parse(original.exportPrivate()),binding,revision:0,state:'prepared',claim:null,attempts:0});
    });
    return new OperationRecord(result!);
  }
  read(id:string):OperationRecord|null{const result=this.transaction(identifier(id),old=>old);return result===null?null:new OperationRecord(result);}
  #change(id:string,revision:number,change:(row:Row)=>void):OperationRecord {
    identifier(id);if(!Number.isSafeInteger(revision)||revision<0||revision>=MAX_REVISION)fail('invalid_input');
    const result=this.transaction(id,old=>{if(old===null)fail('not_found');const row=decode(old);if(row.revision!==revision)fail('conflict');change(row);row.revision++;return encode(row);});
    return new OperationRecord(result!);
  }
  /** Durably unknown before returning. Caller, and only caller, sends afterward. */
  begin(id:string,revision:number,original:NodeOperationIntent,options:{replay?:boolean}={}):OperationRecord {
    if(!(original instanceof NodeOperationIntent)||options.replay!==undefined&&typeof options.replay!=='boolean'||Object.keys(options).some(k=>k!=='replay'))fail('invalid_input');
    if(revision>=MAX_REVISION-1)fail('capacity');
    const binding=original.binding();
    return this.#change(id,revision,row=>{
      if(row.binding!==binding)fail('conflict');if(row.claim!==null)fail('claim_active');
      if(row.state!==(options.replay?'unknown':'prepared'))fail('invalid_transition');
      try{original.assertWindow();}catch{fail('intent_window');}
      if(row.attempts>=MAX_ATTEMPTS)fail('capacity');
      row.state='unknown';row.claim=randomBytes(32).toString('hex');row.attempts++;
    });
  }
  settle(id:string,revision:number,token:string,state:'confirmed'|'rejected'|'unknown'):OperationRecord {
    if(typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token)||!['confirmed','rejected','unknown'].includes(state))fail('invalid_input');
    return this.#change(id,revision,row=>{if(row.state!=='unknown'||row.claim!==token)fail('conflict');// A later attempt's rejection cannot disprove an earlier unknown commit.
      row.state=state==='rejected'&&row.attempts>1?'unknown':state;row.claim=null;});
  }
  /** Explicit owner assertion; no lease expiry or inference about worker/server state. */
  releaseInterrupted(id:string,revision:number,acknowledgeWorkersJoined:true):OperationRecord {
    if(acknowledgeWorkersJoined!==true)fail('invalid_input');
    return this.#change(id,revision,row=>{if(row.state!=='unknown'||row.claim===null)fail('invalid_transition');row.claim=null;});
  }
}
