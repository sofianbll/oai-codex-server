#!/usr/bin/env node
/* Structural inventory of a real local OpenAPI JSON document. Not a backend test. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),S=require('../src/schema.js');
const args=process.argv.slice(2);if(!args[0]||args.includes('--help')){console.log('Usage: node scripts/extract_schema.js OPENAPI.json [--out inventory.json] [--all-routes] [--max-rows 100000]');process.exit(args[0]?0:1);}
try{
const bytes=fs.readFileSync(args[0]),doc=JSON.parse(bytes.toString('utf8'));if(!doc.paths)throw new Error('OpenAPI paths missing.');
const outIndex=args.indexOf('--out'),outPath=outIndex>=0?args[outIndex+1]:'data/openapi-inventory.json';if(!outPath)throw new Error('--out requires a path.');
const limitIndex=args.indexOf('--max-rows'),maxRows=limitIndex>=0?Number(args[limitIndex+1]):100000;if(!Number.isFinite(maxRows)||maxRows<1)throw new Error('Invalid --max-rows.');
const all=S.operations(doc),ops=args.includes('--all-routes')?all:all.filter(o=>/^\/(responses|models|images|audio|realtime|live)(?:\/|\?|$)/.test(o.path));
let fieldCount=0;const issues=[],records=[];
for(const op of ops){const rec={...op,schemas:[]};for(const target of [...op.schemas,...op.parameters.filter(p=>p.schemaPointer).map(p=>({kind:'parameter',media:p.in,pointer:p.schemaPointer,name:p.name,required:p.required}))]){
 if(fieldCount>=maxRows){issues.push({operation:op.operationId,path:op.path,pointer:target.pointer,reason:'global_row_limit'});continue;}
 try{const inv=S.propertyInventory(doc,target.pointer,{maxNodes:20000});const remaining=maxRows-fieldCount;
 const rows=inv.rows.slice(0,remaining).map(r=>({path:r.path,pointer:r.pointer,type:r.type,required:r.required,conditional:r.conditional,branches:r.branches,originChain:r.originChain,constraints:Object.fromEntries(Object.entries(r.schema||{}).filter(([k])=>['type','enum','const','default','nullable','minimum','maximum','minLength','maxLength','minItems','maxItems','pattern','format','deprecated','readOnly','writeOnly','$ref'].includes(k)))}));
 if(inv.rows.length>remaining)issues.push({pointer:target.pointer,reason:'global_row_limit'});fieldCount+=rows.length;
 rec.schemas.push({...target,rootType:S.typeOf(S.get(doc,target.pointer)),properties:rows,issues:inv.issues,complete:inv.complete&&rows.length===inv.rows.length});
 }catch(e){issues.push({pointer:target.pointer,reason:e.message});}
 }records.push(rec);}
const result={meta:{createdAt:new Date().toISOString(),sourceFile:path.basename(args[0]),sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),openapi:doc.openapi,apiVersion:doc.info?.version,scope:args.includes('--all-routes')?'All except Files/Uploads/Video':'Responses,Models,Images,Audio,Realtime,Live',backendValidated:false,semanticMappingCompleted:false,operationCount:records.length,propertyDeclarations:fieldCount,complete:issues.length===0&&records.every(r=>r.schemas.every(s=>s.complete)),limitations:['Local JSON pointers only; cycles reported.','Property requiredness is branch-specific; this is not an instance validator.','Primitive/root-only schemas are identified by rootType; no fabricated property.','Schema anchors, dynamicRef, external refs, and $id resolution are not fully implemented.']},issues,operations:records};
fs.mkdirSync(path.dirname(outPath),{recursive:true});fs.writeFileSync(outPath,JSON.stringify(result,null,2));console.log(JSON.stringify(result.meta,null,2));
}catch(e){console.error('Extraction failed:',e.message);process.exit(1);}
