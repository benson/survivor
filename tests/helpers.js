import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../worker-v2/index.js';

export function fixture({ watchedThrough = 1 } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../worker-v2/schema.sql',import.meta.url),'utf8'));
  sql.exec("INSERT INTO members(user_id,name,role) VALUES('owner','Owner','admin'),('alice','Alice','member'),('bob','Bob','member')");
  if (watchedThrough !== null) for (const user of ['owner','alice','bob']) sql.prepare('INSERT INTO viewer_preferences(user_id,watched_episode,updated_at) VALUES(?,?,?)').run(user,watchedThrough,new Date().toISOString());
  const db={prepare(query){let values=[];return {bind(...args){values=args;return this;},async first(){return sql.prepare(query).get(...values)||null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){const result=sql.prepare(query).run(...values);return {meta:{changes:Number(result.changes)}};}}},async batch(queries){sql.exec('BEGIN');try{const results=[];for(const q of queries)results.push(await q.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const worker=createWorker(async req=>{const id=req.headers.get('Authorization')?.replace('Bearer ','');if(!id)throw Object.assign(new Error('Sign in'),{status:401});return id;});
  const env={DB:db,CLERK_AUTHORIZED_PARTIES:'https://survivordraft.bensonperry.com'};
  const request=async(path,{user='alice',method='GET',body,origin}={})=>{
    const res=await worker.fetch(new Request('https://api.example'+path,{method,headers:{...(user?{Authorization:'Bearer '+user}:{}),'Content-Type':'application/json',...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
    return {status:res.status,data:await res.json()};
  };
  return {request,sql,db,worker,env};
}
