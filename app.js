/* IGYR-Smart Management Platform - synced with Python backend & Turso Cloud DB */
const $=s=>document.querySelector(s);
let db=JSON.parse(localStorage.getItem('igyr')||'null')||{logo:'',users:[{id:'igyr',pw:'cutiee',role:'admin',name:'Super Admin'}],insts:[],classes:[],subjects:[],students:[],att:[],pays:[],tt:[],mats:[],ann:[],exams:[],res:[],bills:[]};
if(!db.bills) db.bills = [];
let U=null, tab=null;
let lastDbSnapshot=JSON.stringify(db);
let pendingSyncRender=false;
let isFetchingTurso=false;
let isPushingTurso=false;
let lastLocalChangeTime=0;
let cloudVersion=0;

/* Cross-Tab & Multi-Window Real-time Broadcast Channel */
let realtimeChannel=null;
try{
  if(typeof BroadcastChannel!=='undefined'){
    realtimeChannel=new BroadcastChannel('igyr_realtime_sync');
    realtimeChannel.onmessage=(ev)=>{
      if(ev&&ev.data&&ev.data.type==='sync'){
        if(ev.data.db&&ev.data.db.users&&ev.data.db.users.length>0){
          db=ev.data.db;
          const str=JSON.stringify(db);
          localStorage.setItem('igyr',str);
          lastDbSnapshot=str;
          applyDashboardSync(true);
        } else {
          syncFromLocalStorage(true);
        }
      }
    };
  }
}catch(e){}

window.addEventListener('storage',(e)=>{
  if(e.key==='igyr'&&e.newValue){
    syncFromLocalStorage(false);
  }
});

function isUserEditingForm(){
  const active=document.activeElement;
  if(!active) return false;
  // If custom modal is open, do not re-render view
  if(document.querySelector('#customModalOverlay')) return true;
  // If only searching students/classes, do not block real-time background sync
  if(active.id==='stuSearch'||active.id==='classSearch') return false;
  const tag=active.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'){
    if(active.type==='date'||active.type==='button'||active.type==='submit'||active.type==='checkbox'||active.type==='radio') return false;
    return (active.value && active.value.trim().length > 0);
  }
  return false;
}

function applyDashboardSync(force=false){
  setLogo();
  if(typeof U!=='undefined'&&U){
    if(!U.inst){
      U.inst=getUserInstId(U);
      if(U.inst) try{sessionStorage.setItem('u',JSON.stringify(U));}catch(e){}
    }
    const instId=I();
    const ins=(instId&&db&&db.insts)?db.insts.find(i=>i.id===instId||(i.id&&i.id.toLowerCase()===String(instId).toLowerCase())):null;
    const coachingName = (ins&&ins.name) || (U.role==='institute'?U.name:'Coaching');
    if($('#ttl')) $('#ttl').textContent = 'IGYR Smart Platform';
    if($('#subttl')) $('#subttl').textContent = (U.role === 'admin') ? 'Super Admin Portal' : (coachingName + ' Portal');
    if($('#neonHeaderTitle')) $('#neonHeaderTitle').textContent = (U.role === 'admin') ? 'SUPER ADMIN' : coachingName.toUpperCase();
  }
  const welcomeEl=$('#fullScreenWelcome');
  if(welcomeEl&&(welcomeEl.classList.contains('active')||welcomeEl.style.display==='flex')){
    showFullScreenWelcome();
  }

  // Targeted update: If user is on Students tab, always refresh the table instantly
  if(tab==='Students'&&$('#stuTableContainer')){
    renderStudentsTable($('#stuSearch')?$('#stuSearch').value:'');
    const countHeaders=document.querySelectorAll('h3');
    countHeaders.forEach(h => {
      if(h.textContent.includes('Enrolled Students')){
        h.textContent=`Enrolled Students (${mine('students').length})`;
      }
    });
  }

  // Targeted update: If user is on Teachers tab, always refresh the faculty table instantly
  if(tab==='Teachers'&&$('#teachersTableContainer')){
    renderTeachersTable();
  }

  // Targeted update: If user is on Fees & Dues tab, always refresh the fees table instantly
  if(tab==='Fees & Dues'&&$('#feesTableContainer')){
    renderFeesTable($('#feeSearch')?$('#feeSearch').value:'');
  }

  // If user is actively typing into an add/edit form, do not blow away whole tab
  if(!force&&isUserEditingForm()){
    pendingSyncRender=true;
    return;
  }
  pendingSyncRender=false;

  if(typeof tab!=='undefined'&&tab&&typeof go==='function'&&typeof U!=='undefined'&&U&&typeof T!=='undefined'&&T[U.role]){
    go(tab);
  }
}

document.addEventListener('focusout',()=>{
  setTimeout(()=>{
    if(pendingSyncRender&&!isUserEditingForm()){
      pendingSyncRender=false;
      applyDashboardSync(false);
    }
  },250);
});

function syncFromLocalStorage(force=false){
  try{
    const stored=localStorage.getItem('igyr');
    if(stored&&stored!==lastDbSnapshot){
      const parsed=JSON.parse(stored);
      if(parsed&&parsed.users&&parsed.users.length>0){
        db=parsed;
        lastDbSnapshot=stored;
        applyDashboardSync(force);
      }
    }
  }catch(e){}
}

let syncTimer=null;
const save=(immediateCloud=false)=>{
  lastLocalChangeTime=Date.now();
  const str=JSON.stringify(db);
  localStorage.setItem('igyr',str);
  lastDbSnapshot=str;
  if(realtimeChannel){
    try{realtimeChannel.postMessage({type:'sync',db:db,time:Date.now()});}catch(e){}
  }
  if(immediateCloud){
    pushToTurso();
  } else {
    clearTimeout(syncTimer);
    syncTimer=setTimeout(pushToTurso, 200);
  }
};

async function pushToTurso(){
  if(!db || !db.users || (db.users.length <= 1 && (!db.insts || db.insts.length === 0))){
    return;
  }
  isPushingTurso=true;
  try{
    const res=await fetch('/api/db/save',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(db)
    });
    if(res.ok){
      const json=await res.json().catch(()=>({}));
      if(json&&json.version){
        cloudVersion=json.version;
      }
      console.log('✓ [Turso Cloud DB] Saved successfully to Turso');
      if(realtimeChannel){
        try{realtimeChannel.postMessage({type:'sync',db:db,time:Date.now()});}catch(e){}
      }
    }
  }catch(err){
    console.warn('[Turso Cloud DB] Sync warning:', err.message);
  }finally{
    isPushingTurso=false;
  }
}

async function fetchFromTurso(force=false){
  if(isFetchingTurso) return;
  // Guard against race condition: never overwrite local database while a save is in-flight
  // or within 2.5 seconds of a user adding/editing records locally!
  if(!force && (isPushingTurso || (Date.now() - lastLocalChangeTime < 2500))){
    return;
  }
  isFetchingTurso=true;
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), 3500);
  try{
    // Strict cache-busting: add timestamp query & headers so mobile/browsers NEVER use cached response
    const res=await fetch('/api/db?_t=' + Date.now(),{
      cache: 'no-store',
      signal: abortCtrl.signal,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    clearTimeout(timeoutId);
    if(res.ok){
      const json=await res.json();
      if(json.ok&&json.data){
        const cloudDb=json.data;
        if(cloudDb.users&&cloudDb.users.length>0){
          // If recent local changes occurred, prevent stale cloud snapshot with fewer students
          if(!force && (Date.now() - lastLocalChangeTime < 4500)){
            const localCount = (db.students||[]).length;
            const cloudCount = (cloudDb.students||[]).length;
            if(cloudCount < localCount){
              return;
            }
          }
          if(json.version) cloudVersion=json.version;
          const cloudStr=JSON.stringify(cloudDb);
          if(cloudStr!==lastDbSnapshot||force){
            db=cloudDb;
            localStorage.setItem('igyr',cloudStr);
            lastDbSnapshot=cloudStr;
            applyDashboardSync(force);
            if(realtimeChannel){
              try{realtimeChannel.postMessage({type:'sync',db:db,time:Date.now()});}catch(e){}
            }
          }
        }
      }
    }
  }catch(err){
    if(err.name !== 'AbortError'){
      console.warn('[Turso Cloud DB] Offline or cached mode:', err.message);
    }
  }finally{
    clearTimeout(timeoutId);
    isFetchingTurso=false;
  }
}

// Initial fetch on page load
fetchFromTurso(false);

// Background Real-Time Polling every 1.5 seconds for instant cross-device updates
setInterval(()=>fetchFromTurso(false), 1500);

// Instant Sync on window focus, mobile unlock, screen touch, and page visibility changes
let lastTouchSyncTime = 0;
['focus', 'pageshow', 'online'].forEach(evt => {
  window.addEventListener(evt, () => fetchFromTurso(true));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchFromTurso(true);
});
['touchstart', 'pointerdown'].forEach(evt => {
  window.addEventListener(evt, () => {
    if (Date.now() - lastTouchSyncTime > 2500) {
      lastTouchSyncTime = Date.now();
      fetchFromTurso(false);
    }
  }, { passive: true });
});

const rnd=n=>Array.from({length:n},()=>String.fromCharCode(97+Math.floor(Math.random()*26))).join('');
const today=()=>new Date().toISOString().slice(0,10);
const me=()=>JSON.parse(sessionStorage.getItem('u')||'null');
const val=id=>$('#'+id).value.trim();
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ==========================================================================
   Modern Custom Dialogs & Toast Notifications (Eliminates "localhost says")
   ========================================================================== */

function getToastContainer(){
  let c=$('#toastContainer');
  if(!c){
    c=document.createElement('div');
    c.id='toastContainer';
    document.body.appendChild(c);
  }
  return c;
}

function uiToast(msg, type='success', title=''){
  const c=getToastContainer();
  const t=document.createElement('div');
  t.className=`ui-toast ${type}`;
  const icons={success:'✅', error:'❌', warning:'⚠️', info:'ℹ️'};
  const defaultTitles={success:'Success', error:'Error', warning:'Notice', info:'Notification'};
  const icon=icons[type]||'ℹ️';
  const displayTitle=title||defaultTitles[type]||'Notice';

  t.innerHTML=`
    <div class="ui-toast-icon">${icon}</div>
    <div class="ui-toast-content">
      <div class="ui-toast-title">${esc(displayTitle)}</div>
      <div class="ui-toast-msg">${esc(msg)}</div>
    </div>
    <button class="ui-toast-close" title="Dismiss" onclick="this.parentElement.remove()">×</button>
  `;
  c.appendChild(t);
  setTimeout(()=>{
    t.style.animation='toastSlideOut 0.3s forwards';
    setTimeout(()=>t.remove(), 300);
  }, 4000);
}

function closeCustomModal(){
  document.querySelectorAll('#customModalOverlay').forEach(m=>m.remove());
}

function uiAlert(title, message, callback){
  closeCustomModal();
  const overlay=document.createElement('div');
  overlay.id='customModalOverlay';
  overlay.style.cssText='position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';
  overlay.innerHTML=`
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#eff6ff!important;color:#2563eb!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">ℹ️</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">${esc(title||'Notification')}</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalCloseBtn" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        ${String(message||'').split('\n').map(l=>l.trim()?`<p>${esc(l)}</p>`:'').join('')}
      </div>
      <div class="custom-modal-footer" style="padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;">
        <button type="button" class="primary" id="modalOkBtn" style="padding:10px 24px">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const done=()=>{
    closeCustomModal();
    if(typeof callback==='function') callback();
  };
  overlay.querySelector('#modalOkBtn').onclick=done;
  overlay.querySelector('#modalCloseBtn').onclick=done;
  overlay.onclick=e=>{ if(e.target===overlay) done(); };
}

function uiConfirm(title, message, onConfirm, onCancel){
  closeCustomModal();
  const overlay=document.createElement('div');
  overlay.id='customModalOverlay';
  overlay.style.cssText='position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';
  overlay.innerHTML=`
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#fef3c7!important;color:#d97706!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">⚠️</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">${esc(title||'Confirmation')}</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalCloseBtn" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        ${String(message||'').split('\n').map(l=>l.trim()?`<p>${esc(l)}</p>`:'').join('')}
      </div>
      <div class="custom-modal-footer" style="padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;">
        <button type="button" class="secondary" id="modalCancelBtn" style="padding:10px 18px">Cancel</button>
        <button type="button" class="red" id="modalConfirmBtn" style="padding:10px 22px">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const cleanup=()=>{ closeCustomModal(); };
  overlay.querySelector('#modalConfirmBtn').onclick=()=>{
    cleanup();
    if(typeof onConfirm==='function') onConfirm(true);
  };
  const cancel=()=>{
    cleanup();
    if(typeof onCancel==='function') onCancel();
  };
  overlay.querySelector('#modalCancelBtn').onclick=cancel;
  overlay.querySelector('#modalCloseBtn').onclick=cancel;
}

function uiPrompt(title, message, defaultValue='', onConfirm, onCancel){
  closeCustomModal();
  const overlay=document.createElement('div');
  overlay.id='customModalOverlay';
  overlay.style.cssText='position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';
  overlay.innerHTML=`
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#eff6ff!important;color:#2563eb!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">✏️</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">${esc(title||'Input Required')}</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalCloseBtn" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        <p>${esc(message||'')}</p>
        <div class="custom-modal-input-wrap">
          <input class="custom-modal-input" id="promptInput" value="${esc(defaultValue)}" autocomplete="off">
        </div>
      </div>
      <div class="custom-modal-footer" style="padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;">
        <button type="button" class="secondary" id="modalCancelBtn" style="padding:10px 18px">Cancel</button>
        <button type="button" class="primary" id="modalSaveBtn" style="padding:10px 22px">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const inp=overlay.querySelector('#promptInput');
  inp.focus();
  inp.select();

  const cleanup=()=>{ closeCustomModal(); };
  overlay.querySelector('#modalSaveBtn').onclick=()=>{
    const val=inp.value.trim();
    cleanup();
    if(typeof onConfirm==='function') onConfirm(val);
  };
  inp.onkeydown=e=>{
    if(e.key==='Enter') overlay.querySelector('#modalSaveBtn').click();
    if(e.key==='Escape') closeCustomModal();
  };
  const cancel=()=>{
    cleanup();
    if(typeof onCancel==='function') onCancel();
  };
  overlay.querySelector('#modalCancelBtn').onclick=cancel;
  overlay.querySelector('#modalCloseBtn').onclick=cancel;
}

// Override window.alert so no "localhost says" ever appears!
window.alert=(msg)=>uiAlert('IGYR Platform', msg);
function showInfo(t,m){ uiAlert(t, m); }

/* ==========================================================================
   Forgot Password Multi-Step Flow (Teachers, Institutes, Students)
   - Step 1: Input registered email ID or User ID.
   - Student check: enforces 1 reset per month (30-day limit).
   - Step 2: Input 6-digit OTP sent via Gmail SMTP.
   - Step 3: Enter new password (User ID never changes).
   - Step 4: Success confirmation.
   ========================================================================== */

let fpState = {
  step: 1,
  email: '',
  maskedEmail: '',
  uid: '',
  name: '',
  role: '',
  otp: ''
};

function openForgotPasswordModal(){
  closeCustomModal();
  fpState = { step: 1, email: '', maskedEmail: '', uid: '', name: '', role: '', otp: '' };
  renderFpStep();
}

function renderFpStep(){
  closeCustomModal();
  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';

  const roleBadges = {
    student: '🎓 Student Account',
    teacher: '👨‍🏫 Faculty Account',
    institute: '🏛️ Institute Admin',
    admin: '🛡️ Administrator'
  };

  let bodyHtml = '';
  let footerHtml = '';
  let title = 'Reset Password';
  let icon = '🔐';

  if(fpState.step === 1){
    title = 'Forgot Password';
    icon = '🔐';
    bodyHtml = `
      <div class="fp-step-badge">Step 1 of 3 • Identify Account</div>
      <p style="margin-bottom:14px;color:#475569;font-size:14px">
        Enter your registered email address (or your User ID). We'll identify your account and send a 6-digit verification code.
      </p>
      <div id="fpAlertBox"></div>
      <label class="form-label" style="font-weight:600">Registered Email or User ID:</label>
      <div class="custom-modal-input-wrap" style="margin-top:6px">
        <input class="custom-modal-input" id="fpEmailInput" placeholder="e.g. yourname@gmail.com or student ID" autocomplete="off" value="${esc(fpState.email)}">
      </div>
      <p style="font-size:12px;color:#64748b;margin-top:8px">
        ℹ️ Students can reset their password once per month (30 days). Teachers & Institute Admins can reset anytime.
      </p>
    `;
    footerHtml = `
      <button type="button" class="secondary" id="fpCloseBtn" style="padding:10px 18px">Cancel</button>
      <button type="button" class="primary" id="fpSendOtpBtn" style="padding:10px 22px">Send Verification OTP 📩</button>
    `;
  } else if(fpState.step === 2){
    title = 'Verify Email OTP';
    icon = '📩';
    bodyHtml = `
      <div class="fp-step-badge">Step 2 of 3 • Verification</div>
      <div class="fp-account-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:700;font-size:15px;color:#0f172a">${esc(fpState.name)}</span>
          <span class="pill" style="background:#dbeafe;color:#1e40af;font-weight:600">${roleBadges[fpState.role]||fpState.role}</span>
        </div>
        <div style="color:#64748b;font-size:13px">User ID: <code style="font-weight:700;color:#2563eb">${esc(fpState.uid)}</code></div>
        <div style="color:#64748b;font-size:13px;margin-top:2px">OTP Code Sent To: <b style="color:#0f172a">${esc(fpState.maskedEmail||fpState.email)}</b></div>
      </div>
      <div id="fpAlertBox"></div>
      <p style="text-align:center;color:#475569;font-size:13px;margin:12px 0 6px">
        Enter the 6-digit security code sent to your email (Valid for 10 minutes):
      </p>
      <div style="margin:14px 0">
        <input class="custom-modal-input fp-otp-input" id="fpOtpInput" maxlength="6" placeholder="------" autocomplete="one-time-code">
      </div>
      <div style="text-align:center;margin-top:6px">
        <a href="#" id="fpResendLink" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:500">Didn't receive code? Resend OTP</a>
        <span style="color:#cbd5e1;margin:0 6px">•</span>
        <a href="#" id="fpChangeEmailLink" style="font-size:13px;color:#64748b;text-decoration:none">Use different email</a>
      </div>
    `;
    footerHtml = `
      <button type="button" class="secondary" id="fpBackBtn" style="padding:10px 18px">Back</button>
      <button type="button" class="primary" id="fpVerifyOtpBtn" style="padding:10px 22px">Verify OTP Code →</button>
    `;
  } else if(fpState.step === 3){
    title = 'Choose New Password';
    icon = '🔑';
    bodyHtml = `
      <div class="fp-step-badge">Step 3 of 3 • Set Password</div>
      <div class="fp-account-card">
        <div style="font-size:13px;color:#64748b">Account: <b>${esc(fpState.name)}</b> (${roleBadges[fpState.role]||fpState.role})</div>
        <div style="margin-top:4px;font-size:13px;color:#64748b">
          Your User ID remains unchanged: <code style="font-weight:700;color:#2563eb;font-size:14px">${esc(fpState.uid)}</code>
        </div>
      </div>
      <div id="fpAlertBox"></div>
      <label class="form-label" style="font-weight:600;margin-top:8px">Enter New Password:</label>
      <div class="custom-modal-input-wrap" style="margin-top:4px">
        <input type="password" class="custom-modal-input" id="fpNewPwInput" placeholder="At least 4 characters" autocomplete="new-password">
      </div>
      <label class="form-label" style="font-weight:600;margin-top:12px">Confirm New Password:</label>
      <div class="custom-modal-input-wrap" style="margin-top:4px">
        <input type="password" class="custom-modal-input" id="fpConfirmPwInput" placeholder="Re-type new password" autocomplete="new-password">
      </div>
    `;
    footerHtml = `
      <button type="button" class="secondary" id="fpCloseBtn" style="padding:10px 18px">Cancel</button>
      <button type="button" class="primary" id="fpSaveNewPwBtn" style="padding:10px 24px">Save & Reset Password ✨</button>
    `;
  } else if(fpState.step === 4){
    title = 'Password Reset Complete';
    icon = '✅';
    bodyHtml = `
      <div style="text-align:center;padding:8px 0 4px">
        <div style="width:76px;height:76px;border-radius:50%;background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:38px;margin:0 auto 16px;box-shadow:0 8px 24px rgba(16,185,129,0.35)">
          ✓
        </div>
        <h3 style="margin:0 0 6px;color:#0f172a;font-size:22px;font-weight:800">Password Changed Successfully!</h3>
        <p style="color:#64748b;font-size:14px;max-width:390px;margin:0 auto 16px;line-height:1.5">
          Your new password has been verified and saved into the cloud database.
        </p>

        <div class="fp-account-card" style="text-align:left;background:#f0fdf4;border:1px solid #bbf7d0;padding:14px 16px;margin:0 0 14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-weight:700;font-size:14px;color:#166534">Account Details</span>
            <span class="pill green" style="font-weight:700">${roleBadges[fpState.role]||fpState.role}</span>
          </div>
          <div style="color:#334155;font-size:13px">Account Name: <b>${esc(fpState.name)}</b></div>
          <div style="color:#334155;font-size:13px;margin-top:4px">
            Login User ID: <code style="font-weight:700;color:#047857;background:#dcfce7;padding:2px 8px;border-radius:4px;font-size:13px">${esc(fpState.uid)}</code> <span style="color:#166534;font-size:12px;font-weight:600">(Unchanged)</span>
          </div>
          <div style="color:#334155;font-size:13px;margin-top:4px">
            Email: <b>${esc(fpState.maskedEmail||fpState.email)}</b>
          </div>
        </div>

        <div class="fp-alert-box fp-alert-success" style="text-align:left;margin:0 auto">
          <span style="font-size:18px">✉️</span>
          <div>A security confirmation has been sent to your email. You can now log in immediately.</div>
        </div>
      </div>
    `;
    footerHtml = `
      <button type="button" class="primary green" id="fpFinishBtn" style="padding:14px;font-size:15px;font-weight:700;border-radius:10px;width:100%;box-shadow:0 4px 14px rgba(16,185,129,0.35);cursor:pointer">
        Sign In with New Password →
      </button>
      <div style="font-size:12px;color:#64748b;text-align:center;margin-top:8px">
        🔒 Ready to login with your User ID and new password
      </div>
    `;
  }

  overlay.innerHTML = `
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#eff6ff!important;color:#2563eb!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">${icon}</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">${esc(title)}</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalTopCloseBtn" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        ${bodyHtml}
      </div>
      <div class="custom-modal-footer ${fpState.step===4?'fp-footer-full':''}" style="${fpState.step===4?'padding:18px 24px 22px!important;border-top:1px solid #f1f5f9!important;display:flex!important;flex-direction:column!important;align-items:stretch!important;justify-content:center!important;background:#fafafa!important;':'padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;'}">
        ${footerHtml}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Common close triggers
  const closeAll = () => { closeCustomModal(); };
  const topX = overlay.querySelector('#modalTopCloseBtn');
  if(topX){
    topX.onclick = () => {
      if(fpState.step === 4 && overlay.querySelector('#fpFinishBtn')){
        overlay.querySelector('#fpFinishBtn').click();
      } else {
        closeAll();
      }
    };
  }
  const cancelBtn = overlay.querySelector('#fpCloseBtn');
  if(cancelBtn) cancelBtn.onclick = closeAll;

  // Helper for error banner in modal
  function showFpAlert(msg, type='error'){
    const box = overlay.querySelector('#fpAlertBox');
    if(!box) return;
    const isErr = (type === 'error');
    box.innerHTML = `
      <div class="fp-alert-box ${isErr ? 'fp-alert-error' : 'fp-alert-info'}">
        <span style="font-size:16px">${isErr ? '⚠️' : 'ℹ️'}</span>
        <div>${esc(msg)}</div>
      </div>
    `;
  }

  // Step 1: Send OTP handler
  if(fpState.step === 1){
    const inp = overlay.querySelector('#fpEmailInput');
    const sendBtn = overlay.querySelector('#fpSendOtpBtn');
    if(inp) inp.focus();

    const doSendOtp = async () => {
      const emailOrId = (inp ? inp.value : '').trim();
      if(!emailOrId){
        return showFpAlert('Please enter your registered email address or User ID.');
      }
      sendBtn.disabled = true;
      sendBtn.innerHTML = 'Sending OTP... ⏳';

      try{
        const res = await fetch('/api/auth/forgot-password/send-otp', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({email: emailOrId})
        });
        const resText = await res.text();
        let data = {};
        try {
          data = JSON.parse(resText);
        } catch(pe) {
          sendBtn.disabled = false;
          sendBtn.innerHTML = 'Send Verification OTP 📩';
          return showFpAlert(resText || 'Server error occurred. Please try again.');
        }
        if(!res.ok || !data.ok){
          sendBtn.disabled = false;
          sendBtn.innerHTML = 'Send Verification OTP 📩';
          return showFpAlert(data.error || 'Failed to send OTP code. Please check your input.');
        }

        fpState.email = data.email || emailOrId;
        fpState.maskedEmail = data.masked_email || data.email;
        fpState.uid = data.uid || '';
        fpState.name = data.name || data.uid;
        fpState.role = data.role || 'user';
        fpState.step = 2;
        renderFpStep();
        uiToast('Verification code sent to your email!', 'info');
      }catch(err){
        sendBtn.disabled = false;
        sendBtn.innerHTML = 'Send Verification OTP 📩';
        showFpAlert('Connection error while contacting server: ' + err.message);
      }
    };

    sendBtn.onclick = doSendOtp;
    inp.onkeydown = e => { if(e.key === 'Enter') doSendOtp(); };
  }

  // Step 2: Verify OTP handler
  if(fpState.step === 2){
    const otpInp = overlay.querySelector('#fpOtpInput');
    const verifyBtn = overlay.querySelector('#fpVerifyOtpBtn');
    const backBtn = overlay.querySelector('#fpBackBtn');
    const resendLink = overlay.querySelector('#fpResendLink');
    const changeLink = overlay.querySelector('#fpChangeEmailLink');

    if(otpInp) otpInp.focus();

    backBtn.onclick = () => {
      fpState.step = 1;
      renderFpStep();
    };

    changeLink.onclick = (e) => {
      e.preventDefault();
      fpState.step = 1;
      renderFpStep();
    };

    resendLink.onclick = async (e) => {
      e.preventDefault();
      resendLink.textContent = 'Resending...';
      try{
        const res = await fetch('/api/auth/forgot-password/send-otp', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({email: fpState.email})
        });
        const resText = await res.text();
        let data = {};
        try {
          data = JSON.parse(resText);
        } catch(pe) {
          resendLink.textContent = "Didn't receive code? Resend OTP";
          return showFpAlert(resText || 'Failed to resend code.');
        }
        if(!res.ok || !data.ok){
          resendLink.textContent = "Didn't receive code? Resend OTP";
          return showFpAlert(data.error || 'Failed to resend code.');
        }
        resendLink.textContent = 'Code resent! Check inbox';
        uiToast('New OTP code sent to your email!', 'info');
        setTimeout(() => {
          if(resendLink) resendLink.textContent = "Didn't receive code? Resend OTP";
        }, 5000);
      }catch(err){
        resendLink.textContent = "Didn't receive code? Resend OTP";
        showFpAlert('Error resending OTP: ' + err.message);
      }
    };

    const doVerifyOtp = async () => {
      const code = (otpInp ? otpInp.value : '').trim();
      if(!code || code.length < 6){
        return showFpAlert('Please enter the full 6-digit OTP code.');
      }
      verifyBtn.disabled = true;
      verifyBtn.innerHTML = 'Verifying... ⏳';

      try{
        const res = await fetch('/api/auth/forgot-password/verify-otp', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({email: fpState.email, otp: code})
        });
        const resText = await res.text();
        let data = {};
        try {
          data = JSON.parse(resText);
        } catch(pe) {
          verifyBtn.disabled = false;
          verifyBtn.innerHTML = 'Verify OTP Code →';
          return showFpAlert(resText || 'Verification error.');
        }
        if(!res.ok || !data.ok){
          verifyBtn.disabled = false;
          verifyBtn.innerHTML = 'Verify OTP Code →';
          return showFpAlert(data.error || 'Invalid or expired OTP code.');
        }

        fpState.otp = code;
        fpState.step = 3;
        renderFpStep();
        uiToast('Code verified successfully!', 'success');
      }catch(err){
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = 'Verify OTP Code →';
        showFpAlert('Verification error: ' + err.message);
      }
    };

    verifyBtn.onclick = doVerifyOtp;
    otpInp.onkeydown = e => { if(e.key === 'Enter') doVerifyOtp(); };
  }

  // Step 3: Set New Password
  if(fpState.step === 3){
    const newPwInp = overlay.querySelector('#fpNewPwInput');
    const confirmPwInp = overlay.querySelector('#fpConfirmPwInput');
    const savePwBtn = overlay.querySelector('#fpSaveNewPwBtn');

    if(newPwInp) newPwInp.focus();

    const doSavePw = async () => {
      const pw1 = (newPwInp ? newPwInp.value : '').trim();
      const pw2 = (confirmPwInp ? confirmPwInp.value : '').trim();

      if(!pw1){
        return showFpAlert('Please enter your new password.');
      }
      if(pw1.length < 4){
        return showFpAlert('Password must be at least 4 characters long.');
      }
      if(pw1 !== pw2){
        return showFpAlert('Passwords do not match. Please re-enter both identical passwords.');
      }

      savePwBtn.disabled = true;
      savePwBtn.innerHTML = 'Updating Password... ⏳';

      try{
        const res = await fetch('/api/auth/forgot-password/reset', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            email: fpState.email,
            otp: fpState.otp,
            new_pw: pw1
          })
        });
        const resText = await res.text();
        let data = {};
        try {
          data = JSON.parse(resText);
        } catch(pe) {
          savePwBtn.disabled = false;
          savePwBtn.innerHTML = 'Save & Reset Password ✨';
          return showFpAlert(resText || 'Failed to update password.');
        }
        if(!res.ok || !data.ok){
          savePwBtn.disabled = false;
          savePwBtn.innerHTML = 'Save & Reset Password ✨';
          return showFpAlert(data.error || 'Failed to update password.');
        }

        // Update in-memory local DB user list so subsequent UI immediately has it
        const u = db.users.find(x => x.id === fpState.uid || (x.id && x.id.toLowerCase() === fpState.uid.toLowerCase()));
        if(u){
          u.pw = pw1;
          save(false);
        }
        fetchFromTurso(true); // Fetch latest state from cloud with force

        fpState.step = 4;
        renderFpStep();
        uiToast('Password reset complete!', 'success');
      }catch(err){
        savePwBtn.disabled = false;
        savePwBtn.innerHTML = 'Save & Reset Password ✨';
        showFpAlert('Network error while resetting password: ' + err.message);
      }
    };

    savePwBtn.onclick = doSavePw;
    confirmPwInp.onkeydown = e => { if(e.key === 'Enter') doSavePw(); };
  }

  // Step 4: Finish & Sign In
  if(fpState.step === 4){
    const finishBtn = overlay.querySelector('#fpFinishBtn');
    finishBtn.onclick = () => {
      closeCustomModal();
      if($('#uid')) $('#uid').value = fpState.uid;
      if($('#pw')) {
        $('#pw').value = '';
        $('#pw').focus();
      }
      if($('#err')) $('#err').textContent = '';
      const notice = $('#loginSuccessNotice');
      if(notice){
        notice.style.display = 'block';
        notice.innerHTML = `
          <div class="fp-alert-box fp-alert-success" style="margin:12px 0 0;text-align:left">
            <span style="font-size:18px">✅</span>
            <div><b>Password Reset Successful!</b><br>User ID <b>${esc(fpState.uid)}</b> is ready. Enter your new password above and click Sign In.</div>
          </div>
        `;
      }
      uiToast(`Password for ${fpState.uid} reset successfully!`, 'success');
    };
  }
}

