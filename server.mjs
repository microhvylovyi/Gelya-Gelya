import express from "express";
import { chromium } from "playwright";
import sharp from "sharp";
import jsQR from "jsqr";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8080);

const jobs = new Map();
let browserPromise = null;

const SAT = {1:"Дуже незадоволений(-а)",2:"Незадоволений(-а)",3:"Ані задоволений(-а), ані незадоволений(-а)",4:"Задоволений(-а)",5:"Дуже задоволений(-а)"};
const VALUE = {1:"Зовсім не погоджуюсь",2:"Скоріше не погоджуюсь",3:"В чомусь погоджуюсь, в чомусь ні",4:"Скоріше погоджуюсь",5:"Повністю погоджуюсь"};
const REVISIT = {1:"Дуже малоймовірно",2:"Малоймовірно",3:"Ані ймовірно, ані малоймовірно",4:"Ймовірно",5:"Дуже ймовірно"};
const allowedReasons = new Set(["Швидкість обслуговування","Привітність персоналу","Якість їжі та/або напоїв","Чистота","Інше (будь ласка, уточніть)"]);

function normalizePreset(input={}) {
  const clamp=v=>Math.max(1,Math.min(5,Number(v)||5));
  return {
    satisfaction: clamp(input.satisfaction),
    orderCorrect: input.orderCorrect !== false,
    mainReason: allowedReasons.has(input.mainReason) ? input.mainReason : "Швидкість обслуговування",
    mainReasonOther: String(input.mainReasonOther||"").slice(0,500),
    valueForMoney: clamp(input.valueForMoney),
    revisit: clamp(input.revisit),
    visitComment: String(input.visitComment||"").slice(0,1200),
    employeeComment: String(input.employeeComment||"").slice(0,1200)
  };
}
function validSurveyUrl(raw){try{const u=new URL(raw);return u.protocol==="https:"&&u.hostname==="feedback.mcdonalds.com"&&u.pathname.startsWith("/jfe/form/SV_")}catch{return false}}
function publicJob(j){return {id:j.id,state:j.state,progress:j.progress,status:j.status,detail:j.detail,log:j.log.slice(-16),createdAt:j.createdAt,updatedAt:j.updatedAt}}
function update(j,progress,status,detail="",line=""){j.progress=Math.max(j.progress||0,Math.min(100,progress));j.status=status;j.detail=detail;j.updatedAt=Date.now();if(line&&j.log[j.log.length-1]!==line)j.log.push(line);if(j.log.length>40)j.log.splice(0,j.log.length-40)}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}

async function getBrowser(){
  if(!browserPromise) browserPromise=chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]}).catch(e=>{browserPromise=null;throw e});
  return browserPromise;
}
async function bodyText(page){return (await page.locator("body").innerText({timeout:7000}).catch(()=>"")).replace(/\s+/g," ").trim()}
function completionText(text){const t=text.toLowerCase();return t.includes("дякуємо, що поділились позитивними враженнями")||t.includes("дякуємо за ваш відгук")||t.includes("thank you for your feedback")}
function usedText(text){const t=text.toLowerCase();return t.includes("вже було використано")||t.includes("вже використано")||t.includes("вже брали участь")||t.includes("already been completed")||t.includes("already completed")||t.includes("already used")||t.includes("response has already been recorded")}
function introText(text){const t=text.toLowerCase();return t.includes("дякуємо, що завітали до mcdonald")||t.includes("опитування займе лише кілька хвилин")||(t.includes("мова українська")&&t.includes("наступна сторінка"))}
function detectStage(text){
  if(text.includes("Загалом, наскільки ви задоволені"))return "satisfaction";
  if(text.includes("Чи все було правильно у вашому замовленні"))return "correct";
  if(text.includes("Чим ви найбільше задоволені"))return "reason";
  if(text.includes("співвідношення ціни та якості"))return "value";
  if(text.includes("наступних 30 днів"))return "revisit";
  if(text.includes("відзначити працівника за обслуговування"))return "employee";
  return "";
}

