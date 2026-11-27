import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const fail = code => { throw new Error(code); };
export const sourceHash = source => createHash('sha256').update(source).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const equal = (a,b) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const validHash = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
export function filesOnly(payload) {
  if(!Array.isArray(payload?.files) || !payload.files.length) fail('invalid_project_content');
  const files=payload.files.map(({name,type,source})=>{
    if(typeof name!=='string'||!name||!['SERVER_JS','HTML','JSON'].includes(type)||typeof source!=='string') fail('invalid_project_file');
    return {name,type,source};
  });
  if(new Set(files.map(x=>x.name)).size!==files.length) fail('duplicate_project_file');
  return files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
}
export function checkTarget(project,target) {
  if(typeof target?.scriptId!=='string'||! /^[A-Za-z0-9_-]+$/.test(target.scriptId)||
    typeof target.title!=='string'||!/^ТЕСТ\b|^ТЕСТ[ —-]|^TEST[ —-]/u.test(target.title)) fail('invalid_test_target');
  if(project?.scriptId!==target.scriptId||project.title!==target.title||project.parentId) fail('wrong_or_bound_project');
}
export function prepare(files,bundle,manifest,request) {
  if(!['probe','apply'].includes(request?.mode) || typeof bundle!=='string'||!bundle.includes('function crmV2Preflight(')) fail('invalid_request_or_bundle');
  const main=files.find(f=>f.name==='CrmV2'&&f.type==='SERVER_JS');
  const json=files.find(f=>f.name==='appsscript'&&f.type==='JSON');
  if(!main||!json||!main.source.includes('function crmV2Preflight(')) fail('unexpected_installed_layout');
  if(!equal(JSON.parse(json.source),JSON.parse(manifest))) fail('manifest_drift_manual_review');
  const before=sourceHash(main.source),after=sourceHash(bundle);
  if(request.mode==='apply'&&(!validHash(request.expectedSourceSha256)||!validHash(request.expectedBundleSha256)||request.expectedBundleSha256!==after)) fail('invalid_apply_hashes');
  if(request.mode==='apply'&&before!==request.expectedSourceSha256&&before!==after) fail('source_drift');
  return {before,after,changed:before!==after,next:files.map(f=>f===main?{...f,source:bundle}:f)};
}
export async function execute({api,target,bundle,manifest,request}) {
  checkTarget(await api('GET',''),target);
  const original=filesOnly(await api('GET','/content'));
  const plan=prepare(original,bundle,manifest,request);
  if(request.mode==='probe'||!plan.changed) return {status:request.mode==='probe'?'PROBE':'ALREADY_CURRENT',before:plan.before,after:plan.after};
  checkTarget(await api('GET',''),target);
  if(!equal(original,filesOnly(await api('GET','/content')))) fail('concurrent_source_change');
  let uncertain=false;
  try { await api('PUT','/content',{files:plan.next}); } catch { uncertain=true; }
  const actual=filesOnly(await api('GET','/content'));
  if(!equal(actual,plan.next)) fail(uncertain?'uncertain_write_manual_review':'readback_mismatch');
  return {status:uncertain?'VERIFIED_AFTER_UNCERTAIN_RESPONSE':'APPLIED',before:plan.before,after:plan.after};
}
async function main() {
  const target=JSON.parse(process.env.CRM_GAS_TEST_TARGET||'null');
  const auth=JSON.parse(process.env.CRM_GAS_TEST_OAUTH||'null');
  if(!auth||!['client_id','client_secret','refresh_token'].every(k=>typeof auth[k]==='string'&&auth[k])) fail('missing_oauth');
  if(!target||typeof target.scriptId!=='string'||! /^[A-Za-z0-9_-]+$/.test(target.scriptId)) fail('missing_test_target');
  const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:auth.client_id,client_secret:auth.client_secret,refresh_token:auth.refresh_token,grant_type:'refresh_token'}),signal:AbortSignal.timeout(30000)});
  if(!tokenRes.ok) fail('oauth_refresh_failed');
  const token=(await tokenRes.json()).access_token;
  if(typeof token!=='string'||!token) fail('oauth_invalid_response');
  const api=async(method,suffix,body)=>{
    const res=await fetch('https://script.googleapis.com/v1/projects/'+encodeURIComponent(target.scriptId)+suffix,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if(!res.ok) fail('apps_script_http_'+res.status);
    return res.json();
  };
  const result=await execute({api,target,bundle:readFileSync('dist/crm-v2-test/CrmV2.gs','utf8'),manifest:readFileSync('dist/crm-v2-test/appsscript.json','utf8'),request:JSON.parse(readFileSync('.github/crm-test-deploy-request.json','utf8'))});
  // Only public application source hashes; no target IDs, helper content, response bodies or credentials.
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{console.error('TEST deployment blocked or failed; no automatic retry. Inspect using authorized private session.');process.exitCode=1;});
