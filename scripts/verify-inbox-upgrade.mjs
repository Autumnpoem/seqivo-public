// Read-only source -> isolated online backup -> upgrade/replay -> exact rollback copy.
// Never point Store at the user's original DB. Report only counts and hashes.
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtemp,copyFile,rm,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../server/store.mjs';
import {createInbox} from '../server/inbox.mjs';

const sourcePath=process.argv[2],reportPath=process.argv[3];
if (!sourcePath) throw Error('Usage: node scripts/verify-inbox-upgrade.mjs /path/to/board.sqlite [report.json]');
const scratch=await mkdtemp(join(tmpdir(),'seqivo-upgrade-'));await chmod(scratch,0o700);
const source=new DatabaseSync(resolve(sourcePath),{readOnly:true});
const readImage=db=>Object.fromEntries(['projects','tasks','settings','receipts','metadata','events'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const checksum=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let store;
try {
  await backup(source,join(scratch,'before.sqlite'));source.close();
  const beforeDb=new DatabaseSync(join(scratch,'before.sqlite'),{readOnly:true});
  const before=readImage(beforeDb);beforeDb.close();
  const originalTasks=before.tasks.map(row=>JSON.parse(row.data));
  await copyFile(join(scratch,'before.sqlite'),join(scratch,'upgraded.sqlite'));
  store=new Store(join(scratch,'upgraded.sqlite'));
  const inbox=createInbox({store});inbox.sync({executions:{active:[],recent:[]},policies:[]});
  const after=store.tasks();assert.equal(after.length,originalTasks.length);
  const newTaskMap=new Map(after.map(task=>[task.id,task]));
  for(const oldTask of originalTasks){
    const upgraded=structuredClone(newTaskMap.get(oldTask.id));
    if(!Object.hasOwn(oldTask,'reviewHistory'))delete upgraded.reviewHistory;
    assert.deepEqual(upgraded,oldTask,'all original task fields including acceptance/version/evidence must stay unchanged');
    if(oldTask.review)assert.ok(newTaskMap.get(oldTask.id).reviewHistory.some(review=>JSON.stringify(review)===JSON.stringify(oldTask.review)));
  }
  const stable=checksum({tasks:store.tasks(),inbox:inbox.state()});
  const journalCount=store.journal.rows().length;
  inbox.sync({executions:{active:[],recent:[]},policies:[]});
  assert.equal(store.journal.rows().length,journalCount,'unchanged sync must not append journal');
  store.close();store=new Store(join(scratch,'upgraded.sqlite'));
  assert.equal(checksum({tasks:store.tasks(),inbox:createInbox({store}).state()}),stable,'restart must not duplicate migration or inbox');
  store.replay();
  assert.equal(checksum({tasks:store.tasks(),inbox:createInbox({store}).state()}),stable,'journal replay must preserve inbox/history');
  const itemCount=createInbox({store}).state().items.length;
  store.close();store=null;
  // Rollback uses the complete pre-upgrade database, not portable archive import.
  // Portable import intentionally clears executable bindings and stales acceptance.
  await copyFile(join(scratch,'before.sqlite'),join(scratch,'rolled-back.sqlite'));
  const rolledBack=new DatabaseSync(join(scratch,'rolled-back.sqlite'),{readOnly:true});
  const rollback=readImage(rolledBack);rolledBack.close();assert.deepEqual(rollback,before);
  const report={checkedAt:new Date().toISOString(),platform:process.platform,node:process.version,
    sourceReadOnly:true,isolatedCopy:true,tasks:originalTasks.length,projects:before.projects.length,
    accepted:originalTasks.filter(task=>task.acceptance==='passed').length,inboxItems:itemCount,
    originalTaskFieldsPreserved:true,currentReviewBackfilled:true,restartIdempotent:true,journalReplayPassed:true,
    exactBackupRollbackPassed:true,preUpgradeHash:checksum(before),rollbackHash:checksum(rollback)};
  if(reportPath)await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify(report));
} finally {try{source.close();}catch{}store?.close();await rm(scratch,{recursive:true,force:true});}
