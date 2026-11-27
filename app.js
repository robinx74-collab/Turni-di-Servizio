'use strict';
const $ = id => document.getElementById(id);
const form = $('shift');
const prefs = $('preferences');
const key = 'turni-servizio-v1';
const types = ['Ordinario','Scorta','Missione','Reperibilità','Riposo','Congedo','Riposo compensativo','Assenza','Altro servizio'];
const noHours = new Set(['Riposo','Congedo','Riposo compensativo','Assenza','Reperibilità']);
const sources = {
  ot: ['DPR 53/2025, art. 6','https://www.funzionepubblica.gov.it/media/n42l02pb/gu-dpr-24-marzo-2025-n-53-forze-polizia-ad-ordinamento-civile-e-militare.pdf'],
  presence: ['DPR 57/2022, art. 14','https://www.gazzettaufficiale.it/eli/id/2022/05/31/22G00066/sg'],
  fesi: ['Accordo FESI 2025','https://www.siap-polizia.org/newsamp/comunicati/15565/fesi-2025-firmato-l-accordo-definitivo-pagamento-gia-nello-statino-di-luglio']
};
// Rates are stored in cents. Hourly quantities are entered in minutes.
const rates = [
  {id:'weekday', label:'Straordinario feriale', cents:1335, hourly:true, source:'ot', from:'2024-01-01'},
  {id:'nightOrHoliday', label:'Straordinario notturno o festivo', cents:1510, hourly:true, source:'ot', from:'2024-01-01'},
  {id:'nightHoliday', label:'Straordinario notturno festivo', cents:1742, hourly:true, source:'ot', from:'2024-01-01'},
  {id:'night', label:'Presenza notturna 22–06', cents:430, hourly:true, source:'presence', from:'2022-01-01'},
  {id:'holiday', label:'Presenza festiva', cents:1400, hourly:false, source:'presence', from:'2022-01-01'},
  {id:'onCall', label:'Reperibilità FESI 2025', cents:1750, hourly:false, source:'fesi', from:'2025-01-01', to:'2025-12-31'},
  {id:'change', label:'Cambio turno FESI 2025', cents:1000, hourly:false, source:'fesi', from:'2025-01-01', to:'2025-12-31'}
];
const mealDefaults = () => ({reason:'',colleagues:'',missedMeals:0,mealGross:0,mealNet:null,tickets:0,ticketValue:700});
const overtimeDefaults = () => ({plannedStart:'',plannedEnd:'',plannedOvernight:false,breakStart:'',localHoliday:''});
const overtimeNames = ['Diurno feriale','Notturno feriale','Diurno festivo','Notturno festivo'];
const overtimeRates = ['weekday','nightOrHoliday','nightHoliday'];
const fixedHolidays = new Set(['01-01','01-06','04-25','05-01','06-02','08-15','11-01','12-08','12-25','12-26']);
const defaults = () => ({version:1, shifts:[], deductions:{ordinario:null,fesi:null}});
const timeZone = 'Europe/Rome';
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone}).format(new Date());
const fmt = (day, options) => new Intl.DateTimeFormat('it-IT',{...options,timeZone:'UTC'}).format(new Date(day+'T12:00:00Z'));
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const iso = date => date.toISOString().slice(0,10);
const validDate = date => typeof date === 'string' && datePattern.test(date) &&
  Number.isFinite(Date.parse(date)) && iso(new Date(date)) === date;
const clock = time => time.split(':').reduce((hour, minute) => 60*Number(hour)+Number(minute));
const timeText = minutes => [Math.floor(minutes/60), minutes%60].map(n=>String(n).padStart(2,'0')).join(':');
const euro = new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'});
const money = cents => cents === null ? '—' : euro.format(cents/100);
const duration = n => Math.floor(n/60)+' h '+String(n%60).padStart(2,'0')+' m';
const status = message => { $('status').textContent = message; };
const option = (value, title) => new Option(title,value);
const applicable = (rate,date) => date >= rate.from && (!rate.to || date <= rate.to);
const inRange = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max;
let data = defaults();
let blocked = false;
let selected = today();
let month = selected.slice(0,7);
let view = 'cal';
let editing = null;
let loadWarning = '';

