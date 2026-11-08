import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLtx,configPath} from './game-configs.mjs';
const files=entries=>new Map(Object.entries(entries).map(([path,text])=>[path,{text}]));
test('ordered includes, multiple inheritance and last key win match CInifile',()=>{
 const {sections,loaded}=parseLtx(files({'system.ltx':'#include "Items\\base.ltx"\n[child]:one,two\nweight = 4.5\nweight=5\nname="quoted ; // text" ; comment',
 'items/base.ltx':'[one]\nweight=1\nslot=2\n[two]\nweight=3\n'}));
 assert.deepEqual({...sections.get('child').values},{weight:'5',slot:'2',name:'"quoted ; // text"'});
 assert.deepEqual(loaded,['items/base.ltx','system.ltx']);
});
test('include does not change parent current section; headers ignore annotation',()=>{
 const {sections}=parseLtx(files({'system.ltx':'[parent]\na=1\n#include "other.ltx"\nb=2\n[end] annotation\nc=3','other.ltx':'[other]\nx=7'}));
 assert.deepEqual({...sections.get('parent').values},{a:'1',b:'2'});
 assert.equal(sections.get('end').values.c,'3');
});
test('case-folded paths and lexical wildcard loading',()=>{
 const {sections}=parseLtx(files({'system.ltx':'#include "items/*.ltx"\n[last]:b','items/a.ltx':'[a]\nx=1','items/b.ltx':'[b]:a\nx=2'}));
 assert.equal(sections.get('last').values.x,'2');
 assert.equal(configPath('Items\\BASE.ltx'),'items/base.ltx');
});
test('invalid references, duplicate sections, cycles and traversal fail closed',()=>{
 for(const entries of [
  {'system.ltx':'#include "missing.ltx"'},
  {'system.ltx':'[a]:missing'},
  {'system.ltx':'[a]\n[a]'},
  {'system.ltx':'#include "system.ltx"'},
  {'system.ltx':'[a]:b\n[b]'},
  {'system.ltx':'[a]\nx="never closed'},
 ])assert.throws(()=>parseLtx(files(entries)));
 assert.throws(()=>configPath('../secret'));
});
test('whitespace outside strings is removed; quoted multiline text is retained',()=>{
 const {sections}=parseLtx(files({'system.ltx':'[a]\nv=1, 2, 3\ns="first line\nsecond line"\nbare_key'}));
 assert.equal(sections.get('a').values.v,'1,2,3');
 assert.equal(sections.get('a').values.s,'"first line\r\nsecond line"');
 assert.equal(sections.get('a').values.bare_key,'');
});
