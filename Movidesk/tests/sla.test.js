const test = require('node:test');
const assert = require('node:assert/strict');
const { minutosUteisEntre, calcularSLAPrimeiroContato, parseData } = require('../server/utils/sla');
const cases = [
 ['2026-09-14T17:00:00-03:00','2026-09-14T18:00:00-03:00',60],
 ['2026-09-14T07:00:00-03:00','2026-09-14T07:30:00-03:00',0],
 ['2026-09-14T11:30:00-03:00','2026-09-14T14:00:00-03:00',60],
 ['2026-09-11T17:30:00-03:00','2026-09-14T08:15:00-03:00',60],
 ['2026-09-14T07:45:00-03:00','2026-09-14T18:00:00-03:00',525],
 ['2018-12-03T17:00:00-02:00','2018-12-03T18:00:00-02:00',60]
];
for(const [start,end,expected] of cases) test(`expediente Brasília ${start} → ${end}`,()=>assert.equal(minutosUteisEntre(start,end),expected));
test('invalid dates are rejected without crashing',()=>{
 assert.equal(parseData('invalid'),null);
 assert.equal(calcularSLAPrimeiroContato({id:1,createdDate:'invalid'}).abertura,null);
});
test('a later pause does not erase time before it',()=>{
 const result=calcularSLAPrimeiroContato({id:1,urgency:'Alta',createdDate:'2026-09-14T08:00:00-03:00',
 actions:[{id:2,type:2,createdDate:'2026-09-14T10:00:00-03:00',createdBy:{id:'agent'}}],
 statusHistories:[{status:'Aguardando retorno do cliente',changedDate:'2026-09-14T09:00:00-03:00'}]});
 assert.equal(result.minutosUteisConsumidos,60);
});
test('standalone documentation uses the same business calendar',()=>{
 const standalone=require('../docs/sla-standalone');
 for(const [a,b,n] of cases) assert.equal(standalone.minutosUteisEntre(a,b),n);
});