function validateShift(s) {
  if (!s || !text(s.id,100) || !s.id || !validDate(s.date) || !types.includes(s.type) ||
      !['done','plan'].includes(s.status) || !text(s.note,4000) || !text(s.manualLabel,120) ||
      !inRange(s.manualGross,10000000) || (s.manualNet !== null && !inRange(s.manualNet,s.manualGross)) ||
      typeof s.overnight !== 'boolean' || !inRange(s.pause,1439) || !inRange(s.unclassified,1440) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end) ||
      !s.quantities || !rates.every(r=>inRange(s.quantities[r.id],r.hourly?1440:1))) {
    throw new Error('Controlla i dati della scheda e gli importi inseriti.');
  }
  if (!text(s.reason,200) || !text(s.colleagues,300) || !inRange(s.missedMeals,20) ||
      !inRange(s.tickets,20) || !inRange(s.ticketValue,10000000) || !inRange(s.mealGross,10000000) ||
      (s.mealNet!==null && !inRange(s.mealNet,s.mealGross||10000000))) throw new Error('Controlla i dati di pasti, ticket o causale.');
  if (!s.missedMeals && (s.mealGross || s.mealNet!==null)) throw new Error('Indica il numero di pasti non fruiti.');
  if (s.manualNet !== null && s.manualGross === 0) throw new Error('Inserisci il lordo della voce da cedolino.');
  if (rates.some(r=>s.quantities[r.id] && !applicable(r,s.date))) throw new Error('Tariffa non applicabile alla data selezionata.');
  if (noHours.has(s.type)) {
    if (s.pause || s.unclassified || rates.some(r=>r.source!=='fesi' && s.quantities[r.id])) throw new Error('Questa voce è senza ore di servizio.');
    return;
  }
  const minutes = netMinutes(s);
  if (minutes <= 0 || minutes+s.pause > 1440) throw new Error('Controlla gli orari, la pausa e il passaggio a mezzanotte.');
  if (s.plannedStart || s.plannedEnd) {
    const validTime = time=>typeof time==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
    if (!validTime(s.plannedStart) || !validTime(s.plannedEnd) || typeof s.plannedOvernight!=='boolean') {
      throw new Error('Inserisci inizio e fine dell’orario previsto.');
    }
    const plannedLength = clock(s.plannedEnd)+(s.plannedOvernight?1440:0)-clock(s.plannedStart);
    if (plannedLength<=0 || plannedLength>1440) throw new Error('Controlla l’orario previsto e il passaggio a mezzanotte.');
    if (s.localHoliday && ![s.date,nextDay(s.date)].includes(s.localHoliday)) throw new Error('La festività locale deve coincidere con il giorno del turno o quello successivo.');
    if (s.pause && (clock(s.start)<clock(s.plannedStart) ||
        clock(s.end)+(s.overnight?1440:0)>clock(s.plannedEnd)+(s.plannedOvernight?1440:0)) && !s.breakStart) {
      throw new Error('Indica quando inizia la pausa per sottrarla dalla fascia oraria corretta.');
    }
    if (s.pause && s.breakStart) {
      const start = pauseStart(s);
      if (!validTime(s.breakStart) || start+s.pause>clock(s.end)+(s.overnight?1440:0)) {
        throw new Error('La pausa deve rientrare nel servizio effettivo.');
      }
    }
  }
  if (extraMinutes(s)>minutes) throw new Error('Lo straordinario supera le ore di servizio.');
  const start = clock(s.start);
  const end = clock(s.end)+(s.overnight?1440:0);
  const nightMinutes = [[0,360],[1320,1800],[2760,3240]].reduce(
    (sum,[from,to])=>sum+Math.max(0,Math.min(end,to)-Math.max(start,from)),0);
  if (s.quantities.night > Math.min(nightMinutes, minutes)) throw new Error('I minuti di presenza notturna superano la fascia 22–06 del turno.');
}
function parse(raw) {
  if (raw?.versione === 1 && Array.isArray(raw.turni)) {
    return parse({...defaults(), shifts:raw.turni.map(s=>{
      if (!s || !Number.isFinite(s.giorno) || !inRange(s.inizio,1439) || !inRange(s.fine,1439) ||
          typeof s.svolto!=='boolean') throw new Error('Backup Mac non valido.');
      const date = new Intl.DateTimeFormat('sv-SE',{timeZone}).format(new Date((s.giorno+978307200)*1000));
      return {...newShift(date), ...overtimeDefaults(), id:s.id, type:s.tipo, status:s.svolto?'done':'plan',
        start:timeText(s.inizio),end:timeText(s.fine),overnight:s.giornoDopo,pause:s.pausa,
        unclassified:s.extra,note:s.nota};
    })});
  }
  if (raw?.version !== 1 || !Array.isArray(raw.shifts) || !raw.deductions ||
      !['ordinario','fesi'].every(k=>raw.deductions[k] === null ||
        (typeof raw.deductions[k] === 'number' && raw.deductions[k]>=0 && raw.deductions[k]<=100))) {
    throw new Error('Formato di backup non valido.');
  }
  raw = {...raw, shifts:raw.shifts.map(shift=>({...mealDefaults(),...overtimeDefaults(),...shift}))};
  raw.shifts.forEach(validateShift);
  if (new Set(raw.shifts.map(s=>s.id)).size!==raw.shifts.length) throw new Error('Il backup contiene duplicati.');
  return raw;
}
try {
  const raw = localStorage.getItem(key);
  if (raw) data = parse(JSON.parse(raw));
} catch {
  blocked = true;
  loadWarning = 'Archivio illeggibile o non accessibile. Puoi ripristinare un backup dalla sezione Archivio.';
}
function save(next, notify=true) {
  localStorage.setItem(key,JSON.stringify(next));
  data = next;
  blocked = false;
  loadWarning = '';
  if (notify) window.dispatchEvent(new Event('turni-saved'));
}
function netMinutes(s) {
  return noHours.has(s.type)?0:clock(s.end)-clock(s.start)+(s.overnight?1440:0)-s.pause;
}
function nextDay(date) {
  return iso(new Date(Date.parse(date)+86400000));
}