async function questionContainer(page,q){
  const exact=page.getByText(q,{exact:false}).first();if(!(await exact.count()))return null;
  const handle=await exact.elementHandle();if(!handle)return null;
  const h=await handle.evaluateHandle(el=>{let cur=el;for(let i=0;i<8&&cur;i++,cur=cur.parentElement){const txt=(cur.innerText||"").trim();const n=cur.querySelectorAll("input,textarea,button,[role=radio],[role=option],label").length;if(txt.length<2200&&n>0)return cur}return el.parentElement||el});
  return h.asElement();
}
async function clickText(page,text,q=null){
  const radio=page.getByRole("radio",{name:text,exact:true}).first();if(await radio.count()){try{await radio.click({timeout:2500});return true}catch{}}
  const label=page.locator("label").filter({hasText:text}).first();if(await label.count()){try{await label.click({timeout:2500});return true}catch{}}
  if(q){const c=await questionContainer(page,q);if(c){const ok=await c.evaluate((el,wanted)=>{const norm=s=>(s||"").replace(/\s+/g," ").trim();const nodes=[...el.querySelectorAll("label,button,[role=radio],[role=option],li,div")];const hit=nodes.find(n=>norm(n.innerText)===wanted)||nodes.find(n=>norm(n.innerText).includes(wanted));if(!hit)return false;const input=hit.querySelector?.("input[type=radio],input[type=checkbox]");(input||hit).click?.();return true},text).catch(()=>false);await c.dispose().catch(()=>{});if(ok)return true}}
  return false;
}
async function fillText(page,q,value){if(!value)return true;const c=await questionContainer(page,q);if(!c)return false;const ok=await c.evaluate((el,v)=>{const f=el.querySelector("textarea,input[type=text]");if(!f)return false;f.value=v;f.dispatchEvent(new Event("input",{bubbles:true}));f.dispatchEvent(new Event("change",{bubbles:true}));return true},value).catch(()=>false);await c.dispose().catch(()=>{});return ok}
async function clickNext(page){
  const cs=[page.locator("#NextButton").first(),page.getByRole("button",{name:/наступна сторінка/i}).first(),page.getByRole("button",{name:/далі/i}).first(),page.getByRole("button",{name:/next/i}).first(),page.getByRole("button",{name:/почати|розпочати|start/i}).first(),page.locator('input[type="submit"][value*="Наступна" i]').first(),page.locator('input[type="submit"][value*="Далі" i]').first(),page.locator('input[type="submit"][value*="Next" i]').first()];
  for(const loc of cs){if(await loc.count()&&await loc.isVisible().catch(()=>false)){try{await loc.click({timeout:3500});return true}catch{}}}return false;
}
async function waitForChange(page,beforeStage,beforeText,timeout=7000){const start=Date.now();while(Date.now()-start<timeout){await wait(300);const text=await bodyText(page);if(completionText(text)||usedText(text))return true;const st=detectStage(text);if(st&&st!==beforeStage)return true;if(text&&text!==beforeText&&!introText(text))return true}return false}