// Global exposure
window.openForgotPasswordModal = openForgotPasswordModal;

function getUserInstId(user){
  if(!user) return '';
  if(user.role === 'admin') return '';
  if(user.inst && String(user.inst).trim()) return String(user.inst).trim();
  if(user.role === 'institute') return String(user.inst || user.id || '').trim();

  const uid = String(user.id || '').toLowerCase().trim();
  // 1. Check students
  if(db && db.students){
    const s = db.students.find(x => x.uid && String(x.uid).toLowerCase().trim() === uid);
    if(s && s.inst) return String(s.inst).trim();
  }
  // 2. Check users
  if(db && db.users){
    const tu = db.users.find(x => x.id && String(x.id).toLowerCase().trim() === uid);
    if(tu && tu.inst) return String(tu.inst).trim();
  }
  // 3. Check subjects
  if(db && db.subjects){
    const sub = db.subjects.find(x => x.teacher && String(x.teacher).toLowerCase().trim() === uid);
    if(sub && sub.inst) return String(sub.inst).trim();
  }
  return '';
}

function getEffectiveLogo(){
  try{
    const currentUser = (U && U.id) ? U : (typeof me === 'function' ? me() : null);
    if(currentUser){
      if(currentUser.role === 'admin'){
        return (db && db.logo) ? db.logo : '';
      }
      const instId = getUserInstId(currentUser);
      if(instId && db && db.insts){
        const ins = db.insts.find(i => 
          i.id === instId || 
          (i.id && i.id.toLowerCase() === String(instId).toLowerCase()) || 
          (i.name && i.name.toLowerCase() === String(instId).toLowerCase())
        );
        // CRITICAL: Return ONLY this specific institute's uploaded logo!
        if(ins && ins.logo) return ins.logo;
      }
      // CRITICAL: If THIS specific institute has NOT uploaded a logo, return empty string ('')!
      // Do NOT fall back to db.logo (system logo) or another institute's logo!
      return '';
    }
    // Public screen (not logged in): Always return system logo!
    return (db && db.logo) ? db.logo : '';
  }catch(e){
    return (db && db.logo) ? db.logo : '';
  }
}

function setLogo(){
  const isPublicPage = !$('#view') || !(typeof me === 'function' && me());
  let activeLogo = '';
  if(isPublicPage){
    activeLogo = (db && db.logo) ? db.logo : '';
  } else {
    activeLogo = getEffectiveLogo();
  }
  document.querySelectorAll('#leftLogo,#midLogo').forEach(e => {
    e.innerHTML = activeLogo ? `<img src="${activeLogo}" alt="Logo">` : 'LOGO';
  });
}
setLogo();

async function login(){
  const rawId=val('uid'),cleanId=rawId.toLowerCase().replace(/\s+/g,'');
  const enteredPw=$('#pw').value;
  if($('#loginSuccessNotice')) $('#loginSuccessNotice').style.display='none';
  if($('#err')) $('#err').textContent='Authenticating...';

  try{
    const res=await fetch('/api/auth/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({uid:rawId,pw:enteredPw})
    });
    const resText=await res.text();
    let data={};
    try{ data=JSON.parse(resText); }catch(e){ data={ ok:false, error:resText }; }
    if(res.ok && data.ok && data.user){
      if($('#err')) $('#err').textContent='Loading all dashboard data... ⏳';
      // CRITICAL FOR MOBILE: Download all data from cloud before navigating so mobile has everything!
      try {
        await fetchFromTurso(true);
      } catch(e) {}
      if(!data.user.inst) data.user.inst = getUserInstId(data.user);
      sessionStorage.setItem('u',JSON.stringify(data.user));
      sessionStorage.setItem('showWelcome','1');
      sessionStorage.removeItem('welcomed');
      location.href='dashboard.html';
      return;
    } else if(res.status === 401 || (data && data.ok === false)){
      if($('#err')) $('#err').textContent = (data && data.error) || 'Invalid ID or password';
      return;
    }
  }catch(err){
    console.warn('API login request error, checking local store:', err);
  }

  if(cleanId === 'admin'){
    if($('#err')) $('#err').textContent='Invalid ID or password';
    return;
  }

  const u=db.users.find(x=>(x.id===rawId||x.id.toLowerCase()===rawId.toLowerCase()||x.id.toLowerCase()===cleanId||(x.name&&x.name.toLowerCase().trim()===rawId.toLowerCase().trim())||(x.name&&x.name.toLowerCase().replace(/\s+/g,'')===cleanId))&&(x.pw===enteredPw||(x.id==='igyr'&&enteredPw==='cutiee')));
  if(!u){if($('#err'))$('#err').textContent='Invalid ID or password';return}
  if(u.role === 'admin' && u.id.toLowerCase() !== 'igyr'){
    if($('#err'))$('#err').textContent='Invalid ID or password';
    return;
  }
  // If institute was deleted, reject login
  if(u.role !== 'admin'){
    const userInst = u.inst || getUserInstId(u);
    if(userInst && db.insts && !db.insts.some(i => i.id === userInst || (i.id && i.id.toLowerCase() === String(userInst).toLowerCase()))){
      if($('#err')) $('#err').textContent='Invalid ID or password';
      return;
    }
  }
  const userToSave = Object.assign({}, u);
  if(!userToSave.inst) userToSave.inst = getUserInstId(userToSave);
  sessionStorage.setItem('u',JSON.stringify(userToSave));
  sessionStorage.setItem('showWelcome','1');
  sessionStorage.removeItem('welcomed');
  location.href='dashboard.html';
}
function logout(){sessionStorage.removeItem('u');location.href='index.html'}
function readFile(inp,cb){const f=inp.files[0];if(!f)return cb('','');const r=new FileReader();r.onload=()=>cb(r.result,f.name);r.readAsDataURL(f)}
function readText(inp,cb){const f=inp.files[0];if(!f)return;const r=new FileReader();r.onload=()=>cb(r.result);r.readAsText(f)}

/* ---------- helpers ---------- */
const I=()=>{
  if(!U) return '';
  let inst = getUserInstId(U);
  if(!inst && U.inst) inst = String(U.inst).trim();
  if(!U.inst && inst){
    U.inst = inst;
    try { sessionStorage.setItem('u', JSON.stringify(U)); } catch(e){}
  }
  return inst;
};

const mine=k=>{
  const currentInst = String(I() || '').toLowerCase().trim();
  const list = (db && db[k]) ? db[k] : [];
  if(!currentInst) return (U && U.role === 'admin') ? list : [];
  return list.filter(x => {
    const itemInst = String(x.inst || '').toLowerCase().trim();
    return itemInst === currentInst;
  });
};

const sOf=uid=>{
  if(!db || !db.students) return null;
  const target = String(uid || '').toLowerCase().trim();
  return db.students.find(s => s.uid && String(s.uid).toLowerCase().trim() === target) || null;
};

function months(join){if(!join)return 1;const a=new Date(join),b=new Date();return Math.max(1,(b.getFullYear()-a.getFullYear())*12+b.getMonth()-a.getMonth()+1)}

const MONTH_NAMES_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function feeInfo(s){
  if(!s) return {total:0, paid:0, due:0, m:0};
  const sUid = String(s.uid || '').toLowerCase().trim();

  // If explicit fee bills exist in db.bills, use them
  const studentBills = ((db && db.bills) ? db.bills : []).filter(b => 
    String(b.uid || '').toLowerCase().trim() === sUid
  );

  let total = 0;
  if(studentBills.length > 0){
    total = studentBills.reduce((sum, b) => sum + (+b.debit || 0), 0);
  } else {
    // Only show dues for months explicitly added by admin, or one-time fee plan
    if(s.feeType === 'one') total = +s.fee || 0;
    else total = 0;
  }

  const paid = ((db&&db.pays)?db.pays:[]).filter(p => 
    String(p.uid||'').toLowerCase().trim() === sUid
  ).reduce((a,p)=>a+ (+p.amt||0),0);

  return {total, paid, due:Math.max(0, total-paid), m: studentBills.length};
}

function getStudentMonthlyLedger(s){
  if(!s) return [];
  const sUid = String(s.uid || '').trim().toLowerCase();
  
  // 1. Fetch any explicit bills in db.bills
  const existingBills = ((db && db.bills) ? db.bills : []).filter(b => 
    String(b.uid || '').trim().toLowerCase() === sUid
  );

  // 2. Total paid by student from db.pays
  const totalPaid = ((db && db.pays) ? db.pays : []).filter(p => 
    String(p.uid || '').trim().toLowerCase() === sUid
  ).reduce((sum, p) => sum + (+p.amt || 0), 0);

  let rows = [];

  if(existingBills.length > 0){
    // Sort existing bills chronologically by year, then month
    const MONTH_ORDER = {JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12};
    const sortedBills = existingBills.slice().sort((a, b) => {
      const ya = +(a.year || 0), yb = +(b.year || 0);
      if(ya !== yb) return ya - yb;
      const ma = MONTH_ORDER[String(a.month||'').toUpperCase()] || 0;
      const mb = MONTH_ORDER[String(b.month||'').toUpperCase()] || 0;
      return ma - mb;
    });

    rows = sortedBills.map(b => ({
      id: b.id,
      date: b.date || today(),
      month: String(b.month || '').toUpperCase(),
      year: String(b.year || new Date().getFullYear()),
      debit: (+b.debit || 0)
    }));
  } else if(s.feeType === 'one' && (+s.fee > 0)){
    rows = [{
      id: 'one_' + s.uid,
      date: s.join || today(),
      month: 'ONE-TIME',
      year: String(new Date().getFullYear()),
      debit: (+s.fee || 0)
    }];
  } else {
    // ONLY show months explicitly added by admin! Do NOT generate dummy 12 months.
    rows = [];
  }

  // Credit payments in FIFO order against rows
  let remainingPaid = totalPaid;
  const ledger = rows.map(r => {
    const debit = r.debit;
    const credit = Math.min(debit, remainingPaid);
    remainingPaid = Math.max(0, remainingPaid - credit);
    const due = Math.max(0, debit - credit);
    return {
      id: r.id,
      date: r.date,
      month: r.month,
      year: r.year,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      due: due.toFixed(2)
    };
  });

  return ledger;
}

