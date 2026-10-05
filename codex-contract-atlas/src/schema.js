/* Standalone OpenAPI 3.1 / local JSON Schema exploration utilities.
   Does not validate instances. Conjunctions and union branches are never flattened. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasSchema=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const esc=s=>String(s).replace(/~/g,'~0').replace(/\//g,'~1');
function get(doc,pointer){if(pointer==='#'||pointer==='')return doc;if(!pointer.startsWith('#/'))throw new Error('Référence non locale : '+pointer);let cur=doc;for(const seg of decodeURIComponent(pointer.slice(1)).slice(1).split('/')){const key=seg.replace(/~1/g,'/').replace(/~0/g,'~');if(cur===null||typeof cur!=='object'||!Object.prototype.hasOwnProperty.call(cur,key))throw new Error('Pointeur introuvable : '+pointer);cur=cur[key];}return cur;}
function resolve(doc,pointer='#',options={}){const trace=[],unresolved=[],cycles=[];let nodes=0;const maxNodes=options.maxNodes||30000,maxDepth=options.maxDepth||50;function walk(v,p,stack,depth){if(++nodes>maxNodes)throw new Error('Budget de résolution dépassé ; choisissez un schéma plus précis.');if(depth>maxDepth){unresolved.push({pointer:p,reason:'depth_limit'});return clone(v);}if(!v||typeof v!=='object')return v;if(Array.isArray(v))return v.map((x,i)=>walk(x,p+'/'+i,stack,depth+1));
 if(typeof v.$ref==='string'){const ref=v.$ref;trace.push({from:p+'/$ref',to:ref});const siblings={...v};delete siblings.$ref;let result;
  if(!ref.startsWith('#')){unresolved.push({pointer:p,ref,reason:'external_reference'});return clone(v);}
  if(stack.includes(ref)){cycles.push({pointer:p,ref});return clone(v);}
  try{result=walk(get(doc,ref),ref,[...stack,ref],depth+1);}catch(e){if(String(e.message).startsWith('Budget'))throw e;unresolved.push({pointer:p,ref,reason:e.message});return clone(v);}
  // JSON Schema 2020-12: sibling assertions also apply. Keep them conjunctive.
  return Object.keys(siblings).length?{allOf:[result,walk(siblings,p,stack,depth+1)]}:result;
 }
 const out=Object.create(null);for(const [k,x]of Object.entries(v)){// Schema-bearing keys only: do not reinterpret $ref inside examples/default/const.
  const mapKeys=['properties','patternProperties','$defs','definitions','dependentSchemas'];
  const singleKeys=['items','contains','additionalProperties','unevaluatedProperties','unevaluatedItems','propertyNames','not','if','then','else'];
  const arrayKeys=['allOf','anyOf','oneOf','prefixItems'];
  if(mapKeys.includes(k)&&x&&typeof x==='object'){out[k]=Object.create(null);for(const[n,s]of Object.entries(x))out[k][n]=walk(s,p+'/'+k+'/'+esc(n),stack,depth+1);}
  else if(singleKeys.includes(k)||arrayKeys.includes(k))out[k]=walk(x,p+'/'+k,stack,depth+1);else out[k]=clone(x);
 }return out;
 }
 return{schema:walk(get(doc,pointer),pointer,[pointer],0),trace,unresolved,cycles,nodes,semantics:'allOf = conjunction; oneOf/anyOf preserved; not an instance validator'};
}
function typeOf(s){if(s===true)return'any';if(s===false)return'never';if(!s)return'?';if(s.type)return Array.isArray(s.type)?s.type.join(' | '):s.type;if(s.enum)return'enum';if(Object.prototype.hasOwnProperty.call(s,'const'))return'const';if(s.oneOf)return'oneOf';if(s.anyOf)return'anyOf';if(s.allOf)return'allOf';if(s.$ref)return'$ref';if(s.properties)return'object';return'?';}
function requirements(doc,s,seen=new Set()){const out=new Set(s&&s.required||[]);if(!s||typeof s!=='object')return out;if(s.$ref&&s.$ref.startsWith('#')&&!seen.has(s.$ref)){try{for(const r of requirements(doc,get(doc,s.$ref),new Set([...seen,s.$ref])))out.add(r);}catch(_){}}
 for(const b of s.allOf||[])for(const r of requirements(doc,b,seen))out.add(r);return out;}
function propertyInventory(doc,pointer,options={}){const rows=[],issues=[];let nodes=0;const maxNodes=options.maxNodes||20000,maxDepth=options.maxDepth||28;
 function walk(s,p,path,branches,chain,stack,depth,inherited){if(++nodes>maxNodes){if(!issues.some(x=>x.reason==='node_limit'))issues.push({pointer:p,reason:'node_limit'});return;}if(depth>maxDepth){issues.push({pointer:p,reason:'depth_limit'});return;}if(!s||typeof s!=='object'||Array.isArray(s))return;
 const req=new Set([...(inherited||[]),...requirements(doc,s)]);
 if(s.$ref){const r=s.$ref;if(!r.startsWith('#'))issues.push({pointer:p,ref:r,reason:'external_reference'});else if(stack.includes(r))issues.push({pointer:p,ref:r,reason:'cycle'});else{try{walk(get(doc,r),r,path,branches,[...chain,p+'/$ref',r],[...stack,r],depth+1,req);}catch(e){issues.push({pointer:p,ref:r,reason:e.message});}}}
 for(const[name,sub]of Object.entries(s.properties||{})){const np=p+'/properties/'+esc(name),field=path?path+'.'+name:name;rows.push({path:field,pointer:np,type:typeOf(sub),required:req.has(name),conditional:branches.some(b=>b.operator==='oneOf'||b.operator==='anyOf'||b.operator==='then'||b.operator==='else'),branches:clone(branches),originChain:[...chain,np],schema:clone(sub)});walk(sub,np,field,branches,[...chain,np],stack,depth+1,new Set());}
 if(s.items)walk(s.items,p+'/items',path+'[]',branches,[...chain,p+'/items'],stack,depth+1,new Set());
 for(const op of ['allOf','oneOf','anyOf'])for(const[i,b]of (s[op]||[]).entries())walk(b,p+'/'+op+'/'+i,path,[...branches,{operator:op,index:i}],[...chain,p+'/'+op+'/'+i],stack,depth+1,req);
 for(const op of ['then','else'])if(s[op])walk(s[op],p+'/'+op,path,[...branches,{operator:op}],[...chain,p+'/'+op],stack,depth+1,new Set());
 for(const[name,sub]of Object.entries(s.patternProperties||{}))walk(sub,p+'/patternProperties/'+esc(name),path+'{'+name+'}',branches,[...chain,p+'/patternProperties/'+esc(name)],stack,depth+1,new Set());
 if(s.additionalProperties&&typeof s.additionalProperties==='object')walk(s.additionalProperties,p+'/additionalProperties',path+'{*}',branches,[...chain,p+'/additionalProperties'],stack,depth+1,new Set());
 }
 walk(get(doc,pointer),pointer,'',[],[pointer],[pointer],0,new Set());return{rows,issues,nodes,complete:issues.length===0};
}
function derefObject(doc,obj,pointer){let seen=new Set();while(obj&&obj.$ref){if(seen.has(obj.$ref))throw new Error('Cycle de référence : '+obj.$ref);seen.add(obj.$ref);pointer=obj.$ref;obj=get(doc,pointer);}return{value:obj,pointer};}
function operations(doc,{excludeOutOfScope=true}={}){const out=[];for(const[path,item]of Object.entries(doc.paths||{})){if(excludeOutOfScope&&/^\/(files|uploads|videos)(?:\/|\?|$)/.test(path))continue;for(const[method,op]of Object.entries(item||{})){if(!['get','post','put','patch','delete','options','head','trace'].includes(method))continue;const p='#/paths/'+esc(path)+'/'+method;const schemas=[];const issues=[];
 function content(obj,ptr,kind,status){try{const d=derefObject(doc,obj,ptr);for(const[media,v]of Object.entries(d.value?.content||{}))if(v.schema!==undefined)schemas.push({kind,status,media,pointer:d.pointer+'/content/'+esc(media)+'/schema'});}catch(e){issues.push({pointer:ptr,reason:e.message});}}
 if(op.requestBody)content(op.requestBody,p+'/requestBody','request',null);
 for(const[status,r]of Object.entries(op.responses||{}))content(r,p+'/responses/'+esc(status),'response',status);
 const parameters=[];for(const[group,pp]of [[item.parameters,'#/paths/'+esc(path)+'/parameters'],[op.parameters,p+'/parameters']])for(const[i,par]of (group||[]).entries()){try{const d=derefObject(doc,par,pp+'/'+i);parameters.push({name:d.value.name,in:d.value.in,required:!!d.value.required,pointer:d.pointer,schemaPointer:d.value.schema?d.pointer+'/schema':null});}catch(e){issues.push({pointer:pp+'/'+i,reason:e.message});}}
 out.push({method:method.toUpperCase(),path,pointer:p,operationId:op.operationId||null,summary:op.summary||'',schemas,parameters,issues});}}
 return out;
}
function diff(before,after,path='#',result=[]){if(JSON.stringify(before)===JSON.stringify(after))return result;if(before===undefined){result.push({kind:'added',path,after});return result;}if(after===undefined){result.push({kind:'removed',path,before});return result;}if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){for(const k of new Set([...Object.keys(before),...Object.keys(after)]))diff(before[k],after[k],path+'/'+esc(k),result);}else result.push({kind:'changed',path,before,after});return result;}
return{get,resolve,typeOf,requirements,propertyInventory,operations,diff,escapePointer:esc};
});
