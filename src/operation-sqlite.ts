/** Explicit opt-in: Node24's built-in SQLite is experimental. Filesystem entry does not load it. */
import {DatabaseSync} from 'node:sqlite';
import {inspect} from 'node:util';
import {PrivateDirectory} from './operation-files.ts';
import {Store,OperationRecord,OperationStoreError,MAX_RECORDS,fail} from './operation-store.ts';
/** Single local SQLite DB in an owned0700 directory; bounded transactions, no sending. */
export class SQLiteOperationStore extends Store {
  #directory:PrivateDirectory;
  #db:DatabaseSync|undefined;
  constructor(directory:string){
    super();this.#directory=new PrivateDirectory(directory);
    try{
      const d=this.#directory;
      try{d.write('operations.sqlite',Buffer.alloc(0));d.sync();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      if(d.read('operations.sqlite',16777216)===null)fail('invalid_storage');
      for(const suffix of ['-journal','-wal','-shm'])d.read('operations.sqlite'+suffix,16777216);
      const db=new DatabaseSync(d.path('operations.sqlite'),{timeout:1000,allowExtension:false,enableDoubleQuotedStringLiterals:false});this.#db=db;
      const identity=db.prepare('PRAGMA application_id').get()!.application_id;
      if(![0,1096174385].includes(Number(identity))||identity===0&&db.prepare('SELECT count(*) AS n FROM sqlite_master').get()!.n!==0||db.prepare('PRAGMA page_size').get()!.page_size!==4096)fail('invalid_storage');
      db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=4096; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
      const app=db.prepare('PRAGMA application_id').get()!.application_id;
      if(app===0){
        if(db.prepare('SELECT count(*) AS n FROM sqlite_master').get()!.n!==0)fail('invalid_storage');
        db.exec('CREATE TABLE operations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536)); PRAGMA application_id=1096174385; PRAGMA user_version=1');
      }else if(app!==1096174385||db.prepare('PRAGMA user_version').get()!.user_version!==1)fail('invalid_storage');
      db.exec('COMMIT');d.read('operations.sqlite',16777216);d.sync();
    }catch{this.close();fail('invalid_storage');}
  }
  close():void{try{this.#db?.close();}finally{this.#db=undefined;this.#directory.close();}}
  [inspect.custom]():string{return '<AvailKit SQLiteOperationStore (private)>';}
  toJSON():string{return '<AvailKit SQLiteOperationStore (private)>';}
  protected transaction(id:string,change:(old:string|null)=>string|null):string|null {
    const db=this.#db;if(!db)fail('invalid_storage');
    try{
      db.exec('BEGIN IMMEDIATE');
      const row=db.prepare('SELECT revision,data FROM operations WHERE id=?').get(id);
      const old=row?row.data as string:null;
      if(old!==null&&new OperationRecord(old).revision!==row!.revision)fail('invalid_record');
      const next=change(old);
      if(next!==old){
        if(next===null)fail('invalid_record');
        const record=new OperationRecord(next);
        if(old===null){
          if(Number(db.prepare('SELECT count(*) AS n FROM operations').get()!.n)>=MAX_RECORDS)fail('capacity');
          db.prepare('INSERT INTO operations(id,revision,data) VALUES(?,?,?)').run(id,record.revision,next);
        }else if(db.prepare('UPDATE operations SET revision=?,data=? WHERE id=? AND revision=?').run(record.revision,next,id,row!.revision).changes!==1)fail('conflict');
      }
      db.exec('COMMIT');return next;
    }catch(e){
      try{if(db.isTransaction)db.exec('ROLLBACK');}catch{fail('storage_failed');}
      if(e instanceof OperationStoreError)throw e;
      const code=(e as {errcode?:number})?.errcode;
      fail(code===5||code===6?'busy':'storage_failed');
    }
  }
}
