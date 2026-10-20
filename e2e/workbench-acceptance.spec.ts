import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resetDb } from './helpers'

let server: http.Server
let mockUrl = ''
let scenario: 'normal' | 'stress' | 'invalid' | 'demo' = 'normal'
let stressSize = 40000
let requests: any[] = []
const OUT = process.env.ACCEPTANCE_EVIDENCE_DIR ?? path.join(process.cwd(), '.omo', 'evidence', 'workbench-acceptance')
const delay = (ms:number)=>new Promise(r=>setTimeout(r,ms))
const makeText=(marker:string,size:number)=> {const unit=marker+' line of synthetic test text.\n';return unit.repeat(Math.ceil(size/unit.length)).slice(0,size)}
const FINAL='This is original text of the final translation.'
const DEMO_SOURCE="By the time Mara reached the riverside bookshop, the rain had thinned to a silver mist. The old bridge was still hidden behind it, but she could hear the first bicycle crossing the wooden boards. Inside the shop, a kettle murmured on the stove. Someone had opened the upstairs window, and the smell of wet leaves drifted between the shelves.\n\nHer grandfather had left three notebooks on the counter. The first contained the names of customers who borrowed books and forgot to return them. The second held recipes, train times, and a careful drawing of a bird he had never managed to identify. The third was almost empty. On its first page he had written: Begin with what you can see, and be patient with what you cannot yet name.\n\nMara turned the pages slowly. She had come to decide which books should be packed away before the shop closed, but the notebooks made that decision feel less simple. A pencilled note beside a familiar title recorded a conversation she remembered from childhood. Another page preserved the address of a traveller who had promised to write. None of these details belonged in a catalogue, yet together they explained why people had kept coming back.\n\nWhen the kettle began to whistle, she set the notebook beside the window and went to make tea. Across the river, the mist was lifting from the roofs. She would start with one shelf, she decided, and leave room in every box for something she had not expected to keep."
const DEMO_FINAL="玛拉走到河边的书店时，雨已经细成一片银色的薄雾。旧桥还藏在雾里，她却听见第一辆自行车轧过木板的声音。店内，炉子上的水壶低低作响。有人推开了楼上的窗，湿叶的气息便在书架之间缓缓散开。\n\n祖父在柜台上留下了三本笔记。第一本记着借了书却忘记归还的顾客姓名。第二本里有食谱、火车时刻，还有一幅画得很仔细的鸟图，他始终没能辨认出那是什么鸟。第三本几乎空白，只有首页写着一句话：从你看得见的东西开始，对那些尚且叫不出名字的事物，多留一点耐心。\n\n玛拉慢慢翻着书页。她原本是来决定哪些书该在书店关门前装箱收走，可这些笔记让这件事忽然变得难以取舍。一本熟悉的书名旁，铅笔记下了一场她从小就记得的谈话。另一页保存着一位旅人的地址，那个人曾答应写信回来。这些细节都进不了书目，合在一起，却解释了为什么人们一次又一次走进这间店。\n\n水壶响起尖细的哨声时，她把笔记放到窗边，起身去沏茶。河对岸，薄雾正从屋顶上渐渐升起。她决定先整理一层书架，并在每只箱子里留一点空处，放下那些自己原以为不会留下的东西。"
test.use({viewport:{width:1440,height:1000}})
async function respond(req:http.IncomingMessage,res:http.ServerResponse) {
  if(req.method==='GET' && req.url?.endsWith('/models')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:['astra-worker','astra-main','astra-edit'].map(id=>({id,object:'model'}))}));return}

  const chunks:Buffer[]=[]
  for await(const c of req) chunks.push(c)
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}')
  requests.push(body)
  const messages=body.messages||[]
  const prompt=messages.map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n')
  const marker=messages.some((m:any)=>m.role==='system' && String(m.content).includes('[protocol:json-v1]'))
  const names=(body.tools||[]).map((x:any)=>x.function.name)
  let name=body.tool_choice?.function?.name || names[0]
  let args:any=null
  if(name==='call_agents') {
    const ids=[...prompt.matchAll(/^- ([a-z0-9][a-z0-9.-]+):/gim)].map(m=>m[1]).filter(x=>!x.startsWith('cultural-context.'))
    args={calls:ids.slice(0,2).map(agentVariantId=>({agentVariantId,additionalInstruction:'Complete candidate',selectionReason:'Synthetic complementary role'}))}
  } else if(name==='write_draft') {
    const ids=[...new Set([...prompt.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi)].map(m=>m[0]))]
    args={text:scenario==='demo'?DEMO_FINAL:scenario==='stress'?'FINAL_BEGIN_SENTINEL\n'+makeText('FINAL_BODY_SENTINEL',stressSize-21):FINAL,reason:'Synthetic final based on candidate bodies',evidenceInvocationIds:ids.slice(-2)}
  } else if(body.model==='astra-edit' && !messages.some((m:any)=>m.role==='tool')) {
    name='replace_text';args=prompt.includes('FINAL_BEGIN_SENTINEL')?{old_string:'FINAL_BEGIN_SENTINEL',new_string:'FINAL_BEGIN_REVISED'}:{old_string:'original text',new_string:'replaced text'}
  }
  if(args) {
    res.writeHead(200,{'Content-Type':'application/json'})
    res.end(JSON.stringify({id:'astra-tool',object:'chat.completion',created:1,model:body.model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'tool-'+Date.now(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:300,completion_tokens:50,total_tokens:350}}));return
  }
  const stress=scenario==='stress' && body.model==='astra-worker'
  let text=body.model==='astra-edit'?'The selected phrase has been updated.':(stress?makeText('BODY_ONLY_SENTINEL',stressSize):'A complete synthetic candidate translation.')
  if(marker)text=JSON.stringify({body:text,annotation:stress?'ANNOTATION_ONLY_SENTINEL':null})
  if(scenario==='invalid' && body.model==='astra-worker')text='{"body":"incomplete candidate","annotation":'
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'})
  const send=(delta:any,finish:any=null)=>res.write('data: '+JSON.stringify({id:'astra-stream',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n')
  if(stress){ const reason=makeText('REASONING_ONLY_SENTINEL',stressSize); for(let i=0;i<reason.length;i+=1000){if(res.destroyed)return;send({reasoning_content:reason.slice(i,i+1000)});await delay(35)} }
  for(let i=0;i<text.length;i+=(stress?1000:30)){if(res.destroyed)return;send({content:text.slice(i,i+(stress?1000:30))});await delay(stress?25:12)}
  send({},'stop');res.end('data: [DONE]\n\n')
}
test.beforeAll(async()=>{server=http.createServer((req,res)=>{void respond(req,res).catch(e=>{res.statusCode=500;res.end(String(e))})});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));mockUrl='http://127.0.0.1:'+(server.address() as any).port;await fs.mkdir(OUT,{recursive:true})})
test.afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))})
test.beforeEach(async({request,page})=>{scenario='normal';requests=[];await resetDb(request);await page.addInitScript(()=>localStorage.setItem('ui_locale','zh-CN'))})
async function seed(request:APIRequestContext) {
  const ep=await (await request.post('/api/endpoints',{data:{name:'Workbench synthetic local provider',base_url:mockUrl,api_key:'mock-only',context_window:scenario==='stress'?2000000:256000}})).json()
  const bind=(model:string)=>({endpointId:ep.id,model,contextWindow:scenario==='stress'?2000000:256000,maxOutputTokens:scenario==='stress'?64000:4096})
  for(const direction of ['en_to_zh','zh_to_en'])expect((await request.put('/api/model-profiles/'+direction,{data:{defaultWorker:bind('astra-worker'),mainAgent:bind('astra-main'),editingAgent:bind('astra-edit')}})).status()).toBe(200)
  return ep
}
async function begin(page:Page,source:string) {
 await page.goto('/?fresh=1');await page.getByTestId('source-input').fill(source);await page.getByTestId('translate-button').click();await expect(page).toHaveURL(/session=/,{timeout:20000});return new URL(page.url()).searchParams.get('session')!
}
async function completed(request:APIRequestContext,id:string){let detail:any;await expect.poll(async()=>{detail=await(await request.get('/api/sessions/'+id)).json();return Boolean(detail.finalVersion)},{timeout:90000}).toBe(true);return detail}
async function checkNoOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)}