async function runSurvey(job){
  let context=null;
  try{
    update(job,5,"Відкриваю анкету…","","QR OK");
    const browser=await getBrowser();
    context=await browser.newContext({viewport:{width:390,height:844},locale:"uk-UA",userAgent:"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36"});
    const page=await context.newPage();page.setDefaultTimeout(5000);page.on("dialog",d=>d.dismiss().catch(()=>{}));
    await page.goto(job.url,{waitUntil:"domcontentloaded",timeout:30000});
    update(job,12,"Сесію створено","Перевіряю перший екран.","Survey opened");
    const p=job.preset;let introPassed=false,idle=0;

    for(let step=0;step<16;step++){
      if(job.cancelled)throw new Error("Зупинено користувачем");
      await wait(450);const text=await bodyText(page);
      if(completionText(text)){job.state="done";update(job,100,"Готово","Анкету завершено.","completion=100");return}
      if(usedText(text))throw new Error("Цей чек/QR уже використаний або анкета вже закрита");
      if(!text){if(++idle<6){update(job,13,"Чекаю Qualtrics…",`Завантаження ${idle}/6`);continue}throw new Error("Qualtrics не віддав сторінку")}

      const stage=detectStage(text);
      if(!stage&&!introPassed&&introText(text)){
        update(job,17,"Вступна сторінка","Натискаю «Далі» один раз.","Intro detected");
        const before=text;if(!(await clickNext(page)))throw new Error("Не знайшов кнопку на вступній сторінці");
        introPassed=true;update(job,20,"Переходжу до питань…","Чекаю перше питання.","Intro passed once");
        if(!(await waitForChange(page,"",before,8000)))throw new Error("Після вступу не з'явилося перше питання. Повторно Next не натискаю, щоб не псувати чек.");
        continue;
      }
      if(!stage){
        const validation=await page.locator('.ValidationError,.validation-error,[role="alert"],.ErrorMessage').filter({visible:true}).first().innerText().catch(()=>"");
        if(validation?.trim())throw new Error(`Qualtrics: ${validation.trim().slice(0,250)}`);
        if(introText(text)&&introPassed)throw new Error("Qualtrics залишився на вступному екрані після одного кліку. Повторно Next не натискаю.");
        if(++idle<5){update(job,Math.max(job.progress,21),"Чекаю питання…",`Спроба ${idle}/5`);continue}
        throw new Error(`Невідомий екран: ${text.slice(0,320)}`);
      }
      idle=0;
      let progress=25,status="";
      if(stage==="satisfaction"){
        if(!(await clickText(page,SAT[p.satisfaction],"Загалом, наскільки ви задоволені")))throw new Error("Не знайшов загальну оцінку");
        if(p.visitComment&&text.includes("Розкажіть, будь ласка, що вплинуло на вашу оцінку"))await fillText(page,"Розкажіть, будь ласка, що вплинуло на вашу оцінку",p.visitComment);
        progress=30;status="Загальна оцінка";
      }else if(stage==="correct"){
        if(!(await clickText(page,p.orderCorrect?"Так":"Ні","Чи все було правильно у вашому замовленні")))throw new Error("Не знайшов Так/Ні");progress=45;status="Правильність замовлення";
      }else if(stage==="reason"){
        if(!(await clickText(page,p.mainReason,"Чим ви найбільше задоволені")))throw new Error("Не знайшов пункт «Чим задоволені»");
        if(p.mainReason.startsWith("Інше")&&p.mainReasonOther)await page.locator('input[type="text"],textarea').last().fill(p.mainReasonOther).catch(()=>{});progress=60;status="Основний плюс";
      }else if(stage==="value"){
        if(!(await clickText(page,VALUE[p.valueForMoney],"співвідношення ціни та якості")))throw new Error("Не знайшов ціна/якість");progress=73;status="Ціна / якість";
      }else if(stage==="revisit"){
        if(!(await clickText(page,REVISIT[p.revisit],"наступних 30 днів")))throw new Error("Не знайшов оцінку повернення");progress=86;status="Повернення";
      }else if(stage==="employee"){
        if(p.employeeComment&&!(await fillText(page,"відзначити працівника за обслуговування",p.employeeComment)))throw new Error("Не знайшов фінальний коментар");progress=95;status="Фінальний коментар";
      }
      update(job,progress,status,"","Stage: "+stage);
      const before=text;if(!(await clickNext(page)))throw new Error("Не знайшов кнопку «Далі» на розпізнаному питанні");
      if(!(await waitForChange(page,stage,before,8000)))throw new Error("Після відповіді сторінка не змінилась. Повторно кнопку не натискаю.");
    }
    throw new Error("Анкета не завершилась у межах очікуваних екранів");
  }catch(err){
    if(job.cancelled){job.state="cancelled";update(job,100,"Зупинено","","Cancelled")}
    else{job.state="error";update(job,100,"Потрібна перевірка",String(err?.message||err),"Automation stopped safely")}
  }finally{if(context)await context.close().catch(()=>{})}
}

