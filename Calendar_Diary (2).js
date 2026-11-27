//@name calendar_diary
//@display-name 달력 · 작은 기록장
//@api 3.0
//@version 0.1.1
//@link https://github.com/hhja37984-AI/Playroom/tree/main/Plugin%20V3/Calendar 사용 안내

/* Manual, chat-scoped diary. No prompt insertion or model requests.
 * Main-page UI uses SafeElement; editable forms stay in the plugin iframe.
 * Settings are opt-in per character; each chat may independently opt out.
 */
(async () => {
  'use strict';
  const api = risuai;
  const KEY = 'calendar_diary_v1';
  const ROOT = 'calendar-diary-root';
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => globalThis.crypto?.randomUUID?.() || `diary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pad = n => String(n).padStart(2, '0');
  const dateKey = (y, m, d) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  function parts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return null;
    const [y, m, d] = match.slice(1).map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] ? {y, m, d} : null;
  }
  function utc(y, m, d) { const dt = new Date(0); dt.setUTCFullYear(y, m - 1, d); dt.setUTCHours(0, 0, 0, 0); return dt; }
  function shift(value, count, unit = 'day') {
    const p = parts(value); if (!p) throw new Error('날짜를 확인해 주세요.');
    const dt = utc(p.y, p.m, unit === 'month' ? 1 : p.d);
    if (unit === 'month') dt.setUTCMonth(dt.getUTCMonth() + count);
    else dt.setUTCDate(dt.getUTCDate() + count);
    const next = dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    return parts(next) ? next : value;
  }
  function initialDate() { const n = new Date(); return dateKey(n.getFullYear(), n.getMonth() + 1, n.getDate()); }
  function monthCells(value) {
    const {y, m} = parts(value);
    const start = utc(y, m, 1).getUTCDay();
    const last = utc(y, m + 1, 0).getUTCDate();
    return Array.from({length: Math.ceil((start + last) / 7) * 7}, (_, i) => {
      const d = i - start + 1; return d >= 1 && d <= last ? dateKey(y, m, d) : null;
    });
  }
  // A range is stored once, under its start date. Both endpoints are inclusive.
  function entriesOn(d, key) {
    const out = [];
    for (const [startDate, day] of Object.entries(d?.days || {})) {
      if (startDate > key) continue;
      for (const entry of day.entries || []) {
        const endDate = entry.endDate || startDate;
        if (key <= endDate) out.push({...entry, startDate, endDate});
      }
    }
    return out.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title));
  }
  function checkedEnd(startDate, endDate) {
    if (!parts(startDate) || !parts(endDate)) throw new Error('시작일과 종료일을 YYYY-MM-DD 형식으로 입력해 주세요.');
    if (endDate < startDate) throw new Error('종료일은 시작일과 같거나 이후여야 해요.');
    return endDate;
  }
  let state = {version: 1, bots: {}};
  let context = null, root = null, rootDoc = null;
  let expanded = false, selected = '', month = '', modal = false, stopped = false;
  let listeners = [], settingsId, timer, lastProbe = 0;
  let queue = Promise.resolve();
  const work = action => {
    const job = queue.then(() => stopped ? undefined : action());
    queue = job.catch(error => { console.error('[Calendar Diary]', error); status(error.message || String(error), true); });
    return queue;
  };
  function status(message, error = false) {
    const target = document.getElementById('diary-status');
    if (target) { target.textContent = message; target.style.color = error ? '#ffada4' : '#bad8c7'; }
  }
  async function update(mutator) {
    const next = clone(state); mutator(next);
    await api.pluginStorage.setItem(KEY, next);
    state = next;
  }
  function bot(ctx = context) { return ctx ? state.bots[ctx.botId] : null; }
  function diary(ctx = context) { return ctx?.chatId ? bot(ctx)?.chats?.[ctx.chatId] : null; }
  function active(ctx = context) { return !!(ctx?.chatId && bot(ctx)?.enabled && diary(ctx)?.enabled !== false); }
  function ensureBot(next, ctx) {
    return next.bots[ctx.botId] ||= {enabled: false, chats: {}};
  }
  function ensureDiary(next, ctx) {
    if (!ctx.chatId) throw new Error('이 채팅을 먼저 활성화해 주세요.');
    const b = ensureBot(next, ctx);
    return b.chats[ctx.chatId] ||= {enabled: true, today: initialDate(), days: {}};
  }
  async function readContext() {
    const characterIndex = await api.getCurrentCharacterIndex();
    if (characterIndex === null || characterIndex === undefined || characterIndex === -1 || characterIndex === '') return null;
    const character = await api.getCharacterFromIndex(characterIndex);
    if (!character?.chaId) return null;
    const chatIndex = await api.getCurrentChatIndex();
    if (await api.getCurrentCharacterIndex() !== characterIndex) return null;
    const chat = character.chats?.[chatIndex];
    if (!chat) return null;
    return {botId: character.chaId, chatId: chat.id || '', name: character.name || '이름 없는 캐릭터', chatName: chat.name || '채팅', characterIndex, chatIndex};
  }
  const signature = ctx => ctx ? JSON.stringify([ctx.botId, ctx.chatId, ctx.characterIndex, ctx.chatIndex]) : '';
  async function refresh(force = false) {
    const next = await readContext();
    const changed = signature(next) !== signature(context);
    context = next;
    if (changed) {
      expanded = false;
      selected = diary()?.today || initialDate(); month = selected.slice(0, 7) + '-01';
      if (modal) { modal = false; document.body.replaceChildren(); await api.hideContainer(); }
    }
    if (changed || force) await renderSide();
  }
  // Old chats may lack an ID. Assign one only on explicit activation, then verify.
  async function withStableChat(ctx) {
    if (ctx.chatId) return ctx;
    const freshChar = await api.getCharacterFromIndex(ctx.characterIndex);
    if (freshChar?.chaId !== ctx.botId) throw new Error('캐릭터가 바뀌었어요. 다시 열어 주세요.');
    const latest = await api.getChatFromIndex(ctx.characterIndex, ctx.chatIndex);
    if (!latest) throw new Error('채팅을 찾지 못했어요.');
    if (!latest.id) {
      const id = uid(); latest.id = id;
      await api.setChatToIndex(ctx.characterIndex, ctx.chatIndex, latest);
      const saved = await api.getChatFromIndex(ctx.characterIndex, ctx.chatIndex);
      if (saved?.id !== id) throw new Error('채팅 ID를 저장하지 못했어요. 쓰기 권한을 확인해 주세요.');
    }
    const saved = await api.getChatFromIndex(ctx.characterIndex, ctx.chatIndex);
    return {...ctx, chatId: saved.id};
  }
  async function clearSide() {
    for (const [el, id] of listeners) await el.removeEventListener('click', id);
    listeners = [];
    if (root) { await root.remove(); root = null; }
  }
  const buttonStyle = 'appearance:none;box-sizing:border-box;font:inherit;cursor:pointer;border:1px solid #655f53;border-radius:8px;background:#302e29;color:#f3eddf;padding:7px 9px;line-height:1.35;';
  async function renderSide() {
    await clearSide();
    if (!active()) return;
    if (!rootDoc) rootDoc = await api.getRootDocument();
    if (!rootDoc) {status('옆쪽 달력을 표시하려면 메인 화면 접근 권한이 필요해요. 설정을 다시 저장해 권한을 허용해 주세요.', true); return;}
    const body = await rootDoc.querySelector('body'); if (!body) return;
    const old = await rootDoc.querySelector(`[x-diary="${ROOT}"]`); if (old) await old.remove();
    root = await rootDoc.createElement('div');
    await root.setAttribute('x-diary', ROOT);
    await root.setStyleAttribute('position:fixed;right:0;top:14%;z-index:800;font:13px/1.5 system-ui,sans-serif;color:#f3eddf;box-sizing:border-box;');
    const bindings = [];
    function b(label, action, extra = '') {
      const id = `diary-action-${bindings.length}`; bindings.push([id, action]);
      return `<button type="button" data-diary-action="${id}" style="${buttonStyle}${extra}">${esc(label)}</button>`;
    }
    const d = diary();
    let html;
    if (!expanded) {
      html = b('▤ 달력', async () => { expanded = true; await renderSide(); }, 'border-radius:12px 0 0 12px;padding:12px 9px;box-shadow:0 4px 18px #0005;');
    } else {
      const p = parts(month), today = d?.today || initialDate();
      const day = d?.days?.[selected] || {entries: [], note: ''};
      const nav = b('‹', async () => {month = shift(month, -1, 'month'); await renderSide();}) +
        `<strong style="flex:1;text-align:center">${p.y}년 ${p.m}월</strong>` +
        b('›', async () => {month = shift(month, 1, 'month'); await renderSide();});
      const cells = monthCells(month).map(key => {
        if (!key) return '<span></span>';
        const saved = d?.days?.[key];
        const mark = entriesOn(d, key).length ? '•' : saved?.note ? '·' : '';
        return b(`${Number(key.slice(-2))}${mark}`, async () => {selected = key; await renderSide();},
          `min-height:37px;padding:5px 2px;${key === selected ? 'background:#d7c394;color:#27241c;border-color:#d7c394;' : key === today ? 'border-color:#d7c394;' : 'border-color:transparent;'}`);
      }).join('');
      const entries = entriesOn(d, selected).map(e => b(`${e.done ? '✓ ' : ''}${e.time ? e.time + ' ' : ''}${e.title}${e.endDate !== e.startDate ? ' · ' + e.startDate + ' ~ ' + e.endDate : ''}`, () => openEditor(e.id), 'width:100%;text-align:left;margin-top:6px;overflow-wrap:anywhere;' + (e.done ? 'opacity:.65;' : ''))).join('');
      html = `<section style="width:min(350px,calc(100vw - 18px));max-height:74dvh;overflow:auto;overscroll-behavior:contain;background:#24231f;border:1px solid #655f53;border-radius:16px 0 0 16px;padding:14px;box-shadow:0 8px 32px #0007;box-sizing:border-box;">
        <div style="display:flex;align-items:center;gap:8px"><strong style="flex:1">작은 기록장</strong>${b('설정', () => openSettings())}${b('접기', async () => {expanded = false; await renderSide();})}</div>
        <div style="font-size:11px;color:#c6bda9;margin:5px 0 12px;overflow-wrap:anywhere">${esc(context.name)} · ${esc(context.chatName)}</div>
        <div style="display:flex;gap:8px;align-items:center">${nav}</div>
        <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;text-align:center;margin:12px 0 8px">${'일월화수목금토'.split('').map(w => `<span style="color:#aaa28e;font-size:11px">${w}</span>`).join('')}${cells}</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${b('이야기 오늘', async () => {selected = today; month = today.slice(0,7)+'-01'; await renderSide();})}${b('날짜 설정', () => openSettings())}</div>
        <div style="margin:13px 0 4px;font-weight:700">${esc(selected)}${selected === today ? ' · 이야기 오늘' : ''}</div>
        ${entries || '<p style="color:#aaa28e">등록된 약속이 없어요.</p>'}
        ${day.note ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere;color:#d0c7b5;max-height:120px;overflow:auto">${esc(day.note)}</p>` : ''}
        <div style="display:flex;gap:6px;margin-top:12px">${b('+ 약속', () => openEditor())}${b('하루 메모', () => openNote())}</div>
      </section>`;
    }
    await root.setInnerHTML(html); await body.appendChild(root);
    await Promise.all(bindings.map(async ([id, callback]) => {
      const el = await root.querySelector(`[data-diary-action="${id}"]`);
      if (el) listeners.push([el, await el.addEventListener('click', () => work(async () => {
        const before = signature(context); await refresh();
        if (before === signature(context) && active()) await callback();
      }))]);
    }));
  }
  const css = `*{box-sizing:border-box}body{margin:0;background:#191b1a;color:#ecece5;font:15px/1.6 system-ui,sans-serif;padding:18px}main{max-width:620px;margin:auto}h1{font-size:21px;margin:0}h2{font-size:17px}header,.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}header h1{flex:1}section{padding:16px;border:1px solid #485149;border-radius:14px;margin-top:18px;background:#222723}label{display:block;margin:14px 0 5px}input,textarea,select,button{font:inherit;color:inherit;border:1px solid #626d60;border-radius:8px;padding:10px;background:#161b17}input:not([type=checkbox]),textarea{width:100%}textarea{min-height:160px;resize:vertical}button{cursor:pointer;background:#354236}button:disabled{opacity:.45;cursor:default}input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:8px}.hint{font-size:13px;color:#b9c4b6;white-space:pre-wrap;overflow-wrap:anywhere}.danger{background:#50362f}#diary-status{min-height:1.6em;white-space:pre-wrap}`;
  function el(tag, text, parent) { const n = document.createElement(tag); if (text) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function field(parent, label, kind, value = '') {
    const wrap = el('label', label, parent); const n = el(kind === 'textarea' ? 'textarea' : 'input', '', wrap);
    if(kind !== 'textarea') n.type = kind;
    n.value = value; return n;
  }
  function action(parent, label, callback, className = '') {
    const n = el('button', label, parent); n.type = 'button'; n.className = className;
    n.addEventListener('click', () => {n.disabled = true; work(callback).finally(() => {n.disabled = false;});}); return n;
  }
  async function shell(title) {
    document.body.replaceChildren();
    let style = document.getElementById('calendar-diary-style');
    if (!style) {style = el('style', '', document.head); style.id = 'calendar-diary-style'; style.textContent = css;}
    const main = el('main', '', document.body), header = el('header', '', main);
    el('h1', title, header);
    action(header, '닫기', async () => {modal = false; document.body.replaceChildren(); await api.hideContainer(); await refresh(true);});
    const s = el('p', '', main); s.id = 'diary-status';
    modal = true; await api.showContainer('fullscreen'); return main;
  }
  async function assertCurrent(captured) {
    const latest = await readContext();
    if (signature(latest) !== signature(captured)) throw new Error('열어 둔 캐릭터 또는 채팅이 바뀌었어요. 닫은 뒤 다시 열어 주세요.');
  }
  async function openSettings() {
    await refresh();
    const main = await shell('달력 · 작은 기록장');
    if (!context) {el('p', '사용할 캐릭터의 채팅을 연 뒤 다시 실행해 주세요.', main); return;}
    const ctx = clone(context);
    el('p', `${ctx.name} · ${ctx.chatName}`, main).className = 'hint';
    const sec = el('section', '', main);
    const botLabel = el('label', '', sec), cb = el('input', '', botLabel); cb.type='checkbox'; cb.checked = !!bot(ctx)?.enabled;
    botLabel.appendChild(document.createTextNode('현재 캐릭터에서 사용'));
    const chatLabel = el('label', '', sec), ch = el('input', '', chatLabel); ch.type='checkbox'; ch.checked = diary(ctx)?.enabled !== false;
    chatLabel.appendChild(document.createTextNode('현재 채팅에서 사용'));
    const toggleChat = () => {ch.disabled = !cb.checked;}; toggleChat(); cb.addEventListener('change', toggleChat);
    el('p', '캐릭터 사용을 켜야 달력 탭이 나타나요. 이 캐릭터의 다른 채팅은 기본으로 사용하며, 각 채팅에서 따로 끌 수 있어요. 기록은 채팅별로 나뉘고, 꺼도 그대로 보관해요.', sec).className='hint';
    const today = field(sec, '이야기 오늘', 'text', diary(ctx)?.today || initialDate()); today.placeholder='YYYY-MM-DD';
    el('p', '1~9999년의 양력 날짜를 사용해요. 처음에는 기기 날짜로 시작하며 이후에는 직접 바꿀 수 있어요.', sec).className='hint';
    action(sec, '설정 저장', async () => {
      await assertCurrent(ctx);
      if (!parts(today.value)) throw new Error('날짜를 YYYY-MM-DD 형식으로 입력해 주세요.');
      const stable = cb.checked ? await withStableChat(ctx) : ctx;
      await update(next => {const b = ensureBot(next, stable); b.enabled=cb.checked; if(stable.chatId) {const d=ensureDiary(next, stable); d.enabled=ch.checked; d.today=today.value;}});
      context=stable; selected=today.value; month=selected.slice(0,7)+'-01';
      await renderSide(); status('저장했어요.');
      // Keep this form's identity valid when an old chat received its first ID.
      Object.assign(ctx, stable);
    });
    const tools = el('section', '', main); el('h2', '현재 채팅 기록 백업', tools);
    el('p', '아래 JSON을 복사해 보관하거나, 다른 곳의 백업을 붙여 넣어 합칠 수 있어요.', tools).className='hint';
    const backup = field(tools, '백업 JSON', 'textarea'); backup.spellcheck=false;
    action(tools, '백업 불러오기', async () => {await assertCurrent(ctx); backup.value=JSON.stringify({format:KEY, version:1, diary:diary(ctx) || {today:today.value, enabled:true, days:{}}}, null, 2);});
    action(tools, '붙여 넣은 기록 합치기', async () => {
      await assertCurrent(ctx);
      const imported = validateBackup(JSON.parse(backup.value));
      const stable=await withStableChat(ctx);
      await update(next => {const d=ensureDiary(next, stable); for (const [key, value] of Object.entries(imported.days)) {
        const target=d.days[key] ||= {note:'',entries:[]};
        if (value.note && target.note !== value.note) target.note = target.note ? target.note+'\n\n'+value.note : value.note;
        for(const e of value.entries) {const i=target.entries.findIndex(x=>x.id===e.id); if(i<0) target.entries.push(e);}
      }});
      context=stable; Object.assign(ctx, stable); await renderSide(); status('기록을 합쳤어요. 같은 ID의 약속과 기존 설정은 유지했어요.');
    });
  }
  function validateBackup(input) {
    if(input?.format!==KEY || input.version!==1 || !input.diary?.days || typeof input.diary.days!=='object' || Array.isArray(input.diary.days)) throw new Error('지원하는 달력 백업이 아니에요.');
    const days={};
    for(const [key, day] of Object.entries(input.diary.days)) {
      if(!parts(key) || typeof day.note!=='string' || !Array.isArray(day.entries) || day.note.length>50000) throw new Error('백업 날짜 또는 메모 형식이 올바르지 않아요.');
      days[key]={note:day.note,entries:day.entries.map(e=>{
        if(typeof e.id!=='string' || !e.id || typeof e.title!=='string' || !e.title.trim() || e.title.length>200 || typeof e.body!=='string' || e.body.length>50000 || (e.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time))) throw new Error('백업 약속 형식이 올바르지 않아요.');
        const endDate = checkedEnd(key, e.endDate ?? key);
        return {id:e.id,title:e.title,body:e.body,time:e.time||'',done:!!e.done,endDate};
      })};
    }
    return {days};
  }
  async function openEditor(id) {
    if(!active()) return;
    const ctx=clone(context);
    const old=id ? entriesOn(diary(),selected).find(e=>e.id===id) : null;
    const origin=old?.startDate || selected;
    if(id && !old) throw new Error('약속을 찾지 못했어요.');
    const entry=old ? clone(old) : {id:uid(),title:'',time:'',body:'',done:false};
    const main=await shell(old ? '약속 편집' : '새 약속');
    el('p', `${ctx.name} · ${ctx.chatName}`, main).className='hint';
    const date=field(main,'시작일','text',origin);
    const end=field(main,'종료일','text',entry.endDate || origin);
    date.placeholder=end.placeholder='YYYY-MM-DD';
    el('p','시작일과 종료일을 모두 포함해요. 하루 일정은 두 날짜를 같게 지정하세요.',main).className='hint';
    let previousStart=origin;
    date.addEventListener('change',()=>{if(end.value===previousStart)end.value=date.value;previousStart=date.value;});
    const title=field(main,'제목','text',entry.title); title.maxLength=200;
    const time=field(main,'시간 · 선택','time',entry.time), body=field(main,'내용','textarea',entry.body); body.maxLength=50000;
    const label=el('label','',main), done=el('input','',label); done.type='checkbox'; done.checked=entry.done; label.appendChild(document.createTextNode('완료'));
    const row=el('div','',main); row.className='row';
    action(row,'저장',async()=>{
      await assertCurrent(ctx);
      const endDate=checkedEnd(date.value,end.value);
      if(!title.value.trim() || title.value.length>200 || body.value.length>50000) throw new Error('제목과 내용을 확인해 주세요.');
      if(time.value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) throw new Error('시간을 확인해 주세요.');
      await update(next=>{
        const d=ensureDiary(next,ctx);
        if(old) d.days[origin].entries=d.days[origin].entries.filter(e=>e.id!==id);
        const day=d.days[date.value] ||= {note:'',entries:[]};
        day.entries.push({id:entry.id,title:title.value.trim(),time:time.value,body:body.value,done:done.checked,endDate});
        day.entries.sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99'));
      });
      selected=date.value; month=selected.slice(0,7)+'-01'; modal=false; await api.hideContainer(); document.body.replaceChildren(); await renderSide();
    });
    if(old) {
      let confirm=false;
      const remove=action(row,'약속 삭제',async()=>{
        if(!confirm){confirm=true;remove.textContent='한 번 더 눌러 삭제';return;}
        await assertCurrent(ctx);
        await update(next=>{const d=ensureDiary(next,ctx);d.days[origin].entries=d.days[origin].entries.filter(e=>e.id!==id);});
        modal=false;await api.hideContainer();document.body.replaceChildren();await renderSide();
      },'danger');
    }
  }
  async function openNote() {
    if(!active()) return;
    const ctx=clone(context), date=selected;
    const main=await shell('하루 메모'); el('p',`${ctx.name} · ${date}`,main).className='hint';
    const note=field(main,'메모','textarea',diary()?.days?.[date]?.note||''); note.maxLength=50000;
    action(main,'저장',async()=>{await assertCurrent(ctx);if(note.value.length>50000)throw new Error('메모는 50,000자까지 저장할 수 있어요.');await update(next=>{const day=ensureDiary(next,ctx).days[date] ||= {entries:[],note:''};day.note=note.value;});modal=false;await api.hideContainer();document.body.replaceChildren();await renderSide();});
  }
  async function probe() {
    if(stopped) return;
    const ci=await api.getCurrentCharacterIndex();
    if(!context || ci!==context.characterIndex) {lastProbe=Date.now();await refresh();return;}
    const ti=await api.getCurrentChatIndex();
    if(!context || ci!==context.characterIndex || ti!==context.chatIndex || Date.now()-lastProbe>6000) {lastProbe=Date.now();await refresh();}
  }
  try {
    const saved=await api.pluginStorage.getItem(KEY);
    if(saved) {
      if(saved.version!==1 || !saved.bots || typeof saved.bots!=='object') throw new Error('저장 데이터 형식을 확인할 수 없어 초기화를 중단했어요.');
      state=saved;
    }
    const registration=await api.registerSetting('달력 · 작은 기록장',()=>work(openSettings),'📓','html','calendar-diary-settings');
    settingsId=registration?.id;
    await refresh(true);
    let polling=false;
    timer=setInterval(()=>{if(polling||stopped)return;polling=true;work(probe).finally(()=>{polling=false;});},1500);
    await api.onUnload(async()=>{stopped=true;clearInterval(timer);await queue;await clearSide();if(settingsId)await api.unregisterUIPart(settingsId);});
  } catch(error) {
    console.error('[Calendar Diary]',error);
    const main=await shell('달력 초기화 오류');el('p',error.message||String(error),main);
  }
})();