function renderStudentLedgerTable(s){
  const ledger = getStudentMonthlyLedger(s);
  let totalDebit = 0, totalCredit = 0, totalDue = 0;
  ledger.forEach(r => {
    totalDebit += (+r.debit || 0);
    totalCredit += (+r.credit || 0);
    totalDue += (+r.due || 0);
  });

  return `
    <div class="mobile-table-hint">👉 Swipe table left & right to view all months and dues</div>
    <div class="dues-table-wrap">
      <table class="dues-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Due Month</th>
            <th>Due Year</th>
            <th>Debit Amount</th>
            <th>Credit Amount</th>
            <th>Due Amount</th>
          </tr>
        </thead>
        <tbody>
          ${ledger.length ? ledger.map(r => `
            <tr>
              <td>${esc(r.date)}</td>
              <td><b>${esc(r.month)}</b></td>
              <td>${esc(r.year)}</td>
              <td><b>₹${r.debit}</b></td>
              <td><span class="paid-val">₹${r.credit}</span></td>
              <td><span class="${+r.due > 0 ? 'due-val' : 'paid-val'}">₹${r.due}</span></td>
            </tr>
          `).join('') : `<tr><td colspan="6" style="padding:28px;text-align:center;color:#64748b;font-size:14px">ℹ️ No monthly dues added yet for this student. Use "Add Due Month" above or "Apply Monthly Fee Bill" to schedule dues.</td></tr>`}
        </tbody>
        <tfoot>
          <tr style="background:#3d688c;color:#ffffff;font-weight:700">
            <td colspan="3" style="text-align:right;padding:10px 14px;border:1px solid #3d688c;color:#ffffff">Total Summary:</td>
            <td style="padding:10px 14px;border:1px solid #3d688c;color:#ffffff">₹${totalDebit.toFixed(2)}</td>
            <td style="padding:10px 14px;border:1px solid #3d688c;color:#a7f3d0">₹${totalCredit.toFixed(2)}</td>
            <td style="padding:10px 14px;border:1px solid #3d688c;color:${totalDue > 0 ? '#fecaca' : '#a7f3d0'}">₹${totalDue.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function addSingleStudentBill(uid){
  const s = sOf(uid);
  if(!s) return uiToast('Student not found', 'error');
  const month = val('ledgerAddMonth');
  const year = val('ledgerAddYear') || String(new Date().getFullYear());
  const debitAmt = +val('ledgerAddAmt') || (+s.fee || 500);
  const billDate = val('ledgerAddDate') || today();

  if(!db.bills) db.bills = [];
  const billId = `b_${s.uid}_${year}_${month}`.toLowerCase();
  const existingIdx = db.bills.findIndex(b => b.id.toLowerCase() === billId);
  if(existingIdx >= 0){
    db.bills[existingIdx].debit = debitAmt;
    db.bills[existingIdx].date = billDate;
  } else {
    db.bills.push({
      id: billId,
      inst: I(),
      uid: s.uid,
      date: billDate,
      month: month,
      year: year,
      debit: debitAmt,
      credit: 0,
      due: debitAmt
    });
  }

  save(true);
  uiToast(`Monthly due for ${month} ${year} added for ${s.name}!`, 'success');
  viewStudentLedgerModal(uid);
  renderFeesTable($('#feeSearch') ? $('#feeSearch').value : '');
}

function viewStudentLedgerModal(uid){
  closeCustomModal();
  const s = sOf(uid);
  if(!s) return uiToast('Student not found', 'error');
  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:12px!important;box-sizing:border-box!important;margin:0!important;';

  overlay.innerHTML = `
    <div class="ledger-modal-box" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;border-bottom:1px solid #e2e8f0;padding-bottom:12px;gap:10px">
        <div>
          <h3 style="margin:0;color:#0f172a;font-size:18px">🧾 Month-by-Month Fee Ledger</h3>
          <p style="margin:4px 0 0;font-size:13px;color:#64748b">Student: <b>${esc(s.name)}</b> (${esc(s.uid)}) • Class: <b>${esc(s.cls||'General')}</b> • Fee: ₹${s.fee||500}</p>
        </div>
        <button type="button" onclick="closeCustomModal()" style="background:#f1f5f9;color:#64748b;border:0;border-radius:50%;width:32px;height:32px;min-width:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;flex-shrink:0">✕</button>
      </div>

      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 14px;margin-bottom:16px">
        <div style="font-weight:700;font-size:13px;color:#166534;margin-bottom:8px">➕ Add Due Month for this Student (One-by-One)</div>
        <div class="ledger-add-grid">
          <div>
            <label style="font-size:11px;font-weight:600;color:#166534;display:block;margin-bottom:4px">Month</label>
            <select id="ledgerAddMonth" style="margin:0;padding:6px 10px;font-size:13px;border-color:#86efac;background:#ffffff">
              ${MONTH_NAMES_SHORT.map((m, idx) => `<option value="${m}" ${idx === new Date().getMonth() ? 'selected' : ''}>${m} (${MONTH_NAMES_FULL[idx]})</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#166534;display:block;margin-bottom:4px">Year</label>
            <select id="ledgerAddYear" style="margin:0;padding:6px 10px;font-size:13px;border-color:#86efac;background:#ffffff">
              ${[new Date().getFullYear()-1, new Date().getFullYear(), new Date().getFullYear()+1].map(y => `<option value="${y}" ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#166534;display:block;margin-bottom:4px">Amount (₹)</label>
            <input id="ledgerAddAmt" type="number" value="${s.fee || 500}" style="margin:0;padding:6px 10px;font-size:13px;border-color:#86efac;background:#ffffff">
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#166534;display:block;margin-bottom:4px">Billing Date</label>
            <input id="ledgerAddDate" type="date" value="${today()}" style="margin:0;padding:6px 10px;font-size:13px;border-color:#86efac;background:#ffffff">
          </div>
          <button type="button" onclick="addSingleStudentBill('${esc(s.uid)}')" style="background:#16a34a;color:#ffffff;padding:8px 16px;font-size:13px;font-weight:700;border:0;border-radius:6px;cursor:pointer;white-space:nowrap">Add Month</button>
        </div>
      </div>

      ${renderStudentLedgerTable(s)}
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
        <button type="button" class="secondary" onclick="closeCustomModal()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function generateMonthlyBill(){
  const month = val('billMonth');
  const year = val('billYear') || String(new Date().getFullYear());
  const target = val('billClass') || 'ALL';
  const customAmt = val('billAmount');
  const billDate = val('billDate') || today();

  let targetStudents = [];
  if(target === 'ALL'){
    targetStudents = mine('students');
  } else if(target.startsWith('student:')){
    const targetUid = target.replace('student:', '').trim().toLowerCase();
    const st = mine('students').find(s => String(s.uid||'').toLowerCase().trim() === targetUid);
    if(st) targetStudents = [st];
  } else if(target.startsWith('class:')){
    const targetCls = target.replace('class:', '').trim().toLowerCase();
    targetStudents = mine('students').filter(s => String(s.cls||'').toLowerCase().trim() === targetCls);
  } else {
    targetStudents = mine('students').filter(s => s.cls === target);
  }

  if(!targetStudents.length){
    return uiToast('No students found for selected target', 'warning');
  }

  if(!db.bills) db.bills = [];
  let addedCount = 0;
  targetStudents.forEach(s => {
    const debitAmt = (customAmt && +customAmt > 0) ? +customAmt : (+s.fee || 500);
    const billId = `b_${s.uid}_${year}_${month}`.toLowerCase();
    const existingIdx = db.bills.findIndex(b => b.id.toLowerCase() === billId);
    if(existingIdx >= 0){
      db.bills[existingIdx].debit = debitAmt;
      db.bills[existingIdx].date = billDate;
    } else {
      db.bills.push({
        id: billId,
        inst: I(),
        uid: s.uid,
        date: billDate,
        month: month,
        year: year,
        debit: debitAmt,
        credit: 0,
        due: debitAmt
      });
    }
    addedCount++;
  });

  save(true);
  uiToast(`Monthly fee bill for ${month} ${year} applied to ${addedCount} student(s)!`, 'success');
  renderFeesTable($('#feeSearch') ? $('#feeSearch').value : '');
}

function buildFeesTable(studentsList){
  return `
    <div class="mobile-table-hint">👉 Swipe table left & right to view all student fee columns</div>
    ${tbl(['Student Name','Class','Fee Plan','Total Billed','Total Paid','Pending Due','Record Payment','Fee Schedule'], studentsList.map(s => {
      const f = feeInfo(s);
      return [
        `<b>${esc(s.name)}</b><div style="font-size:11px;color:#64748b">${esc(s.uid)}</div>`,
        `<span class="pill">${esc(s.cls)||'-'}</span>`,
        `<span class="pill purple">${s.feeType} / ₹${s.fee||0}</span>`,
        '₹' + f.total,
        `<span style="color:#10b981;font-weight:700">₹${f.paid}</span>`,
        `<span class="${f.due ? 'due' : 'ok'}">₹${f.due}</span>`,
        `<div style="display:flex;gap:6px;align-items:center;min-width:145px">
          <input id="p_${s.uid}" type="number" placeholder="₹" style="width:75px;margin:0;padding:6px 8px;font-size:13px">
          <button onclick="pay('${s.uid}')" style="padding:6px 12px;font-size:12px;white-space:nowrap">Collect</button>
        </div>`,
        `<button type="button" class="secondary" onclick="viewStudentLedgerModal('${esc(s.uid)}')" style="padding:6px 10px;font-size:12px;white-space:nowrap" title="View Month-by-Month Dues Table">📋 Ledger</button>`
      ];
    }), 'fees-main-table')}
  `;
}

function renderFeesTable(filterText){
  const term = (filterText || '').trim().toLowerCase();
  const all = mine('students');
  const filtered = term ? all.filter(s => s.name.toLowerCase().includes(term) || s.uid.toLowerCase().includes(term) || (s.cls||'').toLowerCase().includes(term)) : all;
  const container = $('#feesTableContainer');
  if(container) container.innerHTML = buildFeesTable(filtered);
}

function buildReceiptsHistoryTable(paysList){
  return `
    <div class="mobile-table-hint">👉 Swipe table left & right to view all payment receipts</div>
    ${tbl(['Receipt No', 'Payment Date', 'Student Name', 'Class', 'Amount Paid', 'Official Receipt'], paysList.slice().reverse().map(p => {
      const st = sOf(p.uid) || { name: 'Student', cls: '-' };
      return [
        `<b style="font-family:monospace;color:#1e3a8a;font-size:13px">${esc(p.id)}</b>`,
        esc(p.date),
        `<b>${esc(st.name)}</b><div style="font-size:11px;color:#64748b">${esc(p.uid)}</div>`,
        `<span class="pill">${esc(st.cls||'General')}</span>`,
        `<b style="color:#059669;font-size:14px">₹${p.amt}</b>`,
        `<button type="button" class="secondary" onclick='receipt("${esc(p.id)}")' style="padding:6px 12px;font-size:12px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px">🧾 View Receipt</button>`
      ];
    }), 'receipts-main-table')}
  `;
}

function renderReceiptsHistoryTable(filterText){
  const term = (filterText || '').trim().toLowerCase();
  const all = ((db && db.pays) ? db.pays : []).filter(p => p.inst === I());
  const filtered = term ? all.filter(p => {
    const st = sOf(p.uid) || { name: '', uid: '' };
    return String(p.id||'').toLowerCase().includes(term) ||
           String(st.name||'').toLowerCase().includes(term) ||
           String(st.uid||'').toLowerCase().includes(term) ||
           String(p.date||'').toLowerCase().includes(term);
  }) : all;
  const container = $('#receiptsTableContainer');
  if(container) container.innerHTML = buildReceiptsHistoryTable(filtered);
}

const tbl=(h,rows,cls='')=>`<div class="table-wrap"><table class="${cls}"><thead><tr>${h.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${h.length}" class="empty-state"><div class="empty-icon">📂</div><div>No records found</div></td></tr>`}</tbody></table></div>`;
const classOpts=()=>mine('classes').map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const ICONS = {
  'Classes & Subjects': '🏫',
  'Teachers': '👨‍🏫',
  'Teacher Payout': '💰',
  'Students': '🎓',
  'Attendance': '📅',
  'Teacher Attendance': '👨‍🏫',
  'Fees & Dues': '💳',
  'Timetable': '🕒',
  'Study Material': '📚',
  'Announcements': '📢',
  'Online Exams': '📝',
  'Online Exam': '📝',
  'My Subjects': '📖',
  'My Profile': '👤',
  'Fees & Receipts': '🧾',
  'Institute Logo': '🖼️',
  'Public Logo': '🖼️',
  'Institutes': '🏛️'
};

/* ---------- Header Stats Helpers ---------- */
function instStatsHeader(){
  const stus=mine('students'), subs=mine('subjects');
  const tchs=db.users.filter(u=>u.role==='teacher'&&u.inst===I());
  const totalFee=stus.reduce((a,s)=>a+feeInfo(s).total,0);
  const paidFee=stus.reduce((a,s)=>a+feeInfo(s).paid,0);
  const dueFee=Math.max(0,totalFee-paidFee);
  const ins=db.insts.find(i=>i.id===I());
  return `<div class="welcome-banner">
    <div>
      <h2>🏛️ ${esc((ins&&ins.name)||'Institute')} Management Portal</h2>
      <p>Manage courses, teachers, students, fees, and academic records in real-time.</p>
    </div>
    <div><span class="pill" style="background:#fff;color:#1e3a8a;font-weight:700">Login ID: ${esc(I())}</span></div>
  </div>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-icon stat-blue">🎓</div><div><div class="stat-val">${stus.length}</div><div class="stat-label">Total Students</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-green">👨‍🏫</div><div><div class="stat-val">${tchs.length}</div><div class="stat-label">Total Teachers</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-purple">🏫</div><div><div class="stat-val">${mine('classes').length}</div><div class="stat-label">Classes (${subs.length} Subjects)</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-amber">💳</div><div><div class="stat-val">₹${dueFee}</div><div class="stat-label">Pending Dues (₹${paidFee} Paid)</div></div></div>
  </div>`;
}

function teacherHeader(){
  const subs=db.subjects.filter(s=>s.teacher===U.id);
  const myClasses=[...new Set(subs.map(s=>s.cls))];
  return `<div class="welcome-banner" style="background:linear-gradient(135deg,#0f766e 0%,#0d9488 100%)">
    <div>
      <h2>👨‍🏫 Welcome, ${esc(U.name)}!</h2>
      <p>Teacher Portal • ${subs.length} Assigned Subjects • Classes: ${myClasses.join(', ')||'None'}</p>
    </div>
    <div><span class="pill" style="background:#fff;color:#0f766e;font-weight:700">Teacher ID: ${esc(U.id)}</span></div>
  </div>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-icon stat-blue">📖</div><div><div class="stat-val">${subs.length}</div><div class="stat-label">My Subjects</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-green">🏫</div><div><div class="stat-val">${myClasses.length}</div><div class="stat-label">Assigned Classes</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-purple">📚</div><div><div class="stat-val">${mine('mats').length}</div><div class="stat-label">Study Notes</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-amber">📢</div><div><div class="stat-val">${mine('ann').length}</div><div class="stat-label">Announcements</div></div></div>
  </div>`;
}

function studentHeader(){
  const s=sOf(U.id) || { name: (U&&U.name)||'Student', uid: (U&&U.id)||'', cls: '', join: today(), done: false };
  const a=((db&&db.att)?db.att:[]).filter(x=>x.uid===(U&&U.id));
  const attRate=a.length?Math.round((a.filter(x=>x.p).length/a.length)*100):100;
  const f=feeInfo(s);
  return `<div class="welcome-banner" style="background:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%)">
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      ${s.photo?`<img class="ph" style="border:3px solid #fff;width:64px;height:64px" src="${s.photo}">`:`<div style="width:64px;height:64px;border-radius:50%;background:#fff;color:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:26px">🎓</div>`}
      <div>
        <h2>Welcome, ${esc(s.name)}!</h2>
        <p>Class: <b style="color:#fff">${esc(s.cls||'General')}</b> • User ID: <code style="background:rgba(255,255,255,0.2);padding:2px 8px;border-radius:4px;color:#fff">${esc(s.uid)}</code> • Joined: ${s.join}</p>
      </div>
    </div>
    <div>
      <span class="pill ${s.done?'green':''}" style="background:#fff;color:${s.done?'#065f46':'#b45309'};font-weight:700">${s.done?'✅ Profile Verified':'⚠️ Profile Incomplete'}</span>
    </div>
  </div>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-icon stat-green">📅</div><div><div class="stat-val">${attRate}%</div><div class="stat-label">Attendance (${a.filter(x=>x.p).length}/${a.length} Days)</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-blue">💳</div><div><div class="stat-val">₹${f.paid}</div><div class="stat-label">Fee Paid (Total ₹${f.total})</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-amber">⚠️</div><div><div class="stat-val">₹${f.due}</div><div class="stat-label">${f.due>0?'Fee Balance Due':'Fees Cleared!'}</div></div></div>
    <div class="stat-card"><div class="stat-icon stat-purple">📝</div><div><div class="stat-val">${mine('exams').filter(e=>e.cls===s.cls).length}</div><div class="stat-label">Class Exams</div></div></div>
  </div>`;
}

/* ---------- tab definitions per role ---------- */
const T={
admin:{
  'Institutes':()=>`<div class=card><h3>🏛️ Add New Institute</h3>
  <div class=grid><input id=in_n placeholder="Institute name e.g. Oxford Academy"><input id=in_e placeholder="Institute Email (for password recovery)"><input id=in_l placeholder="Location / City"><input id=in_d placeholder="Other details / Phone"></div>
  <p style="font-size:13px;color:#64748b;margin:6px 0 12px">* Institute Login ID is automatically set from the Institute Name. Password is auto-generated.</p>
  <button onclick="addInst()">Add Institute</button></div>
  <div class=card><div class="card-header"><h3>Registered Institutes (${db.insts.length})</h3></div>
  ${tbl(['Name','Location','Details','Login ID','Password','Action'],db.insts.map(i=>{const u=db.users.find(x=>x.id===i.id)||{pw:'-'};return[esc(i.name),esc(i.loc),esc(i.det),`<span class="pill">${i.id}</span>`,`<span style="font-family:monospace;font-weight:600;color:#0f766e">${esc(u.pw)}</span>`,`<div style="display:flex;gap:6px"><button type="button" class="secondary" onclick="resetInstPw('${esc(i.id)}')" style="padding:6px 10px;font-size:12px;cursor:pointer">🔑 Reset PW</button><button type="button" class=red onclick="delInst('${esc(i.id)}')" style="padding:6px 12px;font-size:12px;cursor:pointer">Delete</button></div>`]}))}</div>`,
  'Public Logo':()=>`<div class=card><h3>🖼️ Public Logo</h3>
  <div style="display:flex;align-items:center;gap:18px;margin:16px 0 20px">
    <div class="logo mid" style="margin:0">${db.logo?`<img src="${db.logo}">`:'LOGO'}</div>
    <div>
      <h4 style="margin:0 0 6px">Round Logo Preview</h4>
      <p style="color:#64748b;margin:0;font-size:13px">This logo will appear as a circular icon in the top header and public login screen.</p>
    </div>
  </div>
  <input type=file id=lg accept="image/*">
  <button onclick="readFile($('#lg'),d=>{db.logo=d;save();setLogo();alert('Logo saved successfully!');go(tab)})">Upload & Save Logo</button></div>`
},
institute:{
 'Classes & Subjects':()=>`${instStatsHeader()}<div class=card><h3>🏫 Manage Classes</h3>
  <div style="display:flex;gap:10px;margin-bottom:14px;max-width:500px">
    <input id=cn placeholder="Class name e.g. Class 10" style="margin:0">
    <button onclick="addClass()">Add Class</button>
  </div>
  <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px">${mine('classes').map(c=>{
    const count=mine('students').filter(s=>String(s.cls||'').toLowerCase().trim()===String(c.name||'').toLowerCase().trim()).length;
    return`<span class="pill" style="margin:0;display:inline-flex;align-items:center;gap:8px;padding:6px 12px;font-size:13px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:20px">
      <span>🏫 <b>${esc(c.name)}</b> <span style="opacity:0.75;font-weight:normal">(${count} student${count===1?'':'s'})</span></span>
      <button type="button" onclick="delClass('${esc(c.name)}')" title="Delete Class ${esc(c.name)}" style="background:none;border:none;color:#ef4444;cursor:pointer;padding:0 2px;font-size:15px;line-height:1;font-weight:bold" onmouseover="this.style.color='#dc2626'" onmouseout="this.style.color='#ef4444'">✕</button>
    </span>`;
  }).join('')||'<span style="color:#94a3b8">No classes added yet</span>'}</div></div>
  <div class=card><h3>📚 Add Subject (Compulsory / Optional, Teacher & Pay Rate)</h3>
  <div class=grid>
    <input id=sn placeholder="Subject name e.g. Mathematics">
    <select id=sc>${classOpts()}</select>
    <select id=stype>
      <option value="compulsory">📌 Compulsory Subject</option>
      <option value="optional">⭐ Optional / Elective Subject</option>
    </select>
    <select id=st><option value="">-- Assign Teacher --</option>${db.users.filter(u=>u.role==='teacher'&&u.inst===I()).map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
    <input id=srate type=number placeholder="Teacher Pay (₹ / class) e.g. 500">
    <input id=sf type=number placeholder="Student fee / month (optional)">
  </div>
  <button onclick="addSub()">Add Subject</button>
  <div style="margin-top:20px">${tbl(['Subject','Class','Type','Teacher Assigned','Teacher Pay (₹/class)','Student Fee','Action'],mine('subjects').map(s=>[
    `<b>${esc(s.name)}</b>`,
    `<span class=pill>${esc(s.cls)}</span>`,
    `<span class="pill ${s.type==='optional'?'purple':''}">${s.type==='optional'?'Optional':'Compulsory'}</span>`,
    esc((db.users.find(u=>u.id===s.teacher)||{}).name||'Unassigned'),
    `<b style="color:#059669">₹${s.perClassRate || s.rate || 0} / class</b>`,
    s.fee?'₹'+s.fee:'Free',
    `<div style="display:flex;gap:6px">
      <button type="button" class="secondary" onclick="editSubjectRatePrompt('${esc(s.name)}','${esc(s.cls)}', ${s.perClassRate || s.rate || 0})" style="padding:5px 8px;font-size:12px">✏️ Rate</button>
      <button type="button" class="red" onclick="delSub('${esc(s.name)}','${esc(s.cls)}')" style="padding:5px 10px;font-size:12px">Delete</button>
    </div>`
  ]))}</div></div>`,

 'Teachers':()=>`${instStatsHeader()}<div class=card><h3>👨‍🏫 Add New Teacher</h3>
  <div style="display:flex;gap:10px;margin-bottom:8px;max-width:650px;flex-wrap:wrap">
    <input id=tn placeholder="Teacher full name" style="margin:0;flex:1;min-width:180px">
    <input id=te placeholder="Teacher email (for password recovery)" style="margin:0;flex:1;min-width:200px">
    <button onclick="addTeacher()">Add Teacher</button>
  </div>
  <p style="font-size:12px;color:#64748b;margin:0 0 4px">* Faculty User ID for login is set to their name. Password is auto-generated.</p>
  </div>
  <div class=card>
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
      <h3 id="teachersCountHeader">Active Faculty Members (${(db.users||[]).filter(u=>u.role==='teacher'&&u.inst===I()).length})</h3>
      <button type="button" class="secondary" onclick="go('Teacher Payout')" style="font-weight:700;color:#059669">💰 View Teacher Payout</button>
    </div>
    <div id="teachersTableContainer">
      ${buildTeachersTable()}
    </div>
  </div>`,

 'Teacher Payout':()=>renderTeacherPayoutView(),

 'Students':()=>`${instStatsHeader()}<div class=card><h3>🎓 Enroll New Student</h3>
  <div class=grid><input id=nm placeholder="Student full name"><input id=em placeholder="Email address">
  <input id=cl list="classList" placeholder="Class (type or select)"><datalist id="classList">${mine('classes').map(c=>`<option value="${esc(c.name)}">`).join('')}</datalist>
  <input id=jd type=date value="${today()}">
  <select id=ft><option value=month>Monthly fee</option><option value=one>One-time fee</option><option value=subject>Per-subject fee</option></select>
  <input id=fe type=number placeholder="Fee amount (₹)"></div>
  <p style="font-size:12px;color:#64748b;margin:4px 0 12px">* Student User ID will be their name. Password is auto-generated. Type any class name or choose from existing.</p>
  <button onclick="addStudent()">Add Student</button>
  <hr style="border:0;border-top:1px solid #e2e8f0;margin:20px 0">
  <h4 style="margin:0 0 10px">Bulk Upload Student List (CSV)</h4>
  <p style="font-size:12px;color:#64748b;margin:0 0 10px">Format: name, email, class, joindate (YYYY-MM-DD), feeType (month/one/subject), fee</p>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <input type=file id=csv accept=".csv" style="max-width:320px;margin:0">
    <button class="secondary" onclick="readText($('#csv'),importCsv)">Import CSV</button>
  </div></div>
  <div class=card>
    <div class="card-header">
      <h3>Enrolled Students (${mine('students').length})</h3>
    </div>
    <div class="search-bar">
      <span class="search-icon">🔍</span>
      <input id="stuSearch" oninput="renderStudentsTable(this.value)" placeholder="Search students by name, class, or User ID...">
    </div>
    <div id="stuTableContainer">
      ${buildStudentsTable(mine('students'))}
    </div>
  </div>`,

 'Attendance':()=>`${instStatsHeader()}${attView()}`,

 'Fees & Dues':()=>`${instStatsHeader()}
  <div class=card style="border-left:4px solid #3b82f6">
    <div class="card-header">
      <h3>📅 Add / Apply Monthly Fee Bill</h3>
    </div>
    <p style="color:#64748b;font-size:13px;margin:0 0 14px">Select Month, Year, and Target. Pressing "Apply Monthly Dues" automatically adds the bill to all matching student dashboards and fee schedules.</p>
    <div class="fee-bill-controls">
      <div>
        <label class="form-label">Due Month</label>
        <select id="billMonth">
          ${MONTH_NAMES_SHORT.map((m, idx) => `<option value="${m}" ${idx === new Date().getMonth() ? 'selected' : ''}>${m} (${MONTH_NAMES_FULL[idx]})</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label">Due Year</label>
        <select id="billYear">
          ${[new Date().getFullYear()-1, new Date().getFullYear(), new Date().getFullYear()+1].map(y => `<option value="${y}" ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label">Target (Class or Single Student)</label>
        <select id="billClass">
          <option value="ALL">🌐 All Classes (All Students)</option>
          <optgroup label="Classes">
            ${mine('classes').map(c=>`<option value="class:${esc(c.name)}">${esc(c.name)}</option>`).join('')}
          </optgroup>
          <optgroup label="Single Student (One-by-One)">
            ${mine('students').map(st => `<option value="student:${esc(st.uid)}">👤 ${esc(st.name)} (${esc(st.uid)}) - ${esc(st.cls||'General')}</option>`).join('')}
          </optgroup>
        </select>
      </div>
      <div>
        <label class="form-label">Custom Amount (₹) (Optional)</label>
        <input id="billAmount" type="number" placeholder="Default student fee">
      </div>
      <div>
        <label class="form-label">Billing Date</label>
        <input id="billDate" type="date" value="${today()}">
      </div>
    </div>
    <button type="button" onclick="generateMonthlyBill()" style="margin-top:14px;padding:10px 22px">⚡ Apply Monthly Dues</button>
  </div>
  <div class=card>
    <div class="card-header">
      <h3 id="feesCountHeader">Fee Collection & Student Dues (${mine('students').length})</h3>
    </div>
    <div class="search-bar" style="margin-bottom:16px">
      <span class="search-icon">🔍</span>
      <input id="feeSearch" oninput="renderFeesTable(this.value)" placeholder="Search by student name, User ID, or class...">
    </div>
    <div id="feesTableContainer">
      ${buildFeesTable(mine('students'))}
    </div>
  </div>
  <div class=card style="margin-top:20px">
    <div class="card-header">
      <h3 id="receiptsCountHeader">💳 Payment Receipts History (${((db&&db.pays)?db.pays:[]).filter(p=>p.inst===I()).length})</h3>
    </div>
    <div class="search-bar" style="margin-bottom:16px">
      <span class="search-icon">🔍</span>
      <input id="receiptSearch" oninput="renderReceiptsHistoryTable(this.value)" placeholder="Search receipts by student name, User ID, or Receipt No...">
    </div>
    <div id="receiptsTableContainer">
      ${buildReceiptsHistoryTable(((db&&db.pays)?db.pays:[]).filter(p=>p.inst===I()))}
    </div>
  </div>`,

 'Timetable':()=>`${instStatsHeader()}<div class=card><h3>🕒 Update Class Schedule</h3>
  <div class=grid>
    <select id=tc>${classOpts()}</select>
    <select id=td>${DAYS.map(d=>`<option>${d}</option>`).join('')}</select>
    <input id=tt placeholder="Time e.g. 09:00 - 10:00 AM">
    <input id=ts list="ttSubList" placeholder="Subject name">
    <datalist id="ttSubList">${mine('subjects').map(s=>`<option value="${esc(s.name)}">${esc(s.name)} (${esc(s.cls)})</option>`).join('')}</datalist>
  </div>
  <button onclick="addTT()">Add Timetable Slot</button></div>
  <div class=card><div class="card-header"><h3>Active Class Timetables</h3></div>${ttTable(mine('tt'),true)}</div>`,

 'Study Material':()=>`${instStatsHeader()}${matView()}`,
 'Announcements':()=>`${instStatsHeader()}${annView()}`,

 'Online Exams':()=>`${instStatsHeader()}<div class=card><h3>📝 Create Online Exam</h3>
  <div class=grid><input id=et placeholder="Exam title e.g. Midterm Physics Test"><select id=ec>${classOpts()}</select></div>
  <label class="form-label">Questions & Answer Options (One question per line):</label>
  <textarea id=eq rows=5 placeholder="Question?|option A|option B|option C|option D|correct option number (1-4)&#10;Example: What is 5+5?|8|10|12|15|2"></textarea>
  <button onclick="addExam()">Publish Exam</button></div>
  <div class=card><div class="card-header"><h3>Scheduled Exams (${mine('exams').length})</h3></div>
  ${tbl(['Exam Title','Class','Questions','Status','Actions'],mine('exams').map(e=>[esc(e.title),`<span class=pill>${esc(e.cls)}</span>`,e.qs.length+' Questions',e.open?'<span class=ok>ACTIVE</span>':'<span class=due>CLOSED</span>',`<div style="display:flex;gap:6px"><button class="secondary" onclick="togExam('${e.id}')">${e.open?'Close':'Open'}</button><button class=red onclick="delExam('${e.id}')">Delete</button></div>`]))}</div>
  <div class=card><div class="card-header"><h3>Exam Results & Submissions</h3></div>
  ${tbl(['Student','Exam Title','Score Awarded'],mine('res').map(r=>[esc((sOf(r.uid)||{}).name),esc((db.exams.find(e=>e.id===r.exam)||{}).title),`<span class="pill green" style="font-weight:700">${r.score} / ${r.total}</span>`]))}</div>`,

 'Institute Logo':()=> {
   const instId = I();
   const ins = db.insts.find(i => i.id === instId || (i.id && i.id.toLowerCase() === String(instId).toLowerCase())) || {};
   const currLogo = ins.logo || '';
   return `${instStatsHeader()}<div class=card>
    <div class="card-header"><h3>🖼️ Upload Institute Official Logo</h3></div>
    <p style="color:#64748b;font-size:14px;margin:6px 0 20px">Upload your institute's official logo or emblem. This logo will be displayed in <b>big size in the center</b> of the full-screen welcome screen when anyone logs in, as well as on top headers and login cards.</p>
    <div style="display:flex;align-items:center;gap:24px;margin-bottom:24px;flex-wrap:wrap">
      <div id="instLogoPreviewBox" style="width:160px;height:160px;border-radius:50%;border:4px solid #00f0ff;box-shadow:0 0 35px rgba(0,240,255,0.45);display:flex;align-items:center;justify-content:center;background:#ffffff;overflow:hidden">
        ${currLogo ? `<img id="instLogoPreviewImg" src="${currLogo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : `<span style="font-size:54px;color:#3b82f6;font-weight:900">🏛️</span>`}
      </div>
      <div style="flex:1;min-width:240px">
        <h4 style="margin:0 0 8px;font-size:16px;color:#0f172a">Circular Emblem & Welcome Preview</h4>
        <p style="color:#64748b;margin:0 0 14px;font-size:13px">Recommended: Square PNG, JPG, or SVG image (at least 300x300 pixels). The circular glowing frame will be applied automatically.</p>
        <input type="file" id="instLogoFileInput" accept="image/*" onchange="previewInstLogoFile(this)" style="max-width:350px;margin-bottom:8px">
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button type="button" onclick="uploadInstLogo()">💾 Upload & Save Logo</button>
      ${ins.logo ? `<button type="button" class="secondary red" onclick="removeInstLogo()">Remove Custom Logo</button>` : ''}
    </div>
   </div>`;
 }
},
teacher:{
 'My Subjects':()=>`${teacherHeader()}<div class=card><div class="card-header"><h3>📖 Assigned Subjects & Classes</h3></div>
  ${tbl(['Subject Name','Class','Enrolled Students'],db.subjects.filter(s=>s.teacher===U.id).map(s=>[esc(s.name),`<span class=pill>${esc(s.cls)}</span>`,mine('students').filter(st=>st.cls===s.cls).length+' Students']))}</div>`,
 'Attendance':()=>`${teacherHeader()}${attView()}`,
 'Study Material':()=>`${teacherHeader()}${matView()}`,
 'Announcements':()=>`${teacherHeader()}${annView()}`,
 'Timetable':()=>`${teacherHeader()}<div class=card><div class="card-header"><h3>🕒 Teaching Schedule</h3></div>${ttTable(mine('tt'),false)}</div>`
},
student:{
 'My Profile':()=>{
  const s=sOf(U.id) || { name: (U&&U.name)||'Student', email: '', phone: '', addr: '', cls: '', join: today(), photo: '', optSubs: '[]' };
  const classSubs = mine('subjects').filter(sub => sub.cls === s.cls);
  const compSubs = classSubs.filter(sub => sub.type !== 'optional');
  const optSubs = classSubs.filter(sub => sub.type === 'optional');
  let selectedOpts = [];
  try { selectedOpts = JSON.parse(s.optSubs || '[]'); } catch(e) { selectedOpts = []; }

  return `${studentHeader()}<div class=card>
   <h3>👤 Student Profile & Subjects</h3>
   <div style="display:flex;gap:20px;align-items:center;margin:16px 0 20px;flex-wrap:wrap">
     ${s.photo?`<img class=ph src="${s.photo}">`:`<div class="ph" style="display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-size:24px">👤</div>`}
     <div>
       <label class="form-label">Upload Profile Photo:</label>
       <input type=file id=ph accept="image/*" style="max-width:300px">
     </div>
   </div>
   <div class=grid>
     <div><label class="form-label">Full Name (Locked)</label><input id=pn value="${esc(s.name||'')}" readonly disabled style="background:#f1f5f9;cursor:not-allowed"></div>
     <div><label class="form-label">Email Address (Locked)</label><input id=pe value="${esc(s.email||'')}" readonly disabled style="background:#f1f5f9;cursor:not-allowed"></div>
     <div><label class="form-label">Phone Number</label><input id=pp value="${esc(s.phone||'')}" placeholder="e.g. 9876543210"></div>
     <div><label class="form-label">Address</label><input id=pa value="${esc(s.addr||'')}" placeholder="Home Address"></div>
   </div>
   <p style="font-size:12px;color:#64748b;margin:4px 0 16px">* Name and Email are permanently registered with your institute and cannot be changed by student.</p>

   ${compSubs.length ? `
     <div style="margin:16px 0;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
       <div style="font-weight:700;margin-bottom:8px;color:#1e293b">📌 Compulsory Subjects (Mandatory for ${esc(s.cls||'Class')}):</div>
       <div style="display:flex;gap:8px;flex-wrap:wrap">
         ${compSubs.map(cs => `<span class="pill" style="font-weight:600">${esc(cs.name)}</span>`).join('')}
       </div>
     </div>
   ` : ''}

   ${optSubs.length ? `
     <div style="margin:16px 0;padding:14px;background:#fffbeb;border:1px solid #fef3c7;border-radius:8px">
       <div style="font-weight:700;margin-bottom:8px;color:#92400e">⭐ Optional / Elective Subjects (Select Your Subjects):</div>
       <div style="display:flex;gap:14px;flex-wrap:wrap">
         ${optSubs.map(os => `
           <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
             <input type="checkbox" class="opt-sub-cb" value="${esc(os.name)}" ${selectedOpts.includes(os.name) ? 'checked' : ''} style="width:auto;margin:0">
             <span style="font-weight:600;color:#78350f">${esc(os.name)}</span>
           </label>
         `).join('')}
       </div>
     </div>
   ` : ''}

   <button onclick="saveProfile()" style="margin-top:10px">Save Profile Details</button>
   <div style="margin-top:14px;font-size:13px;color:#64748b">Class: <b>${esc(s.cls||'General')}</b> • Registration Date: <b>${s.join||today()}</b></div>
  </div>`},

 'Fees & Receipts':()=>{
  const s=sOf(U.id) || { name: (U&&U.name)||'Student', cls: '', join: today() }, f=feeInfo(s);
  return `${studentHeader()}
  <div class=card>
   <div class="card-header"><h3>🧾 Fee Status & Receipts</h3></div>
   <div class="fee-summary-grid">
     <div class="fee-summary-card">
       <div class="fee-card-title">Total Billed Fee</div>
       <div class="fee-card-val" style="color:#0f172a">₹${f.total}</div>
     </div>
     <div class="fee-summary-card" style="background:#ecfdf5;border-color:#a7f3d0">
       <div class="fee-card-title" style="color:#065f46">Amount Paid</div>
       <div class="fee-card-val" style="color:#059669">₹${f.paid}</div>
     </div>
     <div class="fee-summary-card" style="background:${f.due>0?'#fef2f2':'#ecfdf5'};border-color:${f.due>0?'#fecaca':'#a7f3d0'}">
       <div class="fee-card-title" style="color:${f.due>0?'#991b1b':'#065f46'}">Pending Balance Due</div>
       <div class="fee-card-val" style="color:${f.due>0?'#dc2626':'#059669'}">₹${f.due}</div>
     </div>
   </div>
   <div class="card-header" style="margin-top:20px">
     <h4 style="margin:0;font-size:16px;color:#1e3a8a">📅 Month-by-Month Dues Schedule</h4>
   </div>
   ${renderStudentLedgerTable(s)}
   <div class="card-header" style="margin-top:24px">
     <h4 style="margin:0;font-size:16px;color:#1e3a8a">💳 Payment Receipts History</h4>
   </div>
   <div class="mobile-table-hint">👉 Swipe table left & right to view payment receipts</div>
   ${tbl(['Receipt No','Payment Date','Amount Paid','Official Receipt'],((db&&db.pays)?db.pays:[]).filter(p=>p.uid===(U&&U.id)).slice().reverse().map(p=>[
     `<b style="font-family:monospace;color:#1e3a8a;font-size:13px">${esc(p.id)}</b>`,
     esc(p.date),
     `<b style="color:#059669;font-size:14px">₹${p.amt}</b>`,
     `<button type="button" class="secondary" onclick='receipt("${esc(p.id)}")' style="padding:6px 12px;font-size:12px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px">🧾 View Receipt</button>`
   ]), 'receipts-main-table')}
  </div>`},

 'Attendance':()=>{
  const s = sOf(U.id) || { cls: '' };
  const myAtt = ((db && db.att) ? db.att : []).filter(x => x.uid === (U && U.id));
  const allSubs = mine('subjects').filter(sub => sub.cls === s.cls);
  
  let optList = [];
  try { optList = JSON.parse(s.optSubs || '[]'); } catch(e) { optList = []; }

  const enrolledSubs = allSubs.filter(sub => {
    if(sub.type === 'optional'){
      return optList.length === 0 || optList.includes(sub.name);
    }
    return true;
  });

  const subRows = enrolledSubs.map(sub => {
    const subAtt = myAtt.filter(a => a.sub === sub.name || (!a.sub && enrolledSubs.length === 1));
    const total = subAtt.length;
    const present = subAtt.filter(a => a.p).length;
    const absent = total - present;
    const pct = total > 0 ? Math.round((present / total) * 100) : 100;
    const teacherObj = (db.users || []).find(u => u.id === sub.teacher) || {};
    const statusPill = pct >= 75 ? `<span class="ok">Good (${pct}%)</span>` : `<span class="due">Low (${pct}%)</span>`;
    return [
      `<b>${esc(sub.name)}</b>`,
      `<span class="pill ${sub.type === 'optional' ? 'purple' : ''}">${sub.type === 'optional' ? 'Optional' : 'Compulsory'}</span>`,
      esc(teacherObj.name || 'Assigned Faculty'),
      total + ' Classes',
      `<span style="color:#10b981;font-weight:700">${present}</span>`,
      `<span style="color:#ef4444;font-weight:700">${absent}</span>`,
      `<b>${pct}%</b>`,
      statusPill
    ];
  });

  const totalDays = myAtt.length;
  const presentDays = myAtt.filter(x => x.p).length;
  const overallPct = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

  return `${studentHeader()}
  <div class=card>
    <div class="card-header">
      <h3>📊 Subject-Wise Attendance Breakdown</h3>
    </div>
    <div style="display:flex;gap:16px;margin:8px 0 18px;flex-wrap:wrap">
      <div style="flex:1;min-width:140px;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0;text-align:center">
        <div style="font-size:12px;color:#64748b">Total Sessions</div>
        <div style="font-size:22px;font-weight:800;color:#0f172a">${totalDays}</div>
      </div>
      <div style="flex:1;min-width:140px;background:#ecfdf5;padding:12px;border-radius:8px;border:1px solid #a7f3d0;text-align:center">
        <div style="font-size:12px;color:#065f46">Present</div>
        <div style="font-size:22px;font-weight:800;color:#059669">${presentDays}</div>
      </div>
      <div style="flex:1;min-width:140px;background:#fef2f2;padding:12px;border-radius:8px;border:1px solid #fecaca;text-align:center">
        <div style="font-size:12px;color:#991b1b">Absent</div>
        <div style="font-size:22px;font-weight:800;color:#dc2626">${totalDays - presentDays}</div>
      </div>
      <div style="flex:1;min-width:140px;background:#eff6ff;padding:12px;border-radius:8px;border:1px solid #bfdbfe;text-align:center">
        <div style="font-size:12px;color:#1e40af">Overall Rate</div>
        <div style="font-size:22px;font-weight:800;color:#2563eb">${overallPct}%</div>
      </div>
    </div>
    ${subRows.length ? tbl(['Subject','Type','Faculty','Classes Held','Present','Absent','Attendance %','Status'], subRows) : '<p style="color:#64748b">No subjects scheduled for this class yet.</p>'}
  </div>
  <div class=card>
    <div class="card-header"><h3>📅 Recent Attendance Logs</h3></div>
    ${tbl(['Date','Subject','Status'], myAtt.slice().reverse().map(x => [x.date, esc(x.sub || 'General Class'), x.p ? '<span class="ok">Present</span>' : '<span class="due">Absent</span>']))}
  </div>`;
 },

 'Timetable':()=>{
  const s=sOf(U.id) || { cls: '' };
  return `${studentHeader()}<div class=card>
   <div class="card-header"><h3>🕒 Weekly Class Schedule (${esc(s.cls||'General')})</h3></div>
   ${ttTable(mine('tt').filter(t=>t.cls===s.cls),false)}</div>`},
 'Study Material':()=>`${studentHeader()}${matView()}`,
 'Announcements':()=>`${studentHeader()}${annView()}`,
 'Online Exam':()=>{
  const s=sOf(U.id) || { cls: '' };
  return `${studentHeader()}<div class=card>
   <div class="card-header"><h3>📝 Available Online Tests & Quizzes</h3></div>
   ${tbl(['Exam Title','Exam Status'],mine('exams').filter(e=>e.cls===s.cls).map(e=>{const r=((db&&db.res)?db.res:[]).find(x=>x.exam===e.id&&x.uid===(U&&U.id));return[esc(e.title),r?`<span class="pill green" style="font-weight:700">Completed: ${r.score}/${r.total}</span>`:e.open?`<button onclick="startExam('${e.id}')">Start Test</button>`:'<span class="due">Closed</span>']}))}</div>
   <div id=exam></div>`},
 'Teacher Attendance':()=>renderMonitorTeacherAttendanceView()
}
};

/* ---------- shared views ---------- */
function ttTable(list,del){
  return tbl(['Class','Day','Time Slot','Subject','Assigned Faculty',del?'Action':''],list.map(t=>{
    const subObj = mine('subjects').find(x => x.cls === t.cls && x.name === t.sub);
    const teacherName = subObj && subObj.teacher ? ((db.users||[]).find(u => u.id === subObj.teacher)||{}).name || subObj.teacher : '<span style="color:#94a3b8">Unassigned</span>';
    return [
      esc(t.cls),
      `<span class="pill">${t.day}</span>`,
      esc(t.time),
      `<b>${esc(t.sub)}</b>`,
      teacherName,
      del?`<button class=red onclick="delTT(${db.tt.indexOf(t)})">Remove</button>`:''
    ];
  }));
}

function attView(){
  const isTeacher = (U && U.role === 'teacher');
  let teacherSubs = [];
  if(isTeacher){
    teacherSubs = mine('subjects').filter(s => s.teacher === U.id);
  }

  if(isTeacher && !teacherSubs.length){
    return `<div class=card>
      <div class="card-header"><h3>📅 Daily Attendance Register</h3></div>
      <div class="empty-state" style="padding:40px 20px">
        <div class="empty-icon">⚠️</div>
        <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px">No Subjects Assigned</div>
        <div style="color:#64748b;max-width:460px;margin:auto">You have not been assigned any subject by the Institute Admin yet. Please ask your Institute Admin to assign your subject(s) in Classes & Subjects.</div>
      </div>
    </div>`;
  }

  return `<div class=card>
    <div class="card-header"><h3>📅 Daily Attendance Register</h3></div>
    <div class=grid style="max-width:700px">
      ${isTeacher ? `
        <div>
          <label class="form-label">Assigned Subject</label>
          <select id="asub" onchange="onTeacherSubSelect(this.value)">
            ${teacherSubs.map(s => `<option value="${esc(s.name)}__${esc(s.cls)}">${esc(s.name)} (${esc(s.cls)})</option>`).join('')}
          </select>
          <input type="hidden" id="ac" value="${esc(teacherSubs[0].cls)}">
        </div>
      ` : `
        <div>
          <label class="form-label">Select Class</label>
          <select id="ac" onchange="go(tab,this.value)">${classOpts()}</select>
        </div>
        <div>
          <label class="form-label">Subject (Optional)</label>
          <select id="asub" onchange="attList()">
            <option value="">-- All / General Class --</option>
            ${mine('subjects').map(s => `<option value="${esc(s.name)}">${esc(s.name)} (${esc(s.cls)})</option>`).join('')}
          </select>
        </div>
      `}
      <div>
        <label class="form-label">Date ${isTeacher ? '(Today Only - Locked)' : ''}</label>
        <input id="ad" type="date" value="${today()}" ${isTeacher ? `min="${today()}" max="${today()}" readonly disabled style="background:#f1f5f9;cursor:not-allowed"` : `onchange="attList()"`}>
      </div>
    </div>
    ${isTeacher ? `<p style="font-size:12px;color:#64748b;margin:6px 0 12px">🔒 Faculty members can only mark attendance for the current day (${today()}). Past dates and upcoming dates are locked.</p>` : ''}
    <div style="display:flex;gap:10px;margin:10px 0 16px">
      <button type="button" class="secondary" onclick="markAllAtt(true)">✅ Mark All Present</button>
      <button type="button" class="secondary" onclick="markAllAtt(false)">❌ Mark All Absent</button>
    </div>
    <div id=al></div>
  </div>`;
}

function onTeacherSubSelect(val){
  if(!val) return;
  const parts = val.split('__');
  const cls = parts[1] || '';
  if($('#ac')) $('#ac').value = cls;
  attList();
}

function markAllAtt(present){
  document.querySelectorAll('.ack').forEach(c=>c.checked=present);
}

function attList(){
  const c=$('#ac')?$('#ac').value:'';
  let subVal=$('#asub')?$('#asub').value:'';
  if(subVal.includes('__')) subVal=subVal.split('__')[0];
  const d=$('#ad')?$('#ad').value:today();

  const stus=mine('students').filter(s=>s.cls===c);
  if(!stus.length){
    $('#al').innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div>No students enrolled in this class yet.</div></div>';
    return;
  }

  const existingAtt = (db.att || []).filter(a => a.date === d && a.cls === c && (subVal ? a.sub === subVal : true));

  $('#al').innerHTML = tbl(['Student Name','Present Status'],stus.map(s=>{
    const existing = existingAtt.find(a => a.uid === s.uid);
    const isChecked = existing ? existing.p : true;
    return [
      `<b>${esc(s.name)}</b> <span style="font-size:12px;color:#64748b">(${esc(s.uid)})</span>`,
      `<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type=checkbox style="width:auto;margin:0" class=ack value="${s.uid}" ${isChecked?'checked':''}> <span style="font-weight:600;color:#10b981">Present</span></label>`
    ];
  })) + `<button onclick="saveAtt()" style="margin-top:14px">💾 Save Attendance</button>`;
}

function matView(){
  const can=(!U || U.role!=='student'),s=(U && U.role==='student')?sOf(U.id):null;
  const myMats = mine('mats').filter(m => (!s || m.cls === s.cls) && String(m.inst||'').toLowerCase().trim() === String(I()).toLowerCase().trim());
  return `${can?`<div class=card><h3>📚 Upload Notes / PDF Material</h3>
    <div class=grid><input id=mt placeholder="Document / Lecture Title"><select id=mc>${classOpts()}</select><input type=file id=mf></div>
    <button onclick="addMat()">Upload Material</button></div>`:''}
    <div class=card><div class="card-header"><h3>Shared Course Materials</h3></div>
    ${tbl(['Document Title','Class','Download Link'],myMats.map(m=>[esc(m.title),`<span class=pill>${esc(m.cls)}</span>`,`<a href="${m.data}" download="${esc(m.name)}" style="color:#2563eb;font-weight:600;text-decoration:none">📥 Download File</a>`]))}</div>`;
}

function annView(){
  const can = (!U || U.role !== 'student');
  const myAnn = mine('ann');
  const annWithIndices = myAnn.map(a => ({
    ann: a,
    idx: db.ann.indexOf(a)
  })).reverse();
  const headers = can ? ['Date Posted', 'Announcement Message', 'Action'] : ['Date Posted', 'Announcement Message'];
  const rows = annWithIndices.map(item => {
    const a = item.ann;
    const dateCell = `<span class="pill">${esc(a.date)}</span>`;
    const msgCell = `<div style="font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(a.text)}</div>`;
    if(can){
      const actionCell = `
        <button type="button" class="red" onclick="delAnn(${item.idx})" style="padding:6px 12px;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px" title="Delete this notice">
          <span>🗑️</span><span>Delete</span>
        </button>
      `;
      return [dateCell, msgCell, actionCell];
    }
    return [dateCell, msgCell];
  });

  return `${can ? `<div class="card">
    <h3>📢 Post New Announcement</h3>
    <textarea id="at" rows="3" placeholder="Write an announcement for students and staff..."></textarea>
    <button onclick="addAnn()">Broadcast Announcement</button>
  </div>` : ''}
  <div class="card">
    <div class="card-header"><h3>Notice Board (${myAnn.length})</h3></div>
    ${tbl(headers, rows)}
  </div>`;
}

/* ---------- Teacher Attendance (Class Monitor) ---------- */
function renderMonitorTeacherAttendanceView(){
  const s = sOf(U.id);
  if(!s || !s.isMonitor){
    return `<div class=card>
      <div class="empty-state" style="padding:40px 20px">
        <div class="empty-icon">⚠️</div>
        <h3>Access Restricted</h3>
        <p>This section is only accessible to appointed Class Monitors.</p>
      </div>
    </div>`;
  }

  const todayDay = WEEKDAYS[new Date().getDay()];
  const todayDate = today();
  const selectedDay = window._monitorSelectedDay || todayDay;

  // Timetable entries for this class and selected day
  const classTT = mine('tt').filter(t => t.cls === s.cls && t.day === selectedDay);

  return `${studentHeader()}
  <div class=card style="border-left:4px solid #16a34a">
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <h3 style="margin:0;color:#1e3a8a">⭐ Class Monitor: Teacher Attendance Register</h3>
        <p style="margin:4px 0 0;font-size:13px;color:#64748b">
          Class: <b>${esc(s.cls)}</b> • Monitor: <b>${esc(s.name)}</b> (${esc(s.uid)}) • Date: <b>${todayDate}</b> (${todayDay})
        </p>
      </div>
      <div>
        <span class="pill green" style="font-weight:700">⭐ Class Monitor Active</span>
      </div>
    </div>
    
    <div style="background:#f8fafc;padding:14px;border-radius:8px;border:1px solid #e2e8f0;margin:16px 0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:10px">
        <label style="font-size:13px;font-weight:700;color:#1e293b">Select Day of Schedule:</label>
        <select id="monitorDaySelect" onchange="changeMonitorDay(this.value)" style="margin:0;padding:6px 12px;font-size:13px;font-weight:600">
          ${DAYS.map(d => `<option value="${d}" ${d === selectedDay ? 'selected' : ''}>${d} ${d === todayDay ? '(Today)' : ''}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:13px;color:#64748b">
        Scheduled Sessions for <b>${esc(s.cls)}</b>: <b>${classTT.length} Classes</b>
      </div>
    </div>

    ${classTT.length ? `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time Slot</th>
              <th>Subject</th>
              <th>Assigned Faculty</th>
              <th>Status</th>
              <th>Attendance Action</th>
            </tr>
          </thead>
          <tbody>
            ${classTT.map(t => {
              const subObj = mine('subjects').find(x => x.cls === t.cls && x.name === t.sub);
              const teacherId = subObj ? subObj.teacher : '';
              const teacherUser = db.users.find(u => u.id === teacherId);
              const teacherName = teacherUser ? teacherUser.name : (subObj && subObj.teacher ? subObj.teacher : 'Unassigned');

              const rec = ((db && db.teacherAtt) ? db.teacherAtt : []).find(a => 
                a.inst === I() && a.cls === t.cls && a.sub === t.sub && a.date === todayDate && a.time === t.time
              );

              let statusBadge = '<span class="pill" style="background:#f1f5f9;color:#64748b">⏳ Not Marked Yet</span>';
              if(rec){
                if(rec.status === 'P'){
                  statusBadge = '<span class="pill green" style="font-weight:700;font-size:13px">✅ Present</span>';
                } else if(rec.status === 'A'){
                  statusBadge = '<span class="pill red" style="font-weight:700;font-size:13px">❌ Absent</span>';
                }
              }

              return `
                <tr>
                  <td><b>${esc(t.time)}</b></td>
                  <td><b>${esc(t.sub)}</b></td>
                  <td>
                    <b>${esc(teacherName)}</b>
                    ${teacherId ? `<div style="font-size:11px;color:#64748b">${esc(teacherId)}</div>` : ''}
                  </td>
                  <td>${statusBadge}</td>
                  <td>
                    <div style="display:flex;gap:8px;align-items:center">
                      <button type="button" onclick="recordTeacherAttendance('${esc(t.day)}', '${esc(t.cls)}', '${esc(t.sub)}', '${esc(t.time)}', '${esc(teacherId)}', 'P')" style="background:${rec&&rec.status==='P'?'#15803d':'#16a34a'};color:#ffffff;border:0;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">
                        ✅ Present
                      </button>
                      <button type="button" onclick="recordTeacherAttendance('${esc(t.day)}', '${esc(t.cls)}', '${esc(t.sub)}', '${esc(t.time)}', '${esc(teacherId)}', 'A')" style="background:${rec&&rec.status==='A'?'#b91c1c':'#dc2626'};color:#ffffff;border:0;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">
                        ❌ Absent
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    ` : `
      <div style="padding:30px;text-align:center;color:#64748b;background:#f8fafc;border-radius:8px">
        <p style="margin:0 0 6px;font-weight:600">No scheduled classes found in timetable for ${esc(s.cls)} on ${selectedDay}.</p>
        <p style="font-size:12px;margin:0">Ask your Institute Admin to configure the Timetable for ${esc(s.cls)}.</p>
      </div>
    `}
  </div>`;
}

function changeMonitorDay(dayVal){
  window._monitorSelectedDay = dayVal;
  go(tab);
}

function recordTeacherAttendance(day, cls, sub, timeSlot, teacherId, status){
  if(!db.teacherAtt) db.teacherAtt = [];
  const todayDate = today();
  const monitorStudent = sOf(U.id);
  const monitorUid = monitorStudent ? monitorStudent.uid : U.id;
  const attId = `ta_${I()}_${cls}_${sub}_${todayDate}_${timeSlot}`.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

  const existingIdx = db.teacherAtt.findIndex(a => 
    a.id === attId || 
    (a.inst === I() && a.cls === cls && a.sub === sub && a.date === todayDate && a.time === timeSlot)
  );

  const subObj = mine('subjects').find(x => x.cls === cls && x.name === sub);

  const record = {
    id: attId,
    inst: I(),
    teacher: teacherId || (subObj ? subObj.teacher : ''),
    sub: sub,
    cls: cls,
    day: day,
    time: timeSlot,
    date: todayDate,
    status: status,
    monitor: monitorUid
  };

  if(existingIdx >= 0){
    db.teacherAtt[existingIdx] = record;
  } else {
    db.teacherAtt.push(record);
  }

  save(true);
  const statusLabel = status === 'P' ? 'Present' : 'Absent';
  uiToast(`Faculty attendance for "${sub}" marked ${statusLabel}!`, status === 'P' ? 'success' : 'info');
  go(tab);
}

/* ---------- Teacher Payout (Institute Admin) ---------- */
function renderTeacherPayoutView(){
  const teachers = (db.users || []).filter(u => u.role === 'teacher' && u.inst === I());
  const teacherAtts = ((db && db.teacherAtt) ? db.teacherAtt : []).filter(a => a.inst === I());
  const subjects = mine('subjects');

  let totalClassesConducted = 0;
  let totalPayoutDisbursed = 0;

  const teacherRows = teachers.map(t => {
    const mySubs = subjects.filter(s => s.teacher === t.id);
    const myAtts = teacherAtts.filter(a => a.teacher === t.id || (mySubs.some(s => s.name === a.sub && s.cls === a.cls)));
    const presentClasses = myAtts.filter(a => a.status === 'P');
    const absentClasses = myAtts.filter(a => a.status === 'A');

    let salary = 0;
    presentClasses.forEach(att => {
      const sObj = mySubs.find(s => s.name === att.sub && s.cls === att.cls) || subjects.find(s => s.name === att.sub && s.cls === att.cls);
      const rate = sObj ? (+sObj.perClassRate || +sObj.rate || 0) : 0;
      salary += rate;
    });

    totalClassesConducted += presentClasses.length;
    totalPayoutDisbursed += salary;

    const subDisplay = mySubs.length ? mySubs.map(s => 
      `<div style="font-size:12px;margin-bottom:2px"><b>${esc(s.name)}</b> (${esc(s.cls)}) • <span style="color:#059669;font-weight:600">₹${s.perClassRate||s.rate||0}/class</span></div>`
    ).join('') : '<span style="color:#94a3b8;font-size:12px">No subjects assigned</span>';

    return [
      `<b>${esc(t.name)}</b><div style="font-size:11px;color:#64748b">${esc(t.id)}</div>`,
      subDisplay,
      `<button type="button" class="secondary" onclick="viewTeacherPayoutModal('${esc(t.id)}')" style="font-weight:800;color:#1e40af;padding:4px 10px;font-size:13px;cursor:pointer" title="Click to view full day-wise and date-wise class logs">${presentClasses.length} Classes 📊</button>`,
      `<span style="color:#ef4444;font-weight:700">${absentClasses.length}</span>`,
      `<b style="color:#059669;font-size:16px">₹${salary.toFixed(2)}</b>`,
      `<div style="display:flex;gap:6px">
        <button type="button" class="secondary" onclick="viewTeacherPayoutModal('${esc(t.id)}')" style="padding:6px 10px;font-size:12px;white-space:nowrap">📋 Class Logs</button>
      </div>`
    ];
  });

  return `${instStatsHeader()}
  <div class=card style="border-left:4px solid #059669">
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <h3 style="margin:0">💰 Faculty Payout & Attendance Earnings</h3>
        <p style="margin:4px 0 0;font-size:13px;color:#64748b">
          Automatic salary calculation based on daily teacher attendance taken by appointed Class Monitors.
        </p>
      </div>
      <div>
        <button type="button" class="secondary" onclick="go('Classes & Subjects')" style="font-size:13px">📚 Set Subject Rates</button>
      </div>
    </div>

    <div style="display:flex;gap:16px;margin:16px 0 20px;flex-wrap:wrap">
      <div style="flex:1;min-width:160px;background:#f8fafc;padding:14px;border-radius:8px;border:1px solid #e2e8f0;text-align:center">
        <div style="font-size:12px;color:#64748b">Active Faculty</div>
        <div style="font-size:24px;font-weight:800;color:#0f172a">${teachers.length}</div>
      </div>
      <div style="flex:1;min-width:160px;background:#eff6ff;padding:14px;border-radius:8px;border:1px solid #bfdbfe;text-align:center">
        <div style="font-size:12px;color:#1d4ed8">Total Classes Conducted</div>
        <div style="font-size:24px;font-weight:800;color:#1e40af">${totalClassesConducted}</div>
      </div>
      <div style="flex:1;min-width:160px;background:#ecfdf5;padding:14px;border-radius:8px;border:1px solid #a7f3d0;text-align:center">
        <div style="font-size:12px;color:#065f46">Total Calculated Salary Payout</div>
        <div style="font-size:24px;font-weight:800;color:#059669">₹${totalPayoutDisbursed.toFixed(2)}</div>
      </div>
    </div>

    ${tbl(['Teacher Name', 'Assigned Subjects & Rates', 'Total Classes Conducted', 'Missed / Absent', 'Total Salary Payout', 'Class Details'], teacherRows)}
  </div>`;
}

function viewTeacherPayoutModal(teacherId){
  closeCustomModal();
  const t = (db.users || []).find(u => u.id === teacherId);
  if(!t) return uiToast('Teacher not found', 'error');

  const subjects = mine('subjects');
  const mySubs = subjects.filter(s => s.teacher === t.id);
  const teacherAtts = ((db && db.teacherAtt) ? db.teacherAtt : []).filter(a => 
    a.inst === I() && (a.teacher === t.id || mySubs.some(s => s.name === a.sub && s.cls === a.cls))
  );

  const presentClasses = teacherAtts.filter(a => a.status === 'P');
  const absentClasses = teacherAtts.filter(a => a.status === 'A');

  let totalSalary = 0;
  presentClasses.forEach(att => {
    const sObj = mySubs.find(s => s.name === att.sub && s.cls === att.cls) || subjects.find(s => s.name === att.sub && s.cls === att.cls);
    const rate = sObj ? (+sObj.perClassRate || +sObj.rate || 0) : 0;
    totalSalary += rate;
  });

  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';

  overlay.innerHTML = `
    <div style="background:#ffffff;border-radius:12px;padding:24px;max-width:880px;width:100%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);position:relative;max-height:90vh;overflow-y:auto;border:1px solid #e2e8f0" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;border-bottom:1px solid #e2e8f0;padding-bottom:12px">
        <div>
          <h3 style="margin:0;color:#0f172a;font-size:18px">📋 Teacher Class Breakdown & Salary Logs</h3>
          <p style="margin:4px 0 0;font-size:13px;color:#64748b">Teacher: <b>${esc(t.name)}</b> (${esc(t.id)}) • Calculated Salary: <b style="color:#059669">₹${totalSalary.toFixed(2)}</b></p>
        </div>
        <button type="button" onclick="closeCustomModal()" style="background:#f1f5f9;color:#64748b;border:0;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px">✕</button>
      </div>

      <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
        <div style="flex:1;min-width:130px;background:#ecfdf5;border:1px solid #a7f3d0;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:11px;color:#065f46">Conducted (Present)</div>
          <div style="font-size:20px;font-weight:800;color:#059669">${presentClasses.length} Classes</div>
        </div>
        <div style="flex:1;min-width:130px;background:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:11px;color:#991b1b">Missed (Absent)</div>
          <div style="font-size:20px;font-weight:800;color:#dc2626">${absentClasses.length} Classes</div>
        </div>
        <div style="flex:1;min-width:130px;background:#f0fdf4;border:1px solid #86efac;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:11px;color:#166534">Total Salary Earned</div>
          <div style="font-size:20px;font-weight:800;color:#16a34a">₹${totalSalary.toFixed(2)}</div>
        </div>
      </div>

      <h4 style="margin:0 0 10px;color:#1e293b;font-size:15px">📅 Date-Wise & Day-Wise Class Records</h4>
      ${teacherAtts.length ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>Time Slot</th>
                <th>Subject & Class</th>
                <th>Marked By (Monitor)</th>
                <th>Attendance</th>
                <th>Pay Rate Earned</th>
              </tr>
            </thead>
            <tbody>
              ${teacherAtts.slice().reverse().map(att => {
                const sObj = mySubs.find(s => s.name === att.sub && s.cls === att.cls) || subjects.find(s => s.name === att.sub && s.cls === att.cls);
                const rate = sObj ? (+sObj.perClassRate || +sObj.rate || 0) : 0;
                const earned = att.status === 'P' ? rate : 0;
                const monStudent = sOf(att.monitor);
                const monDisplay = monStudent ? `${monStudent.name} (${att.monitor})` : (att.monitor || 'Monitor');

                return `
                  <tr>
                    <td><b>${esc(att.date)}</b></td>
                    <td><span class="pill">${esc(att.day)}</span></td>
                    <td>${esc(att.time || '-')}</td>
                    <td><b>${esc(att.sub)}</b> <span style="font-size:12px;color:#64748b">(${esc(att.cls)})</span></td>
                    <td><span style="font-size:12px;color:#475569">👤 ${esc(monDisplay)}</span></td>
                    <td>${att.status === 'P' ? '<span class="ok">✅ Present</span>' : '<span class="due">❌ Absent</span>'}</td>
                    <td><b style="color:${att.status === 'P' ? '#059669' : '#94a3b8'}">₹${earned.toFixed(2)}</b></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <p style="padding:24px;text-align:center;color:#64748b;background:#f8fafc;border-radius:8px">No class attendance recorded yet for this faculty member. Class attendance is marked daily by the appointed Class Monitor.</p>
      `}

      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
        <button type="button" class="secondary" onclick="closeCustomModal()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}


function buildStudentsTable(studentsList){
  return tbl(['Photo','Name','Class','Role','User ID','Password','Joined','Fee Plan','Action'],studentsList.map(s=>{
    const u = db.users.find(x => x.id === s.uid || (x.id && x.id.toLowerCase() === String(s.uid).toLowerCase())) || {};
    const pwDisplay = u.pw ? `<code style="font-family:monospace;font-weight:700;color:#047857;background:#ecfdf5;padding:4px 8px;border-radius:6px;border:1px solid #a7f3d0;font-size:13px">${esc(u.pw)}</code>` : '<span style="color:#94a3b8">-</span>';
    const monitorBadge = s.isMonitor ? `<span class="pill green" style="font-weight:700">⭐ Class Monitor</span>` : `<span style="color:#94a3b8;font-size:12px">Student</span>`;
    const monitorBtn = s.isMonitor ?
      `<button type="button" class="secondary" onclick="toggleStudentMonitor('${esc(s.uid)}', false)" style="padding:6px 10px;font-size:12px;background:#fef2f2;color:#dc2626;border-color:#fecaca" title="Remove as Class Monitor">Remove Monitor</button>` :
      `<button type="button" class="secondary" onclick="toggleStudentMonitor('${esc(s.uid)}', true)" style="padding:6px 10px;font-size:12px;background:#f0fdf4;color:#16a34a;border-color:#bbf7d0" title="Set this student as Class Monitor for ${esc(s.cls)}">⭐ Make Monitor</button>`;

    return [
      s.photo?`<img class="ph sm" src="${s.photo}">`:'<div class="ph sm" style="display:flex;align-items:center;justify-content:center;background:#e2e8f0;font-size:14px">👤</div>',
      `<b>${esc(s.name)}</b>`,
      `<span class="pill" style="cursor:pointer" onclick="editStuClass('${s.uid}')" title="Click to edit class">${esc(s.cls)||'<span style=\'color:#dc2626;font-weight:bold\'>Set Class</span>'} ✏️</span>`,
      monitorBadge,
      `<span class="pill">${esc(s.uid)}</span>`,
      pwDisplay,
      s.join,
      `<span class="pill purple">${s.feeType} / ₹${s.fee}</span>`,
      `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${monitorBtn}
        <button type="button" class="secondary" onclick="editStudentModal('${esc(s.uid)}')" style="padding:6px 10px;font-size:12px;cursor:pointer" title="Edit Student Details">✏️ Edit</button>
        <button type="button" class="secondary" onclick="resetStudentPw('${esc(s.uid)}')" style="padding:6px 10px;font-size:12px;cursor:pointer" title="Reset Student Password">🔑 Reset</button>
        <button type="button" class="red" onclick="delStu('${esc(s.uid)}')" style="padding:6px 12px;font-size:12px;cursor:pointer">Delete</button>
      </div>`
    ];
  }));
}

function toggleStudentMonitor(uid, make){
  const s = sOf(uid);
  if(!s) return uiToast('Student not found', 'error');
  if(make){
    // Reset any previous monitor for this class so there is 1 active monitor
    mine('students').filter(x => x.cls === s.cls).forEach(x => { x.isMonitor = false; });
    s.isMonitor = true;
    uiToast(`⭐ ${s.name} is now appointed as Class Monitor for ${s.cls}!`, 'success');
  } else {
    s.isMonitor = false;
    uiToast(`Removed ${s.name} as Class Monitor`, 'info');
  }
  save(true);
  renderStudentsTable($('#stuSearch') ? $('#stuSearch').value : '');
}

function renderStudentsTable(filterText){
  const term=(filterText||'').trim().toLowerCase();
  const all=mine('students');
  const filtered=term ? all.filter(s=>s.name.toLowerCase().includes(term)||s.uid.toLowerCase().includes(term)||(s.cls||'').toLowerCase().includes(term)) : all;
  const container=$('#stuTableContainer');
  if(container) container.innerHTML=buildStudentsTable(filtered);
}

function buildTeachersTable(){
  const teachers = (db.users || []).filter(u => u.role === 'teacher' && u.inst === I());
  if(!teachers.length){
    return '<p style="color:#64748b;font-size:13px;padding:14px 0">No faculty members added yet.</p>';
  }
  return tbl(['Name','User ID','Login Password','Action'], teachers.map(t => {
    const pwDisplay = t.pw ? `<code style="font-family:monospace;font-weight:700;color:#047857;background:#ecfdf5;padding:4px 8px;border-radius:6px;border:1px solid #a7f3d0;font-size:13px">${esc(t.pw)}</code>` : '<span style="color:#94a3b8">-</span>';
    return [
      `<b>${esc(t.name)}</b>`,
      `<span class="pill">${esc(t.id)}</span>`,
      pwDisplay,
      `<div style="display:flex;gap:6px;align-items:center">
        <button type="button" class="secondary" onclick="resetTeacherPw('${esc(t.id)}')" style="padding:6px 10px;font-size:12px;cursor:pointer" title="Reset Faculty Password">🔑 Reset</button>
        <button type="button" class="red" onclick="delTeacher('${esc(t.id)}')" style="padding:6px 12px;font-size:12px;cursor:pointer" title="Delete Faculty Member">Delete</button>
      </div>`
    ];
  }));
}

function renderTeachersTable(){
  const container = $('#teachersTableContainer');
  if(container) container.innerHTML = buildTeachersTable();
  const th = $('#teachersCountHeader');
  if(th){
    th.textContent = `Active Faculty Members (${(db.users||[]).filter(u=>u.role==='teacher'&&u.inst===I()).length})`;
  }
}

/* ---------- dashboard initialization ---------- */
function go(t,cls){
  tab=t;
  const roleTabs = { ...T[U.role] };
  if(U.role === 'student'){
    const cs = sOf(U.id);
    if(cs && cs.isMonitor){
      roleTabs['Teacher Attendance'] = T.student['Teacher Attendance'];
    } else {
      delete roleTabs['Teacher Attendance'];
    }
  }
  const tabKeys = Object.keys(roleTabs);
  if(!tabKeys.includes(tab)) tab = tabKeys[0];
  $('#nav').innerHTML=tabKeys.map(k=>`
    <button class="${k===tab?'on':''}" onclick="go('${k}')">
      <span class="nav-icon">${ICONS[k]||'📌'}</span>
      <span>${k}</span>
    </button>
  `).join('');
  $('#view').innerHTML=roleTabs[tab]();
  if($('#ac')){if(cls)$('#ac').value=cls;attList()}
}

function checkWelcomeScreen(){
  if(!U) return;
  if(U.role === 'admin') return;
  // Show on login or if welcome preview requested or if not seen yet in this session
  if(sessionStorage.getItem('showWelcome')==='1' || sessionStorage.getItem('welcomed')!=='1' || location.search.includes('welcome=1')){
    showFullScreenWelcome();
  }
}

function readAndResizeImage(file, maxWidth, maxHeight, callback){
  if(!file) return callback('');
  const reader = new FileReader();
  reader.onload = function(e){
    const img = new Image();
    img.onload = function(){
      let width = img.width;
      let height = img.height;
      if(width > maxWidth || height > maxHeight){
        if(width > height){
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        } else {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      callback(dataUrl);
    };
    img.onerror = function(){
      callback(e.target.result);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function previewInstLogoFile(inp){
  if(inp && inp.files && inp.files[0]){
    readAndResizeImage(inp.files[0], 400, 400, (data)=>{
      const box = $('#instLogoPreviewBox');
      if(box && data){
        box.innerHTML = `<img id="instLogoPreviewImg" src="${data}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      }
    });
  }
}

