// Trusted backend only. Linux local private storage; use an OWNED test offering.
// Install @availkit/booking0.4.0 first. Inspect/reconcile never mutates the API.
import {createNodeClient,prepareNodeOperation,executeNodeOperation,FileOperationStore,OperationStoreError} from '@availkit/booking/node';
import {AvailKitError} from '@availkit/booking';
import {randomUUID} from 'node:crypto';

async function run(action){
  const id=process.env.AVAILKIT_OPERATION_ID??'00000000000000000000000000000001'; // stable across restarts
  const directory=process.env.AVAILKIT_OPERATION_DIR;
  const backend=process.env.AVAILKIT_OPERATION_BACKEND??'file';
  if(!directory||!['file','sqlite'].includes(backend)||process.env.AVAILKIT_ENVIRONMENT!=='test')throw new OperationStoreError('invalid_input');
  const Factory=backend==='file'?FileOperationStore:(await import('@availkit/booking/node/sqlite')).SQLiteOperationStore;
  const store=new Factory(directory);
  try{
    let row=store.read(id);
    if(action==='inspect'){
      console.log(JSON.stringify(row??{state:'absent'}));return;
    }
    if(action==='acknowledge-interruption'){
      // This explicit action asserts ALL previous workers have stopped/joined.
      if(process.env.AVAILKIT_ACK_WORKERS_JOINED!=='yes'||!row)throw new OperationStoreError('invalid_input');
      row=store.releaseInterrupted(id,row.revision,true);console.log(JSON.stringify(row));return;
    }
    const client=await createNodeClient({baseUrl:process.env.AVAILKIT_BASE_URL??'https://api.availkit.com',workspaceId:process.env.AVAILKIT_WORKSPACE_ID,credentialFile:process.env.AVAILKIT_CREDENTIAL_FILE});
    if(action==='prepare'){
      if(row)throw new OperationStoreError('conflict');
      const original=prepareNodeOperation(client,{environment:'test',operation:'book',body:{offeringId:process.env.AVAILKIT_OFFERING_ID,start:process.env.AVAILKIT_START},idempotencyKey:randomUUID()});
      row=store.create(id,original);console.log(JSON.stringify(row));return;
    }
    if(!row)throw new OperationStoreError('not_found');
    if(action==='reconcile'){
      const input=JSON.parse(JSON.parse(row.original().exportPrivate()).body);
      // Bounded first page only. Matching rows are candidates, not proof/automatic settlement.
      const page=await client.listBookings({limit:100});
      const candidateCount=page.items.filter(b=>b.offeringId===input.offeringId&&Date.parse(b.start)===Date.parse(input.start)).length;
      console.log(JSON.stringify({candidateCount,partial:page.nextAfter!==null,outcome:'inspect_before_explicit_replay'}));return;
    }
    if(!['send','replay'].includes(action))throw new OperationStoreError('invalid_input');
    const original=row.original();
    // Admission is durable UNKNOWN before this function can send once.
    const attempt=store.begin(id,row.revision,original,{replay:action==='replay'});
    try{
      await executeNodeOperation(client,'test',original);
    }catch(error){
      const retained=store.settle(id,attempt.revision,attempt.attemptToken(),error instanceof AvailKitError&&error.outcome==='rejected'?'rejected':'unknown');
      // The latest attempt may reject while an earlier unknown attempt committed.
      console.error(JSON.stringify({code:error instanceof AvailKitError?error.code:'example_failed',attemptOutcome:error instanceof AvailKitError?error.outcome:'unknown',operationState:retained.state}));
      process.exitCode=1;return;
    }
    row=store.settle(id,attempt.revision,attempt.attemptToken(),'confirmed');
    console.log(JSON.stringify(row));
  }finally{store.close();}
}
try{await run(process.argv[2]);}
catch(error){console.error(JSON.stringify({code:error instanceof OperationStoreError?error.code:error instanceof AvailKitError?error.code:'example_failed',outcome:error instanceof AvailKitError?error.outcome:'inspect_retained_operation'}));process.exitCode=1;}
