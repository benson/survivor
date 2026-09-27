import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifySession } from '../worker-v2/index.js';

test('real JWT verification rejects wrong issuer, origin, expiration, pending and forged signatures',async()=>{
  const pair=await generateKeyPair('RS256');
  const jwk={...await exportJWK(pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const issuer=`http://127.0.0.1:${server.address().port}`;
  const env={CLERK_ISSUER:issuer,CLERK_AUTHORIZED_PARTIES:'https://survivordraft.bensonperry.com'};
  const sign=async(overrides={},key=pair.privateKey)=>new SignJWT({sub:'member',sid:'session',iss:issuer,azp:env.CLERK_AUTHORIZED_PARTIES,iat:Math.floor(Date.now()/1000),nbf:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+120,...overrides}).setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(key);
  const request=token=>new Request('https://api.example/me',{headers:{Authorization:'Bearer '+token}});
  try {
    assert.equal(await verifySession(request(await sign()),env),'member');
    for(const overrides of [{iss:'https://other.clerk.accounts.dev'},{azp:'https://evil.example'},{exp:0},{sts:'pending'},{sid:null}]) {
      await assert.rejects(verifySession(request(await sign(overrides)),env),{status:401});
    }
    const forged=await generateKeyPair('RS256');
    await assert.rejects(verifySession(request(await sign({},forged.privateKey)),env),{status:401});
    await assert.rejects(verifySession(new Request('https://api.example/me'),env),{status:401});
  } finally {await new Promise(resolve=>server.close(resolve));}
});
