const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../easyread/web/js/pdf-reader/sync.js');
const assets={source:{page_count:4,page_boxes:Array(4).fill([0,0,600,800])},translation:{page_count:4,page_boxes:Array(4).fill([0,0,300,400])}};
test('scroll follows the other side with physical page index and proportional page position',async()=>{
 const calls=[];const sync=new PDFPageSync({assets:()=>assets,enabled:()=>true,navigate:async(side,state)=>calls.push({side,state})});
 await sync.request('source',{pageIndex:1,top:600,left:40});
 assert.deepEqual(calls,[{side:'translation',state:{pageIndex:1,top:300,left:20}}]);
 await sync.request('translation',{pageIndex:2,top:100,left:15});
 assert.deepEqual(calls[1],{side:'source',state:{pageIndex:2,top:200,left:30}});
});
test('fast scrolls keep the latest destination without moving the source pane',async()=>{
 let release;const gate=new Promise(r=>release=r),calls=[];
 const sync=new PDFPageSync({assets:()=>assets,enabled:()=>true,navigate:async(side,state)=>{calls.push({side,state});if(calls.length===1)await gate;}});
 const flight=sync.request('source',{pageIndex:0});sync.request('source',{pageIndex:1});sync.request('source',{pageIndex:3});release();await flight;
 assert.deepEqual(calls,[{side:'translation',state:{pageIndex:0}},{side:'translation',state:{pageIndex:3}}]);
});
test('disabled, source-only and unequal-page readers do not synchronize',async()=>{
 for(const [value,enabled] of [[assets,false],[{source:assets.source},true],[{...assets,translation:{...assets.translation,page_count:7}},true]]){
  let count=0;const sync=new PDFPageSync({assets:()=>value,enabled:()=>enabled,navigate:async()=>count++});
  await sync.request('source',{pageIndex:1,top:300});assert.equal(count,0);
 }
});
