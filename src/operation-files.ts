import * as fs from 'node:fs';
import {resolve,sep} from 'node:path';
import {inspect} from 'node:util';
import {Store,OperationRecord,OperationStoreError,MAX_BYTES,MAX_RECORDS,fail} from './operation-store.ts';
const C=fs.constants;
/** Internal pinned Linux directory; not a hostile same-UID filesystem sandbox. */
export class PrivateDirectory {
  fd=-1;
  constructor(path:string){
    let fd=-1;
    try{
      if(process.platform!=='linux'||typeof process.getuid!=='function'||typeof path!=='string')fail('invalid_storage');
      fd=fs.openSync('/',C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
      for(const part of resolve(path).split(sep).filter(Boolean)){
        const next=fs.openSync(`/proc/self/fd/${fd}/${part}`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);fs.closeSync(fd);fd=next;
      }
      const info=fs.fstatSync(fd);if(info.uid!==process.getuid()||(info.mode&0o777)!==0o700)fail('invalid_storage');
      this.fd=fd;fd=-1;
    }catch{fail('invalid_storage');}finally{if(fd>=0)fs.closeSync(fd);}
  }
  path(leaf:string):string{if(this.fd<0)fail('invalid_storage');return `/proc/self/fd/${this.fd}/${leaf}`;}
  close():void{if(this.fd>=0){fs.closeSync(this.fd);this.fd=-1;}}
  read(leaf:string,maximum=MAX_BYTES):Buffer|null {
    let fd=-1;
    try{
      try{fd=fs.openSync(this.path(leaf),C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
      const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==process.getuid!()||(info.mode&0o777)!==0o600||info.nlink!==1||info.size>maximum)fail('invalid_storage');
      const output=Buffer.alloc(Math.min(info.size+1,maximum+1));let offset=0;
      while(offset<output.length){const n=fs.readSync(fd,output,offset,output.length-offset,null);if(n===0)break;offset+=n;}
      if(offset>maximum||offset!==info.size)fail('invalid_storage');
      return output.subarray(0,offset);
    }finally{if(fd>=0)fs.closeSync(fd);}
  }
  write(leaf:string,data:string|Buffer):void {
    const fd=fs.openSync(this.path(leaf),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
    try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  sync():void{fs.fsyncSync(this.fd);}
}
/** Local128-record store. Lock recovery is explicit and never timer-based. */
export class FileOperationStore extends Store {
  #directory:PrivateDirectory;
  constructor(directory:string){super();this.#directory=new PrivateDirectory(directory);}
  close():void{this.#directory.close();}
  [inspect.custom]():string{return '<AvailKit FileOperationStore (private)>';}
  toJSON():string{return '<AvailKit FileOperationStore (private)>';}
  protected transaction(id:string,change:(old:string|null)=>string|null):string|null {
    const d=this.#directory;let locked=false,dirty=false;
    try{
      try{fs.mkdirSync(d.path('.lock'),{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')fail('busy');throw e;}
      locked=true;d.sync();
      const bytes=d.read(id+'.json'),old=bytes===null?null:new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(old!==null)new OperationRecord(old);
      const next=change(old);
      if(next!==old){
        if(old===null&&fs.readdirSync(d.path('.')).length-1>=MAX_RECORDS)fail('capacity');
        if(next===null)fail('invalid_record');
        dirty=true;d.write('.pending',next);fs.renameSync(d.path('.pending'),d.path(id+'.json'));d.sync();dirty=false;
      }
      return next;
    }catch(e){if(e instanceof OperationStoreError)throw e;return fail('storage_failed');}
    finally{if(locked&&!dirty){try{fs.rmdirSync(d.path('.lock'));d.sync();}catch{/* retained or failed release: next writer fails closed */}}}
  }
  /** All writers/starters/other repairers must remain stopped until this returns. */
  recoverLock(acknowledgeWorkersJoined:true):void {
    if(acknowledgeWorkersJoined!==true)fail('invalid_input');
    const d=this.#directory;
    try{
      try{fs.lstatSync(d.path('.pending'));fail('repair_required');}catch(e){if(e instanceof OperationStoreError)throw e;if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const info=fs.lstatSync(d.path('.lock'));if(!info.isDirectory()||info.uid!==process.getuid!()||(info.mode&0o777)!==0o700)fail('invalid_storage');
      fs.rmdirSync(d.path('.lock'));d.sync();
    }catch(e){if(e instanceof OperationStoreError)throw e;return fail('storage_failed');}
  }
}
