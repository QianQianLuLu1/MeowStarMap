// Local presentation only: reuse the authenticated channel, never export raw metadata or identifiers.
const WIDTH=1440, MAX_HEIGHT=4096, BODY_LIMIT=3690;
const CAMERA=['焦距','镜头旋转','光圈','景深','晕影','柔光强度','柔光范围','曝光','亮度','对比度','饱和度','鲜艳度','自然饱和','高光','阴影','柔光'];
const EFFECTS=['动作','光照','滤镜','地点'];
const PARAMETER_ORDER=['焦距','光圈','晕影','柔光','柔光范围','亮度','曝光','对比度','饱和度','自然饱和','高光','阴影'];
let sequence=0;
const clean=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim():'';
function buildPayload(input){
 const rows=Array.isArray(input.rows)?input.rows:[];
 const pick=labels=>rows.filter(row=>labels.indexOf(row.label)>=0&&clean(row.value)).map(row=>({label:row.label,value:clean(row.value)}));
 const version=rows.find(row=>row.label==='游戏版本');
 const name=value=>{const text=clean(value);return /^(名称待解析|未解析|未命名|未知名称|服装名称待解析)$/.test(text)||/^服装[\s#：:_-]*\d{6,}$/.test(text)||/^\d+$/.test(text)?'':text;};
 return {date:clean(input.date),version:clean(version?.value),outfit:(input.outfits||[]).map(item=>({label:'',value:name(item.name),iconPath:clean(item.iconPath),iconSource:item.iconSource==='category'?'category':'item'})),camera:pick(CAMERA),effects:pick(EFFECTS)};
}
function wrap(ctx,text,width){
 const lines=[];let line='';
 for(const char of Array.from(text)){if(line&&ctx.measureText(line+char).width>width){lines.push(line);line=char;}else line+=char;}
 if(line)lines.push(line);return lines.length?lines:[''];
}
function layoutCards(ctx,payload){
 ctx.font='23px sans-serif';
 const outfit=payload.outfit.map(item=>Object.assign({},item,{lines:item.value?wrap(ctx,item.value,174):[]}));
 const aliases={'柔光强度':'柔光','鲜艳度':'自然饱和'};
 const camera=payload.camera.map(row=>({label:aliases[row.label]||row.label,value:row.value}));
 const parameters=PARAMETER_ORDER.map(label=>parameterPresentation(label,camera.find(row=>row.label===label)?.value));
 for(const row of camera)if(PARAMETER_ORDER.indexOf(row.label)<0)parameters.push(parameterPresentation(row.label,row.value));
 ctx.font='28px sans-serif';
 for(const row of payload.effects)parameters.push({label:row.label,value:row.value,displayValue:row.value,effect:true,lines:wrap(ctx,row.value,540),height:Math.max(104,28+wrap(ctx,row.value,540).length*34)});
 const parameterHeight=parameters.reduce((n,row)=>n+row.height,0)+60,pages=[];let items=[],bodyHeight=0;
 const finish=()=>{pages.push({outfit:items,parameters,height:Math.max(1740,Math.ceil(400+Math.max(bodyHeight,parameterHeight)))});items=[];bodyHeight=0;};
 for(let index=0;index<outfit.length;index+=2){
  const pair=outfit.slice(index,index+2),rowHeight=Math.max(...pair.map(item=>198+item.lines.length*29+(item.iconSource==='category'?25:0)));
  if(bodyHeight+rowHeight>BODY_LIMIT&&items.length)finish();
  const row=items.length/2;pair.forEach((item,column)=>items.push(Object.assign({},item,{column,row,y:bodyHeight})));
  bodyHeight+=rowHeight;
 }
 if(items.length||!pages.length)finish();
 if(pages.some(page=>page.height>MAX_HEIGHT))throw new Error('分享图内容过长');return pages;
}
function parameterPresentation(label,value){
 const raw=clean(value),number=raw!==''?Number(raw):NaN,percent=['亮度','对比度','柔光','晕影'].indexOf(label)>=0;
 let displayValue=raw||'—',ratio=null;
 if(Number.isFinite(number)){
  if(label==='焦距')displayValue=raw+'mm';else if(label==='光圈')displayValue='f/'+raw;else if(percent)displayValue=raw+'%';
  // Only presentation domains supported by the displayed units. Unverified lens/aperture
  // game slider limits stay unpositioned; never infer missing numeric values.
  if(percent&&number>=0&&number<=100)ratio=number/100;
  else if(['曝光','饱和度','自然饱和','高光','阴影'].indexOf(label)>=0&&number>=-1&&number<=1)ratio=(number+1)/2;
 }
 return {label,value:raw,displayValue,ratio,missing:!raw,height:86};
}
function rounded(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();ctx.fill();}
function render(ctx,image,page,payload,index,total,rotation,soft,icons){
 const height=page.height;ctx.fillStyle='#FFF8F0';ctx.fillRect(0,0,WIDTH,height);
 // Keep the photo visible through fine translucent panels, as in the game parameter overlay.
 const source=soft||image,w=source.width||1,h=source.height||1;
 ctx.save();ctx.translate(WIDTH/2,height/2);ctx.rotate(rotation*Math.PI/180);
 const swap=rotation===90||rotation===270,areaW=swap?height:WIDTH,areaH=swap?WIDTH:height,scale=Math.max(areaW/w,areaH/h);
 ctx.drawImage(source,-w*scale/2,-h*scale/2,w*scale,h*scale);ctx.restore();
 ctx.fillStyle='rgba(34,28,38,0.48)';ctx.fillRect(0,0,WIDTH,height);
 ctx.fillStyle='#FFF8F0';ctx.font='48px sans-serif';ctx.fillText('NikkiSync',60,98);
 ctx.font='25px sans-serif';ctx.fillStyle='rgba(255,248,240,.8)';ctx.fillText([payload.date||'无限暖暖摄影',payload.version].filter(Boolean).join(' · '),60,146);
 ctx.fillStyle='#F6BCC0';rounded(ctx,60,170,96,4,2);
 const panel=(x,w)=>{ctx.fillStyle='rgba(244,224,232,.16)';rounded(ctx,x,218,w,height-284,22);ctx.strokeStyle='rgba(255,248,240,.52)';ctx.lineWidth=2;ctx.stroke();};
 panel(60,440);panel(536,844);
 ctx.fillStyle='#FFF8F0';ctx.font='30px sans-serif';ctx.fillText('穿搭',90,272);ctx.fillText('拍摄参数',570,272);
 for(const item of page.outfit){
  const x=86+item.column*200,y=310+item.y,size=178;
  ctx.fillStyle='rgba(255,248,240,.12)';rounded(ctx,x,y,size,size,18);ctx.strokeStyle='rgba(255,248,240,.3)';ctx.lineWidth=1;ctx.stroke();
  const icon=icons.get(item.iconPath);
  if(icon){const scale=Math.min(162/icon.width,162/icon.height);ctx.drawImage(icon,x+(size-icon.width*scale)/2,y+(size-icon.height*scale)/2,icon.width*scale,icon.height*scale);}
  else{ctx.fillStyle='rgba(255,248,240,.58)';ctx.font='20px sans-serif';ctx.textAlign='center';ctx.fillText('图标暂缺',x+size/2,y+size/2+7);ctx.textAlign='left';}
  ctx.fillStyle='#FFF8F0';ctx.font='23px sans-serif';ctx.textAlign='center';
  item.lines.forEach((line,n)=>ctx.fillText(line,x+size/2,y+size+30+n*29));
  if(item.iconSource==='category'){ctx.font='18px sans-serif';ctx.fillStyle='rgba(255,248,240,.6)';ctx.fillText('分类示意',x+size/2,y+size+30+item.lines.length*29);}
  ctx.textAlign='left';
 }
 if(!page.outfit.length){ctx.fillStyle='rgba(255,248,240,.65)';ctx.font='24px sans-serif';ctx.fillText('暂无穿搭数据',90,360);}
 let y=348,firstEffect=true;
 for(const parameter of page.parameters){
  if(parameter.effect){
   if(firstEffect){ctx.strokeStyle='rgba(255,248,240,.5)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(570,y-22);ctx.lineTo(1346,y-22);ctx.stroke();firstEffect=false;y+=16;}
   ctx.fillStyle='rgba(255,248,240,.76)';ctx.font='27px sans-serif';ctx.fillText(parameter.label,574,y+24);
   ctx.fillStyle='rgba(246,188,192,.15)';rounded(ctx,728,y-8,64,64,14);ctx.strokeStyle='rgba(246,188,192,.55)';ctx.stroke();
   ctx.fillStyle='#F6BCC0';ctx.font='27px sans-serif';ctx.fillText(parameter.label.slice(0,1),747,y+32);
   ctx.fillStyle='#FFF8F0';ctx.font='28px sans-serif';parameter.lines.forEach((line,n)=>ctx.fillText(line,816,y+26+n*34));y+=parameter.height;continue;
  }
  ctx.fillStyle=parameter.missing?'rgba(255,248,240,.42)':'#FFF8F0';ctx.font='29px sans-serif';
  const label=parameter.label==='焦距'?'焦距调节':parameter.label==='光圈'?'光圈调节':parameter.label==='晕影'?'晕影调节':parameter.label==='柔光'?'柔光强度':parameter.label;
  ctx.fillText(label,570,y);
  ctx.fillStyle=parameter.missing?'rgba(255,248,240,.16)':'rgba(255,248,240,.50)';rounded(ctx,748,y-18,374,10,5);
  if(parameter.ratio!==null){const x=748+374*parameter.ratio;ctx.fillStyle='rgba(246,188,192,.2)';ctx.beginPath();ctx.arc(x,y-13,25,0,Math.PI*2);ctx.fill();ctx.fillStyle='#FFF8F0';ctx.beginPath();ctx.arc(x,y-13,18,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle=parameter.missing?'rgba(255,248,240,.42)':'#FFF8F0';ctx.font='29px sans-serif';ctx.fillText(parameter.displayValue,1150,y);y+=parameter.height;
  if(parameter.label==='光圈'){ctx.strokeStyle='rgba(255,248,240,.36)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(570,y-40);ctx.lineTo(1346,y-40);ctx.stroke();}
 }
 // Delicate corner stars replace large opaque boxes and keep the photograph unobstructed.
 for(const [x,y] of [[1364,208],[1390,height-78]]){ctx.strokeStyle='rgba(255,248,240,.65)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y-18);ctx.lineTo(x+6,y-5);ctx.lineTo(x+18,y);ctx.lineTo(x+6,y+5);ctx.lineTo(x,y+18);ctx.lineTo(x-6,y+5);ctx.lineTo(x-18,y);ctx.lineTo(x-6,y-5);ctx.closePath();ctx.stroke();}
 ctx.fillStyle='rgba(255,248,240,.7)';ctx.font='20px sans-serif';ctx.fillText('NikkiSync · 穿搭与摄影记录'+(total>1?' · '+(index+1)+' / '+total:''),60,height-26);
}
function loadImage(canvas,path){return new Promise((resolve,reject)=>{const image=canvas.createImage();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('照片无法绘制，请重试'));image.src=path;});}
function createShareCardJob(wxApi,options){
 let cancelled=false,disposed=false,rejectCancel;const paths=[],owned=new Set(),pinned=new Set(),waits=new Set(),fs=wxApi.getFileSystemManager();
 const remove=path=>{if(!path||pinned.has(path))return;owned.delete(path);try{fs.unlink({filePath:path,fail(){}});}catch(_){} };
 const check=()=>{if(cancelled||disposed)throw new Error('已取消生成');};
 const cancelledResult=new Promise((_,reject)=>rejectCancel=reject);
 const request=(method,args,optional)=>new Promise((resolve,reject)=>{
  let ended=false;const stop=()=>{ended=true;clearTimeout(timer);waits.delete(abort);};
  const abort=()=>{if(!ended){stop();reject(new Error('已取消生成'));}};
  const timer=setTimeout(()=>{stop();reject(new Error('电脑传输超时，请重新连接'));},150000);waits.add(abort);
  const callback=value=>{if(ended||cancelled||disposed){value?.image?.fill(0);abort();return;}stop();if(value?.status!=='ok'){value?.image?.fill(0);if(optional)resolve({status:'failed'});else reject(new Error('电脑资料读取失败，请重试'));}else resolve(value);};
  try{options.channel[method](options.id,...args,callback);}catch(_){stop();reject(new Error('连接已结束，请重新连接电脑'));}
 });
 const work=async()=>{
  check();options.progress?.('正在读取拍摄参数…');
  const metadata=await request('metadata',[]);check();
  if(typeof options.channel.outfit!=='function')throw new Error('请更新电脑端后生成完整穿搭分享图');
  const outfits=[];let offset=0,total;
  do{options.progress?.('正在读取完整穿搭…');const page=await request('outfit',[offset]);check();
   if(!Array.isArray(page.items)||page.offset!==offset||!Number.isInteger(page.total)||page.total<0||page.total>100||total!==undefined&&page.total!==total)throw new Error('穿搭信息不完整，请重试');
   total=page.total;outfits.push(...page.items);
   if(outfits.length>total||page.next!==null&&page.next!==outfits.length||page.next!==null&&page.next<=offset)throw new Error('穿搭信息不完整，请重试');
   offset=page.next;
  }while(offset!==null);
  if(outfits.length!==total)throw new Error('穿搭信息不完整，请重试');
  let missingIcons=0;
  for(const [index,item] of outfits.entries()){
   check();const cached=options.iconCache?.get(item.key);
   if(cached){item.iconPath=cached.path;item.iconSource=cached.source;continue;}
   if(!item.hasIcon||typeof options.channel.icon!=='function'){missingIcons++;continue;}
   options.progress?.('正在读取部件图标 '+(index+1)+' / '+outfits.length+'…');
   const value=await request('icon',[item.key],true);if(cancelled||disposed)value.image?.fill(0);check();
   if(value.status!=='ok'||value.icon!==true||value.mime!=='image/png'||!['item','category'].includes(value.source)||!(value.image instanceof Uint8Array)||value.image.length<8||value.image.length>262144){value.image?.fill(0);missingIcons++;continue;}
   const file=wxApi.env.USER_DATA_PATH+'/nikkisync-share-icon-'+Date.now()+'-'+(++sequence)+'.png';owned.add(file);
   const written=await new Promise(resolve=>{const bytes=value.image,buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const finish=ok=>{bytes.fill(0);new Uint8Array(buffer).fill(0);if(!ok||cancelled||disposed){remove(file);resolve(false);}else resolve(true);};
    try{fs.writeFile({filePath:file,data:buffer,success:()=>finish(true),fail:()=>finish(false)});}catch(_){finish(false);}
   });check();if(written){item.iconPath=file;item.iconSource=value.source;}else missingIcons++;
  }
  const payload=buildPayload({date:options.date,rows:metadata.rows,outfits});
  let path=options.originalPath;
  if(!path){options.progress?.('正在读取高清照片…');const value=await request('original',[]);if(cancelled||disposed)value.image?.fill(0);check();
   if(value.original!==true||!(value.image instanceof Uint8Array)||value.image.length<4||value.image.length>16777216||!['image/jpeg','image/png'].includes(value.mime)||! /^[a-f0-9]{64}$/.test(value.sha256||'')){value.image?.fill(0);throw new Error('高清照片校验失败');}
   path=wxApi.env.USER_DATA_PATH+'/nikkisync-share-source-'+Date.now()+'-'+(++sequence)+(value.mime==='image/png'?'.png':'.jpg');owned.add(path);
   await new Promise((resolve,reject)=>{const bytes=value.image,buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const finish=ok=>{bytes.fill(0);new Uint8Array(buffer).fill(0);if(!ok||cancelled||disposed){remove(path);reject(new Error(ok?'已取消生成':'照片临时写入失败'));}else resolve();};
    try{fs.writeFile({filePath:path,data:buffer,success:()=>finish(true),fail:()=>finish(false)});}catch(_){finish(false);}
   });
  }
  check();const canvas=options.canvas,ctx=canvas.getContext('2d'),image=await loadImage(canvas,path);check();
  let soft;
  if(typeof wxApi.createOffscreenCanvas==='function'){
   try{const scale=Math.min(360/image.width,900/image.height);soft=wxApi.createOffscreenCanvas({type:'2d',width:Math.max(1,Math.round(image.width*scale)),height:Math.max(1,Math.round(image.height*scale))});soft.getContext('2d').drawImage(image,0,0,soft.width,soft.height);}catch(_){soft=null;}
  }
  const pages=layoutCards(ctx,payload);
  for(let index=0;index<pages.length;index++){
   check();options.progress?.('正在生成分享图 '+(index+1)+' / '+pages.length+'…');
   const icons=new Map();
   for(const item of pages[index].outfit){if(!item.iconPath||icons.has(item.iconPath))continue;try{icons.set(item.iconPath,await loadImage(canvas,item.iconPath));}catch(_){missingIcons++;}check();}
   canvas.width=WIDTH;canvas.height=pages[index].height;render(ctx,image,pages[index],payload,index,pages.length,options.rotation||0,soft,icons);icons.clear();
   const output=await new Promise((resolve,reject)=>{try{wxApi.canvasToTempFilePath({canvas,x:0,y:0,width:WIDTH,height:canvas.height,destWidth:WIDTH,destHeight:canvas.height,fileType:'png',
    success:value=>{owned.add(value.tempFilePath);if(cancelled||disposed){remove(value.tempFilePath);reject(new Error('已取消生成'));}else resolve(value.tempFilePath);},fail:()=>reject(new Error('分享图导出失败，请重试'))});}catch(_){reject(new Error('当前微信无法生成分享图，请更新后重试'));}});
   paths.push(output);
  }
  // Release source/soft canvas memory immediately; only output pages live until preview closes.
  if(soft){soft.width=1;soft.height=1;}canvas.width=1;canvas.height=1;
  if(!options.originalPath)remove(path);
  for(const file of Array.from(owned))if(paths.indexOf(file)<0)remove(file);
  return {paths:paths.slice(),payload,missingIcons};
 };
 const pending=Promise.resolve().then(work);
 const result=Promise.race([pending,cancelledResult]).catch(error=>{disposed=true;for(const path of Array.from(owned))remove(path);if(options.canvas){options.canvas.width=1;options.canvas.height=1;}throw error;});
 return {result,cancel(){const transferring=waits.size>0;cancelled=true;rejectCancel(new Error('已取消生成'));this.dispose();if(transferring){try{if(options.channel.interrupt)options.channel.interrupt();else options.channel.close();}catch(_){}}return transferring;},dispose(){disposed=true;for(const abort of Array.from(waits))abort();for(const path of Array.from(owned))remove(path);},pin(path){pinned.add(path);},unpin(path){pinned.delete(path);if(disposed)remove(path);}};
}
function saveShareCard(wxApi,path){return new Promise((resolve,reject)=>{
 if(!path||typeof wxApi.saveImageToPhotosAlbum!=='function'||typeof wxApi.authorize!=='function'){reject(new Error('当前微信不支持相册保存'));return;}
 try{wxApi.authorize({scope:'scope.writePhotosAlbum',success:()=>{try{wxApi.saveImageToPhotosAlbum({filePath:path,success:resolve,fail:()=>reject(new Error('分享图保存失败，请检查相册权限后重试'))});}catch(_){reject(new Error('分享图保存失败'));}},fail:()=>reject(new Error('请允许相册权限后重试'))});}catch(_){reject(new Error('请检查相册权限后重试'));}
});}
module.exports={buildPayload,layoutCards,createShareCardJob,saveShareCard};