function easterMonday(year) {
  // Gregorian computus (Meeus/Jones/Butcher), then add one day.
  const a=year%19, b=Math.floor(year/100), c=year%100;
  const d=Math.floor(b/4), e=b%4, f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30;
  const l=(32+2*e+2*Math.floor(c/4)-h-c%4)%7;
  const m=Math.floor((a+11*h+22*l)/451);
  const day=h+l-7*m+114;
  return iso(new Date(Date.UTC(year,Math.floor(day/31)-1,day%31+2)));
}

function holiday(date, localHoliday) {
  return date===localHoliday || new Date(date).getUTCDay()===0 ||
    fixedHolidays.has(date.slice(5)) || (date>='2026-01-01' && date.slice(5)==='10-04') ||
    date===easterMonday(Number(date.slice(0,4)));
}

function pauseStart(s) {
  const start = clock(s.breakStart);
  return start<clock(s.start)?start+1440:start;
}

function serviceBreakdown(s) {
  const result={regular:0, before:[0,0,0,0], after:[0,0,0,0]};
  if (!s.plannedStart || !s.plannedEnd || noHours.has(s.type) || s.status==='plan') return result;
  const expectedStart=clock(s.plannedStart);
  const expectedEnd=clock(s.plannedEnd)+(s.plannedOvernight?1440:0);
  const effectiveEnd=clock(s.end)+(s.overnight?1440:0);
  const pause=s.pause&&s.breakStart?pauseStart(s):Infinity;
  const holidays=[holiday(s.date,s.localHoliday),holiday(nextDay(s.date),s.localHoliday)];
  for (let minute=clock(s.start);minute<effectiveEnd;minute++) {
    if (minute>=pause && minute<pause+s.pause) continue;
    if (minute>=expectedStart && minute<expectedEnd) {
      result.regular++;
      continue;
    }
    const time=minute%1440;
    const night=time<360||time>=1320;
    const festivo=holidays[Math.floor(minute/1440)];
    const period=minute<expectedStart?result.before:result.after;
    period[(festivo?2:0)+(night?1:0)]++;
  }
  if (s.pause && !s.breakStart) result.regular-=s.pause;
  return result;
}

function automaticOvertime(s) {
  const {before,after}=serviceBreakdown(s);
  return before.map((minutes,i)=>minutes+after[i]);
}

function overtimeText(s) {
  if (!s.plannedStart || noHours.has(s.type) || s.status==='plan') return [];
  const {regular,before,after}=serviceBreakdown(s);
  const periodText=(label,categories)=>{
    const total=categories.reduce((a,b)=>a+b,0);
    const detail=categories.flatMap((minutes,i)=>minutes?[overtimeNames[i]+' '+duration(minutes)]:[]);
    return label+' '+duration(total)+(detail.length?' · '+detail.join(' · '):'');
  };
  return ['Turno regolare '+duration(regular),periodText('Anticipo',before),periodText('Posticipo',after)];
}

