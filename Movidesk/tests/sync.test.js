const test=require('node:test');const assert=require('node:assert/strict');const vm=require('vm');const fs=require('fs');
const {createRequire}=require('module');const path=require('path');
const file=path.resolve('server/routes/tickets.js');const realRequire=createRequire(file);
function load(overrides={}){
 const ctx={module:{exports:{}},exports:{},console:{log(){},warn(){},error(){}},process:{env:{}},Buffer,URL,Date,Set,Map,
 setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout(){},
 require:name=>Object.hasOwn(overrides,name)?overrides[name]:realRequire(name)};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(file,'utf8')+`\nmodule.exports.testing={fetchTicketsFromApi,collectCurrentOpenTicketIds,filterByCustomFieldCondition,markMissingTicketsAsClosed};`,ctx);
 return ctx.module.exports.testing;
}
const config={statuses:['New'],syncLimit:100,ownerTeam:'Team',customFieldId:'',customFieldValue:''};
test('network failure aborts collection instead of treating it as end of pagination',async()=>{
 let count=0;const lib=load({'node-fetch':async()=>{count++;throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'});}});
 await assert.rejects(lib.fetchTicketsFromApi('dummy-secret',0,0,config),/Coleta incompleta/);
 assert.equal(count,3);
});
test('reconciliation includes historical active tickets',async()=>{
 const urls=[];
 const lib=load({'node-fetch':async(url)=>{urls.push(url);return {ok:true,text:async()=>JSON.stringify([{id:urls.length,ownerTeam:'Team',baseStatus:'New'}])};}});
 const ids=await lib.collectCurrentOpenTicketIds('dummy',config);
 assert.deepEqual(Array.from(ids),[1,2]);assert(urls.some(u=>u.includes('/past?')));
});
test('custom-field lookup errors fail the request instead of shrinking KPIs',async()=>{
 const lib=load({'../utils/datalakeClient':{fetchTicketCamposDatalake:async()=>{throw new Error('unavailable');}}});
 await assert.rejects(lib.filterByCustomFieldCondition([{ticket_id:1}],{customFieldId:1,customFieldValue:'yes'}),/unavailable/);
});