function uploadInstLogo(){
  const inp = $('#instLogoFileInput');
  if(!inp || !inp.files || !inp.files[0]){
    uiAlert('No File Selected', 'Please select an image file to upload as your institute logo.');
    return;
  }
  const file = inp.files[0];
  readAndResizeImage(file, 400, 400, async (data) => {
    if(!data) return;
    const instId = I();
    let ins = db.insts.find(i => i.id === instId || (i.id && i.id.toLowerCase() === String(instId).toLowerCase()));
    if(ins){
      ins.logo = data;
    } else {
      ins = { id: instId, name: (U && U.name) || instId, logo: data, loc: '', det: '' };
      db.insts.push(ins);
    }

    // Direct dedicated sync to Turso backend
    try{
      await fetch('/api/institutes/logo', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ id: instId, logo: data })
      });
    }catch(err){
      console.warn('[Logo API Sync] warning:', err);
    }

    save(true);
    setLogo();
    uiToast('Institute logo uploaded and saved successfully!', 'success', 'Logo Saved');
    go(tab);
  });
}

function removeInstLogo(){
  uiConfirm('Remove Logo', 'Are you sure you want to remove the institute custom logo?', async (confirmed)=>{
    if(confirmed){
      const instId = I();
      let ins = db.insts.find(i => i.id === instId || (i.id && i.id.toLowerCase() === String(instId).toLowerCase()));
      if(ins) ins.logo = '';
      try{
        await fetch('/api/institutes/logo', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ id: instId, logo: '' })
        });
      }catch(err){}
      save(true);
      setLogo();
      uiToast('Institute custom logo removed.', 'info');
      go(tab);
    }
  });
}

