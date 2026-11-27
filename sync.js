'use strict';
(() => {
  const bindingKey = 'turni-sync-binding-v1';
  const sessionKey = 'turni-sync-session-v1';
  const baselineKey = 'turni-sync-baseline-v1';
  const privateFields = ['reason','colleagues','note','manualLabel'];
  const sharedFields = [
    'id','date','type','status','start','end','overnight','pause','plannedStart','plannedEnd',
    'plannedOvernight','breakStart','localHoliday','missedMeals','mealGross','mealNet',
    'tickets','ticketValue','unclassified','manualGross','manualNet'
  ];
  const load = name => {
    try { return JSON.parse(localStorage.getItem(name)); }
    catch { return null; }
  };
  const persist = (name,value) => localStorage.setItem(name,JSON.stringify(value));
  const canonical = record => ({
    version:1, deductions:{ordinario:record.deductions.ordinario,fesi:record.deductions.fesi},
    shifts:record.shifts.map(shift => ({
      ...Object.fromEntries(sharedFields.map(field=>[field,shift[field]])),
      quantities:Object.fromEntries(rates.map(rate=>[rate.id,shift.quantities[rate.id]]))
    })).sort((a,b)=>a.id.localeCompare(b.id))
  });
  const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);

  // Reconcile individual turns and settings against the last common version.
  // Undefined represents a deleted or previously absent turn.
  function reconcile(base, local, remote, choice) {
    let conflicts=0;
    function pick(previous,a,b) {
      if (equal(a,b)) return a;
      if (equal(a,previous)) return b;
      if (equal(b,previous)) return a;
      conflicts++;
      return choice==='remote'?b:a;
    }
    const maps=[base,local,remote].map(record=>new Map(record.shifts.map(s=>[s.id,s])));
    const ids=new Set(maps.flatMap(map=>[...map.keys()]));
    const shifts=[...ids].map(id=>pick(...maps.map(map=>map.get(id)))).filter(Boolean);
    const deductions=Object.fromEntries(['ordinario','fesi'].map(name=>[
      name,pick(base.deductions[name],local.deductions[name],remote.deductions[name])
    ]));
    return {record:canonical({shifts,deductions}),conflicts};
  }

  let binding=load(bindingKey);
  let session=load(sessionKey);
  let running=false;
  let timer;
  let conflict=false;
  let settingsEdited=false;
  const login=$('sync-login');
  const updateStatus=message=>{$('sync-status').textContent=message;};
  const options=()=> {
    $('sync-login').hidden=Boolean(session);
    $('sync-controls').hidden=!session;
    $('sync-conflict').hidden=!conflict;
    $('sync-now').disabled=running;
    $('sync-logout').disabled=running;
    login.elements.project.readOnly=Boolean(binding);
    login.elements.publishable.readOnly=Boolean(binding);
    login.elements.email.readOnly=Boolean(binding);
    if (binding && !session) {
      login.elements.project.value=binding.project;
      login.elements.publishable.value=binding.publishable;
      login.elements.email.value=binding.email;
    }
  };
  function schedule(delay=500) {
    clearTimeout(timer);
    if (session && !conflict) timer=setTimeout(()=>sync(),delay);
  }
  async function request(config,path,{method='GET',accessToken,body,headers={}}={}) {
    const response=await fetch(config.project+path,{
      method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000),
      headers:{apikey:config.publishable, ...(accessToken?{Authorization:'Bearer '+accessToken}:{}),
        ...(body?{'Content-Type':'application/json'}:{}),...headers},
      body:body?JSON.stringify(body):undefined
    });
    const payload=await response.json().catch(()=>null);
    if (!response.ok) {
      const error=new Error('Richiesta non riuscita.');
      error.status=response.status;
      throw error;
    }
    return payload;
  }
  async function access() {
    if (session.expires_at>Date.now()/1000+60) return session.access_token;
    try {
      const fresh=await request(binding,'/auth/v1/token?grant_type=refresh_token',{
        method:'POST',body:{refresh_token:session.refresh_token}
      });
      if (fresh.user?.id!==binding.uid) throw new Error('Account inatteso.');
      persist(sessionKey,fresh);
      session=fresh;
      return fresh.access_token;
    } catch (error) {
      if ([400,401,403].includes(error.status)) {
        localStorage.removeItem(sessionKey);
        session=null;
        options();
      }
      throw error;
    }
  }

  function applyRemote(record) {
    const localById=new Map(data.shifts.map(s=>[s.id,s]));
    const next=parse({...record,shifts:record.shifts.map(s=>({
      ...s,...Object.fromEntries(privateFields.map(field=>[field,localById.get(s.id)?.[field]??'']))
    }))});
    if (!equal(canonical(data),record)) {
      save(next,false);
      render();
    }
  }

  async function sync(choice) {
    if (!session || running || blocked || (conflict && !choice)) return;
    if ($('editor').open || settingsEdited || document.hidden) {schedule(15000);return;}
    running=true;
    options();
    try {
      const token=await access();
      const path='/rest/v1/turni_registro?user_id=eq.'+encodeURIComponent(binding.uid);
      const result=await request(binding,path+'&select=revision,payload',{accessToken:token});
      const previous=load(baselineKey);
      // Do not recreate a removed cloud register from a stale local copy.
      if (!result.length && previous) throw new Error('L’archivio online non è disponibile.');
      const remote=result[0];
      const remoteData=remote?canonical(parse({...remote.payload,shifts:remote.payload.shifts.map(shift=>({
        ...shift,...Object.fromEntries(privateFields.map(field=>[field,'']))
      }))})):canonical(defaults());
      const baseline=previous??canonical(defaults());
      const start=canonical(data);
      const merged=reconcile(baseline,start,remoteData,choice);
      if (merged.conflicts && !choice) {
        conflict=true;
        updateStatus(merged.conflicts+' modifiche in conflitto. Scegli quale versione conservare per queste voci.');
        return;
      }
      if (choice && merged.conflicts) {
        download('Backup-prima-della-risoluzione-'+today()+'.json','application/json',JSON.stringify(data,null,2));
      }
      if (!remote || !equal(merged.record,remoteData)) {
        const write={revision:remote?remote.revision+1:1,payload:merged.record};
        const saved=await request(binding,remote?path+'&revision=eq.'+remote.revision:'/rest/v1/turni_registro',{
          method:remote?'PATCH':'POST',accessToken:token,
          headers:{Prefer:'return=representation'},body:remote?write:{...write,user_id:binding.uid}
        });
        if (!saved?.length) {
          conflict=false;
          updateStatus('Il registro è cambiato. Riprovo con la versione aggiornata.');
          return;
        }
      }
      const latest=canonical(data);
      const duringSync=reconcile(start,latest,merged.record);
      if (duringSync.conflicts || $('editor').open || settingsEdited) {
        // Keep current input intact and reconcile again after the editor closes.
        // Keep the old base so a divergent edit cannot overwrite an incoming one silently.
        conflict=false;
        updateStatus('Aggiornamento in attesa di completare la modifica locale.');
        return;
      }
      applyRemote(duringSync.record);
      persist(baselineKey,merged.record);
      conflict=false;
      updateStatus(equal(duringSync.record,merged.record)
        ? 'Sincronizzato alle '+new Date().toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})
        : 'Modifiche locali in attesa di sincronizzazione.');
    } catch (error) {
      if (error.status===409) {
        conflict=false;
        updateStatus('Registro creato dall’altro dispositivo. Riprovo.');
      } else if (error.status===404 || error.status===403) {
        updateStatus('Archivio online non accessibile. Controlla di aver eseguito Database_Supabase.sql.');
      } else if (!session) {
        updateStatus('Sessione scaduta. Accedi di nuovo.');
      } else {
        updateStatus('Sincronizzazione in attesa. Le modifiche restano salvate sul dispositivo.');
      }
    } finally {
      running=false;
      options();
      schedule(15000);
    }
  }

  login.onsubmit=async event=>{
    event.preventDefault();
    const button=login.querySelector('button');
    const project=login.elements.project.value.trim().replace(/\/$/,'');
    const publishable=login.elements.publishable.value.trim();
    const email=login.elements.email.value.trim().toLowerCase();
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(project) || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishable)) {
      updateStatus('Inserisci il Project URL Supabase e la chiave sb_publishable_.');
      return;
    }
    if (!binding && !confirm('Attivare la sincronizzazione dei turni presenti su questo dispositivo? Causali, colleghi e note restano qui.')) return;
    button.disabled=true;
    const password=login.elements.password.value;
    login.elements.password.value='';
    try {
      const config={project,publishable,email};
      const auth=await request(config,'/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
      if (!auth?.user?.id || !auth.refresh_token || (binding && auth.user.id!==binding.uid)) throw new Error('Account inatteso.');
      binding={...config,uid:auth.user.id};
      persist(bindingKey,binding);
      persist(sessionKey,auth);
      session=auth;
      options();
      updateStatus('Accesso riuscito. Sincronizzazione in corso…');
      schedule();
    } catch (error) {
      updateStatus(error.status===400 || error.status===401
        ? 'Accesso non riuscito. Controlla email e password del tuo utente nell’app.'
        : 'Accesso non riuscito. Controlla connessione e configurazione.');
    } finally {button.disabled=false;}
  };
  $('sync-logout').onclick=async ()=>{
    if (running) return;
    clearTimeout(timer);
    const last=session;
    session=null;
    localStorage.removeItem(sessionKey);
    conflict=false;
    options();
    updateStatus('Disconnesso. Il registro locale resta su questo dispositivo.');
    try {
      await request(binding,'/auth/v1/logout?scope=local',{method:'POST',accessToken:last.access_token});
    } catch {}
  };
  $('sync-now').onclick=()=>sync();
  $('sync-local').onclick=()=>sync('local');
  $('sync-remote').onclick=()=>sync('remote');
  prefs.addEventListener('input',()=>{settingsEdited=true;});
  prefs.addEventListener('submit',()=>{settingsEdited=false;schedule();});
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{settingsEdited=false;schedule();}));
  $('editor').addEventListener('close',()=>schedule());
  window.addEventListener('turni-saved',()=>{schedule();if(session&&!conflict)updateStatus('Modifiche locali in attesa di sincronizzazione.');});
  window.addEventListener('online',()=>schedule());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
  window.addEventListener('storage',event=>{
    if (event.key===sessionKey || event.key===null) {
      binding=load(bindingKey);
      session=load(sessionKey);
      conflict=false;
      options();
    }
    if (event.key===key) schedule();
  });
  options();
  if (session) schedule();
})();