function extraMinutes(s) {
  if (s.plannedStart) return automaticOvertime(s).reduce((a,b)=>a+b,0);
  return s.unclassified+s.quantities.weekday+s.quantities.nightOrHoliday+s.quantities.nightHoliday;
}
function netEstimate(cents, group) {
  const deduction = data.deductions[group];
  return !cents ? 0 : deduction === null ? null : Math.round(cents*(1-deduction/100));
}
function pay(s) {
  const quantities = {...s.quantities};
  if (s.plannedStart) {
    const [day,night,holidayDay,holidayNight]=automaticOvertime(s);
    Object.assign(quantities,{weekday:day,nightOrHoliday:night+holidayDay,nightHoliday:holidayNight});
  }
  const lines = rates.filter(r=>quantities[r.id]&&applicable(r,s.date)).map(r=>{
    const gross = Math.round(r.cents*quantities[r.id]/(r.hourly?60:1));
    return {label:r.label,gross,net:netEstimate(gross,r.source==='fesi'?'fesi':'ordinario')};
  });
  if (s.manualGross) lines.push({label:s.manualLabel||'Voce da liquidazione',gross:s.manualGross,
    net:s.manualNet??netEstimate(s.manualGross,'ordinario')});
  if (s.mealGross || s.mealNet!==null) lines.push({label:'Rimborso pasti non fruiti',gross:s.mealGross||null,net:s.mealNet});
  const total = sum(lines);
  return {...total,lines};
}
function sum(items) {
  return {gross:items.some(i=>i.gross===null)?null:items.reduce((a,b)=>a+b.gross,0),
    net:items.some(i=>i.net===null)?null:items.reduce((a,b)=>a+b.net,0)};
}
function node(tag, content, className) {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (className) el.className = className;
  return el;
}
function newShift(date) {
  return {...mealDefaults(),...overtimeDefaults(),plannedStart:'08:00',plannedEnd:'14:00',id:typeof crypto.randomUUID==='function'?crypto.randomUUID():crypto.getRandomValues(new Uint32Array(4)).join('-'),
    date,type:'Ordinario',status:'done',start:'08:00',end:'14:00',pause:0,overnight:false,
    quantities:Object.fromEntries(rates.map(r=>[r.id,0])),unclassified:0,note:'',manualLabel:'',manualGross:0,manualNet:null};
}
function monthShifts() {
  return data.shifts.filter(s=>s.date.startsWith(month+'-')).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
}
function row(s,showDate) {
  const el = node('article',undefined,'entry');
  const body = node('div');
  const title = (showDate?fmt(s.date,{day:'numeric',month:'short'})+' · ':'')+s.type;
  body.append(node('strong',title));
  const time = noHours.has(s.type)?'':s.start+'–'+s.end+(s.overnight?' (+1 g)':'')+' · ';
  body.append(node('p',time+(s.status==='plan'?'Programmato':'Registrato'),'muted'));
  const values = pay(s);
  if (values.lines.length) {
    const detail = node('details');
    detail.append(node('summary','Lordo '+money(values.gross)+' · Netto '+money(values.net)));
    for (const line of values.lines) detail.append(node('p',line.label+' · '+money(line.gross)+' lordi · '+money(line.net)+' netti','muted'));
    body.append(detail);
  }
  if (s.unclassified) body.append(node('p','Straordinario da classificare: '+duration(s.unclassified),'muted'));
  if (s.plannedStart) body.append(node('p','Previsto: '+s.plannedStart+'–'+s.plannedEnd+(s.plannedOvernight?' (+1 g)':''),'muted'));
  for (const line of overtimeText(s)) body.append(node('p',line,'muted'));
  if (s.reason) body.append(node('p','Causale: '+s.reason,'muted'));
  if (s.colleagues) body.append(node('p','Con chi lavori: '+s.colleagues,'muted'));
  if (s.missedMeals) body.append(node('p','Pasti non fruiti: '+s.missedMeals,'muted'));
  if (s.tickets) body.append(node('p','Ticket pasto: '+s.tickets+' · '+money(s.tickets*s.ticketValue),'muted'));
  if (s.note) body.append(node('p',s.note,'muted'));
  const edit = node('button','Modifica');
  edit.disabled = blocked;
  edit.onclick = ()=>open(s);
  el.append(body,edit);
  return el;
}
function render() {
  const isMonth = view==='cal'||view==='reg';
  $('month-content').hidden = !isMonth;
  $('calendar').hidden = view!=='cal';
  $('register').hidden = view!=='reg';
  $('tariffs').hidden = view!=='tar';
  $('archive').hidden = view!=='arch';
  $('new').disabled = blocked;
  $('backup').disabled = blocked;
  for (const btn of document.querySelectorAll('[data-view]')) {
    if (btn.dataset.view===view) btn.setAttribute('aria-current','page');
    else btn.removeAttribute('aria-current');
  }
  $('title').textContent = {cal:'Calendario di servizio',reg:'Registro mensile',tar:'Tariffe e compensi',arch:'Archivio personale'}[view];
  $('subtitle').textContent = {cal:'Organizza i turni e controlla le ore registrate.',reg:'Consulta le registrazioni e scarica il riepilogo del mese.',tar:'Straordinari, indennità e stima del netto.',arch:'Gestisci i backup e personalizza la stima del netto.'}[view];
  if (view==='tar') renderRates();
  if (view==='arch') for (const name of ['ordinario','fesi']) prefs.elements[name].value = data.deductions[name]??'';
  if (!isMonth) return;
  const shifts=monthShifts();
  const done=shifts.filter(s=>s.status==='done');
  const totals=sum(done.map(pay));
  $('month').textContent=fmt(month+'-01',{month:'long',year:'numeric'});
  const cards = [
    ['Ore di servizio',duration(done.reduce((n,s)=>n+netMinutes(s),0))],
    ['Straordinario',duration(done.reduce((n,s)=>n+extraMinutes(s),0))],
    ['Compensi lordi',money(totals.gross)],['Netto stimato',money(totals.net)],
    ['Pasti non fruiti',String(done.reduce((n,s)=>n+s.missedMeals,0))],
    ['Ticket pasto',done.reduce((n,s)=>n+s.tickets,0)+' · '+money(done.reduce((n,s)=>n+s.tickets*s.ticketValue,0))]
  ];
  $('metrics').replaceChildren(...cards.map(([name,value])=>{
    const card=node('div',undefined,'metric');
    card.append(node('span',name),node('strong',value));
    return card;
  }));
  $('csv').disabled = !shifts.length;
  if (view==='reg') { renderRows(); return; }
  $('selected').textContent=fmt(selected,{weekday:'long',day:'numeric',month:'long'});
  $('add-day').disabled=blocked;
  const first=new Date(month+'-01T12:00:00Z');
  const offset=(first.getUTCDay()+6)%7;
  const grid=$('grid');
  grid.replaceChildren();
  for (let i=0;i<offset;i++) grid.append(node('span'));
  for (let date=first;iso(date).startsWith(month);date.setUTCDate(date.getUTCDate()+1)) {
    const day=iso(date);
    const dayShifts=shifts.filter(s=>s.date===day);
    const button=node('button',String(date.getUTCDate()),'day');
    if ([0,6].includes(date.getUTCDay())) button.classList.add('weekend');
    button.setAttribute('aria-label',fmt(day,{day:'numeric',month:'long'})+' · '+dayShifts.length+' turni');
    button.setAttribute('aria-pressed',String(day===selected));
    if (day===today()) button.setAttribute('aria-current','date');
    if (dayShifts.length) {
      const firstShift=dayShifts[0];
      button.append(node('span',firstShift.type+(dayShifts.length>1?' +'+(dayShifts.length-1):''),'badge '+firstShift.status));
    }
    button.onclick=()=>{selected=day;render();grid.querySelector('[aria-pressed=true]').focus();};
    grid.append(button);
  }
  const daily=shifts.filter(s=>s.date===selected);
  $('day-list').replaceChildren(...(daily.length?daily.map(s=>row(s,false)):[node('p','Nessun turno per questo giorno.','muted')]));
}
function renderRows() {
  const search=$('search').value.trim().toLocaleLowerCase('it');
  const type=$('filter').value;
  const rows=monthShifts().filter(s=>(!type||s.type===type)&&[s.type,s.reason,s.colleagues,s.note].join(' ').toLocaleLowerCase('it').includes(search));
  $('rows').replaceChildren(...(rows.length?rows.map(s=>row(s,true)):[node('p','Nessun turno da mostrare.','muted')]));
}
function renderRates() {
  $('rates').replaceChildren(...rates.map(r=>{
    const tr=node('tr');
    const group=r.source==='fesi'?'fesi':'ordinario';
    const unit=r.hourly?' / h':r.id==='holiday'?' / giorno':' / turno';
    const source=node('a',sources[r.source][0]);
    source.href=sources[r.source][1];
    source.target='_blank';
    source.rel='noopener noreferrer';
    const td=node('td');
    td.append(source);
    tr.append(node('td',r.label),node('td',money(r.cents)+unit),
      node('td',money(netEstimate(r.cents,group))),td);
    return tr;
  }));
}
function open(shift) {
  editing=shift;
  const existing=data.shifts.some(s=>s.id===shift.id);
  form.reset();
  for (const name of ['date','type','status','start','end','pause','note','manualLabel','reason','colleagues']) form.elements[name].value=shift[name];
  const hasActual=existing&&shift.status==='done';
  if (!hasActual && shift.plannedStart) {
    form.elements.start.value='';
    form.elements.end.value='';
  }
  form.elements.overnight.checked=shift.overnight&&(!shift.plannedStart||hasActual);
  form.elements.automatic.checked=Boolean(shift.plannedStart);
  form.elements.plannedStart.value=shift.plannedStart||shift.start;
  form.elements.plannedEnd.value=shift.plannedEnd||shift.end;
  form.elements.plannedOvernight.checked=shift.plannedStart?shift.plannedOvernight:shift.overnight;
  form.elements.breakStart.value=shift.breakStart;
  form.elements.localHoliday.value=shift.localHoliday;
  for (const name of ['missedMeals','tickets']) form.elements[name].value=shift[name]||'';
  form.elements.ticketValue.value=shift.ticketValue/100;
  form.elements.mealGross.value=shift.mealGross?shift.mealGross/100:'';
  form.elements.mealNet.value=shift.mealNet===null?'':shift.mealNet/100;
  $('meals').open=Boolean(shift.missedMeals||shift.tickets);
  form.elements.manualGross.value=shift.manualGross?shift.manualGross/100:'';
  form.elements.manualNet.value=shift.manualNet===null?'':shift.manualNet/100;
  for (const r of rates) form.elements[r.id].value=shift.quantities[r.id]||'';
  form.elements.unclassified.value=shift.unclassified||'';
  $('editor-title').textContent=existing?'Modifica turno':'Nuovo turno';
  $('delete').hidden=$('editor-title').textContent==='Nuovo turno';
  $('manual').open=Boolean(shift.manualGross);
  $('pay').open=Boolean(shift.unclassified||Object.values(shift.quantities).some(Boolean)||shift.type==='Reperibilità');
  $('error').textContent='';
  preview();
  $('editor').showModal();
}
function readForm() {
  const values=form.elements;
  const noService=noHours.has(values.type.value);
  const automatic=!noService&&values.automatic.checked;
  const plannedOnly=automatic&&values.status.value==='plan';
  const quantities=Object.fromEntries(rates.map(r=>[r.id,values[r.id].disabled?0:Number(values[r.id].value)]));
  return {id:editing.id,date:values.date.value,type:values.type.value,status:values.status.value,
    plannedStart:automatic?values.plannedStart.value:'',plannedEnd:automatic?values.plannedEnd.value:'',
    plannedOvernight:automatic&&values.plannedOvernight.checked,
    breakStart:automatic&&!plannedOnly?values.breakStart.value:'',localHoliday:automatic?values.localHoliday.value:'',
    start:noService?'08:00':plannedOnly?values.plannedStart.value:values.start.value,
    end:noService?'14:00':plannedOnly?values.plannedEnd.value:values.end.value,
    overnight:!noService&&(plannedOnly?values.plannedOvernight.checked:values.overnight.checked),
    pause:noService||plannedOnly?0:Number(values.pause.value),
    reason:values.reason.value.trim(),colleagues:values.colleagues.value.trim(),
    missedMeals:Number(values.missedMeals.value),tickets:Number(values.tickets.value),
    ticketValue:Math.round(Number(values.ticketValue.value)*100),
    mealGross:Math.round(Number(values.mealGross.value)*100),
    mealNet:values.mealNet.value===''?null:Math.round(Number(values.mealNet.value)*100),
    note:values.note.value,quantities,unclassified:noService||automatic?0:Number(values.unclassified.value),
    manualLabel:values.manualLabel.value,manualGross:Math.round(Number(values.manualGross.value)*100),
    manualNet:values.manualNet.value===''?null:Math.round(Number(values.manualNet.value)*100)};
}
function preview() {
  const values=form.elements;
  const noService=noHours.has(values.type.value);
  const automatic=!noService&&values.automatic.checked;
  const range = values.plannedStart.value+'/'+values.plannedEnd.value;
  values.preset.value = !values.plannedOvernight.checked && [...values.preset.options].some(option=>option.value===range) ? range : '';
  $('hours').hidden=noService;
  $('hours').disabled=noService;
  $('planned').hidden=!automatic;
  for (const control of $('planned').querySelectorAll('input, select')) control.disabled=!automatic;
  $('actual').hidden=noService||(automatic&&values.status.value==='plan');
  $('actual').disabled=$('actual').hidden;
  $('break-start').hidden=!automatic||!Number(values.pause.value);
  $('overtime').textContent='';
  for (const r of rates) {
    const input=values[r.id];
    input.parentElement.hidden=(noService&&r.source!=='fesi')||(automatic&&overtimeRates.includes(r.id));
    input.disabled=input.parentElement.hidden||!applicable(r,values.date.value);
    input.placeholder=input.disabled?'Fuori annualità':'';

  }
  values.unclassified.parentElement.hidden=noService || automatic || (!editing.unclassified&&!values.unclassified.value);
  values.unclassified.disabled=values.unclassified.parentElement.hidden;
  if (!$('actual').hidden && (!values.start.value || !values.end.value)) {
    $('preview').textContent='';
    $('error').textContent='';
    if (automatic) $('overtime').textContent='Inserisci inizio e fine effettivi per calcolare lo straordinario.';
    return;
  }
  try {
    const s=readForm();
    validateShift(s);
    const totals=pay(s);
    const breakdown=overtimeText(s);
    if (breakdown.length) $('overtime').replaceChildren(
      node('strong','Straordinario totale '+duration(extraMinutes(s))),
      ...breakdown.map(line=>node('div',line))
    );
    $('error').textContent='';
    $('preview').textContent=[!noService?duration(netMinutes(s))+' di servizio':'',
      'Lordo '+money(totals.gross),'Netto '+money(totals.net)].filter(Boolean).join(' · ');
  } catch (error) { $('preview').textContent=''; $('error').textContent=error.message; }
}
function moveMonth(step) {
  const date=new Date(month+'-01T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth()+step);
  selected=iso(date);
  month=selected.slice(0,7);
  render();
}
function download(name,type,contents) {
  const url=URL.createObjectURL(new Blob([contents],{type}));
  const a=node('a');
  a.href=url;
  a.download=name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function csv() {
  const headers=['Data','Tipo','Stato','Inizio','Fine','Giorno dopo','Pausa min','Servizio min',
    'Straordinario min','Straordinario da classificare min','Lordo EUR','Netto EUR','Voci','Causale','Con chi lavori','Pasti non fruiti','Rimborso pasti lordo EUR','Rimborso pasti netto EUR','Ticket pasto','Valore ticket unitario EUR','Valore ticket totale EUR','Note','Inizio previsto','Fine prevista','Previsto giorno dopo','Inizio pausa','Festività locale',...overtimeNames.map(name=>name+' min'),'Turno regolare min',
    ...['Anticipo','Posticipo'].flatMap(period=>overtimeNames.map(name=>period+' '+name+' min'))];
  const number=cents=>cents===null?'':(cents/100).toFixed(2).replace('.',',');
  const rows=monthShifts().map(s=>{
    const amounts=pay(s);
    const automatic=s.plannedStart&&s.status==='done';
    const {regular,before,after}=serviceBreakdown(s);
    return [s.date,s.type,s.status==='done'?'Registrato':'Programmato',noHours.has(s.type)?'':s.start,
      noHours.has(s.type)?'':s.end,s.overnight?'Sì':'',s.pause,netMinutes(s),extraMinutes(s),s.unclassified,
      number(amounts.gross),number(amounts.net),amounts.lines.map(l=>l.label+': '+number(l.gross)).join(' | '),s.reason,s.colleagues,s.missedMeals,number(s.mealGross||null),number(s.mealNet),s.tickets,number(s.ticketValue),number(s.tickets*s.ticketValue),s.note,s.plannedStart,s.plannedEnd,s.plannedOvernight?'Sì':'',s.breakStart,s.localHoliday,...(automatic?[...automaticOvertime(s),regular,...before,...after]:Array(13).fill(''))];
  });
  const escape=value=>{
    const string=String(value);
    const safe=/^[\s\uFEFF]*[=+@-]/u.test(string) ? "'"+string : string;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  download('Turni-'+month+'.csv','text/csv;charset=utf-8','\uFEFF'+[headers,...rows].map(row=>row.map(escape).join(';')).join('\r\n'));
}
for (const t of types) form.elements.type.add(option(t,t));
$('filter').add(option('','Tutti'));
for (const t of types) $('filter').add(option(t,t));
for (const r of rates) {
  const label=node('label',r.label+' ('+(r.hourly?'min':r.id==='holiday'?'0/1 giorno':'0/1 turno')+')');
  const input=node('input');
  Object.assign(input,{type:'number',name:r.id,min:'0',max:r.hourly?'1440':'1',step:'1'});
  label.append(input);
  $('pay-inputs').append(label);
}
const oldExtra=node('label','Da classificare (min)');
const oldInput=node('input');
Object.assign(oldInput,{name:'unclassified',type:'number',min:'0',max:'1440',step:'1'});
oldExtra.append(oldInput);
$('pay-inputs').append(oldExtra);
for (const btn of document.querySelectorAll('[data-view]')) btn.onclick=()=>{view=btn.dataset.view;render();};
$('new').onclick=$('add-day').onclick=()=>open(newShift(selected));
$('next').onclick=()=>moveMonth(1);
$('prev').onclick=()=>moveMonth(-1);
$('today').onclick=()=>{selected=today();month=selected.slice(0,7);render();};
$('search').oninput=$('filter').onchange=renderRows;
$('csv').onclick=csv;
$('close').onclick=$('cancel').onclick=()=>$('editor').close();
form.oninput=event=>{
  const values = form.elements;
  if (event.target===values.preset && values.preset.value) {
    [values.plannedStart.value,values.plannedEnd.value]=values.preset.value.split('/');
    values.plannedOvernight.checked=false;
  }
  if ((event.target===values.start || event.target===values.end) && values.start.value && values.end.value &&
      values.start.value!==values.end.value) values.overnight.checked=values.end.value<values.start.value;
  if (event.target!==values.preset || values.preset.value) preview();
};
form.onsubmit=event=>{
  event.preventDefault();
  try {
    const s=readForm();
    validateShift(s);
    save({...data,shifts:[...data.shifts.filter(old=>old.id!==s.id),s]});
    selected=s.date;
    month=selected.slice(0,7);
    if (view==='tar'||view==='arch') view='cal';
    $('editor').close();
    render();
    status('Turno salvato.');
  } catch (err) { $('error').textContent=err.message; }
};
$('delete').onclick=()=>{
  if (!confirm('Eliminare questo turno?')) return;
  try {
    save({...data,shifts:data.shifts.filter(s=>s.id!==editing.id)});
    $('editor').close();
    render();
    status('Turno eliminato.');
  } catch (err) { $('error').textContent=err.message; }
};
prefs.onsubmit=event=>{
  event.preventDefault();
  if (blocked) { status(loadWarning); return; }
  try {
    const entries=['ordinario','fesi'].map(name=>[name,prefs.elements[name].value===''?null:Number(prefs.elements[name].value)]);
    save({...data,deductions:Object.fromEntries(entries)});
    status('Impostazioni salvate.');
  } catch (err) { status('Salvataggio non riuscito. '+err.message); }
};
$('backup').onclick=()=>download('Backup-turni-'+today()+'.json','application/json',JSON.stringify(data,null,2));
$('restore').onclick=()=>$('file').click();
$('file').onchange=async event=>{
  const file=event.target.files[0];
  event.target.value='';
  if (!file) return;
  try {
    const imported=parse(JSON.parse(await file.text()));
    if (!confirm('Sostituire il registro con '+imported.shifts.length+' registrazioni del backup? Se è collegato a un account, la sostituzione verrà sincronizzata.')) return;
    save(imported);
    render();
    status('Backup ripristinato.');
  } catch (err) { status('Ripristino non riuscito. '+err.message); }
};
window.addEventListener('storage',event=>{
  if (event.key!==key && event.key!==null) return;
  try {
    data=event.newValue?parse(JSON.parse(event.newValue)):defaults();
    blocked=false;
    loadWarning='';
    if ($('editor').open) $('editor').close();
    render();
    status('Registro aggiornato da un’altra scheda.');
  } catch {
    blocked=true;
    loadWarning='Archivio illeggibile. Ripristina un backup.';
    render();
    status(loadWarning);
  }
});
render();
if (loadWarning) status(loadWarning);
if ('serviceWorker' in navigator && location.protocol!=='file:') {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