function showFullScreenWelcome(){
  const el=$('#fullScreenWelcome');
  const app=$('#dashboardApp');
  if(!el) return;

  // Hide the dashboard application while full-screen welcome overlay is showing
  if(app) app.style.display='none';

  let instName='INSTITUTE';
  let logoSrc='';
  if(U){
    const instId = I();
    const ins = (instId && db && db.insts) ? db.insts.find(i => i.id === instId || (i.id && i.id.toLowerCase() === String(instId).toLowerCase())) : null;
    if(ins && ins.name) instName = ins.name;
    else if(U.role === 'institute' && U.name) instName = U.name;
    else if(U.role === 'institute' && U.id) instName = U.id;

    // Show ONLY the specific institute's uploaded logo, never another institute or system logo
    if(ins && ins.logo) logoSrc = ins.logo;
  }

  el.classList.add('active');
  el.style.cssText='display:flex!important;';
  el.innerHTML=`
    <div class="welcome-box">
      <div class="welcome-big-logo-wrap">
        ${logoSrc ? `
          <img src="${logoSrc}" class="welcome-big-logo-img" alt="${esc(instName)} Logo">
        ` : `
          <div class="welcome-big-logo-placeholder">
            <span class="welcome-placeholder-icon">🏛️</span>
            <span class="welcome-placeholder-text">${esc(instName)}</span>
          </div>
        `}
      </div>
      <div class="welcome-action-wrap">
        <button class="enter-dash-btn" id="enterDashBtn" onclick="enterDashboard()">
          Enter Dashboard →
        </button>
      </div>
    </div>
  `;
}