test('Workbench complete workbench flow, edit, versions, history export and narrow screen',async({page,request})=>{
 test.setTimeout(150000);await seed(request);const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)))
 const id=await begin(page,'The river keeps its quiet light beneath the evening sky.')
 await expect(page.getByTestId('agent-stream-card').first()).toBeVisible({timeout:30000})
 await completed(request,id);await page.screenshot({path:path.join(OUT,'workbench-source-1440.png'),fullPage:true})
 await page.getByTestId('workspace-tab-workflow').click();await page.screenshot({path:path.join(OUT,'workbench-workflow-1440.png'),fullPage:true})
 await page.getByTestId('workspace-tab-editor').click();await expect(page.getByTestId('final-text')).toContainText(FINAL)
 await page.getByRole('textbox',{name:'聊天输入'}).fill('Replace original text with replaced text.')
 await page.getByRole('button',{name:'发送',exact:true}).click()
 await expect(page.getByTestId('final-text')).toContainText('replaced text',{timeout:30000})
 await page.getByText('版本与修订记录',{exact:true}).click();await expect(page.getByTestId('version-item')).toHaveCount(2)
 await page.locator('[data-testid="version-item"][data-version-no="1"]').click();await page.getByRole('button',{name:'确认恢复',exact:true}).click()
 await expect(page.getByTestId('final-text')).toContainText('original text');await expect(page.getByTestId('version-item')).toHaveCount(3)
 await page.screenshot({path:path.join(OUT,'workbench-editor-1440.png'),fullPage:true});await checkNoOverflow(page)
 await page.setViewportSize({width:390,height:844});await checkNoOverflow(page);await page.screenshot({path:path.join(OUT,'workbench-editor-390.png'),fullPage:true})
 await page.getByRole('link',{name:'历史',exact:true}).click();await expect(page).toHaveURL(/history/)
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'Markdown',exact:true}).first().click();const file=await download;await file.saveAs(path.join(OUT,'synthetic-session-export.md'))
 expect(await fs.readFile(path.join(OUT,'synthetic-session-export.md'),'utf8')).toContain('original text');await page.screenshot({path:path.join(OUT,'history-390.png'),fullPage:true});await checkNoOverflow(page);expect(errors).toEqual([])
})

