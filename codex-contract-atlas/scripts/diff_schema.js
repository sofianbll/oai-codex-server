#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),S=require('../src/schema.js');
const [before,after,pointer='#']=process.argv.slice(2);
if(!before||!after){console.error('Usage: node scripts/diff_schema.js before.json after.json [#pointer] > diff.json');process.exit(1);}
try{const a=JSON.parse(fs.readFileSync(before,'utf8')),b=JSON.parse(fs.readFileSync(after,'utf8'));let x,y;try{x=S.get(a,pointer);}catch(_){}try{y=S.get(b,pointer);}catch(_){}if(x===undefined&&y===undefined)throw new Error('Pointer absent in both documents.');console.log(JSON.stringify({pointer,before,after,note:'Structural diff; not a semantic compatibility verdict.',changes:S.diff(x,y)},null,2));}catch(e){console.error(e.message);process.exit(1);}