function enterDashboard(){
  sessionStorage.setItem('welcomed','1');
  sessionStorage.removeItem('showWelcome');
  const el=$('#fullScreenWelcome');
  const app=$('#dashboardApp');
  if(app){
    app.style.display='block';
    app.style.visibility='visible';
    app.style.opacity='1';
  }
  if(el){
    el.style.pointerEvents='none';
    el.style.animation='fadeOut 0.25s ease-out forwards';
    setTimeout(()=>{
      el.classList.remove('active');
      el.style.cssText='display:none!important;';
      el.style.animation='';
      el.innerHTML='';
    }, 250);
  }
  // Immediately render active view and header logo so all show
  if(typeof tab !== 'undefined' && tab && typeof go === 'function'){
    go(tab);
  } else if(U && typeof T !== 'undefined' && T[U.role]){
    go(Object.keys(T[U.role])[0]);
  }
  setLogo();
}

async function initDashboard(){
  if(!$('#view')) return;
  U=me();
  if(!U){ location.href='index.html'; return; }

  // Always fetch fresh data from Turso Cloud on dashboard load so other devices' changes show on the very first load!
  try{
    await fetchFromTurso(true);
  }catch(e){}

  // Ensure institute is set on U
  if(!U.inst){
    U.inst = getUserInstId(U);
    if(U.inst) try{ sessionStorage.setItem('u', JSON.stringify(U)); }catch(e){}
  }

  const app=$('#dashboardApp');
  if(app) app.style.display='block';
  const instId=I();
  const ins=(instId && db && db.insts) ? db.insts.find(i=>i.id===instId || (i.id&&i.id.toLowerCase()===String(instId).toLowerCase())) : null;
  const coachingName = (ins && ins.name) || (U.role==='institute'?U.name:'Coaching');
  const roleLabels={admin:'Super Admin',institute:'Institute Admin',teacher:'Faculty Member',student:'Student'};
  
  if($('#ttl')) $('#ttl').textContent='IGYR Smart Platform';
  if($('#subttl')) $('#subttl').textContent = (U.role === 'admin') ? 'Super Admin Portal' : (coachingName + ' Portal');
  if($('#userRolePill')) $('#userRolePill').textContent=roleLabels[U.role]||U.role;
  if($('#userName')) $('#userName').textContent=U.name||U.id;
  if($('#sidebarTitle')) $('#sidebarTitle').textContent=(roleLabels[U.role]||'MENU').toUpperCase()+' MENU';
  
  if($('#neonHeaderTitle')){
    $('#neonHeaderTitle').textContent = (U.role === 'admin') ? 'SUPER ADMIN' : coachingName.toUpperCase();
  }

  setLogo();
  checkWelcomeScreen();
  go(Object.keys(T[U.role])[0]);
}

if($('#view')){
  initDashboard();
}

/* ---------- Password Reset Handlers ---------- */
function resetInstPw(instId){
  closeCustomModal();
  if(!instId) return uiToast('Invalid institute identifier', 'error');

  const ins = db.insts.find(i=>i.id===instId || (i.id&&i.id.toLowerCase()===String(instId).toLowerCase())) || { id: instId, name: instId };
  let u = db.users.find(x=>x.id===instId || (x.id&&x.id.toLowerCase()===String(instId).toLowerCase()) || (x.role==='institute'&&x.inst===instId));
  if(!u){
    u = { id: instId, pw: rnd(6), role: 'institute', name: (ins&&ins.name)||instId, inst: instId };
    db.users.push(u);
    save(true);
  }

  const generatedPw = rnd(6);
  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';
  overlay.innerHTML = `
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#fef3c7!important;color:#b45309!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">🔑</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">Reset Institute Password</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalCloseX" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        <p>Set a new login password for institute <b>${esc(ins.name)}</b></p>
        <div style="background:#f8fafc;padding:12px;border-radius:10px;font-size:13px;margin:12px 0 16px;border:1px solid #e2e8f0">
          <div>Login ID: <code style="font-weight:700;color:#2563eb;font-size:14px">${esc(instId)}</code></div>
          <div style="margin-top:6px">Current Password: <span style="font-family:monospace;font-weight:600;color:#0f766e" id="currInstPwSpan">${esc(u.pw||'-')}</span></div>
        </div>
        <label class="form-label" style="font-weight:600">New Password:</label>
        <div style="display:flex;gap:8px">
          <input class="custom-modal-input" id="newInstPwInput" value="${generatedPw}" placeholder="Enter new password" style="margin:0" autocomplete="off">
          <button type="button" class="secondary" id="genInstPwBtn" style="padding:10px 14px;white-space:nowrap">🎲 Generate</button>
        </div>
      </div>
      <div class="custom-modal-footer" style="padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;">
        <button type="button" class="secondary" id="cancelResetInstBtn" style="padding:10px 18px">Cancel</button>
        <button type="button" class="primary" id="confirmResetInstBtn" style="padding:10px 22px">Save New Password</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#modalCloseX').onclick = () => closeCustomModal();
  overlay.querySelector('#cancelResetInstBtn').onclick = () => closeCustomModal();
  overlay.querySelector('#genInstPwBtn').onclick = () => {
    const inp = overlay.querySelector('#newInstPwInput');
    if(inp) inp.value = rnd(6);
  };

  overlay.querySelector('#confirmResetInstBtn').onclick = async () => {
    const inputEl = overlay.querySelector('#newInstPwInput');
    const newPw = (inputEl ? inputEl.value : '').trim();
    if(!newPw) return uiToast('Password cannot be empty', 'warning');

    u.pw = newPw;
    save(true);

    try{
      await fetch('/api/users/password',{
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: instId, pw: newPw})
      });
    }catch(err){
      console.warn('Backend password sync error:', err);
    }

    closeCustomModal();
    if(typeof go === 'function' && typeof tab !== 'undefined') go(tab);
    uiAlert('Password Updated Successfully', `Institute: ${ins.name}\nLogin ID: ${instId}\nNew Password: ${newPw}\n\nThe new password has been saved to Turso cloud database.`);
    uiToast(`Password for ${ins.name} reset to "${newPw}"`, 'success');
  };
}

function resetStudentPw(uid){
  closeCustomModal();
  if(!uid) return uiToast('Invalid student identifier', 'error');

  const s = db.students.find(x=>x.uid===uid || (x.uid&&x.uid.toLowerCase()===String(uid).toLowerCase())) || { uid: uid, name: uid, cls: '-' };
  let u = db.users.find(x=>x.id===uid || (x.id&&x.id.toLowerCase()===String(uid).toLowerCase()));
  if(!u){
    u = { id: uid, pw: rnd(6), role: 'student', name: (s&&s.name)||uid, inst: (s&&s.inst)||(typeof I==='function'?I():'') };
    db.users.push(u);
    save(true);
  }

  const generatedPw = rnd(6);
  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';
  overlay.innerHTML = `
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#eff6ff!important;color:#2563eb!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">🔑</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">Reset Student Password</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalCloseX" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        <p>Set a new password for student <b>${esc(s.name)}</b></p>
        <div style="background:#f8fafc;padding:12px;border-radius:10px;font-size:13px;margin:12px 0 16px;border:1px solid #e2e8f0">
          <div>Student Name: <b>${esc(s.name)}</b></div>
          <div style="margin-top:4px">User ID: <code style="font-weight:700;color:#2563eb">${esc(s.uid)}</code> • Class: <b>${esc(s.cls||'General')}</b></div>
          <div style="margin-top:4px">Current Password: <span style="font-family:monospace;font-weight:600;color:#0f766e" id="currStuPwSpan">${esc(u.pw||'-')}</span></div>
        </div>
        <label class="form-label" style="font-weight:600">New Password:</label>
        <div style="display:flex;gap:8px">
          <input class="custom-modal-input" id="newStuPwInput" value="${generatedPw}" placeholder="Enter new password" style="margin:0" autocomplete="off">
          <button type="button" class="secondary" id="genStuPwBtn" style="padding:10px 14px;white-space:nowrap">🎲 Generate</button>
        </div>
      </div>
      <div class="custom-modal-footer" style="padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;">
        <button type="button" class="secondary" id="cancelResetStuBtn" style="padding:10px 18px">Cancel</button>
        <button type="button" class="primary" id="confirmResetStuBtn" style="padding:10px 22px">Save Password</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#modalCloseX').onclick = () => closeCustomModal();
  overlay.querySelector('#cancelResetStuBtn').onclick = () => closeCustomModal();
  overlay.querySelector('#genStuPwBtn').onclick = () => {
    const inp = overlay.querySelector('#newStuPwInput');
    if(inp) inp.value = rnd(6);
  };

  overlay.querySelector('#confirmResetStuBtn').onclick = async () => {
    const inputEl = overlay.querySelector('#newStuPwInput');
    const newPw = (inputEl ? inputEl.value : '').trim();
    if(!newPw) return uiToast('Password cannot be empty', 'warning');

    u.pw = newPw;
    save(true);

    try{
      await fetch('/api/users/password',{
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: uid, pw: newPw})
      });
    }catch(err){
      console.warn('Backend password sync error:', err);
    }

    closeCustomModal();
    if(typeof renderStudentsTable === 'function'){
      renderStudentsTable($('#stuSearch') ? $('#stuSearch').value : '');
    }
    uiAlert('Student Password Reset', `Student Name: ${s.name}\nUser ID: ${s.uid}\nNew Password: ${newPw}\n\nPlease share these credentials with the student.`);
    uiToast(`Password for ${s.name} updated!`, 'success');
  };
}