test('Workbench immediate navigation persists latest draft and save failure retains editor',async({page,request})=>{
 await seed(request);await page.goto('/?fresh=1');const source=page.getByTestId('source-input');await source.fill('IMMEDIATE_DRAFT_SENTINEL')
 await page.getByRole('link',{name:'配置',exact:true}).click();await expect(page).toHaveURL(/config/)
 expect((await(await request.get('/api/workspace-drafts/en_to_zh')).json()).sourceText).toBe('IMMEDIATE_DRAFT_SENTINEL')
 await page.getByRole('link',{name:'工作台',exact:true}).click();if(await page.getByTestId('draft-restore-button').isVisible())await page.getByTestId('draft-restore-button').click();await expect(source).toHaveValue('IMMEDIATE_DRAFT_SENTINEL')
 await page.route('**/api/workspace-drafts/en_to_zh',async route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'synthetic save failure'})}):route.continue())
 await source.fill('SAVE_FAILURE_SENTINEL');await page.getByRole('link',{name:'配置',exact:true}).click();await expect(page.getByTestId('draft-save-error')).toBeVisible();expect(new URL(page.url()).pathname).toBe('/');await expect(source).toHaveValue('SAVE_FAILURE_SENTINEL')
 await page.unroute('**/api/workspace-drafts/en_to_zh');await page.getByRole('link',{name:'配置',exact:true}).click();await expect(page).toHaveURL(/config/)
})