function cropRGBA(data,w,h,x,y,cw,ch){
  x=Math.max(0,Math.floor(x));y=Math.max(0,Math.floor(y));cw=Math.max(1,Math.min(w-x,Math.floor(cw)));ch=Math.max(1,Math.min(h-y,Math.floor(ch)));
  const out=new Uint8ClampedArray(cw*ch*4);
  for(let row=0;row<ch;row++){const src=(y+row)*w*4+x*4;out.set(data.subarray(src,src+cw*4),row*cw*4)}
  return {data:out,width:cw,height:ch};
}
function thresholdRGBA(src,threshold=145){const out=new Uint8ClampedArray(src.length);for(let i=0;i<src.length;i+=4){const g=.299*src[i]+.587*src[i+1]+.114*src[i+2];const v=g<threshold?0:255;out[i]=out[i+1]=out[i+2]=v;out[i+3]=255}return out}
function tryQR(data,w,h){try{return jsQR(data,w,h,{inversionAttempts:"attemptBoth"})?.data||""}catch{return ""}}
async function decodeReceipt(buffer){
  const {data,info}=await sharp(buffer).rotate().resize({width:1800,height:1800,fit:"inside",withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const raw=new Uint8ClampedArray(data.buffer,data.byteOffset,data.byteLength),W=info.width,H=info.height;
  const regions=[
    {data:raw,width:W,height:H},
    cropRGBA(raw,W,H,W*.08,H*.08,W*.84,H*.84),
    cropRGBA(raw,W,H,W*.10,H*.22,W*.80,H*.72),
    cropRGBA(raw,W,H,W*.18,H*.28,W*.64,H*.62),
    cropRGBA(raw,W,H,W*.22,H*.18,W*.56,H*.70)
  ];
  for(const r of regions){let hit=tryQR(r.data,r.width,r.height);if(hit)return hit;for(const t of [125,150,175]){hit=tryQR(thresholdRGBA(r.data,t),r.width,r.height);if(hit)return hit}}
  return "";
}

app.post("/api/decode-qr",express.raw({type:["image/*","application/octet-stream"],limit:"12mb"}),async(req,res)=>{
  try{if(!req.body?.length)return res.status(400).json({error:"Порожнє фото"});const value=await decodeReceipt(req.body);if(!value)return res.status(422).json({error:"QR не знайдено"});res.json({value})}catch(e){res.status(422).json({error:String(e?.message||e)})}
});
app.use(express.json({limit:"256kb"}));
app.use(express.static(path.join(__dirname,"public"),{maxAge:0,etag:false,setHeaders(res){res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, max-age=0")}}));
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"gelya-gelya",version:"5.0",port:PORT,ts:Date.now()}));
app.get("/api/health/browser",async(_req,res)=>{try{const b=await getBrowser();res.json({ok:true,browser:await b.version(),ts:Date.now()})}catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}});
app.post("/api/jobs",(req,res)=>{const surveyUrl=String(req.body?.surveyUrl||"").trim();if(!validSurveyUrl(surveyUrl))return res.status(400).json({error:"Невірне посилання анкети"});const id=crypto.randomUUID();const j={id,state:"running",progress:0,status:"Старт…",detail:"",log:[],createdAt:Date.now(),updatedAt:Date.now(),url:surveyUrl,preset:normalizePreset(req.body?.preset),cancelled:false};jobs.set(id,j);runSurvey(j);res.status(202).json(publicJob(j))});
app.get("/api/jobs/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json(publicJob(j))});
app.delete("/api/jobs/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});j.cancelled=true;res.json({ok:true})});
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
setInterval(()=>{const cutoff=Date.now()-3600000;for(const[id,j]of jobs)if(j.updatedAt<cutoff)jobs.delete(id)},600000).unref();
app.listen(PORT,"0.0.0.0",()=>console.log(`Геля-Геля v5 listening on ${PORT}`));
