const { chromium } = require('playwright');
const path = require('node:path');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage({viewport:{width:1320,height:860}});
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{window.pawettaAgent={status:async()=>({selected:true,name:'example-project',path:'C:\\project'}),selectProject:async()=>({selected:true,name:'example-project',path:'C:\\project'}),account:async()=>({authorized:true,name:'Пользователь Паветты',email:'user@example.com',balance:29.96,requests:18,spent:.04,chats:7,appVersion:'0.8.0',limits:{steps:10,requestSeconds:120,fileKb:300,filesPerRead:8}}),preferences:async()=>({autoLaunch:true,closeToTray:true,notifyOnComplete:true}),setPreferences:async next=>({autoLaunch:true,closeToTray:true,notifyOnComplete:true,...next}),checkUpdate:async()=>({current:'0.8.0',latest:'0.8.0',available:false}),activity:async()=>[{at:new Date().toISOString(),type:'file_written',path:'content/pages.py'},{at:new Date(Date.now()-60000).toISOString(),type:'agent_request_finished',tokens:'420',rub:'.02'}],login:async()=>({authorized:true}),logout:async()=>({authorized:false}),clearActivity:async()=>[],logActivity:async()=>true,openPawetta:async()=>{},onChatEvent:()=>()=>{},onNewTask:()=>()=>{},onPreferencesChanged:()=>()=>{},startChat:()=>{},abortChat:()=>{}}});
  await page.goto('file:///'+path.resolve(__dirname,'../renderer/index.html').replace(/\\/g,'/'));
  await page.waitForTimeout(300);
  const image=page.locator('.model-icon img');
  if(!await image.isVisible())throw new Error('Pawetta model avatar is not visible');
  const size=await image.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,naturalWidth:el.naturalWidth}));
  if(size.width<30||size.height<30||!size.naturalWidth)throw new Error('Pawetta avatar did not load');
  if(errors.length)throw new Error(errors.join('\n'));
  await page.screenshot({path:path.resolve(__dirname,'../qa-render-v3.png')});
  await page.locator('#accountButton').click();
  if(!await page.locator('#accountDialog').isVisible())throw new Error('Account dialog did not open');
  if((await page.locator('#dialogBalance').innerText()).trim()!=='29,96 ₽')throw new Error('Account balance is wrong');
  if(await page.locator('.activity-item').count()<2)throw new Error('Activity log is missing');
  await page.screenshot({path:path.resolve(__dirname,'../qa-account-v4.png')});
  console.log('desktop visual QA OK',size);
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