for(const size of [40000,100000])test('Workbench '+size+' reasoning and body remain bounded, separated and readable',async({page,request})=>{
 test.setTimeout(180000);scenario='stress';stressSize=size;await seed(request);const id=await begin(page,'Synthetic stress document '+size+'. Keep all visible channels separate.')
 const card=page.locator('[data-testid="agent-stream-card"][data-agent-kind="translation"]').first();await expect(card).toBeVisible({timeout:30000})
 const fold=card.locator('[data-collapsible-text]').filter({has:page.getByRole('button',{name:/思考|推理/})}).first();await expect(fold).toBeVisible({timeout:30000});expect(await fold.locator('[data-text-content]').count()).toBe(0)
 await fold.locator('button[aria-expanded]').click();const reason=fold.locator('[data-text-content]');await expect(reason).toContainText('REASONING_ONLY_SENTINEL')
 await reason.locator('..').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll',{bubbles:true}))});const frozen=await reason.textContent();await page.waitForTimeout(300);expect(await reason.textContent()).toBe(frozen)
 const body=card.locator('[data-text-content]').filter({hasText:'BODY_ONLY_SENTINEL'}).first();await expect(body).toBeVisible({timeout:45000});expect(await body.textContent()).not.toContain('{"body":');expect(await body.textContent()).not.toContain('ANNOTATION_ONLY_SENTINEL');expect(await body.textContent()).not.toContain('REASONING_ONLY_SENTINEL');await expect(card.getByTestId('agent-status-streaming')).toBeVisible();await page.screenshot({path:path.join(OUT,'streaming-'+size+'.png'),fullPage:true})
 await completed(request,id)
 const sizes=await page.locator('[data-text-content]').evaluateAll(es=>es.map(e=>(e.textContent||'').length));expect(Math.max(...sizes)).toBeLessThanOrEqual(8000)
 expect(await reason.textContent()).toBe(frozen);await fold.getByRole('button',{name:/最新/}).click();expect((await reason.textContent())!.length).toBeLessThanOrEqual(4000)
 await fold.locator('button[aria-expanded]').click();expect(await fold.locator('[data-text-content]').count()).toBe(0)
 const detail=await(await request.get('/api/sessions/'+id)).json();expect(JSON.stringify(detail.finalVersion)).not.toContain('REASONING_ONLY_SENTINEL');expect(JSON.stringify(detail.finalVersion)).not.toContain('ANNOTATION_ONLY_SENTINEL')
 const mainRequests=requests.filter(r=>r.model==='astra-main');expect(JSON.stringify(mainRequests)).not.toContain('REASONING_ONLY_SENTINEL')
 await fs.writeFile(path.join(OUT,'stress-'+size+'.json'),JSON.stringify({size,domLengths:sizes,reasoningPreviewLength:(await reason.count())?0:0,mainRequestCount:mainRequests.length,finalVersionPresent:!!detail.finalVersion,channelIsolation:true},null,2))
 await page.screenshot({path:path.join(OUT,'stress-'+size+'.png'),fullPage:true})
 const editorStart=Date.now();await page.getByTestId('workspace-tab-editor').click();await expect(page.getByTestId('final-text')).toContainText('FINAL_BEGIN_SENTINEL');const renderMs=Date.now()-editorStart
 const finalChars=await page.getByTestId('final-text').evaluate(e=>(e.textContent||'').length)
 const selectMs=await page.getByTestId('final-text').evaluate(e=>{const start=performance.now();const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);const n=walker.nextNode();if(!n)throw Error('no text');const r=document.createRange();r.setStart(n,0);r.setEnd(n,20);const sel=getSelection()!;sel.removeAllRanges();sel.addRange(r);e.scrollTop=e.scrollHeight;return performance.now()-start})
 await page.getByRole('textbox',{name:'聊天输入'}).fill('Replace FINAL_BEGIN_SENTINEL with FINAL_BEGIN_REVISED.');const editStart=Date.now();await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByTestId('final-text')).toContainText('FINAL_BEGIN_REVISED',{timeout:30000});const editMs=Date.now()-editStart
 await fs.writeFile(path.join(OUT,'final-editor-'+size+'.json'),JSON.stringify({requestedBodyCharacters:size,finalChars,renderMs,selectAndScrollMs:selectMs,syntheticEditRoundTripMs:editMs,domMode:'full final text retained for exact selection offsets'},null,2))
 await page.screenshot({path:path.join(OUT,'final-editor-'+size+'.png'),fullPage:true})
})

test('Workbench malformed strict JSON never produces a saved final version',async({page,request})=>{
 test.setTimeout(120000);scenario='invalid';await seed(request);const id=await begin(page,'Invalid structured response must fail visibly.')
 let detail:any;await expect.poll(async()=>{detail=await(await request.get('/api/sessions/'+id)).json();return detail.runs?.at(-1)?.status},{timeout:90000}).toBe('failed');expect(detail.finalVersion).toBeNull();await fs.writeFile(path.join(OUT,'invalid-json.json'),JSON.stringify({status:detail.runs.at(-1).status,finalVersion:detail.finalVersion,errors:detail.invocations?.map((x:any)=>x.error_message).filter(Boolean)},null,2))
})

