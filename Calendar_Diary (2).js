//@name calendar_diary
//@display-name 달력
//@api 3.0
//@version 0.2.1
//@update-url https://raw.githubusercontent.com/hhja37984-AI/DaylifePlayroom/refs/heads/main/Calendar_Diary%20(2).js

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
    const start = (utc(y, m, 1).getUTCDay() + 6) % 7;
    const last = utc(y, m + 1, 0).getUTCDate();
    return Array.from({length: Math.ceil((start + last) / 7) * 7}, (_, i) => {
      const d = i - start + 1; return d >= 1 && d <= last ? dateKey(y, m, d) : null;
    });
  }
  const DAY_MS = 86400000;
  function dayNumber(key) { const p=parts(key); return utc(p.y,p.m,p.d).getTime()/DAY_MS; }
  function fromDayNumber(n) {
    const dt=new Date(n*DAY_MS), y=dt.getUTCFullYear();
    return y>=1 && y<=9999 ? dateKey(y,dt.getUTCMonth()+1,dt.getUTCDate()) : null;
  }
  function normalizeRepeat(value, start, end) {
    if (!value) return null;
    const n=Number(value.interval), unit=value.unit;
    const minDays={day:1,week:7,month:28,year:365};
    if (!Object.hasOwn(minDays,unit) || !Number.isInteger(n) || n<1 || n>9999) throw new Error('반복 간격은 1~9999 사이의 정수로 지정해 주세요.');
    if (dayNumber(end)-dayNumber(start)+1 > n*minDays[unit]) throw new Error('반복 간격은 일정 기간 이상이어야 해요.');
    return {interval:n,unit};
  }
  function occurrenceStart(origin, repeat, key) {
    if(!repeat) return origin;
    const {interval:n,unit}=repeat;
    if(unit==='day'||unit==='week') {
      const step=n*(unit==='week'?7:1), delta=dayNumber(key)-dayNumber(origin);
      return fromDayNumber(dayNumber(origin)+Math.floor(delta/step)*step);
    }
    const a=parts(origin), b=parts(key), base=a.y*12+a.m-1;
    const step=n*(unit==='year'?12:1);
    let k=Math.floor((b.y*12+b.m-1-base)/step);
    const at=i=>{
      const m=base+i*step, y=Math.floor(m/12), month=m%12+1;
      return dateKey(y,month,Math.min(a.d,utc(y,month+1,0).getUTCDate()));
    };
    let candidate=at(k);
    if(candidate>key && k>0) candidate=at(--k);
    return candidate<=key?candidate:null;
  }
  function entryTitle(e, today) {
    const delta=dayNumber(today)-dayNumber(e.startDate);
    return e.title+(e.dday ? ' · '+(delta===0?'D-Day':delta<0?'D'+delta:'D+'+delta) : '')+(e.repeat?' ↻':'');
  }
  // Recurring dates are calculated on demand; only the series template is stored.
  function entriesOn(d, key) {
    const out = [];
    for (const [origin, day] of Object.entries(d?.days || {})) {
      if (origin > key) continue;
      for (const entry of day.entries || []) {
        const duration=dayNumber(entry.endDate || origin)-dayNumber(origin);
        const startDate=occurrenceStart(origin,entry.repeat,key);
        if (!startDate || dayNumber(key)-dayNumber(startDate)>duration) continue;
        const endDate=fromDayNumber(dayNumber(startDate)+duration)||'9999-12-31';
        out.push({...entry, origin, startDate, endDate});
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
    if (target) { target.textContent = message; target.style.color = error ? '#a33' : '#356c45'; }
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
    else if (active() && !modal) {
      if (!rootDoc) rootDoc = await api.getRootDocument();
      const mounted = rootDoc && await rootDoc.querySelector('[x-diary="' + ROOT + '"]');
      if (!mounted || !root) await renderSide();
    }
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
  let detailListeners = [], menuListeners = [], lastTapKey = '', lastTapAt = 0;
  const stickers = ['🌙','☀️','⭐','🎂','⚓','✉️','❤️','🌹','🍷','🎁','⚔️','🏛️'];
  function resetTap() { lastTapKey = ''; lastTapAt = 0; }
  async function clearMenu() {
    const old = menuListeners; menuListeners = [];
    for (const [el,id] of old) { try { await el.removeEventListener('click',id); } catch (_) {} }
    const box = root && await root.querySelector('[data-diary-menu]');
    if (box) await box.setInnerHTML('');
  }
  async function clearDetails() {
    const old = detailListeners; detailListeners = [];
    for (const [el,id] of old) { try { await el.removeEventListener('click',id); } catch (_) {} }
  }
  async function clearSide() {
    await clearDetails();
    resetTap();
    await clearMenu();
    const old = listeners; listeners = [];
    for (const [el,id,type] of old) { try { await el.removeEventListener(type || 'click',id); } catch (_) {} }
    const oldRoot = root; root = null;
    if (oldRoot) { try { await oldRoot.remove(); } catch (_) {} }
  }
  const buttonStyle = 'appearance:none;box-sizing:border-box;font:inherit;cursor:pointer;border:0;border-radius:0;background:transparent;color:inherit;padding:4px 6px;line-height:1.35;';
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // Each week has seven explicitly positioned cells. Range bars overlap those
  // same grid tracks and use separate lanes when their dates overlap.
  function weekRanges(d, keys) {
    const seen = new Map();
    keys.forEach((key, col) => {
      if (!key) return;
      for (const e of entriesOn(d, key)) {
        if (e.startDate === e.endDate) continue;
        const id = e.startDate + ':' + e.id;
        if (!seen.has(id)) seen.set(id, {...e, first:col, last:col});
        else seen.get(id).last = col;
      }
    });
    const lanes = [];
    const bars = [...seen.values()].sort((a,b) => a.first-b.first || b.last-a.last || a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
    for (const bar of bars) {
      let lane = lanes.findIndex(end => end < bar.first);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = bar.last;
      bar.lane = lane;
    }
    return {bars, count:lanes.length};
  }
  async function attachSideBindings(scope, bindings, target) {
    await Promise.all(bindings.map(async ([id, callback, dayKey]) => {
      const el = await scope.querySelector('[data-diary-action="' + id + '"]');
      if (el) target.push([el, await el.addEventListener('click', () => {
        const panel = root;
        const now = Date.now();
        const doubleTap = !!dayKey && lastTapKey === dayKey && now-lastTapAt <= 450;
        if (!dayKey || doubleTap) resetTap();
        else { lastTapKey = dayKey; lastTapAt = now; }
        return work(async () => {
          if (panel !== root) return;
          const before = signature(context);
          await refresh();
          if (before === signature(context) && active() && panel === root) {
            if (doubleTap) await showDayMenu(dayKey);
            else await callback();
          }
        });
      })]);
    }));
  }
  async function renderSelectedDetails() {
    if (!root || !expanded) return;
    const dateEl = await root.querySelector('[data-diary-selected]');
    const detail = await root.querySelector('[data-diary-details]');
    if (!dateEl || !detail) return;
    await clearDetails();
    await dateEl.setInnerHTML(esc(selected));
    const d = diary(), day = d?.days?.[selected] || {entries:[],note:''};
    const bindings = [];
    const entries = entriesOn(d,selected).map(e => {
      const id = 'diary-detail-' + bindings.length;
      bindings.push([id, () => openEditor(e.id)]);
      const label = (e.done ? '✓ ' : '') + (e.time ? e.time + ' ' : '') + entryTitle(e,d?.today || initialDate()) + (e.endDate !== e.startDate ? ' · ' + e.startDate + ' ~ ' + e.endDate : '');
      return '<button type="button" data-diary-action="' + id + '" style="' + buttonStyle + 'display:block;width:100%;text-align:left;padding:5px 0;border-bottom:1px solid #eee;overflow-wrap:anywhere;' + (e.done ? 'opacity:.65;text-decoration:line-through;' : '') + '">' + esc(label) + '</button>';
    }).join('');
    await detail.setInnerHTML(entries + (day.note ? '<div style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto;font-size:12px;padding:6px 0">' + esc(day.note) + '</div>' : ''));
    await attachSideBindings(detail,bindings,detailListeners);
  }
  async function selectDate(key) {
    await clearMenu();
    if (key === selected) return;
    selected = key;
    await renderSelectedDetails();
  }
  async function showDayMenu(key) {
    if (!root || !expanded || modal) return;
    selected = key;
    await renderSelectedDetails();
    await clearMenu();
    const box = await root.querySelector('[data-diary-menu]');
    if (!box) return;
    const ctx = clone(context);
    const bindings = [];
    function item(label, callback, style='') {
      const id = 'diary-menu-' + bindings.length;
      bindings.push([id,callback]);
      return '<button type="button" data-diary-action="'+id+'" style="'+buttonStyle+style+'">'+esc(label)+'</button>';
    }
    async function saveSticker(value) {
      await assertCurrent(ctx);
      await update(next => {
        const day = ensureDiary(next,ctx).days[key] ||= {entries:[],note:''};
        if (value) day.sticker = value; else delete day.sticker;
      });
      await renderSide();
    }
    const chosen = diary()?.days?.[key]?.sticker;
    const icons = stickers.map(icon=>item(icon,()=>saveSticker(icon),'font-size:19px;border:1px solid #ddd;border-radius:4px;padding:4px;'+(chosen===icon?'background:#edf5ff;':''))).join('');
    await box.setInnerHTML('<div style="position:absolute;right:8px;left:8px;top:38px;z-index:5;background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px;box-shadow:0 3px 12px #0002;box-sizing:border-box;">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;margin-bottom:8px"><strong>'+esc(key)+'</strong>'+item('×',clearMenu)+'</div>'+
      '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">'+icons+item('−',()=>saveSticker(''),'border:1px solid #ddd;border-radius:4px;')+'</div>'+
      item('+ 일정',async()=>{await clearMenu();await openEditor();},'display:block;text-align:left;width:100%;padding:8px 0;')+
      item('메모',async()=>{await clearMenu();await openNote();},'display:block;text-align:left;width:100%;padding:8px 0;')+
      '</div>');
    await attachSideBindings(box,bindings,menuListeners);
  }
  async function renderSide() {
    await clearSide();
    if (!active()) return;
    rootDoc = await api.getRootDocument();
    if (!rootDoc) {status('달력을 표시하려면 메인 화면 접근 권한이 필요합니다.', true); return;}
    const body = await rootDoc.querySelector('body'); if (!body) return;
    const old = await rootDoc.querySelector('[x-diary="' + ROOT + '"]'); if (old) await old.remove();
    root = await rootDoc.createElement('div');
    await root.setAttribute('x-diary', ROOT);
    await root.setStyleAttribute('position:fixed;right:0;top:14%;z-index:800;font:13px/1.35 sans-serif;color:#333;box-sizing:border-box;');
    const bindings = [];
    function bind(action, dayKey = '') {
      const id = 'diary-action-' + bindings.length;
      bindings.push([id, action, dayKey]); return id;
    }
    function b(label, action, extra = '', title = '') {
      return '<button type="button" data-diary-action="' + bind(action) + '" style="' + buttonStyle + extra + '"' + (title ? ' title="' + esc(title) + '" aria-label="' + esc(title) + '"' : '') + '>' + esc(label) + '</button>';
    }
    const d = diary();
    let html;
    if (!expanded) {
      html = b('달력', async () => { expanded = true; await renderSide(); }, 'display:block;min-width:44px;min-height:36px;color:#333;background:#fff;border:1px solid #ddd;border-right:0;border-radius:4px 0 0 4px;padding:9px 7px;');
    } else {
      const p = parts(month), today = d?.today || initialDate();
      const nav = b('‹', async () => {month = shift(month, -1, 'month'); await renderSide();}, '', '이전 달') +
        '<span style="font-size:18px;font-weight:700">' + monthNames[p.m-1] + '</span><span style="font-size:14px">' + p.y + '</span>' +
        b('›', async () => {month = shift(month, 1, 'month'); await renderSide();}, '', '다음 달');
      const keys = monthCells(month);
      const weeks = [];
      for (let i = 0; i < keys.length; i += 7) {
        const wk = keys.slice(i,i+7);
        const ranges = weekRanges(d, wk);
        const eventTop = Math.max(32, 19 + ranges.count * 15);
        const cells = wk.map((key,col) => {
          const base = 'grid-row:1;grid-column:' + (col+1) + ';position:relative;min-width:0;box-sizing:border-box;border:.5px solid #ddd;';
          if (!key) return '<div style="' + base + 'background:#fafafa"></div>';
          const single = entriesOn(d,key).filter(e => e.startDate === e.endDate);
          const labels = single.map(e => '<div style="font-size:11px;line-height:1.25;overflow-wrap:anywhere;letter-spacing:-.03em;' + (e.done ? 'text-decoration:line-through;opacity:.65;' : '') + '">' + esc(entryTitle(e,today)) + '</div>').join('');
          const note = d?.days?.[key]?.note;
          const cellStyle = buttonStyle + base + 'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation;text-align:left;align-self:stretch;width:100%;padding:' + eventTop + 'px 3px 4px;';
          const background = key === today ? 'background:#edf5ff;' : 'background:#fff;';
          const dateStyle = key === today ? 'font-weight:700;color:#2769a8;' : '';
          return '<button type="button" data-diary-date="' + esc(key) + '" aria-label="' + esc(key) + '" data-diary-action="' + bind(() => selectDate(key),key) + '" style="' + cellStyle + background + '">' +
            '<span style="position:absolute;top:2px;left:4px;font-size:12px;' + dateStyle + '">' + Number(key.slice(-2)) + '</span>' +
            (d?.days?.[key]?.sticker ? '<span style="position:absolute;top:2px;right:3px;font-size:14px;pointer-events:none;">'+esc(d.days[key].sticker)+'</span>' : note ? '<span title="메모" style="position:absolute;top:2px;right:3px;font-size:11px;color:#999">·</span>' : '') + labels + '</button>';
        }).join('');
        const bars = ranges.bars.map(e => {
          const startsHere = wk[e.first] === e.startDate;
          return '<div style="grid-row:1;grid-column:' + (e.first+1) + ' / ' + (e.last+2) + ';align-self:start;margin-top:' + (17+e.lane*15) + 'px;height:13px;line-height:13px;background:linear-gradient(to bottom,transparent 60%,rgba(86,160,244,.3) 60%);font-size:10px;padding-left:4px;min-width:0;overflow:hidden;white-space:nowrap;z-index:1;pointer-events:none;' + (e.done ? 'opacity:.55;text-decoration:line-through;' : '') + '">' + (startsHere || e.first === 0 || !wk[e.first-1] ? esc(entryTitle(e,today)) : '') + '</div>';
        }).join('');
        weeks.push('<div style="position:relative;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-template-rows:minmax(' + Math.max(70,eventTop+20) + 'px,auto)">' + cells + bars + '</div>');
      }
      html = b('', async () => {expanded = false; await renderSide();}, 'position:fixed;inset:0;width:100vw;height:100dvh;padding:0;background:transparent;z-index:0;', '달력 바깥을 눌러 닫기') +
        '<section style="position:relative;z-index:1;width:min(350px,calc(100vw - 18px));max-height:74dvh;overflow:auto;overscroll-behavior:contain;background:#fff;border:1px solid #ddd;border-right:0;border-radius:4px 0 0 4px;padding:8px;box-sizing:border-box;color:#333;">' +
        '<header style="display:flex;align-items:baseline;gap:4px;margin-bottom:10px">' + nav +
        '<span style="flex:1"></span>' +
        b('오늘', async () => {if (month.slice(0,7) === today.slice(0,7)) await selectDate(today); else {selected = today; month = today.slice(0,7)+'-01'; await renderSide();}}) +
        b('⚙', () => openSettings(), '', '설정') +
        b('×', async () => {expanded = false; await renderSide();}, '', '접기') + '</header>' +
        '<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));text-align:center;font-size:12px;margin-bottom:3px">' + '월화수목금토일'.split('').map(w => '<span>' + w + '</span>').join('') + '</div>' +
        '<div data-diary-grid="1">' + weeks.join('') + '</div><div data-diary-menu="1"></div>' +
        '<div style="display:flex;align-items:center;gap:4px;margin-top:10px;border-bottom:1px solid #ddd;padding-bottom:4px"><strong data-diary-selected="1" style="flex:1;font-size:12px">' + esc(selected) + '</strong>' +
        b('+ 일정', () => openEditor()) + b('메모', () => openNote()) + '</div>' +
        '<div data-diary-details="1"></div>' +
        '</section>';
    }
    await root.setInnerHTML(html); await body.appendChild(root);
    await attachSideBindings(root,bindings,listeners);
    if (expanded) await renderSelectedDetails();
  }
  const css = `*{box-sizing:border-box}body{margin:0;background:transparent;color:#333;font:13px/1.45 sans-serif;padding:0}main{background:#fff;max-width:620px;margin:auto;padding:12px}body.diary-compact main{position:fixed;right:0;top:14%;width:min(350px,calc(100vw - 18px));max-height:74dvh;overflow:auto;overscroll-behavior:contain;border:1px solid #ddd;border-right:0;border-radius:4px 0 0 4px;padding:12px}h1{font-size:18px;margin:0}h2{font-size:15px}header,.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header h1{flex:1}section{padding:10px;border:1px solid #ddd;margin-top:12px;background:#fff}label{display:block;margin:10px 0 4px}input,textarea,select,button{font:inherit;color:inherit;border:1px solid #ddd;border-radius:4px;padding:6px;background:#fff}input:not([type=checkbox]),textarea{width:100%}textarea{min-height:100px;resize:vertical}button{cursor:pointer;background:#f5f5f5}button:disabled{opacity:.45;cursor:default}input[type=checkbox]{width:16px;height:16px;vertical-align:middle;margin-right:6px}.hint{font-size:11px;color:#777;white-space:pre-wrap;overflow-wrap:anywhere}.danger{color:#a33}#diary-status{white-space:pre-wrap}#diary-status:empty{display:none}`;
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
  async function shell(title, compact = false) {
    document.body.replaceChildren();
    document.body.classList.toggle('diary-compact', compact);
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
    const main = await shell('달력');
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
    const today = field(sec, '현재 날짜', 'text', diary(ctx)?.today || initialDate()); today.placeholder='YYYY-MM-DD';
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
        if (value.sticker && !target.sticker) target.sticker = value.sticker;
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
      days[key]={note:day.note,...(stickers.includes(day.sticker)?{sticker:day.sticker}:{}),entries:day.entries.map(e=>{
        if(typeof e.id!=='string' || !e.id || typeof e.title!=='string' || !e.title.trim() || e.title.length>200 || typeof e.body!=='string' || e.body.length>50000 || (e.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time))) throw new Error('백업 약속 형식이 올바르지 않아요.');
        const endDate = checkedEnd(key, e.endDate ?? key);
        return {id:e.id,title:e.title,body:e.body,time:e.time||'',done:!!e.done,endDate,dday:!!e.dday,repeat:normalizeRepeat(e.repeat,key,endDate)};
      })};
    }
    return {days};
  }
  function rangePicker(parent,start,end) {
    const value={start,end};
    let shown=start.slice(0,7)+'-01', anchor=null;
    const wrap=el('div','',parent);
    el('label','날짜 선택',wrap);
    const summary=el('button','',wrap); summary.type='button'; summary.style.cssText='font-weight:600;margin:4px 0;padding:5px 0;background:transparent;border:0;text-align:left';
    const popup=el('div','',wrap); popup.hidden=true; popup.style.cssText='padding:4px 0 8px';
    summary.setAttribute('aria-expanded','false');
    summary.addEventListener('click',()=>{popup.hidden=!popup.hidden;summary.setAttribute('aria-expanded',String(!popup.hidden));if(popup.hidden) anchor=null;paint();});
    const nav=el('div','',popup); nav.className='row'; nav.style.justifyContent='space-between';
    const prev=el('button','‹',nav), heading=el('strong','',nav), next=el('button','›',nav);
    for(const button of [prev,next]) {button.type='button';button.style.cssText='border:0;background:transparent;padding:5px 10px;font-size:18px';}
    const grid=el('div','',popup);
    grid.style.cssText='display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px;text-align:center;margin-top:5px';
    const clear=el('button','다시 선택',popup); clear.type='button'; clear.style.cssText='margin-top:5px;background:transparent;border:0';
    function paint() {
      const p=parts(shown);
      heading.textContent=p.y+'년 '+p.m+'월';
      summary.textContent=(value.start===value.end?value.start:value.start+' ~ '+value.end)+(popup.hidden?' ▾':' ▴');
      grid.replaceChildren();
      for(const w of '월화수목금토일') el('span',w,grid);
      for(const key of monthCells(shown)) {
        if(!key){el('span','',grid);continue;}
        const btn=el('button',String(Number(key.slice(-2))),grid); btn.type='button';
        btn.style.cssText='min-width:0;padding:7px 0;border:0;background:transparent;border-radius:4px;touch-action:manipulation';
        if(key>=value.start&&key<=value.end) btn.style.background='#edf5ff';
        if(key===value.start||key===value.end){btn.style.background='#2769a8';btn.style.color='#fff';}
        btn.addEventListener('click',()=>{
          if(anchor===null){anchor=key;value.start=value.end=key;}
          else {value.start=key<anchor?key:anchor;value.end=key>anchor?key:anchor;anchor=null;}
          paint();
        });
      }
    }
    prev.addEventListener('click',()=>{shown=shift(shown,-1,'month');paint();});
    next.addEventListener('click',()=>{shown=shift(shown,1,'month');paint();});
    clear.addEventListener('click',()=>{anchor= null;value.start=value.end=value.start;paint();});
    paint(); return value;
  }
  async function openEditor(id) {
    if(!active()) return;
    const ctx=clone(context);
    const old=id ? entriesOn(diary(),selected).find(e=>e.id===id) : null;
    const origin=old?.origin || selected;
    const template=old && diary()?.days?.[origin]?.entries?.find(e=>e.id===id);
    const viewDate=selected;
    if(id && !old) throw new Error('약속을 찾지 못했어요.');
    const entry=old ? clone(template || old) : {id:uid(),title:'',time:'',body:'',done:false};
    const main=await shell(old ? '약속 편집' : '새 약속', true);
    el('p', `${ctx.name} · ${ctx.chatName}`, main).className='hint';
    const dates=rangePicker(main,origin,entry.endDate || origin);
    if(old?.repeat) el('p','반복 일정의 원본을 편집해요. 변경 및 완료 상태는 전체 반복 일정에 적용됩니다.',main).className='hint';
    const title=field(main,'제목','text',entry.title); title.maxLength=200;
    const time=field(main,'시간 · 선택','time',entry.time), body=field(main,'내용','textarea',entry.body); body.maxLength=50000;
    const opts=el('div','',main);
    const ddLabel=el('label','',opts), dd=el('input','',ddLabel); dd.type='checkbox'; dd.checked=!!entry.dday; ddLabel.appendChild(document.createTextNode('디데이 표시'));
    const repeatLabel=el('label','',opts), repeating=el('input','',repeatLabel); repeating.type='checkbox'; repeating.checked=!!entry.repeat; repeatLabel.appendChild(document.createTextNode('반복'));
    const repeatRow=el('div','',opts); repeatRow.className='row';
    const interval=el('input','',repeatRow); interval.type='number'; interval.min='1'; interval.max='9999'; interval.step='1'; interval.value=entry.repeat?.interval || '1'; interval.style.width='70px';
    const unit=el('select','',repeatRow);
    for(const [value,label] of [['day','일'],['week','주'],['month','개월'],['year','년']]) {const opt=el('option',label,unit);opt.value=value;}
    unit.value=entry.repeat?.unit || 'week'; el('span','마다 반복',repeatRow);
    const syncRepeat=()=>{repeatRow.style.display=repeating.checked?'flex':'none';}; repeating.addEventListener('change',syncRepeat);syncRepeat();
    const label=el('label','',main), done=el('input','',label); done.type='checkbox'; done.checked=entry.done; label.appendChild(document.createTextNode('완료'));
    const row=el('div','',main); row.className='row';
    action(row,'저장',async()=>{
      await assertCurrent(ctx);
      const startDate=dates.start, endDate=checkedEnd(startDate,dates.end);
      const repeat=normalizeRepeat(repeating.checked?{interval:interval.value,unit:unit.value}:null,startDate,endDate);
      if(!title.value.trim() || title.value.length>200 || body.value.length>50000) throw new Error('제목과 내용을 확인해 주세요.');
      if(time.value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) throw new Error('시간을 확인해 주세요.');
      await update(next=>{
        const d=ensureDiary(next,ctx);
        if(old) d.days[origin].entries=d.days[origin].entries.filter(e=>e.id!==id);
        const day=d.days[startDate] ||= {note:'',entries:[]};
        day.entries.push({id:entry.id,title:title.value.trim(),time:time.value,body:body.value,done:done.checked,endDate,dday:dd.checked,repeat});
        day.entries.sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99'));
      });
      selected=old?.repeat && startDate===origin ? viewDate : startDate; month=selected.slice(0,7)+'-01'; modal=false; await api.hideContainer(); document.body.replaceChildren(); await renderSide();
    });
    if(old) {
      let confirm=false;
      const remove=action(row,old.repeat?'반복 일정 전체 삭제':'약속 삭제',async()=>{
        if(!confirm){confirm=true;remove.textContent=old.repeat?'한 번 더 눌러 전체 삭제':'한 번 더 눌러 삭제';return;}
        await assertCurrent(ctx);
        await update(next=>{const d=ensureDiary(next,ctx);d.days[origin].entries=d.days[origin].entries.filter(e=>e.id!==id);});
        modal=false;await api.hideContainer();document.body.replaceChildren();await renderSide();
      },'danger');
    }
  }
  async function openNote() {
    if(!active()) return;
    const ctx=clone(context), date=selected;
    const main=await shell('하루 메모', true); el('p',`${ctx.name} · ${date}`,main).className='hint';
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
    const registration=await api.registerSetting('달력',()=>work(openSettings),'📓','html','calendar-diary-settings');
    settingsId=registration?.id;
    try { await refresh(true); } catch (error) { console.error('[Calendar Diary] Initial panel render',error); }
    let polling=false;
    timer=setInterval(()=>{if(polling||stopped)return;polling=true;work(probe).finally(()=>{polling=false;});},1500);
    await api.onUnload(async()=>{stopped=true;clearInterval(timer);await queue;await clearSide();if(settingsId)await api.unregisterUIPart(settingsId);});
  } catch(error) {
    console.error('[Calendar Diary]',error);
    const main=await shell('달력 초기화 오류');el('p',error.message||String(error),main);
  }
})();