function resetTeacherPw(tid){
  closeCustomModal();
  if(!tid) return uiToast('Invalid teacher identifier', 'error');

  const t = (db.users || []).find(x => x.id === tid);
  if(!t) return uiToast('Teacher record not found', 'error');

  const generatedPw = rnd(6);
  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';
  overlay.innerHTML = `
    <div class="custom-modal-card" style="background:#ffffff!important;border-radius:18px!important;max-width:500px!important;width:100%!important;box-shadow:0 25px 60px rgba(0,0,0,0.35),0 10px 20px rgba(0,0,0,0.15)!important;border:1px solid #e2e8f0!important;overflow:hidden!important;margin:auto!important;position:relative!important;z-index:1000000000!important;box-sizing:border-box!important;">
      <div class="custom-modal-header" style="padding:20px 24px 16px!important;border-bottom:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:space-between!important;">
        <div class="custom-modal-title-wrap" style="display:flex!important;align-items:center!important;gap:12px!important;">
          <div class="custom-modal-icon-badge" style="width:38px!important;height:38px!important;border-radius:10px!important;background:#eff6ff!important;color:#2563eb!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:20px!important;flex-shrink:0!important;">🔑</div>
          <h3 class="custom-modal-title" style="font-size:18px!important;font-weight:700!important;color:#0f172a!important;margin:0!important;">Reset Faculty Password</h3>
        </div>
        <button type="button" class="custom-modal-close" id="modalCloseX" style="background:transparent!important;border:none!important;font-size:24px!important;color:#94a3b8!important;cursor:pointer!important;line-height:1!important;border-radius:8px!important;padding:0!important;width:34px!important;height:34px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;transform:none!important;min-width:auto!important;margin:0!important;">×</button>
      </div>
      <div class="custom-modal-body" style="padding:22px 24px!important;color:#334155!important;font-size:14px!important;line-height:1.6!important;max-height:72vh!important;overflow-y:auto!important;box-sizing:border-box!important;">
        <p>Set a new password for faculty member <b>${esc(t.name)}</b></p>
        <div style="background:#f8fafc;padding:12px;border-radius:10px;font-size:13px;margin:12px 0 16px;border:1px solid #e2e8f0">
          <div>Teacher Name: <b>${esc(t.name)}</b></div>
          <div style="margin-top:4px">User ID: <code style="font-weight:700;color:#2563eb">${esc(t.id)}</code> • Role: <b>Faculty Member</b></div>
          <div style="margin-top:4px">Current Password: <span style="font-family:monospace;font-weight:600;color:#0f766e">${esc(t.pw||'-')}</span></div>
        </div>
        <label class="form-label" style="font-weight:600">New Password:</label>
        <div style="display:flex;gap:8px">
          <input class="custom-modal-input" id="newTchPwInput" value="${generatedPw}" placeholder="Enter new password" style="margin:0" autocomplete="off">
          <button type="button" class="secondary" id="genTchPwBtn" style="padding:10px 14px;white-space:nowrap">🎲 Generate</button>
        </div>
      </div>
      <div class="custom-modal-footer" style="padding:16px 24px 20px!important;border-top:1px solid #f1f5f9!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:10px!important;background:#fafafa!important;">
        <button type="button" class="secondary" id="cancelResetTchBtn" style="padding:10px 18px">Cancel</button>
        <button type="button" class="primary" id="confirmResetTchBtn" style="padding:10px 22px">Save Password</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#modalCloseX').onclick = () => closeCustomModal();
  overlay.querySelector('#cancelResetTchBtn').onclick = () => closeCustomModal();
  overlay.querySelector('#genTchPwBtn').onclick = () => {
    const inp = overlay.querySelector('#newTchPwInput');
    if(inp) inp.value = rnd(6);
  };

  overlay.querySelector('#confirmResetTchBtn').onclick = async () => {
    const inputEl = overlay.querySelector('#newTchPwInput');
    const newPw = (inputEl ? inputEl.value : '').trim();
    if(!newPw) return uiToast('Password cannot be empty', 'warning');

    t.pw = newPw;
    save(true);

    try{
      await fetch('/api/users/password',{
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: tid, pw: newPw})
      });
    }catch(err){
      console.warn('Backend password sync error:', err);
    }

    closeCustomModal();
    renderTeachersTable();
    uiAlert('Faculty Password Reset', `Teacher Name: ${t.name}\nUser ID: ${t.id}\nNew Password: ${newPw}\n\nPlease share these credentials with the faculty member.`);
    uiToast(`Password for ${t.name} updated!`, 'success');
  };
}

// Explicit global exposure for inline onclick attributes
window.resetInstPw = resetInstPw;
window.resetStudentPw = resetStudentPw;
window.resetTeacherPw = resetTeacherPw;

/* ---------- actions ---------- */
function addInst(){
  const n=val('in_n');
  if(!n) return uiToast('Enter institute name', 'warning');
  const id=n.trim().toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9_-]/g,'')||n.trim();
  if(db.users.some(x=>x.id.toLowerCase()===id.toLowerCase())){
    return uiAlert('Duplicate Institute ID', 'An institute with ID "'+id+'" already exists.\nPlease choose a different institute name.');
  }
  const pw=rnd(6);
  const email=val('in_e');
  db.insts.push({id,name:n,email:email,loc:val('in_l'),det:val('in_d')});
  db.users.push({id,pw,role:'institute',name:n,email:email,inst:id});
  save(true);
  uiAlert('Institute Created Successfully', `Institute Name: ${n}\nLogin ID: ${id}\nPassword: ${pw}\nEmail: ${email||'(Not set)'}\n\nThe institute is now active and synchronized to Turso cloud.`);
  uiToast(`Institute "${n}" created!`, 'success');
  go(tab);
}

function delInst(id){
  const ins=db.insts.find(i=>i.id===id||(i.id&&i.id.toLowerCase()===String(id).toLowerCase()));
  const name=ins?ins.name:id;
  uiConfirm('Delete Institute', `Are you sure you want to permanently delete institute "${name}"?\nALL associated classes, faculty, students, attendance, fees, timetable, and study materials will be completely wiped from the database.`, ()=>{
    const cleanId = String(id).trim().toLowerCase();
    db.insts = (db.insts||[]).filter(i => String(i.id).trim().toLowerCase() !== cleanId);
    db.users = (db.users||[]).filter(u => String(u.id).trim().toLowerCase() !== cleanId && String(u.inst||'').trim().toLowerCase() !== cleanId);
    ['classes','subjects','students','att','pays','tt','mats','ann','exams','res','bills'].forEach(k => {
      if(db[k]) db[k] = db[k].filter(x => String(x.inst||'').trim().toLowerCase() !== cleanId);
    });
    save(true);
    fetch(`/api/institutes?id=${encodeURIComponent(id)}`, {method:'DELETE'}).catch(()=>{});
    go(tab);
    uiToast(`Institute "${name}" and all records wiped successfully`, 'info');
  });
}

function addClass(){
  const cn = val('cn');
  if(!cn) return uiToast('Enter a class name', 'warning');
  const exists = mine('classes').some(c => String(c.name||'').toLowerCase().trim() === cn.toLowerCase().trim());
  if(exists) return uiToast(`Class "${cn}" already exists.`, 'warning');
  if(!db.classes) db.classes = [];
  db.classes.push({inst: I(), name: cn});
  save(true);
  if($('#cn')) $('#cn').value = '';
  uiToast(`Class "${cn}" added`, 'success');
  go(tab);
}
window.addClass = addClass;

function delClass(cn){
  const instId = I();
  const curInst = String(instId||'').toLowerCase().trim();
  const clsName = String(cn||'').toLowerCase().trim();
  const studentCount = mine('students').filter(s => String(s.cls||'').toLowerCase().trim() === clsName).length;
  const countWarning = studentCount > 0 ? `\n\nNotice: ${studentCount} enrolled student${studentCount===1?'':'s'} in this class will become unassigned.` : '';

  uiConfirm('Delete Class', `Are you sure you want to permanently delete class "${cn}"?${countWarning}\nAll subjects and timetable entries for this class will also be removed.`, ()=>{
    // 1. Remove class from local db.classes
    db.classes = (db.classes||[]).filter(c => {
      const matchInst = String(c.inst||'').toLowerCase().trim() === curInst;
      const matchName = String(c.name||'').toLowerCase().trim() === clsName;
      return !(matchInst && matchName);
    });

    // 2. Unassign class from enrolled students
    (db.students||[]).forEach(s => {
      if(String(s.inst||'').toLowerCase().trim() === curInst && String(s.cls||'').toLowerCase().trim() === clsName){
        s.cls = '';
      }
    });

    // 3. Remove subjects of this class
    db.subjects = (db.subjects||[]).filter(s => {
      const matchInst = String(s.inst||'').toLowerCase().trim() === curInst;
      const matchCls = String(s.cls||'').toLowerCase().trim() === clsName;
      return !(matchInst && matchCls);
    });

    // 4. Remove timetables of this class
    db.tt = (db.tt||[]).filter(t => {
      const matchInst = String(t.inst||'').toLowerCase().trim() === curInst;
      const matchCls = String(t.cls||'').toLowerCase().trim() === clsName;
      return !(matchInst && matchCls);
    });

    // 5. Remove materials of this class
    if(db.mats){
      db.mats = db.mats.filter(m => {
        const matchInst = String(m.inst||'').toLowerCase().trim() === curInst;
        const matchCls = String(m.cls||'').toLowerCase().trim() === clsName;
        return !(matchInst && matchCls);
      });
    }

    // 6. Direct backend DELETE call to Turso DB
    fetch(`/api/classes?inst=${encodeURIComponent(instId)}&name=${encodeURIComponent(cn)}`, {method:'DELETE'}).catch(()=>{});

    // 7. Save locally and sync immediately to Turso cloud
    save(true);

    uiToast(`Class "${cn}" deleted successfully`, 'info');
    go(tab);
  });
}
window.delClass = delClass;

function addSub(){
  const sn=val('sn'),sc=val('sc'),stype=val('stype')||'compulsory';
  if(!sn||!sc) return uiToast('Please select a class and enter subject name', 'warning');
  const exists = mine('subjects').some(s => String(s.name||'').toLowerCase().trim() === sn.toLowerCase().trim() && String(s.cls||'').toLowerCase().trim() === sc.toLowerCase().trim());
  if(exists) return uiToast(`Subject "${sn}" already exists for class "${sc}".`, 'warning');
  const perClassRate = +val('srate') || 0;
  if(!db.subjects) db.subjects = [];
  db.subjects.push({
    inst: I(),
    name: sn,
    cls: sc,
    teacher: val('st'),
    fee: val('sf')||0,
    type: stype,
    perClassRate: perClassRate,
    rate: perClassRate
  });
  save(true);
  if($('#sn')) $('#sn').value='';
  if($('#sf')) $('#sf').value='';
  if($('#srate')) $('#srate').value='';
  uiToast(`Subject "${sn}" (${stype}) added with pay ₹${perClassRate}/class`, 'success');
  go(tab);
}

function editSubjectRatePrompt(subName, clsName, currentRate){
  const newRate = prompt(`Enter Teacher Per-Class Pay Rate (₹) for "${subName}" (${clsName}):`, currentRate || 500);
  if(newRate === null) return;
  const numRate = Math.max(0, +newRate || 0);
  const sub = mine('subjects').find(s => s.name === subName && s.cls === clsName);
  if(sub){
    sub.perClassRate = numRate;
    sub.rate = numRate;
    save(true);
    uiToast(`Rate updated to ₹${numRate} / class for "${subName}"`, 'success');
    go(tab);
  }
}

function delSub(sn, sc){
  const instId = I();
  uiConfirm('Delete Subject', `Are you sure you want to permanently delete subject "${sn}" (${sc})?\nAny timetable entries for this subject will also be removed.`, ()=>{
    const curInst = String(instId||'').toLowerCase().trim();
    const subName = String(sn||'').toLowerCase().trim();
    const clsName = String(sc||'').toLowerCase().trim();

    // 1. Remove from db.subjects
    db.subjects = (db.subjects||[]).filter(s => {
      const matchInst = String(s.inst||'').toLowerCase().trim() === curInst;
      const matchName = String(s.name||'').toLowerCase().trim() === subName;
      const matchCls = String(s.cls||'').toLowerCase().trim() === clsName;
      return !(matchInst && matchName && matchCls);
    });

    // 2. Remove from timetable db.tt
    db.tt = (db.tt||[]).filter(t => {
      const matchInst = String(t.inst||'').toLowerCase().trim() === curInst;
      const matchSub = String(t.sub||'').toLowerCase().trim() === subName;
      const matchCls = String(t.cls||'').toLowerCase().trim() === clsName;
      return !(matchInst && matchSub && matchCls);
    });

    // 3. Direct backend DELETE call to Turso DB
    fetch(`/api/subjects?inst=${encodeURIComponent(instId)}&name=${encodeURIComponent(sn)}&cls=${encodeURIComponent(sc)}`, {method:'DELETE'}).catch(()=>{});

    // 4. Save locally and sync immediately to Turso cloud
    save(true);

    uiToast(`Subject "${sn}" deleted successfully`, 'info');
    go(tab);
  });
}
window.delSub = delSub;

function addTeacher(){
  const rawTn = val('tn');
  const tn = rawTn ? rawTn.trim() : '';
  if(!tn) return uiToast('Enter teacher name', 'warning');
  
  // Faculty Member User ID for login = its name
  let id = tn;
  let counter = 1;
  while(db.users.some(u => u.id.toLowerCase() === id.toLowerCase())){
    id = tn + counter;
    counter++;
  }
  let pw;
  do{pw=rnd(6)}while(pw.toLowerCase()===id.toLowerCase()||pw.toLowerCase()===tn.toLowerCase());
  const email=val('te');
  db.users.push({id,pw,role:'teacher',name:tn,email:email,inst:I()});
  save(true);
  if($('#tn')) $('#tn').value='';
  if($('#te')) $('#te').value='';
  go(tab);
  uiAlert('Teacher Added Successfully', `Teacher Name: ${tn}\nUser ID (Login ID): ${id}\nPassword: ${pw}\nEmail: ${email||'(Not set)'}\n\nFaculty login User ID is set to their name. Share these credentials with the faculty member.`, ()=>{
    applyDashboardSync(true);
  });
  uiToast(`Teacher "${tn}" added (Login ID: ${id})`, 'success');
}

function mkStudent(n,e,c,j,ft,fe){
  const baseId=n.trim().toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9_-]/g,'')||('stu'+rnd(4));
  let uid=baseId, counter=1;
  while(db.users.some(u=>u.id.toLowerCase()===uid.toLowerCase())){
    uid=baseId+counter;
    counter++;
  }
  let pw;
  do{pw=rnd(6)}while(pw.toLowerCase()===uid.toLowerCase()||pw.toLowerCase()===n.trim().toLowerCase());
  db.users.push({id:uid,pw,role:'student',name:n,inst:I()});
  db.students.push({uid,inst:I(),name:n,email:e,cls:c,join:j||today(),feeType:ft||'month',fee:+fe||0,photo:'',done:false});
  return 'User ID: '+uid+' | Password: '+pw;
}

function addStudent(){
  const nm=val('nm'),cl=val('cl');
  if(!nm) return uiToast('Enter student name', 'warning');
  if(!cl) return uiToast('Enter or select a class for the student', 'warning');
  if(!db.classes.some(x=>x.inst===I()&&x.name.toLowerCase()===cl.toLowerCase())){
    db.classes.push({inst:I(),name:cl});
  }
  const creds=mkStudent(nm,val('em'),cl,val('jd'),val('ft'),val('fe'));
  save(true);

  // Clear input fields immediately
  if($('#nm')) $('#nm').value='';
  if($('#em')) $('#em').value='';
  if($('#fe')) $('#fe').value='';

  // Instantly re-render students table and counter in DOM (0ms delay)
  renderStudentsTable($('#stuSearch')?$('#stuSearch').value:'');
  const countHeaders = document.querySelectorAll('h3');
  countHeaders.forEach(h => {
    if(h.textContent.includes('Enrolled Students')){
      h.textContent = `Enrolled Students (${mine('students').length})`;
    }
  });

  uiAlert('Student Added Successfully', `Name: ${nm}\nClass: ${cl}\n${creds}\n\nStudent can now log in using these credentials.`, ()=>{
    applyDashboardSync(true);
  });
  uiToast(`Student "${nm}" enrolled!`, 'success');
}

function editStudentModal(uid){
  closeCustomModal();
  const s = sOf(uid);
  if(!s) return uiToast('Student not found', 'error');

  const overlay = document.createElement('div');
  overlay.id = 'customModalOverlay';
  overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,0.7)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex!important;align-items:center!important;justify-content:center!important;z-index:999999999!important;padding:20px!important;box-sizing:border-box!important;margin:0!important;';

  overlay.innerHTML = `
    <div style="background:#ffffff;border-radius:12px;padding:24px;max-width:550px;width:100%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);position:relative;max-height:90vh;overflow-y:auto;border:1px solid #e2e8f0" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;border-bottom:1px solid #e2e8f0;padding-bottom:10px">
        <h3 style="margin:0;color:#0f172a;font-size:18px">✏️ Edit Enrolled Student</h3>
        <button type="button" onclick="closeCustomModal()" style="background:#f1f5f9;color:#64748b;border:0;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px">✕</button>
      </div>
      <div class=grid style="grid-template-columns:1fr;gap:10px">
        <div>
          <label class="form-label">Student Full Name</label>
          <input id="edit_s_name" value="${esc(s.name||'')}">
        </div>
        <div>
          <label class="form-label">Email Address</label>
          <input id="edit_s_email" value="${esc(s.email||'')}" placeholder="student@email.com">
        </div>
        <div>
          <label class="form-label">Class</label>
          <input id="edit_s_cls" list="classList" value="${esc(s.cls||'')}" placeholder="Type or select class">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label class="form-label">Fee Plan</label>
            <select id="edit_s_feeType">
              <option value="month" ${s.feeType==='month'?'selected':''}>Monthly fee</option>
              <option value="one" ${s.feeType==='one'?'selected':''}>One-time fee</option>
              <option value="subject" ${s.feeType==='subject'?'selected':''}>Per-subject fee</option>
            </select>
          </div>
          <div>
            <label class="form-label">Fee Amount (₹)</label>
            <input id="edit_s_fee" type="number" value="${s.fee||0}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label class="form-label">Joining Date</label>
            <input id="edit_s_join" type="date" value="${s.join||today()}">
          </div>
          <div>
            <label class="form-label">Phone</label>
            <input id="edit_s_phone" value="${esc(s.phone||'')}" placeholder="Phone number">
          </div>
        </div>
        <div>
          <label class="form-label">Address</label>
          <input id="edit_s_addr" value="${esc(s.addr||'')}" placeholder="Student address">
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px">
        <button type="button" class="secondary" onclick="closeCustomModal()">Cancel</button>
        <button type="button" onclick="saveStudentEdit('${esc(s.uid)}')">💾 Save Changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function saveStudentEdit(uid){
  const s = sOf(uid);
  if(!s) return;
  const newName = val('edit_s_name');
  if(!newName) return uiToast('Name is required', 'warning');
  
  s.name = newName;
  s.email = val('edit_s_email');
  s.cls = val('edit_s_cls');
  s.feeType = val('edit_s_feeType') || 'month';
  s.fee = +val('edit_s_fee') || 0;
  s.join = val('edit_s_join') || today();
  s.phone = val('edit_s_phone');
  s.addr = val('edit_s_addr');

  if(s.cls && !db.classes.some(x => x.inst === I() && x.name.toLowerCase() === s.cls.toLowerCase())){
    db.classes.push({ inst: I(), name: s.cls });
  }

  const u = db.users.find(x => x.id === s.uid || (x.id && x.id.toLowerCase() === String(s.uid).toLowerCase()));
  if(u){
    u.name = s.name;
    u.email = s.email;
  }

  save(true);
  closeCustomModal();
  uiToast(`Student details for "${s.name}" updated!`, 'success');
  renderStudentsTable($('#stuSearch') ? $('#stuSearch').value : '');
}

function editStuClass(uid){
  const s=sOf(uid);
  if(!s) return;
  uiPrompt('Update Class for Student', `Enter new class for student "${s.name}":`, s.cls||'', (cl)=>{
    if(!cl) return uiToast('Class cannot be empty', 'warning');
    s.cls=cl;
    if(!db.classes.some(x=>x.inst===I()&&x.name.toLowerCase()===cl.toLowerCase())){
      db.classes.push({inst:I(),name:cl});
    }
    save(true);
    renderStudentsTable($('#stuSearch')?$('#stuSearch').value:'');
    uiToast(`Class updated to "${cl}" for ${s.name}`, 'success');
  });
}

function importCsv(t){
  const out=[];
  t.split(/\r?\n/).filter(l=>l.trim()).forEach((l,i)=>{
    const [n,e,c,j,ft,fe]=l.split(',').map(x=>x.trim());
    if(i===0&&/name/i.test(n))return;
    if(!n||!c)return;
    if(!db.classes.some(x=>x.inst===I()&&x.name===c))db.classes.push({inst:I(),name:c});
    out.push(n+' : '+mkStudent(n,e,c,j,ft,fe));
  });
  save(true);
  uiAlert('CSV Import Successful', `Enrolled ${out.length} students successfully!\n\n`+out.join('\n'));
  uiToast(`Imported ${out.length} students!`, 'success');
  go(tab);
}

function delStu(id){
  const s=sOf(id);
  const name=s?s.name:id;
  uiConfirm('Delete Student Record', `Are you sure you want to delete student "${name}"?\nAll associated attendance and fee records will be removed.`, ()=>{
    db.students=db.students.filter(st=>st.uid!==id);
    db.users=db.users.filter(u=>u.id!==id);
    db.att=db.att.filter(a=>a.uid!==id);
    db.pays=db.pays.filter(p=>p.uid!==id);
    db.res=db.res.filter(r=>r.uid!==id);
    if(db.bills) db.bills=db.bills.filter(b=>b.uid!==id);
    save(true);
    fetch(`/api/students?uid=${encodeURIComponent(id)}`, {method:'DELETE'}).catch(()=>{});
    renderStudentsTable($('#stuSearch')?$('#stuSearch').value:'');
    const countHeaders = document.querySelectorAll('h3');
    countHeaders.forEach(h => {
      if(h.textContent.includes('Enrolled Students')){
        h.textContent = `Enrolled Students (${mine('students').length})`;
      }
    });
    uiToast(`Student record for ${name} deleted`, 'info');
  });
}

function delTeacher(id){
  const t=(db.users||[]).find(u=>u.id===id);
  const name=t?t.name:id;
  uiConfirm('Delete Faculty Member', `Are you sure you want to remove teacher "${name}"?\nAny assigned subjects will become unassigned and their login access will be revoked permanently.`, ()=>{
    // 1. Remove from local users
    db.users=(db.users||[]).filter(u=>u.id!==id);
    // 2. Unassign from subjects
    if(db.subjects){
      db.subjects.forEach(s=>{
        if(s.teacher===id||s.teacher===name) s.teacher='';
      });
    }
    // 3. Save locally and sync immediately to Turso cloud
    save(true);
    // 4. Send DELETE request to backend to ensure removal from Turso DB
    fetch(`/api/teachers?id=${encodeURIComponent(id)}`, {method:'DELETE'}).catch(()=>{});
    // 5. Update UI table and count immediately (0ms delay)
    renderTeachersTable();
    if(typeof tab!=='undefined'&&tab==='Teachers') go(tab);
    uiToast(`Faculty member "${name}" removed successfully`, 'info');
  });
}
window.delTeacher = delTeacher;

function saveAtt(){
  const d = $('#ad') ? $('#ad').value : today();
  const isTeacher = (U && U.role === 'teacher');
  if(isTeacher && d !== today()){
    return uiToast('Faculty can only mark attendance for today (' + today() + ').', 'error');
  }
  const clsVal = $('#ac') ? $('#ac').value : '';
  let subVal = $('#asub') ? $('#asub').value : '';
  if(subVal.includes('__')) subVal = subVal.split('__')[0];

  db.att = (db.att || []).filter(a => !(a.date === d && a.cls === clsVal && (subVal ? a.sub === subVal : true)));
  document.querySelectorAll('.ack').forEach(c => {
    db.att.push({
      inst: I(),
      uid: c.value,
      cls: clsVal,
      date: d,
      p: c.checked,
      sub: subVal
    });
  });
  save(true);
  uiToast(`Attendance for ${d} ${subVal ? '(' + subVal + ')' : ''} saved successfully!`, 'success');
}

function pay(uid){
  const a=+val('p_'+uid);
  if(!a) return uiToast('Enter a valid payment amount', 'warning');
  db.pays.push({id:'r'+Date.now(),inst:I(),uid,amt:a,date:today()});
  save(true);
  uiAlert('Payment Received', `Payment of ₹${a} recorded and receipt generated.`, ()=>{
    applyDashboardSync(true);
  });
  uiToast('Payment of ₹'+a+' recorded!', 'success');
  go(tab);
}

function addTT(){
  if(!val('tt')||!val('ts')) return uiToast('Please enter time and subject', 'warning');
  const subName = val('ts');
  const dayName = val('td');
  db.tt.push({inst:I(),cls:val('tc'),day:dayName,time:val('tt'),sub:subName});
  save(true);
  if($('#tt')) $('#tt').value='';
  if($('#ts')) $('#ts').value='';
  uiToast(`Timetable slot for ${subName} (${dayName}) added!`, 'success');
  go(tab);
}

function delTT(i){
  db.tt.splice(i,1);
  save(true);
  uiToast('Timetable slot removed', 'info');
  go(tab);
}

function addMat(){
  const f=$('#mf');
  if(!val('mt')||!f.files[0])return alert('Document title and file are required');
  readFile(f,(d,n)=>{
    db.mats.push({inst:I(),cls:val('mc'),title:val('mt'),data:d,name:n});
    save();
    alert('Material uploaded successfully.');
    go(tab);
  });
}

async function addAnn(){
  const t = val('at');
  if(!t) return uiToast('Enter announcement text', 'warning');
  const instId = I();
  const dateStr = today();
  const newAnn = {
    inst: instId,
    text: t,
    date: dateStr
  };
  db.ann.push(newAnn);
  save(true);

  try{
    const res = await fetch('/api/announcements', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(newAnn)
    });
    const data = await res.json();
    if(data && data.id){
      newAnn.id = data.id;
      save();
    }
  }catch(err){
    console.warn('[Notice API] Sync warning:', err);
  }

  uiToast('Announcement broadcasted to Notice Board.', 'success');
  go(tab);
}

