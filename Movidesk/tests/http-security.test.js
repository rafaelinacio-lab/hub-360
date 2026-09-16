const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const db=require('../server/db/remote');
const datalake=require('../server/utils/datalakeClient');
const bcrypt=require('bcrypt');
const speakeasy=require('speakeasy');
const sessions=new Map();const challenges=new Map();
const users={admin:{uid:1,id:1,user_id:1,email:'admin@example.invalid',name:'Admin',role:'admin',role_id:1,is_active:true},
 supervisor:{uid:2,id:2,user_id:2,email:'supervisor@example.invalid',role:'supervisor',vertical:'A',role_id:2,is_active:true},
 guest:{uid:3,id:3,user_id:3,email:'guest@example.invalid',role:'guest',role_id:3,is_active:true},
 inactive:{uid:4,id:4,user_id:4,email:'inactive@example.invalid',role:'admin',is_active:false}};
for(const [key,value] of Object.entries(users))sessions.set(key,value);
const secret=speakeasy.generateSecret().base32;
const calls=[];
const rows=(rows=[])=>({rows,rowCount:rows.length});
// In-memory adapter exercises real Express middleware and route handlers without production credentials.
db.query=async(sql,params=[])=>{
 calls.push(sql);
 if(sql.includes('FROM sessions s')){
  assert.match(sql,/u\.is_active = TRUE/);
  const u=sessions.get(params[0]);return rows(u?.is_active?[u]:[]);
 }
 if(sql.includes('FROM mfa_challenges s')){
  const c=challenges.get(params[0]);return rows(c&&c.attempts<5?[c]:[]);
 }
 if(sql.startsWith('UPDATE mfa_challenges')){
  const c=challenges.get(params[0]);if(!c||c.attempts>=5)return rows();c.attempts++;return rows([c]);
 }
 if(sql.startsWith('DELETE FROM mfa_challenges WHERE token')){
  const c=challenges.get(params[0]);challenges.delete(params[0]);return rows(c?[c]:[]);
 }
 if(sql.includes('INSERT INTO mfa_challenges')){
  challenges.set(params[1],{...users.admin,attempts:0,token:params[1]});return rows([{}]);
 }
 if(sql.includes('INSERT INTO sessions')){sessions.set(params[1],users.admin);return rows([{}]);}
 if(sql.includes('WHERE u.email = $1'))return rows([{...users.admin,password_hash:users.admin.password_hash}]);
 if(sql.includes('FROM mfa_settings'))return rows([{is_enabled:true,totp_secret:secret,backup_codes:'[]'}]);
 if(sql.includes('INSERT INTO mfa_settings'))return rows();
 if(sql.includes('SELECT r.name FROM users'))return rows([{name:Object.values(users).find(u=>u.id===params[0]).role}]);
 if(sql.includes("SELECT name FROM roles"))return rows([{name:'guest'},{name:'supervisor'}]);
 if(sql.includes('FROM access_logs'))return rows([{action:'test-audit'}]);
 if(sql.includes('FROM config'))return rows();
 if(sql.includes('SELECT u.id, u.email'))return rows([users.admin]);
 return rows([{}]);
};
db.get=(sql,p,cb)=>db.query(sql,p).then(r=>cb(null,r.rows[0])).catch(cb);
db.run=(sql,p,cb)=>db.query(sql,p).then(r=>cb.call({changes:r.rowCount},null)).catch(cb);
datalake.fetchNativeTicketDetail=async(id)=>({ticket_id:Number(id),subject:'fixture',servicefirstlevel:id==='1'?'A':'B',acoes:[],clientes:[],statusHistorico:[]});
let server,base;
before(async()=>{
 users.admin.password_hash=await bcrypt.hash('Test-password-123!',4);
 const app=express();app.use(express.json());
 app.use('/api/auth',require('../server/routes/auth'));
 app.use('/api/tickets',require('../server/routes/tickets'));
 app.use('/api/users',require('../server/routes/users'));
 app.use('/api/config',require('../server/routes/config').router);
 app.use('/api/ai',require('../server/routes/ai'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 base=`http://127.0.0.1:${server.address().port}`;
});
after(()=>new Promise(r=>server.close(r)));
async function request(path,token,body){return fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
test('all ticket endpoints reject anonymous/invalid sessions and spoofed viewerRole',async()=>{
 for(const [path,body] of [['/1'],['/1/sla'],['/stats/overview'],['?viewerRole=admin'],['/1/executive-summary',{}],['/sla',{id:1}]]){
  assert.equal((await request('/api/tickets'+path,undefined,body)).status,401);
 }
 assert.equal((await request('/api/tickets/1?viewerRole=admin','invalid')).status,401);
});
test('inactive users cannot use an existing session',async()=>assert.equal((await request('/api/auth/me','inactive')).status,401));
test('supervisor vertical applies to detail, SLA and executive summary',async()=>{
 assert.equal((await request('/api/tickets/1','supervisor')).status,200);
 for(const [path,body] of [['/2'],['/2/sla'],['/2/executive-summary',{}]])assert.equal((await request('/api/tickets'+path,'supervisor',body)).status,403);
});
test('guest dashboard access does not grant history or AI access',async()=>{
 assert.equal((await request('/api/tickets/1','guest')).status,200);
 assert.equal((await request('/api/tickets?scope=all','guest')).status,403);
 assert.equal((await request('/api/ai/chat','guest',{})).status,403);
 assert.equal((await request('/api/config/ai-status','guest')).status,403);
});
test('no endpoint returns the OpenAI credential',async()=>assert.equal((await request('/api/config/gpt-key-for-client','admin')).status,404));
test('audit route is reachable rather than parsed as a user ID',async()=>{
 const r=await request('/api/users/access-logs','admin');assert.equal(r.status,200);assert.equal((await r.json())[0].action,'test-audit');
});
test('MFA challenge cannot call authenticated APIs and is consumed after verification',async()=>{
 const login=await request('/api/auth/login',null,{email:'admin@example.invalid',password:'Test-password-123!'});
 const data=await login.json();assert.equal(data.requiresMFA,true);assert(data.tempToken);
 assert.equal((await request('/api/auth/me',data.tempToken)).status,401);
 const code=speakeasy.totp({secret,encoding:'base32'});
 const verified=await request('/api/auth/verify-mfa',null,{tempToken:data.tempToken,code});assert.equal(verified.status,200);
 const full=await verified.json();assert.equal((await request('/api/auth/me',full.token)).status,200);
 assert.equal((await request('/api/auth/verify-mfa',null,{tempToken:data.tempToken,code})).status,401);
});
test('MFA setup cannot replace an enabled secret',async()=>assert.equal((await request('/api/auth/setup-mfa','admin',{})).status,409));