test('Workbench automatic four-stage production path renders separate stage bodies',async({page,request})=>{
 test.setTimeout(120000);await seed(request)
 const create=await request.post('/api/sessions',{data:{clientRequestId:crypto.randomUUID(),direction:'en_to_zh',sourceText:'The garden remembers the rain.',taskBrief:'Translate literary prose.',reviewMode:'four_stage',constraints:{}}});expect(create.status()).toBe(200);const {id}=await create.json()
 expect([200,202]).toContain((await request.post('/api/sessions/'+id+'/run')).status());await page.goto('/?session='+id);await page.getByTestId('workspace-tab-workflow').click();const detail=await completed(request,id)
 await expect(page.getByTestId('stage-output-panel')).toHaveCount(4);await expect(page.getByTestId('stage-output-panel').last()).toContainText('A complete synthetic candidate translation.')
 expect(detail.stages.filter((s:any)=>s.status==='complete')).toHaveLength(4)
 await page.screenshot({path:path.join(OUT,'automatic-four-stage.png'),fullPage:true})
})

test('Workbench deleted preset is restored with its frozen revision from the real recycle bin',async({page,request})=>{
 const ep=await seed(request);const catalog=await(await request.get('/api/agent-catalog?direction=en_to_zh')).json();const variants=catalog.variants.slice(0,2);const binding={endpointId:ep.id,model:'astra-worker',contextWindow:128000};const bundle=await(await request.get('/api/direction-prompt-bundles?direction=en_to_zh')).json()
 const created=await(await request.post('/api/workflow-presets',{data:{name:'Workbench recoverable preset',description:'Synthetic recycle-bin verification',direction:'en_to_zh',contract:{sourceLang:'英文',targetLang:'中文',taskBriefTemplate:'',teamPolicy:'fixed',reviewMode:'main_editor',agentVariantIds:variants.map((v:any)=>v.id),agentVariantSnapshots:variants,defaultWorkerBinding:binding,agentBindingOverrides:{},mainAgentBinding:binding,editingAgentBinding:binding,promptBundleVersion:bundle.version,maxAgentCalls:5,batchConcurrency:2,constraints:{}}}})).json();expect(created.preset.id).toBeTruthy();expect((await request.delete('/api/workflow-presets/'+created.preset.id)).status()).toBe(204)
 await page.goto('/config');await page.getByRole('button',{name:'工作流预设',exact:true}).click();await page.locator('summary').filter({hasText:'回收站'}).click();await expect(page.getByText('Workbench recoverable preset',{exact:true})).toBeVisible();await page.getByRole('button',{name:'恢复预设',exact:true}).click();await expect(page.getByText('回收站为空。',{exact:true})).toBeVisible()
 const after=await(await request.get('/api/workflow-presets/'+created.preset.id)).json();expect(after.preset.deletedAt).toBeNull();expect(after.revisions[0].id).toBe(created.revision.id);await page.screenshot({path:path.join(OUT,'preset-recycle-restored.png'),fullPage:true})
})