function delAnn(target){
  let a = null;
  if(typeof target === 'number'){
    a = db.ann[target];
  } else if(target && typeof target === 'object'){
    a = target;
  } else if(typeof target === 'string'){
    a = db.ann.find(x => String(x.id) === String(target)) || db.ann.find(x => x.text === target);
  }
  if(!a) return uiToast('Announcement not found', 'warning');

  const promptText = (a.text || '').length > 50 ? (a.text || '').slice(0, 47) + '...' : (a.text || '');
  uiConfirm('Delete Notice', `Are you sure you want to delete this notice?\n\n"${promptText}"\n\nThis will remove the announcement permanently from the Notice Board and database.`, async ()=>{
    const annId = a.id;
    const annText = a.text;
    const instId = a.inst || I();

    // 1. Remove from local in-memory db.ann
    const idx = db.ann.indexOf(a);
    if(idx !== -1){
      db.ann.splice(idx, 1);
    } else if(annId){
      db.ann = db.ann.filter(x => String(x.id) !== String(annId));
    } else {
      db.ann = db.ann.filter(x => !(x.inst === instId && x.text === annText));
    }

    // 2. Persist to localStorage and sync complete state to Turso
    save(true);

    // 3. Send dedicated delete request to backend server for immediate database deletion
    try{
      await fetch('/api/announcements/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          id: (annId && String(annId).trim()) ? annId : undefined,
          inst: instId,
          text: annText
        })
      });
    }catch(err){
      console.warn('[Notice Delete API] Sync warning:', err);
    }

    uiToast('Announcement deleted from Notice Board and database.', 'info');
    go(tab);
  });
}

// Global exposure
window.addAnn = addAnn;
window.delAnn = delAnn;

function addExam(){
  const qs=val('eq').split('\n').filter(l=>l.trim()).map(l=>{
    const p=l.split('|').map(x=>x.trim());
    return{q:p[0],o:p.slice(1,5),a:(+p[5]||1)-1};
  });
  if(!val('et')||!qs.length)return alert('Exam title and questions are required');
  db.exams.push({id:'e'+Date.now(),inst:I(),cls:val('ec'),title:val('et'),open:false,qs});
  save();
  alert('Exam created successfully.');
  go(tab);
}

function togExam(id){
  const e=db.exams.find(x=>x.id===id);
  e.open=!e.open;
  save();
  go(tab);
}

function delExam(id){
  const e=db.exams.find(x=>x.id===id);
  const title=e?e.title:'Exam';
  uiConfirm('Delete Online Exam', `Are you sure you want to delete exam "${title}"?`, ()=>{
    db.exams=db.exams.filter(x=>x.id!==id);
    db.res=db.res.filter(r=>r.exam!==id);
    save(true);
    go(tab);
    uiToast(`Exam "${title}" deleted`, 'info');
  });
}

function saveProfile(){
  const s=sOf(U.id);
  if(!s) return;
  // Student cannot change name or email (permanently registered)
  s.phone=val('pp');
  s.addr=val('pa');
  
  // Save selected optional subjects
  const selectedOpts = Array.from(document.querySelectorAll('.opt-sub-cb:checked')).map(cb => cb.value);
  s.optSubs = JSON.stringify(selectedOpts);

  const fin=p=>{
    if(p) s.photo=p;
    s.done=!!(s.name&&s.email&&s.phone&&s.photo);
    save(true);
    uiToast('Profile details saved successfully!', 'success');
    go(tab);
  };
  ($('#ph')&&$('#ph').files[0]) ? readAndResizeImage($('#ph').files[0], 400, 400, d=>fin(d)) : fin('');
}

function closeReceiptModal(){
  const el = document.getElementById('receiptModalOverlay');
  if(el) el.remove();
}
window.closeReceiptModal = closeReceiptModal;

function printReceiptFromModal(){
  document.body.classList.add('receipt-printing');
  window.print();
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('receipt-printing');
  }, { once: true });
  setTimeout(() => document.body.classList.remove('receipt-printing'), 2000);
}
window.printReceiptFromModal = printReceiptFromModal;

function openReceiptWindow(id){
  const p = ((db && db.pays) ? db.pays : []).find(x => x.id === id);
  if(!p) return uiToast('Receipt not found', 'error');
  const s = sOf(p.uid) || { name: 'Student', uid: p.uid, cls: 'General', photo: '' };
  const i = ((db && db.insts) ? db.insts : []).find(x => x.id === p.inst || x.id === (s ? s.inst : '')) || {};
  const instName = (i && i.name) || 'IGYR Smart Platform';
  const instLogo = (i && i.logo) || '';
  const studentPhoto = s.photo || '';

  const w = window.open('', '_blank');
  if(!w){
    return uiToast('Popup blocked by browser. You can print directly from the receipt preview.', 'info');
  }

  w.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Payment Receipt - ${p.id}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 15mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      margin: 0;
      padding: 24px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .no-print-bar {
      max-width: 210mm;
      margin: 0 auto 16px;
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
    .print-btn {
      background: #2563eb;
      color: #ffffff;
      border: 0;
      padding: 10px 22px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(37,99,235,0.25);
    }
    .print-btn:hover { background: #1d4ed8; }
    .close-btn {
      background: #e2e8f0;
      color: #334155;
      border: 0;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .a4-page {
      width: 210mm;
      min-height: 297mm;
      max-width: 100%;
      margin: 0 auto;
      background: #ffffff;
      border: 2px solid #cbd5e1;
      border-radius: 12px;
      padding: 18mm 18mm;
      box-shadow: 0 15px 35px rgba(0,0,0,0.08);
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .inst-header {
      border-bottom: 3px double #2563eb;
      padding-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .inst-title {
      font-size: 24px;
      font-weight: 900;
      color: #1e3a8a;
      margin: 0 0 4px;
      letter-spacing: -0.5px;
    }
    .receipt-badge {
      display: inline-block;
      background: #eff6ff;
      color: #1d4ed8;
      border: 1px solid #bfdbfe;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .student-center-block {
      text-align: center;
      margin: 24px 0 20px;
      padding: 18px;
      background: linear-gradient(180deg, #f0f7ff 0%, #ffffff 100%);
      border-radius: 16px;
      border: 1px solid #e0e7ff;
    }
    .student-avatar {
      width: 125px;
      height: 125px;
      border-radius: 50%;
      object-fit: cover;
      border: 4px solid #2563eb;
      box-shadow: 0 8px 22px rgba(37,99,235,0.25);
      margin: 0 auto 12px;
      display: block;
    }
    .student-avatar-placeholder {
      width: 125px;
      height: 125px;
      border-radius: 50%;
      background: #e0e7ff;
      border: 4px solid #2563eb;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 58px;
      color: #3b82f6;
      margin: 0 auto 12px;
      box-shadow: 0 8px 22px rgba(37,99,235,0.25);
    }
    .receipt-data-table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0 20px;
      font-size: 15px;
    }
    .receipt-data-table td {
      padding: 12px 14px;
      border-bottom: 1px solid #e2e8f0;
    }
    .receipt-data-table td.label-cell {
      width: 38%;
      color: #64748b;
      font-weight: 600;
    }
    .receipt-data-table td.val-cell {
      width: 62%;
      color: #0f172a;
      font-weight: 700;
    }
    .amount-box {
      background: #ecfdf5;
      border: 2px dashed #059669;
      border-radius: 12px;
      padding: 16px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
    }
    .paid-stamp {
      display: inline-block;
      border: 3px solid #16a34a;
      color: #16a34a;
      padding: 6px 18px;
      font-size: 16px;
      font-weight: 900;
      border-radius: 8px;
      letter-spacing: 2px;
      transform: rotate(-3deg);
    }
    .receipt-footer {
      border-top: 1px solid #e2e8f0;
      padding-top: 18px;
      margin-top: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }

    /* Mobile Responsive Styles */
    @media screen and (max-width: 768px) {
      body {
        padding: 12px 8px !important;
        background: #f8fafc !important;
      }
      .no-print-bar {
        flex-direction: column !important;
        gap: 8px !important;
        margin-bottom: 12px !important;
      }
      .print-btn, .close-btn {
        width: 100% !important;
        justify-content: center !important;
        text-align: center !important;
        padding: 12px 16px !important;
        font-size: 15px !important;
      }
      .a4-page {
        width: 100% !important;
        min-height: auto !important;
        padding: 16px 14px !important;
        border-radius: 12px !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.06) !important;
      }
      .inst-header {
        flex-direction: column !important;
        text-align: center !important;
        gap: 8px !important;
      }
      .inst-header > div:last-child {
        text-align: center !important;
      }
      .inst-title {
        font-size: 20px !important;
      }
      .student-center-block {
        margin: 16px 0 !important;
        padding: 14px 10px !important;
      }
      .student-avatar, .student-avatar-placeholder {
        width: 100px !important;
        height: 100px !important;
        font-size: 46px !important;
      }
      .receipt-data-table {
        margin: 12px 0 16px !important;
        font-size: 13.5px !important;
      }
      .receipt-data-table td {
        padding: 9px 8px !important;
      }
      .receipt-data-table td.label-cell {
        width: 40% !important;
      }
      .receipt-data-table td.val-cell {
        width: 60% !important;
        word-break: break-word !important;
      }
      .amount-box {
        padding: 14px 16px !important;
        flex-direction: column !important;
        gap: 12px !important;
        text-align: center !important;
      }
      .amount-box > div:first-child {
        text-align: center !important;
      }
      .paid-stamp {
        transform: none !important;
        font-size: 15px !important;
        padding: 5px 16px !important;
      }
      .receipt-footer {
        flex-direction: column !important;
        gap: 18px !important;
        text-align: center !important;
        align-items: center !important;
      }
      .receipt-footer > div {
        max-width: 100% !important;
        text-align: center !important;
      }
    }

    @media print {
      body {
        background: #ffffff !important;
        padding: 0 !important;
      }
      .no-print-bar {
        display: none !important;
      }
      .a4-page {
        width: 100% !important;
        min-height: 100% !important;
        max-width: 100% !important;
        margin: 0 !important;
        padding: 10mm 15mm !important;
        border: 2px solid #1e3a8a !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        page-break-inside: avoid;
      }
      .inst-header {
        flex-direction: row !important;
        text-align: left !important;
      }
      .inst-header > div:last-child {
        text-align: right !important;
      }
      .amount-box {
        flex-direction: row !important;
        text-align: left !important;
      }
      .receipt-footer {
        flex-direction: row !important;
        text-align: left !important;
        align-items: flex-end !important;
      }
    }
  </style>
</head>
<body>
  <div class="no-print-bar">
    <button class="print-btn" onclick="window.print()">🖨️ Print Receipt / Save as PDF</button>
    <button class="close-btn" onclick="window.close()">✕ Close</button>
  </div>

  <div class="a4-page">
    <div>
      <div class="inst-header">
        <div>
          <h1 class="inst-title">${esc(instName)}</h1>
          <div style="font-size:13px;color:#64748b;font-weight:500">Official Fee Payment Receipt • Academic A4 Copy</div>
        </div>
        <div style="text-align:right">
          ${instLogo ? `<img src="${instLogo}" alt="Logo" style="height:55px;max-width:140px;object-fit:contain;margin-bottom:4px;display:inline-block">` : `<div style="font-size:32px">🏛️</div>`}
          <div><span class="receipt-badge">Official Record</span></div>
        </div>
      </div>

      <!-- Student Image Centered in Middle -->
      <div class="student-center-block">
        ${studentPhoto ? `
          <img src="${studentPhoto}" class="student-avatar" alt="Student Photo">
        ` : `
          <div class="student-avatar-placeholder">👤</div>
        `}
        <div style="font-size:20px;font-weight:900;color:#1e3a8a;margin-bottom:3px">${esc(s.name)}</div>
        <div style="font-size:13px;color:#64748b;font-weight:600">Student ID: <span style="color:#0f172a;font-family:monospace">${esc(s.uid)}</span></div>
      </div>

      <!-- Details Table -->
      <table class="receipt-data-table">
        <tr>
          <td class="label-cell">Receipt No:</td>
          <td class="val-cell" style="font-family:monospace;font-size:16px;color:#1e3a8a">${p.id}</td>
        </tr>
        <tr>
          <td class="label-cell">Payment Date:</td>
          <td class="val-cell">${p.date}</td>
        </tr>
        <tr>
          <td class="label-cell">Student:</td>
          <td class="val-cell">${esc(s.name)}</td>
        </tr>
        <tr>
          <td class="label-cell">Class:</td>
          <td class="val-cell"><span style="background:#f1f5f9;padding:4px 10px;border-radius:6px;border:1px solid #cbd5e1">${esc(s.cls || 'General')}</span></td>
        </tr>
        <tr>
          <td class="label-cell">Institute:</td>
          <td class="val-cell">${esc(instName)}</td>
        </tr>
        <tr>
          <td class="label-cell">Status:</td>
          <td class="val-cell"><span style="color:#16a34a;font-weight:800">✅ PAYMENT RECEIVED &amp; VERIFIED</span></td>
        </tr>
      </table>

      <!-- Amount Paid -->
      <div class="amount-box">
        <div>
          <div style="font-size:13px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.5px">Amount Paid:</div>
          <div style="font-size:32px;font-weight:900;color:#047857;margin-top:2px">₹${p.amt}</div>
        </div>
        <div>
          <div class="paid-stamp">PAID</div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="receipt-footer">
      <div style="font-size:11px;color:#94a3b8;max-width:340px;line-height:1.5">
        <b>Notice:</b> This receipt is an official system-generated record of payment issued by ${esc(instName)}. Retain this receipt for academic verification and fee clearance.
      </div>
      <div style="text-align:center;min-width:180px">
        <div style="border-bottom:1px solid #94a3b8;height:38px;margin-bottom:6px"></div>
        <div style="font-size:12px;font-weight:700;color:#334155">Authorized Signature</div>
        <div style="font-size:11px;color:#64748b">${esc(instName)}</div>
      </div>
    </div>
  </div>
</body>
</html>`);
  w.document.close();
}
window.openReceiptWindow = openReceiptWindow;

function receipt(id){
  const p = ((db && db.pays) ? db.pays : []).find(x => x.id === id);
  if(!p) return uiToast('Receipt not found', 'error');
  const s = sOf(p.uid) || { name: 'Student', uid: p.uid, cls: 'General', photo: '' };
  const i = ((db && db.insts) ? db.insts : []).find(x => x.id === p.inst || x.id === (s ? s.inst : '')) || {};
  const instName = (i && i.name) || 'IGYR Smart Platform';
  const instLogo = (i && i.logo) || '';
  const studentPhoto = s.photo || '';

  closeReceiptModal();

  const overlay = document.createElement('div');
  overlay.id = 'receiptModalOverlay';
  overlay.className = 'receipt-modal-overlay';
  overlay.onclick = (e) => {
    if(e.target === overlay) closeReceiptModal();
  };

  overlay.innerHTML = `
    <div class="receipt-modal-container" onclick="event.stopPropagation()">
      <div class="receipt-top-actions receipt-no-print">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">🧾</span>
          <span style="font-weight:700;font-size:14px">Official Fee Payment Receipt</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button type="button" onclick="printReceiptFromModal()" style="background:#2563eb;color:#ffffff;border:0;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px">🖨️ Print / Save PDF</button>
          <button type="button" onclick="openReceiptWindow('${esc(p.id)}')" style="background:#334155;color:#ffffff;border:0;padding:6px 12px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Open in dedicated tab">↗️ Full Tab</button>
          <button type="button" onclick="closeReceiptModal()" style="background:#475569;color:#ffffff;border:0;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px">✕</button>
        </div>
      </div>

      <div class="receipt-card-box receipt-printable-content">
        <!-- Institute Header -->
        <div style="border-bottom:3px double #2563eb;padding-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <h2 style="font-size:20px;font-weight:900;color:#1e3a8a;margin:0 0 2px;letter-spacing:-0.5px">${esc(instName)}</h2>
            <div style="font-size:12px;color:#64748b;font-weight:500">Official Fee Payment Receipt • Academic Copy</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            ${instLogo ? `<img src="${instLogo}" alt="Logo" style="height:48px;max-width:120px;object-fit:contain;margin-bottom:3px;display:inline-block">` : `<div style="font-size:28px">🏛️</div>`}
            <div><span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:2px 10px;border-radius:14px;font-size:11px;font-weight:700;text-transform:uppercase">Official Record</span></div>
          </div>
        </div>

        <!-- Student Photo Centered -->
        <div style="text-align:center;margin:18px 0 16px;padding:14px 10px;background:linear-gradient(180deg,#f0f7ff 0%,#ffffff 100%);border-radius:14px;border:1px solid #e0e7ff">
          ${studentPhoto ? `
            <img src="${studentPhoto}" style="width:105px;height:105px;border-radius:50%;object-fit:cover;border:4px solid #2563eb;box-shadow:0 8px 22px rgba(37,99,235,0.22);margin:0 auto 10px;display:block" alt="Student Photo">
          ` : `
            <div style="width:105px;height:105px;border-radius:50%;background:#e0e7ff;border:4px solid #2563eb;display:flex;align-items:center;justify-content:center;font-size:50px;color:#3b82f6;margin:0 auto 10px;box-shadow:0 8px 22px rgba(37,99,235,0.22)">👤</div>
          `}
          <div style="font-size:19px;font-weight:900;color:#1e3a8a;margin-bottom:2px">${esc(s.name)}</div>
          <div style="font-size:12.5px;color:#64748b;font-weight:600">Student ID: <span style="color:#0f172a;font-family:monospace;font-weight:700">${esc(s.uid)}</span></div>
        </div>

        <!-- Details Table -->
        <table style="width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:13.5px">
          <tr>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600;width:38%">Receipt No:</td>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-weight:800;color:#1e3a8a;font-size:14.5px">${esc(p.id)}</td>
          </tr>
          <tr>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600">Payment Date:</td>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;color:#0f172a">${esc(p.date)}</td>
          </tr>
          <tr>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600">Student:</td>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;color:#0f172a">${esc(s.name)}</td>
          </tr>
          <tr>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600">Class:</td>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-weight:700"><span style="background:#f1f5f9;padding:3px 8px;border-radius:6px;border:1px solid #cbd5e1;font-size:12.5px">${esc(s.cls || 'General')}</span></td>
          </tr>
          <tr>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600">Institute:</td>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;color:#0f172a">${esc(instName)}</td>
          </tr>
          <tr>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600">Status:</td>
            <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0"><span style="color:#16a34a;font-weight:800;font-size:13px">✅ PAYMENT RECEIVED &amp; VERIFIED</span></td>
          </tr>
        </table>

        <!-- Amount Box -->
        <div style="background:#ecfdf5;border:2px dashed #059669;border-radius:12px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin:12px 0 16px;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:12px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.5px">Amount Paid:</div>
            <div style="font-size:28px;font-weight:900;color:#047857;margin-top:2px">₹${p.amt}</div>
          </div>
          <div>
            <div style="display:inline-block;border:3px solid #16a34a;color:#16a34a;padding:5px 16px;font-size:15px;font-weight:900;border-radius:8px;letter-spacing:2px">PAID</div>
          </div>
        </div>

        <!-- Footer -->
        <div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-top:18px;display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap">
          <div style="font-size:11px;color:#94a3b8;max-width:320px;line-height:1.5">
            <b>Notice:</b> This receipt is an official system-generated record of payment issued by ${esc(instName)}. Retain for verification.
          </div>
          <div style="text-align:center;min-width:160px;margin-left:auto">
            <div style="border-bottom:1px solid #94a3b8;height:30px;margin-bottom:4px"></div>
            <div style="font-size:12px;font-weight:700;color:#334155">Authorized Signature</div>
            <div style="font-size:11px;color:#64748b">${esc(instName)}</div>
          </div>
        </div>
      </div>

      <!-- Mobile quick-close button -->
      <div class="receipt-no-print" style="text-align:center;margin-top:4px">
        <button type="button" onclick="closeReceiptModal()" style="background:#ffffff;color:#334155;border:1px solid #cbd5e1;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;width:100%;max-width:280px;cursor:pointer">✕ Close Receipt</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
}
window.receipt = receipt;

function startExam(id){
  const e=db.exams.find(x=>x.id===id);
  $('#exam').innerHTML=`<div class=card style="margin-top:20px;border:2px solid #2563eb">
    <div class="card-header"><h3>📝 Taking Exam: ${esc(e.title)}</h3><span class="pill green">${e.qs.length} Questions</span></div>
    ${e.qs.map((q,i)=>`
      <div class="exam-q-box">
        <p style="font-weight:700;margin:0 0 10px;font-size:15px">${i+1}. ${esc(q.q)}</p>
        ${q.o.map((o,j)=>`
          <label class="exam-opt">
            <input type=radio style="width:auto;margin:0" name="q${i}" value="${j}">
            <span>${esc(o)}</span>
          </label>
        `).join('')}
      </div>
    `).join('')}
    <button onclick="submitExam('${id}')" style="margin-top:10px;padding:12px 24px;font-size:15px">Submit Exam Answers</button>
  </div>`;
}

function submitExam(id){
  const e=db.exams.find(x=>x.id===id);
  if(!e.open)return alert('This exam is now closed.');
  let sc=0;
  e.qs.forEach((q,i)=>{
    const r=document.querySelector(`input[name=q${i}]:checked`);
    if(r&&+r.value===q.a)sc++;
  });
  db.res.push({inst:e.inst,exam:id,uid:U.id,score:sc,total:e.qs.length});
  save();
  alert('Exam Submitted Successfully!\n\nYour Score: '+sc+' out of '+e.qs.length);
  go(tab);
}
