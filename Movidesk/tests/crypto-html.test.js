const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const vm=require('vm');
const fs=require('fs');
const {encryptToken,decryptToken,validateEncryptionKey}=require('../server/utils/crypto');
process.env.ENCRYPTION_KEY='test-only-key-01234567890123456789';
test('encrypted values authenticate ciphertext and decrypt legacy configuration',()=>{
 const encoded=encryptToken('dummy-api-key');
 assert.equal(decryptToken(encoded),'dummy-api-key');
 const parts=encoded.split(':');parts[2]='00'.repeat(16);
 assert.throws(()=>decryptToken(parts.join(':')));
 const iv=Buffer.alloc(16,1),cipher=crypto.createCipheriv('aes-256-cbc',Buffer.from(process.env.ENCRYPTION_KEY.slice(0,32)),iv);
 const old=iv.toString('hex')+':'+Buffer.concat([cipher.update('legacy'),cipher.final()]).toString('hex');
 assert.equal(decryptToken(old),'legacy');
});
test('missing/default key fails closed',()=>{
 const original=process.env.ENCRYPTION_KEY;
 for(const key of ['', 'sua-chave-secreta-aqui-min-32-caracteres!!!!!']){
  process.env.ENCRYPTION_KEY=key;assert.throws(validateEncryptionKey);
 }
 process.env.ENCRYPTION_KEY=original;
});
test('HTML and inline JS arguments round-trip hostile strings without executing them',()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync('js/html-safety.js','utf8'),ctx);
 const input=`O'Brien \\" &quot; <img src=x onerror=alert(1)>`;
 assert(!ctx.hubEscapeHtml(input).includes('<'));
 const decode=s=>s.replace(/&(quot|#39|lt|gt|amp);/g,(_,k)=>({quot:'"','#39':"'",lt:'<',gt:'>',amp:'&'}[k]));
 assert.equal(JSON.parse(decode(ctx.hubJsArg(input))),input);
});
