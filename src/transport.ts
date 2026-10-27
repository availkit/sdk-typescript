import { AvailKitError, safeErrorCodes } from './errors.ts';
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export interface TransportOptions {
  baseUrl: string; fetch?: Fetch; headers?: Record<string, string>;
  credentials?: RequestCredentials; timeoutMs?: number; maxResponseBytes?: number;
  maxRequestBytes?: number; requireNoStore?: boolean;
}
/** Exactly one fetch. The deadline includes reading and decoding the response. */
export class JsonTransport {
  #options: TransportOptions; #fetch: Fetch;
  constructor(options: TransportOptions) {
    this.#options = { ...options, headers: { ...options.headers } };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    for (const [n,max] of [[options.timeoutMs ?? 10000,120000],[options.maxResponseBytes ?? 1048576,8388608],[options.maxRequestBytes ?? 16384,65536]]) {
      if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new AvailKitError('input','invalid_limits');
    }
  }
  async request<T>(method: string, path: string, status: number, valid: (x: unknown) => x is T, body?: unknown, intentKey?: string, extra?: Record<string,string>): Promise<T> {
    const o=this.#options; let payload: string|undefined;
    try { payload=body===undefined?undefined:JSON.stringify(body); } catch { throw new AvailKitError('input','invalid_json'); }
    if (payload!==undefined && new TextEncoder().encode(payload).length>(o.maxRequestBytes??16384)) throw new AvailKitError('input','body_too_large');
    const headers:Record<string,string>={Accept:'application/json',...o.headers,...extra};
    if(payload!==undefined)headers['Content-Type']='application/json';
    if(intentKey!==undefined){if(!/^[\x20-\x7e]{16,128}$/.test(intentKey)||intentKey.trim()!==intentKey)throw new AvailKitError('input','invalid_idempotency_key');headers['Idempotency-Key']=intentKey;}
    const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let response:Response|undefined;
    const abort=()=>{controller.abort();if(reader)void reader.cancel().catch(()=>{});else if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{});};
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new AvailKitError('transport','timeout'));abort();},o.timeoutMs??10000);});
    const operation=async():Promise<T>=>{
      response=await this.#fetch(o.baseUrl+path,{method,headers,body:payload,signal:controller.signal,redirect:'error',credentials:o.credentials??'omit',cache:'no-store'});
      const r=response;
      if(controller.signal.aborted)throw new AvailKitError('transport','timeout');
      const media=(r.headers.get('content-type')??'').split(';',1)[0].trim().toLowerCase();
      if(r.redirected||!['application/json','application/problem+json'].includes(media)||r.ok&&media!=='application/json')throw new AvailKitError('protocol','invalid_response',r.status);
      if(r.ok&&(o.requireNoStore||path==='/usage'||path.startsWith('/maintenance/')||path.startsWith('/customers'))&&r.headers.get('cache-control')!=='no-store')throw new AvailKitError('protocol','invalid_response',r.status);
      reader=r.body?.getReader();if(!reader)throw new AvailKitError('protocol','invalid_response',r.status);
      const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>(o.maxResponseBytes??1048576))throw new AvailKitError('protocol','response_too_large',r.status);chunks.push(value);}}
      finally {const old=reader;reader=undefined;old.releaseLock();}
      const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
      let data:unknown;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));}catch{throw new AvailKitError('protocol','invalid_json',r.status);}
      if(!r.ok){
        if(data===null||typeof data!=='object'||Array.isArray(data))throw new AvailKitError('protocol','invalid_error',r.status);
        const v=data as Record<string,unknown>,e=v.error as Record<string,unknown>|undefined;
        const code=e&&typeof e.code==='string'&&typeof e.message==='string'?e.code:v.type==='urn:availkit:problem'&&v.status===r.status&&typeof v.code==='string'?v.code:undefined;
        if(!code)throw new AvailKitError('protocol','invalid_error',r.status);
        throw new AvailKitError('api',safeErrorCodes.has(code)?code:'api_error',r.status);
      }
      if(r.status!==status||!valid(data))throw new AvailKitError('protocol','invalid_response',r.status);
      return data;
    };
    try{return await Promise.race([operation(),timeout]);}
    catch(e){if(e instanceof AvailKitError)throw e;throw new AvailKitError('transport','request_failed');}
    finally{clearTimeout(timer);abort();}
  }
}