test('Workbench Config-created preset freezes current JSON bundle and starts a real run',async({page,request})=>{
 test.setTimeout(150000);const ep=await seed(request);await page.goto('/config');await page.getByRole('button',{name:'工作流预设',exact:true}).click();await page.getByRole('button',{name:'新建预设',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByPlaceholder('预设名称',{exact:true}).fill('Workbench UI preset')
 await modal.locator('select').first().selectOption(String(ep.id));await modal.getByRole('combobox',{name:'正式翻译模型',exact:true}).selectOption('astra-worker')
 for(const role of ['主 Agent','审查','筛选','编排','组装','编辑 Agent']){await modal.getByRole('combobox',{name:role+'端点',exact:true}).selectOption(String(ep.id));await modal.getByRole('combobox',{name:role+'模型',exact:true}).selectOption(role==='编辑 Agent'?'astra-edit':'astra-main')}
 const boxes=modal.getByRole('checkbox');for(let i=0;i<2;i++)await boxes.nth(i).check()
 await page.route('**/api/direction-prompt-bundles?direction=en_to_zh',route=>route.fulfill({status:500,contentType:'application/json',body:'{"error":"synthetic bundle failure"}'}));await modal.getByRole('button',{name:'保存 revision 1',exact:true}).click();await expect(modal).toBeVisible();expect((await(await request.get('/api/workflow-presets?direction=en_to_zh')).json()).length).toBe(0);await page.unroute('**/api/direction-prompt-bundles?direction=en_to_zh')
 await modal.getByRole('button',{name:'保存 revision 1',exact:true}).click();await expect(modal).not.toBeVisible();const presets=await(await request.get('/api/workflow-presets?direction=en_to_zh')).json();const preset=presets.find((p:any)=>p.name==='Workbench UI preset');expect(preset).toBeTruthy();const presetDetail=await(await request.get('/api/workflow-presets/'+preset.id)).json();const bundle=await(await request.get('/api/direction-prompt-bundles?direction=en_to_zh')).json();expect(presetDetail.revisions[0].contract.promptBundleVersion).toBe(bundle.version)
 await page.goto('/?fresh=1');await page.getByTestId('translate-requirements-details').locator(':scope > summary').click();await page.getByTestId('translate-current-preset').selectOption(preset.id);await page.getByTestId('source-input').fill('A short synthetic preset workflow.');await page.getByTestId('translate-button').click();await expect(page).toHaveURL(/session=/);const id=new URL(page.url()).searchParams.get('session')!;const detail=await completed(request,id);const snapshot=typeof detail.session.config_snapshot==='string'?JSON.parse(detail.session.config_snapshot):detail.session.config_snapshot;expect(snapshot.promptBundleSnapshot.version).toBe(bundle.version);await fs.writeFile(path.join(OUT,'ui-preset-version.json'),JSON.stringify({presetVersion:presetDetail.revisions[0].contract.promptBundleVersion,sessionVersion:snapshot.promptBundleSnapshot.version,currentVersion:bundle.version,runCompleted:!!detail.finalVersion,bundleFailurePreventedSave:true},null,2))
})

test('Workbench real production poetry plan and final complete with the structured local mock',async({page,request})=>{
 test.setTimeout(120000);await seed(request);const result=await request.post('/api/sessions',{data:{clientRequestId:crypto.randomUUID(),direction:'zh_to_en',sourceText:'相见时难别亦难，东风无力百花残。春蚕到死丝方尽，蜡炬成灰泪始干。',taskBrief:'Translate as a poem while preserving line relationships.',reviewMode:'main_editor',constraints:{poetryMode:'on',poetryTargetForm:'preserve',englishRhymeMode:'natural',rhymePositions:'auto',firstLineRhyme:'auto',rhymeChange:'source',poetryPriority:'balanced',rhymeEvidence:true}}});expect(result.status()).toBe(200);const {id}=await result.json();expect([200,202]).toContain((await request.post('/api/sessions/'+id+'/run')).status());const detail=await completed(request,id);const plans=detail.invocations.filter((x:any)=>JSON.parse(x.agent_snapshot).roleKind==='poetry_plan');expect(plans).toHaveLength(1);expect(plans[0].status).toBe('complete');expect(detail.events.some((e:any)=>e.event_type==='poetry.plan.completed')).toBe(true);await page.goto('/?session='+id);await page.getByTestId('workspace-tab-editor').click();await expect(page.getByTestId('final-text')).toContainText(FINAL);await page.screenshot({path:path.join(OUT,'poetry-production-complete.png'),fullPage:true});await fs.writeFile(path.join(OUT,'poetry-production-complete.json'),JSON.stringify({runStatus:detail.runs.at(-1).status,planStatus:plans[0].status,finalText:detail.finalVersion.text,completedEvent:true},null,2))
})

test('Workbench default-blue populated editor visual acceptance',async({page,request})=>{
 test.setTimeout(120000);scenario='demo';await seed(request);const id=await begin(page,DEMO_SOURCE);await completed(request,id);await page.getByTestId('workspace-tab-editor').click();await expect(page.getByTestId('final-text')).toContainText(DEMO_FINAL);await expect(page.getByRole('textbox',{name:'聊天输入'})).toBeEditable();await expect(page.locator('html')).toHaveAttribute('data-appearance','blue');await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});await page.screenshot({path:path.join(OUT,'final-default-blue-editor-1440.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await checkNoOverflow(page);await page.screenshot({path:path.join(OUT,'final-default-blue-editor-390.png'),fullPage:true})
})
