import test from 'node:test';
import assert from 'node:assert/strict';
import {execute,sourceHash} from './scripts/deploy-crm-v2-test.mjs';
const target={scriptId:'test_id',title:'ТЕСТ — CRM v2'};
const old='function crmV2Preflight() {}';
const bundle='function crmV2Preflight() { return true; }';
const manifest='{"timeZone":"Europe/Moscow"}';
const req={mode:'apply',expectedSourceSha256:sourceHash(old),expectedBundleSha256:sourceHash(bundle)};
const fixture=()=>[{name:'CrmV2',type:'SERVER_JS',source:old},{name:'appsscript',type:'JSON',source:manifest},{name:'privateHelper',type:'SERVER_JS',source:'private content'}];
function env({files=fixture(),project=target,drift=false,lost=false}={}) {
 let calls=[],reads=0;
 const api=async(method,path,body)=>{
   calls.push([method,path]);
   if(path==='') return project;
   if(method==='GET') {reads++;if(drift&&reads===2)files[2].source='edited';return {files:structuredClone(files)};}
   files=structuredClone(body.files);if(lost)throw Error('lost response');return {files};
 };
 return {api,calls,files:()=>files,run:(request=req)=>execute({api,target,bundle,manifest,request})};
}
test('probe is read-only',async()=>{const e=env();assert.equal((await e.run({mode:'probe'})).status,'PROBE');assert.equal(e.calls.some(([m])=>m==='PUT'),false);});
test('apply preserves private helpers and manifest; replay is no-op',async()=>{const e=env();assert.equal((await e.run()).status,'APPLIED');assert.equal(e.files().find(f=>f.name==='privateHelper').source,'private content');assert.equal(e.files().find(f=>f.name==='appsscript').source,manifest);assert.equal((await e.run()).status,'ALREADY_CURRENT');assert.equal(e.calls.filter(([m])=>m==='PUT').length,1);});
test('wrong or bound target is rejected',async()=>{for(const project of [{...target,title:'production'},{...target,parentId:'bound'},{...target,scriptId:'wrong'}]){const e=env({project});await assert.rejects(e.run(),/wrong_or_bound_project/);assert.equal(e.calls.some(([m])=>m==='PUT'),false);}});
test('unexpected source or requested bundle is rejected',async()=>{const e=env();await assert.rejects(e.run({...req,expectedSourceSha256:'0'.repeat(64)}),/source_drift/);await assert.rejects(e.run({...req,expectedBundleSha256:'0'.repeat(64)}),/invalid_apply_hashes/);assert.equal(e.calls.some(([m])=>m==='PUT'),false);});
test('manifest drift and concurrent helper edit block write',async()=>{const files=fixture();files[1].source='{}';await assert.rejects(env({files}).run(),/manifest_drift/);const e=env({drift:true});await assert.rejects(e.run(),/concurrent_source_change/);assert.equal(e.calls.some(([m])=>m==='PUT'),false);});
test('lost response is verified without repeating PUT',async()=>{const e=env({lost:true});assert.equal((await e.run()).status,'VERIFIED_AFTER_UNCERTAIN_RESPONSE');assert.equal(e.calls.filter(([m])=>m==='PUT').length,1);});
