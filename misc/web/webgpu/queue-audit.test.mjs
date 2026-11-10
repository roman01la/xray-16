import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QueueAudit} from './queue-audit.js';
test('queue observation bounds promise allocation and distinguishes scheduled completion',async()=>{
 let now=0, finish, fail, calls=0;
 const queue={onSubmittedWorkDone(){++calls;return new Promise((yes,no)=>{finish=yes;fail=no})}};
 const audit=new QueueAudit(()=>now);
 for(let i=0;i<100;++i)audit.submit(queue);
 assert.equal(calls,1);assert.equal(audit.stats.maxObservedBacklog,100);
 now=20;finish();await Promise.resolve();assert.equal(audit.stats.completed,1);
 audit.submit(queue);assert.equal(calls,2);now=30;finish();await Promise.resolve();
 assert.equal(audit.stats.completed,101);assert.equal(audit.stats.totalCompletionMs,30);
 audit.submit(queue);fail();await Promise.resolve();assert.equal(audit.stats.errors,1);assert.equal(audit.pending,false);
});
