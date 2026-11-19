/**
 * AI 解題助手 — 右側分割面板（書籤注入版）
 * 由 http://127.0.0.1:8791/panel.js 提供，掛在任何網頁右側，
 * 讀取左側畫面（題目 / 選項 / 解答），送給 DeepSeek 解析。
 */
(function () {
  'use strict';

  var NS = '__DS_TUTOR__';
  if (window[NS]) { window[NS].toggle(); return; }

  var SELF_SRC = '';
  try { SELF_SRC = (document.currentScript && document.currentScript.src) || ''; } catch (e) {}

  // EXT = 瀏覽器擴充功能（Chrome / Edge）：金鑰存在擴充功能裡，所有網站共用同一組
  var EXT = false;
  try {
    EXT = !!(window.chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
  } catch (e) {}

  // HOSTED = 沒有本機伺服器，瀏覽器直接呼叫 DeepSeek
  var HOSTED = EXT || !!window.__DS_HOSTED__ ||
    /[?&]hosted=1/.test(SELF_SRC) ||
    /(^|\.)github\.io$/.test(location.hostname);

  var SERVER = HOSTED ? '' : 'http://127.0.0.1:8791';
  var BASE_DIR = SERVER || (SELF_SRC ? SELF_SRC.replace(/[?#].*$/, '').replace(/[^/]*$/, '') : '');
  var PREFS_KEY = 'dsTutor.prefs.v1';
  var CFG_KEY = 'ds-assistant.cfg.v1';
  var HOST_ID = 'ds-tutor-host';

  // 以 /panel.html 直接開啟時（預覽 / 手動貼上模式）
  var STANDALONE = false;
  try {
    STANDALONE = !!(document.currentScript && document.currentScript.hasAttribute('data-standalone'));
  } catch (e) {}

  /* ============================ 偏好 ============================ */
  var prefs = Object.assign({
    width: 0,
    open: true,
    push: true,
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com',
    temperature: 0.3,
    autoCtx: true,
    siteSelectors: {}
  }, readPrefs());

  function readPrefs() {
    if (EXT) return {};   // 擴充功能模式：偏好存在 chrome.storage，跨網站共用
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
    if (EXT) saveExt();
  }
  function siteKey() { return location.hostname + location.pathname.split('/').slice(0, 2).join('/'); }

  /* ---- 擴充功能模式：金鑰與偏好存在 chrome.storage.local（只在這台電腦，網站讀不到） ---- */
  var extState = { cfg: null, ready: false };

  function saveExt() {
    if (!EXT || !extState.ready) return;   // 還沒讀到舊設定前不要寫，否則會蓋掉金鑰
    try {
      chrome.storage.local.set({
        dsCfg: extState.cfg || {},
        dsPrefs: {
          open: prefs.open, push: prefs.push, width: prefs.width,
          model: prefs.model, baseURL: prefs.baseURL,
          temperature: prefs.temperature, autoCtx: prefs.autoCtx
        }
      });
    } catch (e) {}
  }

  function loadExtState() {
    if (!EXT) return;
    try {
      chrome.storage.local.get(['dsCfg', 'dsPrefs'], function (o) {
        o = o || {};
        extState.cfg = o.dsCfg || {};
        extState.ready = true;
        var p = o.dsPrefs || {};
        ['open', 'push', 'width', 'model', 'baseURL', 'temperature', 'autoCtx'].forEach(function (k) {
          if (p[k] !== undefined) prefs[k] = p[k];
        });
        applyExtPrefs();
        updateCtxBadge();
        loadServerConfig();
      });
    } catch (e) {}
  }

  function applyExtPrefs() {
    if (!EXT) return;
    if (!prefs.width) prefs.width = Math.round(Math.min(520, Math.max(360, window.innerWidth * 0.42)));
    host.style.width = prefs.width + 'px';
    host.style.display = prefs.open ? 'block' : 'none';
    if ($('widthVal')) $('widthVal').textContent = prefs.width;
    applyPush();
    syncMini();
  }

  /* ---- HOSTED：設定存在這台電腦的瀏覽器，不經過任何伺服器 ---- */
  function readHostCfg() {
    if (EXT) return extState.cfg || {};
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveHostCfg(c) {
    if (EXT) { extState.cfg = c; saveExt(); return; }
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
  }
  function hostKey() { return String(readHostCfg().apiKey || '').trim(); }
  function apiBase() { return String(prefs.baseURL || 'https://api.deepseek.com').replace(/\/+$/, ''); }
  function errText(j, status) {
    if (!j) return 'HTTP ' + status;
    var e = j.error;
    if (typeof e === 'string') return e;
    if (e && e.message) return e.message;
    if (j.message) return String(j.message);
    return 'HTTP ' + status;
  }

  async function callChat(payload, signal) {
    if (!HOSTED) {
      return fetch(SERVER + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: signal,
        body: JSON.stringify(payload)
      });
    }
    var key = hostKey();
    if (!key) {
      var e = new Error('尚未設定 DeepSeek API Key');
      e.needKey = true;
      throw e;
    }
    return fetch(apiBase() + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      signal: signal,
      body: JSON.stringify(payload)
    });
  }

  var state = {
    ctx: null,
    stale: true,
    busy: false,
    controller: null,
    messages: [],
    lastAnswer: ''
  };

  var SYSTEM_PROMPT = [
    '你是一位台灣的閱讀與各科解題老師，正在協助一位國小學生看懂眼前這份題目。',
    '一律使用繁體中文（台灣用語），語氣親切、白話、具體。',
    '',
    '回答規則：',
    '1. 先直接給答案，格式如「✅ 答案：（B）」，一句話講完。',
    '2. 再解釋為什麼：用「因為…所以…」的短句，一次只講一個重點，避免艱深術語。',
    '3. 題目有選項時，逐一說明每個選項對或錯的原因（用列點）。',
    '4. 有英文單字或句子時，附上中文翻譯、詞性，必要時給發音提示。',
    '5. 完全依照畫面內容作答，不要自己編造選項或題目；資料不足時明確說「畫面資訊不足」。',
    '6. 最後用一行「💡 小訣竅：」給一個好記的方法。',
    '7. 回答長度控制在 400 字以內，除非使用者要求更詳細。',
    '8. 如果使用者只是問一個概念，就正常教學回答，不要硬套解題格式。'
  ].join('\n');

  var QUICK = [
    ['解析這題', '請解析這題，先給答案，再說明為什麼。'],
    ['只要提示', '先不要給答案，給我三個提示，讓我自己想。'],
    ['一步一步', '請一步一步帶我解，每一步都解釋為什麼。'],
    ['選項分析', '請逐一分析每個選項為什麼對、為什麼錯。'],
    ['翻譯', '請把畫面中的英文句子翻成中文，並解釋單字。'],
    ['重點整理', '請把這頁的重點整理成 5 條。']
  ];

  /* ============================ 樣式 ============================ */
  var CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .app {
    height: 100%; display: flex; flex-direction: column; position: relative;
    background: #0d1016; color: #e7ebf3;
    font: 400 13.5px/1.6 -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif;
    border-left: 1px solid #232a38;
    box-shadow: -10px 0 30px rgba(0,0,0,.45);
    overflow: hidden;
  }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }

  .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #1b2130; background: #10141d; }
  .logo {
    width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center;
    font: 700 10px/1 "Segoe UI", sans-serif; letter-spacing: .02em; color: #fff;
    background: linear-gradient(135deg, #5b8cff, #8b5cf6);
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 13.5px; letter-spacing: .01em; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4b5563; box-shadow: 0 0 0 3px rgba(75,85,99,.18); }
  .dot.on { background: #35d07f; box-shadow: 0 0 0 3px rgba(53,208,127,.18); }
  .dot.err { background: #ff6b6b; box-shadow: 0 0 0 3px rgba(255,107,107,.18); }
  .spacer { flex: 1; }
  .ico {
    width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center;
    color: #97a1b5; font-size: 14px; line-height: 1;
  }
  .ico:hover { background: #1b2130; color: #e7ebf3; }
  .ico.active { background: #1d2a4a; color: #9dbaff; }

  .ctxbar { display: flex; align-items: center; gap: 6px; padding: 7px 12px; background: #0f131b; border-bottom: 1px solid #1b2130; font-size: 11.5px; color: #97a1b5; }
  .ctxbar b { color: #c9d3e6; font-weight: 600; }
  .ctxbar .warn { color: #ffb86b; }
  .mini {
    padding: 3px 8px; border-radius: 6px; font-size: 11.5px; color: #a9b6cd;
    border: 1px solid #232a38; background: #141a24;
  }
  .mini:hover { border-color: #33405a; color: #e7ebf3; }

  .keybar {
    display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 11.5px;
    background: rgba(255,184,107,.09); border-bottom: 1px solid rgba(255,184,107,.22); color: #ffcf9a;
  }
  .keybar[hidden] { display: none; }
  .keybar button {
    margin-left: auto; padding: 3px 10px; border-radius: 6px; font-size: 11px;
    background: #8a5a15; color: #ffe6c7;
  }
  .keybar button:hover { background: #a86f1c; }

  .ctxprev { border-bottom: 1px solid #1b2130; background: #0b0e14; max-height: 34vh; overflow: auto; }
  .ctxprev pre {
    margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word;
    font: 400 11.5px/1.6 "Consolas", "Microsoft JhengHei", monospace; color: #8e9bb3;
  }

  .chat { flex: 1; overflow-y: auto; padding: 14px 12px 8px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; }
  .chat::-webkit-scrollbar { width: 8px; }
  .chat::-webkit-scrollbar-thumb { background: #232a38; border-radius: 4px; }

  .empty { color: #6c778c; font-size: 12.5px; line-height: 1.9; padding: 6px 2px; }
  .empty b { color: #a9b6cd; }

  .msg { display: flex; flex-direction: column; gap: 5px; max-width: 100%; }
  .msg .who { font-size: 10.5px; color: #6c778c; letter-spacing: .04em; display: flex; gap: 6px; align-items: center; }
  .msg .who .chip { font-size: 10px; color: #7f8da6; border: 1px solid #232a38; border-radius: 20px; padding: 0 6px; }
  .bubble { border-radius: 10px; padding: 9px 11px; word-break: break-word; }
  .msg.user .bubble { background: #1b2438; border: 1px solid #26324a; }
  .msg.bot .bubble { background: #121722; border: 1px solid #1e2534; }
  .bubble p { margin: 0 0 7px; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble ul, .bubble ol { margin: 4px 0 8px; padding-left: 20px; }
  .bubble li { margin: 2px 0; }
  .bubble strong { color: #fff; font-weight: 650; }
  .bubble code { background: #1e2534; padding: 1px 5px; border-radius: 4px; font: 400 12px/1.5 Consolas, monospace; color: #b8c7ff; }
  .bubble pre.code { background: #0b0e14; border: 1px solid #1e2534; border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 6px 0; }
  .bubble pre.code code { background: none; padding: 0; color: #c7d3ea; }
  .bubble blockquote { margin: 6px 0; padding: 2px 0 2px 10px; border-left: 2px solid #33405a; color: #a9b6cd; }
  .bubble hr { border: 0; border-top: 1px solid #232a38; margin: 8px 0; }
  .bubble .md-h { font-weight: 650; color: #fff; margin: 8px 0 4px; }
  .bubble .md-h1 { font-size: 15px; }
  .bubble .md-h2 { font-size: 14px; }
  .bubble a { color: #7fa6ff; }
  .msg .acts { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
  .msg:hover .acts { opacity: 1; }
  .msg .acts button { font-size: 10.5px; color: #7f8da6; padding: 1px 6px; border-radius: 5px; }
  .msg .acts button:hover { background: #1b2130; color: #e7ebf3; }

  .reason { border: 1px dashed #26324a; border-radius: 8px; padding: 6px 9px; font-size: 11.5px; color: #8e9bb3; }
  .reason summary { cursor: pointer; color: #7f8da6; }

  .typing { display: inline-flex; gap: 3px; align-items: center; height: 16px; }
  .typing i { width: 5px; height: 5px; border-radius: 50%; background: #5b8cff; animation: bl 1.1s infinite; }
  .typing i:nth-child(2) { animation-delay: .15s; }
  .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes bl { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }
  .err { color: #ff9b9b; background: rgba(255,107,107,.08); border: 1px solid rgba(255,107,107,.25); border-radius: 8px; padding: 8px 10px; font-size: 12px; }

  .chips { display: flex; gap: 6px; overflow-x: auto; padding: 8px 12px; border-top: 1px solid #1b2130; scrollbar-width: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chips button {
    flex: 0 0 auto; padding: 5px 10px; border-radius: 20px; font-size: 12px;
    border: 1px solid #26324a; background: #141a24; color: #b8c5dc; white-space: nowrap;
  }
  .chips button:hover { border-color: #3b4d70; background: #18202d; color: #fff; }
  .chips button.dg { border-color: #3b5ba6; background: #16203a; color: #cfe0ff; font-weight: 600; }
  .chips button.dg:hover { border-color: #5b8cff; background: #1b2745; }

  .composer { padding: 10px 12px 6px; border-top: 1px solid #1b2130; background: #10141d; }
  .box {
    display: flex; gap: 8px; align-items: flex-end; background: #161c27;
    border: 1px solid #26324a; border-radius: 12px; padding: 7px 8px 7px 10px;
  }
  .box:focus-within { border-color: #3b5ba6; box-shadow: 0 0 0 3px rgba(91,140,255,.1); }
  textarea {
    flex: 1; resize: none; background: none; border: 0; outline: 0; color: #e7ebf3;
    font: inherit; line-height: 1.55; max-height: 132px; min-height: 40px; padding: 2px 0;
  }
  textarea::placeholder { color: #5f6b80; }
  .send {
    width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
    background: linear-gradient(135deg, #5b8cff, #7b6cf6); color: #fff; font-size: 14px;
    flex: 0 0 auto;
  }
  .send:hover { filter: brightness(1.1); }
  .send.stop { background: #b3413f; }
  .foot { display: flex; align-items: center; gap: 8px; padding: 6px 2px 2px; font-size: 11px; color: #6c778c; }
  .foot label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .foot input { accent-color: #5b8cff; }
  .tag { margin-left: auto; font-size: 10.5px; color: #5f6b80; }

  .sheet {
    position: absolute; inset: 0; background: #0d1016; z-index: 20;
    display: flex; flex-direction: column;
  }
  .sheet[hidden] { display: none; }
  .ctxprev[hidden] { display: none; }
  .sheet-hd { display: flex; align-items: center; padding: 12px 14px; border-bottom: 1px solid #1b2130; font-weight: 650; }
  .sheet-bd { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #a9b6cd; }
  input[type=text], input[type=password] {
    background: #161c27; border: 1px solid #26324a; border-radius: 8px; color: #e7ebf3;
    padding: 8px 10px; font: inherit; outline: 0; width: 100%;
  }
  input[type=text]:focus, input[type=password]:focus { border-color: #3b5ba6; }
  input[type=range] { width: 100%; accent-color: #5b8cff; }
  .primary {
    padding: 8px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
    background: linear-gradient(135deg, #5b8cff, #7b6cf6); color: #fff;
  }
  .ghost { padding: 7px 11px; border-radius: 8px; font-size: 12px; border: 1px solid #26324a; color: #b8c5dc; }
  .ghost:hover { border-color: #3b4d70; color: #fff; }
  .hint { font-size: 11.5px; color: #6c778c; line-height: 1.7; }
  .ok { color: #35d07f; }
  .bad { color: #ff8f8f; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

  .toast {
    position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%);
    background: #1b2438; border: 1px solid #2c3a55; color: #dbe4f5;
    padding: 7px 12px; border-radius: 8px; font-size: 12px; opacity: 0;
    transition: opacity .2s, transform .2s; pointer-events: none; white-space: nowrap; z-index: 30;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }

  .resizer { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 25; }
  .resizer:hover { background: rgba(91,140,255,.35); }

  .selbtn {
    position: fixed; z-index: 2147483647; display: none; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 8px; font: 600 12px/1 -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
    background: linear-gradient(135deg, #5b8cff, #7b6cf6); color: #fff; cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,.45); border: 0;
  }

  /* ---------- 圖解 ---------- */
  .dgm { background: #0b0e14; }
  .dgm-top { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border-bottom: 1px solid #1b2130; background: #10141d; flex: 0 0 auto; }
  .dgm-top .t { font-weight: 650; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .seg { padding: 5px 10px; border-radius: 8px; font-size: 12px; border: 1px solid #26324a; color: #a9b6cd; background: #141a24; }
  .seg.on { background: #1d2a4a; border-color: #3b5ba6; color: #cfe0ff; }
  .dgm-bar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #1b2130; font-size: 11.5px; flex: 0 0 auto; }
  .dgm-wrap { flex: 1; overflow: auto; padding: 12px; background: #0b0e14; }
  .dgm-canvas { display: inline-block; min-width: 100%; text-align: center; }
  .dgm-canvas svg { display: block; margin: 0 auto; }
  .dgm-foot { border-top: 1px solid #1b2130; background: #10141d; padding: 10px 12px; max-height: 44%; overflow: auto; flex: 0 0 auto; }
  .dgm-foot:empty { display: none; }
  .dgm-foot .q { font-size: 12.5px; color: #dbe4f5; margin: 0 0 8px; font-weight: 600; line-height: 1.6; }
  .dgm-foot .q em { color: #ffcf9a; font-style: normal; font-size: 11px; font-weight: 400; }
  .opt {
    display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 6px;
    border-radius: 8px; border: 1px solid #26324a; background: #141a24; color: #c5cee0; font-size: 12.5px;
  }
  .opt:hover { border-color: #3b4d70; color: #fff; }
  .opt.ok { border-color: #35d07f; background: rgba(53,208,127,.12); color: #bff5d8; }
  .opt.bad { border-color: #ff6b6b; background: rgba(255,107,107,.1); color: #ffc9c9; }
  .opt:disabled { cursor: default; }
  .qex { font-size: 12px; color: #a9bcd8; margin-top: 6px; line-height: 1.7; }
  .nodeinfo {
    border: 1px solid #26324a; background: #141a24; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px;
  }
  .nodeinfo .h { font-size: 12px; color: #cfe0ff; font-weight: 600; margin-bottom: 3px; }
  .nodeinfo .d { font-size: 12px; color: #9fb3d0; line-height: 1.7; }
  .nodeinfo .a { margin-top: 6px; }
  .dgm-skel { padding: 22px 12px; color: #6c778c; font-size: 12.5px; }
  .dgm-skel .bar {
    height: 10px; border-radius: 6px; margin: 10px auto; max-width: 220px;
    background: linear-gradient(90deg, #141a24, #223049, #141a24); background-size: 200% 100%;
    animation: shimmer 1.2s infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  `;


  /* ============================ HTML ============================ */
  var STANDALONE_CSS = [
    '.app { max-width: 1080px; margin: 0 auto; border-right: 1px solid #232a38; box-shadow: none; }',
    '.hd, .composer { position: relative; }'
  ].join('\n');

  var HTML = `
  <div class="app">
    <div class="resizer" id="resizer"></div>
    <div class="hd">
      <span class="logo">AI</span>
      <span class="brand">解題助手 <span class="dot" id="dot"></span></span>
      <span class="spacer"></span>
      <button class="ico" id="btnRefresh" title="重新抓取左側內容 (Alt+R)">⟳</button>
      <button class="ico" id="btnPush" title="推開頁面，避免遮住內容">⇤</button>
      <button class="ico" id="btnSettings" title="設定">⚙</button>
      <button class="ico" id="btnHide" title="收起面板 (Alt+Q)">✕</button>
    </div>

    <div class="ctxbar">
      <span id="ctxLabel">尚未讀取畫面</span>
      <span class="spacer"></span>
      <button class="mini" id="btnPick">框選範圍</button>
      <button class="mini" id="btnViewCtx">預覽</button>
    </div>
    <div class="ctxprev" id="ctxPrev" hidden><pre id="ctxText"></pre></div>

    <div class="keybar" id="keybar" hidden>
      <span>尚未設定 DeepSeek API Key</span>
      <button id="keybarBtn">立即設定</button>
    </div>

    <div class="chat" id="chat"></div>

    <div class="chips" id="chips"></div>

    <div class="composer">
      <div class="box">
        <textarea id="input" rows="1" placeholder="問我任何問題…（Enter 送出、Shift+Enter 換行）"></textarea>
        <button class="send" id="btnSend" title="送出">↑</button>
      </div>
      <div class="foot">
        <label><input type="checkbox" id="autoCtx"> 自動附上左側內容</label>
        <span class="tag" id="modelTag">—</span>
      </div>
    </div>

    <div class="sheet dgm" id="dgm" hidden>
      <div class="dgm-top">
        <button class="ico" id="dgmClose" title="回到對話">←</button>
        <span class="t" id="dgmTitle">圖解</span>
        <span class="spacer"></span>
        <button class="ico" id="dgmZoomOut" title="縮小">－</button>
        <button class="ico" id="dgmZoomIn" title="放大">＋</button>
        <button class="ico" id="dgmWide" title="把面板加寬">⤢</button>
      </div>
      <div class="dgm-bar">
        <button class="seg on" id="dgmMind">思維導圖</button>
        <button class="seg" id="dgmFlow">流程圖</button>
        <span class="spacer"></span>
        <button class="mini" id="dgmExpand">看細節 ▸</button>
        <button class="mini" id="dgmRedraw">重新畫</button>
      </div>
      <div class="dgm-wrap" id="dgmWrap"><div class="dgm-canvas" id="dgmCanvas"></div></div>
      <div class="dgm-foot" id="dgmFoot"></div>
    </div>

    <div class="sheet" id="sheet" hidden>      <div class="sheet-hd">設定<span class="spacer"></span><button class="ico" id="btnCloseSheet">✕</button></div>
      <div class="sheet-bd">
        <label class="f">DeepSeek API Key
          <input type="password" id="inKey" placeholder="sk-..." autocomplete="off" spellcheck="false">
        </label>
        <div class="row">
          <button class="primary" id="btnSaveKey">儲存</button>
          <button class="ghost" id="btnTestKey">測試連線</button>
        </div>
        <div class="hint" id="keyState">—</div>

        <label class="f">API Base URL
          <input type="text" id="inBase" spellcheck="false">
        </label>

        <label class="f">模型
          <input type="text" id="inModel" list="modelList" spellcheck="false">
        </label>
        <datalist id="modelList">
          <option value="deepseek-chat"></option>
          <option value="deepseek-reasoner"></option>
        </datalist>

        <label class="f">溫度 <span id="tempVal" class="hint">0.3</span>
          <input type="range" id="inTemp" min="0" max="1.5" step="0.1">
        </label>

        <label class="f">面板寬度 <span id="widthVal" class="hint">440</span>
          <input type="range" id="inWidth" min="320" max="900" step="10">
        </label>

        <div class="row">
          <button class="ghost" id="btnClearPick">清除框選記憶</button>
          <button class="ghost" id="btnClearChat">清空對話</button>
        </div>
        <div class="hint">
          金鑰儲存在本機 <code>tutor-split/data/config.json</code>，只會由這台電腦送往 DeepSeek。
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  </div>
  `;

  /* ============================ 掛載 ============================ */
  if (!prefs.width) {
    prefs.width = Math.round(Math.min(520, Math.max(360, window.innerWidth * 0.42)));
  }

  var host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = STANDALONE
    ? 'all:initial;position:fixed;inset:0;z-index:2147483646;display:block;'
    : 'all:initial;position:fixed;top:0;right:0;height:100vh;z-index:2147483646;width:' + prefs.width + 'px;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + CSS + (STANDALONE ? STANDALONE_CSS : '') + '</style>' + HTML;
  if (STANDALONE) host.style.background = '#080a0f';
  document.documentElement.appendChild(host);

  var $ = function (id) { return root.getElementById(id); };
  var chatEl = $('chat');
  var inputEl = $('input');
  var sendBtn = $('btnSend');
  var dot = $('dot');
  var ctxLabel = $('ctxLabel');
  var ctxPrev = $('ctxPrev');
  var ctxText = $('ctxText');

  /* ============================ 小工具 ============================ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function inl(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s;
  }

  function md(src) {
    var lines = String(src == null ? '' : src).replace(/\r/g, '').split('\n');
    var out = [], inCode = false, codeBuf = [], listType = null, i = 0;
    function closeList() { if (listType) { out.push('</' + listType + '>'); listType = null; } }
    for (; i < lines.length; i++) {
      var ln = lines[i], t = ln.trim();
      if (/^```/.test(t)) {
        if (!inCode) { inCode = true; codeBuf = []; closeList(); continue; }
        inCode = false;
        out.push('<pre class="code"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
        continue;
      }
      if (inCode) { codeBuf.push(ln); continue; }
      if (!t) { closeList(); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { closeList(); out.push('<div class="md-h md-h' + h[1].length + '">' + inl(h[2]) + '</div>'); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); out.push('<hr>'); continue; }
      if (/^>\s?/.test(t)) { closeList(); out.push('<blockquote>' + inl(t.replace(/^>\s?/, '')) + '</blockquote>'); continue; }
      var ul = /^[-*+]\s+(.*)$/.exec(t), ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
      if (ul || ol) {
        var want = ul ? 'ul' : 'ol';
        if (listType && listType !== want) closeList();
        if (!listType) { out.push('<' + want + '>'); listType = want; }
        out.push('<li>' + inl(ul ? ul[1] : ol[2]) + '</li>');
        continue;
      }
      closeList();
      out.push('<p>' + inl(t) + '</p>');
    }
    if (inCode && codeBuf.length) out.push('<pre class="code"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    closeList();
    return out.join('');
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ============================ 內容擷取 ============================ */
  var BAD_RE = /(nav|navbar|menu|header|footer|sidebar|breadcrumb|pagination|pager|toolbar|banner|advert|\bads?\b|share|social|comment|cookie|popup|toast|modal)/i;

  // 康軒雲學校：閱讀素養（長篇 / 短篇）考試頁
  var SITE_RULES = [{
    test: /(^|\.)kschool\.com\.tw$/i,
    run: function () {
      var art = document.querySelector('article.main__content__article');
      var qa = document.querySelector('.main__content__qa');
      if (!art && !qa) return null;

      var h1 = document.querySelector('.header__left h1') || document.querySelector('h1');
      var title = h1 ? cleanText(h1.innerText) : (document.title || '');

      var artText = '';
      if (art) {
        var best = null, bestLen = 0;
        Array.prototype.forEach.call(art.children, function (c) {
          if (c.tagName === 'IMG') return;
          var l = (c.innerText || '').length;
          if (l > bestLen) { bestLen = l; best = c; }
        });
        artText = cleanText((best && best.innerText) || art.innerText);
        // 去掉工具列殘留
        artText = artText.replace(/^(對應課次|19項議題|SDGs|語音朗讀|注釋一覽)[^\n]*\n?/gm, '').trim();
      }

      var qText = '';
      if (qa) {
        var qs = qa.querySelectorAll('.question');
        for (var i = 0; i < qs.length; i++) {
          var tx = cleanText(qs[i].innerText);
          if (tx.length > 4) { qText = tx; break; }
        }
      }

      var numEl = document.querySelector('.title__numbers .numberStyle.active');
      var num = numEl ? cleanText(numEl.innerText) : '';
      var totalEl = document.querySelectorAll('.title__numbers .numberStyle');

      var out = '';
      if (title) {
        out += '【' + title.replace(/^文章[:：]\s*/, '文章：') + '】\n';
      }
      if (artText) out += '\n── 文章內容 ──\n' + artText + '\n';
      if (qText) {
        out += '\n── 目前題目' + (num ? '（第 ' + num + (totalEl.length ? ' / ' + totalEl.length : '') + ' 題）' : '') + ' ──\n' + qText;
      }
      if (out.length < 40) return null;
      return {
        text: out,
        label: '康軒閱讀' + (num ? ' · 第 ' + num + ' 題' : ''),
        sel: '',
        stored: false
      };
    }
  }];

  function isBad(el) {
    if (!el || !el.tagName) return true;
    var tag = el.tagName.toLowerCase();
    if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside' || tag === 'script' || tag === 'style' || tag === 'noscript') return true;
    var role = el.getAttribute && el.getAttribute('role');
    if (role && /navigation|banner|contentinfo|complementary|search/i.test(role)) return true;
    var cls = typeof el.className === 'string' ? el.className : '';
    var id = el.id || '';
    return BAD_RE.test(cls + ' ' + id);
  }

  function visible(el) {
    try {
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  function cleanText(t) {
    return String(t || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function cssEsc(s) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    } catch (e) {}
    return String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, function (c) { return '\\' + c; });
  }

  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      var tag = el.tagName.toLowerCase();
      if (el.id) { parts.unshift('#' + cssEsc(el.id)); break; }
      var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      var sel = tag + cls.map(function (c) { return '.' + cssEsc(c); }).join('');
      var p = el.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function extract() {
    if (STANDALONE) {
      return { text: '', label: '預覽模式', sel: '', standalone: true };
    }

    // 0. 特定網站規則（先用精準的，抓不到再退回通用）
    for (var r = 0; r < SITE_RULES.length; r++) {
      if (!SITE_RULES[r].test.test(location.hostname)) continue;
      try {
        var got = SITE_RULES[r].run();
        if (got && got.text && got.text.length > 40) return got;
      } catch (e) {}
    }

    // 1. 使用者框選過的區塊優先
    var saved = prefs.siteSelectors[siteKey()];
    if (saved) {
      try {
        var node = document.querySelector(saved);
        if (node) {
          var t = cleanText(node.innerText);
          if (t.length > 20) return { text: t, label: '已記憶區塊 · ' + t.length + ' 字', sel: saved, stored: true };
        }
      } catch (e) {}
    }

    // 2. 自動判斷主內容區
    var nodes = document.querySelectorAll('main,[role=main],article,section,div,form,td');
    var best = null, bestScore = 0;
    var limit = Math.min(nodes.length, 2500);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (isBad(el)) continue;
      var len = (el.textContent || '').length;
      if (len < 80 || len > 200000) continue;
      var linkLen = 0;
      var as = el.getElementsByTagName('a');
      for (var j = 0; j < as.length && j < 60; j++) linkLen += (as[j].textContent || '').length;
      var score = len - 2 * linkLen;
      if (score > bestScore) { bestScore = score; best = el; }
    }

    var text = '';
    if (best) {
      // 往內收斂到「分數接近的最大子區塊」，避免抓到整頁外殼
      var cur = best;
      for (var k = 0; k < 6; k++) {
        var bestChild = null, bestChildScore = 0;
        for (var c = 0; c < cur.children.length; c++) {
          var ch = cur.children[c];
          if (isBad(ch)) continue;
          var tl = (ch.textContent || '').length;
          if (tl < 120) continue;
          var ll = 0, ca = ch.getElementsByTagName('a');
          for (var q = 0; q < ca.length && q < 40; q++) ll += (ca[q].textContent || '').length;
          var sc = tl - 2 * ll;
          if (sc > bestChildScore) { bestChildScore = sc; bestChild = ch; }
        }
        if (bestChild && bestChildScore >= bestScore * 0.82) { cur = bestChild; } else break;
      }
      text = cleanText(cur.innerText || cur.textContent || '');
      if (text.length < 60) text = cleanText(best.innerText || '');
    }
    if (!text) text = cleanText(document.body.innerText || '');

    // 2.5 有些網站的內容放在同源 iframe 裡（題庫、舊系統、嵌入的閱讀頁）
    if (text.length < 400) {
      var frames = document.querySelectorAll('iframe');
      for (var f = 0; f < frames.length && f < 8; f++) {
        try {
          var fdoc = frames[f].contentDocument;
          if (!fdoc || !fdoc.body) continue;
          var ft = cleanText(fdoc.body.innerText || '');
          if (ft.length > Math.max(120, text.length * 2)) {
            text = ft;
            best = null;
          }
        } catch (e) {}
      }
    }

    var sel = window.getSelection ? String(window.getSelection()).trim() : '';
    var label = (document.title || '').slice(0, 40) + ' · ' + text.length + ' 字';
    var path = '';
    try { path = best ? cssPath(best) : ''; } catch (e) { path = ''; }
    return { text: text, label: label, sel: path, selection: sel };
  }

  function clip(t) {
    t = String(t || '');
    if (t.length <= 20000) return t;
    return t.slice(0, 14000) + '\n\n……（內容過長，中間省略）……\n\n' + t.slice(-5000);
  }

  function updateCtxBadge() {
    var c = state.ctx;

    if (HOSTED) {
      // 沒有本機伺服器：燈號代表「金鑰是否設定」
      dot.className = 'dot' + (hostKey() ? ' on' : '');
      if (c && c.text) {
        ctxLabel.innerHTML = STANDALONE
          ? '內容 <b>' + c.text.length + '</b> 字 · ' + esc(c.label || '')
          : '已讀取 <b>' + c.text.length + '</b> 字 · ' + esc(shortTitle(document.title));
      } else {
        ctxLabel.innerHTML = STANDALONE
          ? '<span class="warn">貼上題目或按「貼上內容」</span>'
          : '<span class="warn">尚未讀取畫面</span>';
      }
      return;
    }

    var on = c && c.text && !state.stale;
    dot.className = 'dot' + (on ? ' on' : '');
    if (!c || !c.text) { ctxLabel.innerHTML = '<span class="warn">尚未讀取畫面</span>'; return; }
    ctxLabel.innerHTML = (on ? '已讀取 ' : '內容可能已更新 ') + '<b>' + c.text.length + '</b> 字' +
      (c.stored ? ' · 記憶區塊' : ' · ' + esc(shortTitle(document.title)));
  }

  function refreshCtx(showToast) {
    try {
      state.ctx = extract();
      state.stale = false;
      updateCtxBadge();
      if (ctxPrev && !ctxPrev.hidden) ctxText.textContent = state.ctx.text.slice(0, 4000);
      if (showToast) toast('已抓取 ' + state.ctx.text.length + ' 字');
    } catch (e) {
      try {
        state.ctx = { text: cleanText(document.body.innerText || ''), label: '備援擷取', sel: '' };
        state.stale = false;
        updateCtxBadge();
      } catch (_) {}
      toast('抓取失敗：' + e.message);
    }
    return state.ctx;
  }

  /* ============================ 換頁偵測 ============================ */
  // SPA 網站（Yahoo 股市、新聞站、影音網站）換頁時不會重新載入頁面，
  // 書籤注入的面板會留在畫面上、卻還抱著「上一頁」的內容。
  // 這裡偵測網址／標題變化：舊圖先收起，並自動重讀新的一頁。
  function watchPage() {
    if (STANDALONE) return;
    var lastUrl = location.href;
    var lastTitle = document.title;
    var timer = null;

    function reRead(reason) {
      state.stale = true;
      if ($('dgm') && !$('dgm').hidden) {
        closeDgm();
        toast('頁面換了，舊的圖先收起');
      }
      clearTimeout(timer);
      timer = setTimeout(function () {
        refreshCtx(false);
        if (reason === 'nav') toast('已重新讀取這一頁 · ' + (state.ctx ? state.ctx.text.length : 0) + ' 字');
      }, 600);
    }

    function check() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastTitle = document.title;
        reRead('nav');
        return;
      }
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        reRead('title');
      }
    }

    try {
      var tEl = document.querySelector('title');
      if (tEl && window.MutationObserver) {
        new MutationObserver(check).observe(tEl, { childList: true, characterData: true, subtree: true });
      }
    } catch (e) {}
    window.addEventListener('popstate', check);
    window.addEventListener('hashchange', check);
    setInterval(check, 1200);
  }

  /* ============================ 對話 ============================ */
  function scrollBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

  function addMsg(role, text, meta) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    var who = document.createElement('div');
    who.className = 'who';
    who.innerHTML = (role === 'user' ? '你' : 'DeepSeek') +
      (meta && meta.ctxLen ? '<span class="chip">附上畫面 ' + meta.ctxLen + ' 字</span>' : '');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = role === 'user' ? '<p>' + esc(text) + '</p>' : md(text);
    wrap.appendChild(who);
    wrap.appendChild(bubble);

    var acts = document.createElement('div');
    acts.className = 'acts';
    var copy = document.createElement('button');
    copy.textContent = '複製';
    copy.onclick = function () {
      navigator.clipboard.writeText(bubble.innerText).then(function () { toast('已複製'); });
    };
    acts.appendChild(copy);
    if (role !== 'user') {
      var again = document.createElement('button');
      again.textContent = '重新回答';
      again.onclick = function () { regenerate(); };
      acts.appendChild(again);
    }
    wrap.appendChild(acts);
    chatEl.appendChild(wrap);
    scrollBottom();
    return bubble;
  }

  function clearEmpty() {
    var e = chatEl.querySelector('.empty');
    if (e) e.remove();
  }

  function emptyState() {
    chatEl.innerHTML = (STANDALONE && HOSTED)
      ? '<div class="empty">' +
        '把<b>題目或文章</b>貼在下面（或按上面的 <b>貼上內容</b> 讀剪貼簿），我就直接解題。<br>' +
        '也可以按 <b>解析這題</b>／<b>🧠 思維導圖</b>／<b>🔀 流程圖</b> 讓我整理成圖。' +
        '</div>'
      : STANDALONE
      ? '<div class="empty">這是<b>預覽模式</b>，不會讀取網頁。<br>正式使用時，請到題目頁點書籤列上的 <b>AI 解題</b>。<br>也可以直接把題目貼在下面送出。</div>'
      : '<div class="empty">' +
        '點 <b>解析這題</b>，我會讀取左側畫面的文章、題目與選項，直接給答案與原因。<br>' +
        '按 <b>🧠 思維導圖</b> 先看骨架，再按「看細節」把知識點一層一層展開。<br>' +
        '看不懂某一句，先選取文字，旁邊會出現 <b>問 AI</b> 小按鈕。<br>' +
        '英文題會自動附上翻譯。' +
        '</div>';
  }

  function setBusy(b) {
    state.busy = b;
    sendBtn.classList.toggle('stop', b);
    sendBtn.textContent = b ? '■' : '↑';
    sendBtn.title = b ? '停止' : '送出';
  }

  function buildRequest(question, ctx) {
    var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    state.messages.forEach(function (m) {
      msgs.push({ role: m.role, content: m.content });
    });
    var last = msgs[msgs.length - 1];
    if (ctx && ctx.text && last && last.role === 'user') {
      last.content = '【左側畫面內容（' + (ctx.label || '') + '）】\n' + clip(ctx.text) +
        '\n\n【我的問題】\n' + question;
      if (ctx.selection && ctx.selection.length > 20 && ctx.selection.length < ctx.text.length) {
        last.content += '\n\n【我特別選取的片段】\n' + ctx.selection.slice(0, 2000);
      }
    }
    return msgs;
  }

  function hostedMaterial() {
    if (state.ctx && state.ctx.text) return state.ctx;
    var last = '';
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') { last = state.messages[i].content; break; }
    }
    if (last) return { text: last, label: '剛剛輸入的內容 · ' + last.length + ' 字', sel: '' };
    return null;
  }

  // 每次要用內容時都重新判斷來源：
  //  - 注入模式（書籤）：永遠重讀「現在這一頁」，不要用上次的快取
  //    （SPA 換頁、切換股票代號、新聞上/下一篇都不會重新載入，快取會是舊的）
  //  - 助手頁（全頁模式）：用貼上的內容，沒有就退回剛剛輸入的那一段
  function currentMaterial() {
    if (STANDALONE) {
      if (state.ctx && state.ctx.text) return state.ctx;
      return hostedMaterial();
    }
    return refreshCtx(false);
  }

  function shortTitle(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 16 ? s.slice(0, 16) + '…' : s;
  }

  async function send(text) {
    if (state.busy) { stop(); return; }
    var question = String(text == null ? inputEl.value : text).trim();
    if (!question) { inputEl.focus(); return; }

    clearEmpty();
    if (text == null) inputEl.value = '';
    autoGrow();

    var useCtx = $('autoCtx').checked;
    var ctx = useCtx ? currentMaterial() : (state.ctx || null);

    addMsg('user', question, { ctxLen: useCtx && ctx ? ctx.text.length : 0 });
    state.messages.push({ role: 'user', content: question });

    var bubble = addMsg('bot', '');
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    setBusy(true);

    var acc = '';
    var reasonEl = null;
    var reasonText = '';
    var raf = 0;
    function paint() {
      raf = 0;
      bubble.innerHTML = md(acc) || '<span class="typing"><i></i><i></i><i></i></span>';
      scrollBottom();
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(paint); }

    state.controller = new AbortController();
    try {
      var res = await callChat({
        messages: buildRequest(question, ctx),
        model: prefs.model,
        temperature: prefs.temperature,
        stream: true
      }, state.controller.signal);

      if (!res.ok) {
        var j = null;
        try { j = await res.json(); } catch (e) {}
        throw new Error(errText(j, res.status));
      }

      var reader = res.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '';
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          var json;
          try { json = JSON.parse(payload); } catch (e) { continue; }
          var d = json.choices && json.choices[0] && json.choices[0].delta;
          if (!d) continue;
          if (d.reasoning_content) {
            reasonText += d.reasoning_content;
            if (!reasonEl) {
              var det = document.createElement('details');
              det.className = 'reason';
              det.innerHTML = '<summary>思考中…</summary><div class="reason-body"></div>';
              bubble.parentNode.insertBefore(det, bubble);
              reasonEl = det;
            }
            reasonEl.querySelector('.reason-body').textContent = reasonText;
            scrollBottom();
          }
          if (d.content) { acc += d.content; schedule(); }
        }
      }
      if (raf) cancelAnimationFrame(raf);
      bubble.innerHTML = md(acc) || '<p class="hint">（沒有收到內容）</p>';
      if (reasonEl) {
        reasonEl.querySelector('summary').textContent = '已思考 ' + reasonText.length + ' 字（點開看過程）';
      }
      if (acc) {
        state.messages.push({ role: 'assistant', content: acc });
        state.lastAnswer = acc;
      }
      scrollBottom();
    } catch (e) {
      if (raf) cancelAnimationFrame(raf);
      var stopped = e && e.name === 'AbortError';
      if (stopped) {
        bubble.innerHTML = md(acc) || '<p class="hint">已停止。</p>';
        if (acc) state.messages.push({ role: 'assistant', content: acc });
      } else {
        var hint = HOSTED
          ? '請按右上角 ⚙ 貼上 DeepSeek API Key（金鑰只存在這台電腦的瀏覽器）。'
          : '請確認 start.bat（本機服務）有在執行，且 ⚙ 設定裡的金鑰正確。';
        bubble.innerHTML = '<div class="err">' + esc(e.message || String(e)) + '<br><br>' + hint + '</div>';
        dot.className = 'dot err';
        if (e && e.needKey) { $('keybar').hidden = false; openSheet(); }
      }
    } finally {
      setBusy(false);
      state.controller = null;
    }
  }

  function stop() {
    if (state.controller) state.controller.abort();
  }

  function regenerate() {
    if (state.busy) return;
    // 移除最後一則 assistant，重送最後一則 user
    var lastUser = null;
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') { lastUser = state.messages[i]; break; }
    }
    if (!lastUser) return;
    while (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') state.messages.pop();
    state.messages.pop(); // 移除該 user，send() 會重新加入
    send(lastUser.content);
  }

  /* ============================ 框選擷取 ============================ */
  var picking = false, hl = null, tip = null, hoverEl = null;

  function startPick() {
    if (picking) return;
    picking = true;
    hl = document.createElement('div');
    hl.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #5b8cff;' +
      'background:rgba(91,140,255,.14);border-radius:6px;display:none;box-sizing:border-box';
    tip = document.createElement('div');
    tip.textContent = '點一下要抓取的區塊（按 Esc 取消）';
    tip.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);' +
      'background:#10141d;color:#e7ebf3;border:1px solid #3b5ba6;border-radius:8px;padding:8px 14px;' +
      'font:600 13px -apple-system,"Microsoft JhengHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)';
    document.documentElement.appendChild(hl);
    document.documentElement.appendChild(tip);
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
  }

  function endPick() {
    picking = false;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    if (hl && hl.parentNode) hl.parentNode.removeChild(hl);
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    hl = tip = hoverEl = null;
  }

  function onPickMove(e) {
    var el = e.target;
    if (!el || el === hoverEl) return;
    hoverEl = el;
    var r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }

  function onPickKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endPick(); toast('已取消'); }
  }

  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = hoverEl || e.target;
    endPick();
    if (!el) return;
    var t = cleanText(el.innerText || el.textContent || '');
    if (t.length < 10) { toast('這個區塊沒有文字，換一個'); return; }
    var sel = cssPath(el);
    prefs.siteSelectors[siteKey()] = sel;
    savePrefs();
    state.ctx = { text: t, label: '手動框選 · ' + t.length + ' 字', sel: sel, stored: true };
    state.stale = false;
    updateCtxBadge();
    toast('已記住這個區塊（下次自動抓）');
  }

  /* ============================ 選取文字 → 問 AI ============================ */
  var selBtn = document.createElement('button');
  selBtn.className = 'selbtn';
  selBtn.textContent = '問 AI';
  root.appendChild(selBtn);

  var selText = '';
  document.addEventListener('mouseup', function (e) {
    setTimeout(function () {
      var s = window.getSelection ? String(window.getSelection()).trim() : '';
      if (!s || s.length < 4) { selBtn.style.display = 'none'; return; }
      if (e.target && e.target.closest && e.target.closest('#' + HOST_ID)) return;
      selText = s;
      var r = window.getSelection().getRangeAt(0).getBoundingClientRect();
      selBtn.style.display = 'inline-flex';
      selBtn.style.left = Math.min(window.innerWidth - 90, Math.max(8, r.left + r.width / 2 - 28)) + 'px';
      selBtn.style.top = Math.max(8, r.top - 42) + 'px';
    }, 10);
  }, true);
  selBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
  selBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    selBtn.style.display = 'none';
    if (!selText) return;
    showPanel();
    var t = '請解釋這段文字的意思：\n「' + selText.slice(0, 1500) + '」';
    send(t);
  });

  /* ============================ 面板開關 / 寬度 ============================ */
  var mini = document.createElement('button');
  mini.id = 'ds-tutor-mini';
  mini.textContent = 'AI';
  mini.title = '開啟解題助手 (Alt+Q)';
  mini.style.cssText = 'all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483647;width:46px;height:46px;' +
    'border-radius:50%;display:none;place-items:center;cursor:pointer;' +
    'font:700 13px -apple-system,"Segoe UI",sans-serif;color:#fff;' +
    'background:linear-gradient(135deg,#5b8cff,#7b6cf6);box-shadow:0 8px 22px rgba(59,91,166,.5)';
  mini.onclick = showPanel;
  document.documentElement.appendChild(mini);
  if (STANDALONE) {
    mini.style.display = 'none';
    root.getElementById('resizer').style.display = 'none';
    root.getElementById('btnHide').style.display = 'none';
    root.getElementById('btnPush').style.display = 'none';
    root.getElementById('btnRefresh').style.display = 'none';
    var pb = root.getElementById('btnPick');
    pb.textContent = '貼上內容';
    pb.title = '把左邊頁面複製的文字貼進來';
    pb.onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { toast('這個瀏覽器不支援讀取剪貼簿'); return; }
      navigator.clipboard.readText().then(function (t) {
        t = String(t || '').trim();
        if (t.length < 5) { toast('剪貼簿是空的，先在左邊的網頁複製文字'); return; }
        state.ctx = { text: t, label: '剪貼簿 · ' + t.length + ' 字', sel: '', selection: '' };
        state.stale = false;
        updateCtxBadge();
        toast('已貼上 ' + t.length + ' 字');
      }).catch(function (e) { toast('無法讀取剪貼簿：' + e.message); });
    };
  }

  function applyWidth(w) {
    if (STANDALONE) return;
    prefs.width = Math.max(320, Math.min(900, w));
    host.style.width = prefs.width + 'px';
    savePrefs();
    if ($('widthVal')) $('widthVal').textContent = prefs.width;
    applyPush();
  }

  function applyPush() {
    if (STANDALONE) return;
    try {
      var on = prefs.push && prefs.open && window.innerWidth > 560;
      if (on) document.body.style.setProperty('margin-right', prefs.width + 'px', 'important');
      else document.body.style.removeProperty('margin-right');
    } catch (e) {}
  }

  function showPanel() {
    if (STANDALONE) return;
    prefs.open = true; savePrefs();
    host.style.display = 'block';
    syncMini();
    applyPush();
    setTimeout(function () { inputEl.focus(); }, 30);
  }

  function hidePanel() {
    if (STANDALONE) return;
    prefs.open = false; savePrefs();
    host.style.display = 'none';
    syncMini();
    applyPush();
  }

  function syncMini() {
    mini.style.display = (STANDALONE || host.style.display !== 'none') ? 'none' : 'grid';
  }

  function toggle() { if (prefs.open) hidePanel(); else showPanel(); }

  host.style.display = STANDALONE ? 'block' : (prefs.open ? 'block' : 'none');
  mini.style.display = 'none';
  setTimeout(syncMini, 0);

  // 邊緣拖曳
  (function () {
    var dragging = false, startX = 0, startW = 0;
    $('resizer').addEventListener('mousedown', function (e) {
      dragging = true; startX = e.clientX; startW = prefs.width;
      e.preventDefault();
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      applyWidth(startW + (startX - e.clientX));
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
    });
  })();

  /* ============================ 事件 ============================ */
  $('btnRefresh').onclick = function () { refreshCtx(true); };
  $('btnHide').onclick = hidePanel;
  $('btnPush').onclick = function () {
    prefs.push = !prefs.push;
    this.classList.toggle('active', prefs.push);
    savePrefs();
    applyPush();
    toast(prefs.push ? '已推開頁面' : '已還原頁面');
  };
  $('btnPush').classList.toggle('active', prefs.push);

  $('btnViewCtx').onclick = function () {
    if (ctxPrev.hidden) {
      if (!state.ctx || state.stale) refreshCtx(false);
      ctxText.textContent = (state.ctx && state.ctx.text) || '（沒有內容）';
      ctxPrev.hidden = false;
      this.classList.add('active');
    } else {
      ctxPrev.hidden = true;
      this.classList.remove('active');
    }
  };

  $('btnPick').onclick = startPick;
  $('btnSend').onclick = function () { if (state.busy) stop(); else send(); };

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(132, inputEl.scrollHeight) + 'px';
  }

  $('autoCtx').checked = prefs.autoCtx !== false;
  $('autoCtx').onchange = function () { prefs.autoCtx = this.checked; savePrefs(); };

  // 快捷鍵
  document.addEventListener('keydown', function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'q' || e.key === 'Q')) {
      e.preventDefault(); e.stopPropagation(); toggle();
    } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault(); e.stopPropagation(); refreshCtx(true);
    }
  }, true);

  // 頁面內容變動 → 標記為需要重抓
  var moTimer = null;
  var observer = new MutationObserver(function () {
    clearTimeout(moTimer);
    moTimer = setTimeout(function () { state.stale = true; updateCtxBadge(); }, 1200);
  });
  try { observer.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  // SPA 換頁
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(function () { state.stale = true; updateCtxBadge(); }, 600);
      return r;
    };
  });

  /* ============================ 設定 ============================ */
  function openSheet() {
    $('sheet').hidden = false;
    $('inBase').value = '';
    $('inModel').value = prefs.model;
    $('inTemp').value = prefs.temperature;
    $('tempVal').textContent = prefs.temperature;
    $('inWidth').value = prefs.width;
    $('widthVal').textContent = prefs.width;
    $('inKey').value = '';
    loadServerConfig();
  }
  $('btnSettings').onclick = openSheet;
  $('btnCloseSheet').onclick = function () { $('sheet').hidden = true; };

  async function loadServerConfig() {
    if (HOSTED) {
      var c = readHostCfg();
      prefs.baseURL = c.baseURL || prefs.baseURL || 'https://api.deepseek.com';
      if (c.model) prefs.model = c.model;
      if (typeof c.temperature === 'number') prefs.temperature = c.temperature;
      $('inBase').value = prefs.baseURL;
      $('inModel').value = prefs.model;
      $('inTemp').value = prefs.temperature;
      $('tempVal').textContent = prefs.temperature;
      var hk = String(c.apiKey || '');
      var where = EXT ? '（存在擴充功能，本機所有網站共用）' : '（只存在這台電腦，不會上傳）';
      $('keyState').innerHTML = hk
        ? '<span class="ok">✔ 已設定金鑰</span> ' + esc(hk.slice(0, 6) + '…' + hk.slice(-4)) +
          '　<span class="hint">' + where + '</span>'
        : '<span class="bad">✘ 尚未設定金鑰</span>　貼上 DeepSeek API Key → 儲存' + where;
      dot.className = 'dot' + (hk ? ' on' : '');
      $('keybar').hidden = !!hk;
      $('modelTag').textContent = prefs.model + (EXT ? ' · 擴充功能' : ' · 直接連線');
      return;
    }
    try {
      var r = await fetch(SERVER + '/api/config');
      var j = await r.json();
      $('inBase').value = j.baseURL || '';
      if (j.model) { $('inModel').value = j.model; prefs.model = j.model; }
      $('keyState').innerHTML = j.hasKey
        ? '<span class="ok">✔ 已設定金鑰</span> ' + esc(j.keyHint) + '　（伺服器）'
        : '<span class="bad">✘ 尚未設定金鑰</span>　請貼上 DeepSeek API Key 後按儲存';
      dot.className = 'dot' + (j.hasKey ? ' on' : '');
      $('keybar').hidden = !!j.hasKey;
      if (j.model) $('modelTag').textContent = prefs.model + ' · 本機代理';
    } catch (e) {
      $('keyState').innerHTML = '<span class="bad">✘ 連不上本機服務</span>　請執行 start.bat';
      $('keybar').hidden = false;
      dot.className = 'dot err';
    }
  }

  $('keybarBtn').onclick = openSheet;

  $('btnSaveKey').onclick = async function () {
    var typed = $('inKey').value.trim();
    var model = $('inModel').value.trim() || prefs.model;
    var baseURL = $('inBase').value.trim() || 'https://api.deepseek.com';
    var temp = Number($('inTemp').value);

    if (HOSTED) {
      var c = readHostCfg();
      if (typed) c.apiKey = typed;
      c.model = model;
      c.baseURL = baseURL;
      c.temperature = temp;
      saveHostCfg(c);
      prefs.model = model;
      prefs.baseURL = baseURL;
      prefs.temperature = temp;
      savePrefs();
      $('inKey').value = '';
      $('modelTag').textContent = prefs.model + ' · 直接連線';
      loadServerConfig();
      toast(c.apiKey ? '金鑰已存在這台電腦' : '已儲存設定');
      return;
    }

    var body = {
      apiKey: typed || undefined,
      baseURL: $('inBase').value.trim() || undefined,
      model: model || undefined,
      temperature: temp
    };
    try {
      var r = await fetch(SERVER + '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      prefs.model = model;
      prefs.temperature = temp;
      savePrefs();
      $('modelTag').textContent = prefs.model + ' · 本機代理';
      $('inKey').value = '';
      loadServerConfig();
      toast(j.hasKey ? '金鑰已儲存' : '已儲存設定');
    } catch (e) {
      toast('儲存失敗：本機服務未啟動');
    }
  };

  $('btnTestKey').onclick = async function () {
    $('keyState').textContent = '測試中…';

    if (HOSTED) {
      if (!hostKey()) {
        $('keyState').innerHTML = '<span class="bad">✘ 請先貼上 API Key 並按儲存</span>';
        return;
      }
      try {
        var tr = await fetch(apiBase() + '/models', {
          headers: { Authorization: 'Bearer ' + hostKey() }
        });
        var tj = null;
        try { tj = await tr.json(); } catch (e) {}
        $('keyState').innerHTML = tr.ok
          ? '<span class="ok">✔ 連線成功</span>　金鑰有效，模型：' + esc(prefs.model)
          : '<span class="bad">✘ ' + esc(errText(tj, tr.status)) + '</span>';
      } catch (e) {
        $('keyState').innerHTML = '<span class="bad">✘ 連線失敗：' + esc(e.message) + '</span>';
      }
      return;
    }

    try {
      var r = await fetch(SERVER + '/api/test');
      var j = await r.json();
      $('keyState').innerHTML = j.ok
        ? '<span class="ok">✔ 連線成功</span>　模型：' + esc(prefs.model)
        : '<span class="bad">✘ ' + esc(j.error || ('HTTP ' + j.status)) + '</span>' +
          (j.detail ? '<br><span class="hint">' + esc(String(j.detail).slice(0, 200)) + '</span>' : '');
    } catch (e) {
      $('keyState').innerHTML = '<span class="bad">✘ 連不上本機服務</span>';
    }
  };

  $('inTemp').oninput = function () {
    $('tempVal').textContent = this.value;
  };
  $('inWidth').oninput = function () {
    $('widthVal').textContent = this.value;
    applyWidth(Number(this.value));
  };
  $('btnClearPick').onclick = function () {
    delete prefs.siteSelectors[siteKey()];
    savePrefs();
    state.stale = true;
    refreshCtx(false);
    toast('已清除這個網站的框選記憶');
  };
  $('btnClearChat').onclick = function () {
    state.messages = [];
    emptyState();
    toast('已清空對話');
  };

  /* ============================ 圖解（mermaid） ============================ */
  var DIAGRAM_SYSTEM = [
    '你是台灣國小的教學設計師，專長是把課文與題目拆成「先骨架、後細節」的圖解，讓學生看圖就能做判斷。',
    '你只輸出一個 JSON 物件，不要任何說明文字、不要 markdown 圍欄。',
    '',
    'JSON 結構：',
    '{',
    '  "title": "主題名稱（≤14字）",',
    '  "root": "中心概念（≤10字）",',
    '  "branches": [',
    '    { "label": "主枝（≤8字）", "detail": "一句話說明（≤30字）",',
    '      "children": [ { "label": "細節（≤12字）", "detail": "說明（≤30字）" } ] }',
    '  ],',
    '  "steps": [ { "label": "步驟（≤12字）", "detail": "說明（≤30字）" } ],',
    '  "quiz": { "question": "…", "options": ["…","…","…"], "answer": 0, "explain": "…", "node": "對應的標籤" }',
    '}',
    '',
    '規則：',
    '1. branches 3~5 個，每個 children 2~4 個；children 是「細節」，要能回答「為什麼／怎麼做」。',
    '2. steps 是時間或因果順序（3~7 步）；文章沒有順序概念時給空陣列 []。',
    '3. quiz 要能「看圖推論」出答案，不要直接抄選項；options 3 個，answer 是正解索引（從 0 起）。',
    '4. 全部使用繁體中文（台灣用語），標籤短、口語、好記，不要有標點以外的符號。',
    '5. 只根據提供的文章內容，不要編造；資料不足時把該枝合併或省略。'
  ].join('\n');

  var dgm = { data: null, mode: 'mind', full: false, zoom: 1, seq: 0, hit: '', info: null, prevWidth: 0, busy: false, answered: null };

  function sanitizeLabel(s, max) {
    return String(s == null ? '' : s)
      .replace(/[\r\n]+/g, ' ')
      .replace(/["'`<>\[\]{}()|;\\#*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 24) || '…';
  }

  var MERMAID_CFG = {
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    fontFamily: '-apple-system,"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif',
    themeVariables: {
      darkMode: true,
      background: '#0b0e14',
      fontSize: '14px',
      fontFamily: '-apple-system,"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif',
      primaryColor: '#182238',
      primaryTextColor: '#dbe4f5',
      primaryBorderColor: '#2f3d58',
      secondaryColor: '#16203a',
      tertiaryColor: '#141a24',
      mainBkg: '#182238',
      nodeBorder: '#2f3d58',
      lineColor: '#3a4a6b',
      textColor: '#dbe4f5',
      titleColor: '#e7ebf3',
      edgeLabelBackground: '#0b0e14',
      clusterBkg: '#0f131b',
      clusterBorder: '#26324a',
      cScale0: '#182238', cScale1: '#1a2540', cScale2: '#172137',
      cScale3: '#1b2744', cScale4: '#16203a', cScale5: '#1a2540',
      cScale6: '#172137', cScale7: '#1b2744', cScale8: '#16203a', cScale9: '#1a2540',
      cScale10: '#172137', cScale11: '#1b2744',
      cScaleInv0: '#dbe4f5', cScaleInv1: '#dbe4f5', cScaleInv2: '#dbe4f5',
      cScaleInv3: '#dbe4f5', cScaleInv4: '#dbe4f5', cScaleInv5: '#dbe4f5',
      cScaleInv6: '#dbe4f5', cScaleInv7: '#dbe4f5', cScaleInv8: '#dbe4f5',
      cScaleInv9: '#dbe4f5', cScaleInv10: '#dbe4f5', cScaleInv11: '#dbe4f5'
    },
    flowchart: { htmlLabels: true, curve: 'basis', padding: 12, nodeSpacing: 26, rankSpacing: 34 },
    mindmap: { padding: 12 }
  };

  function ensureMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (ensureMermaid.p) return ensureMermaid.p;

    // 擴充功能：mermaid 檔案在擴充功能內，請 background 注入到這個頁面的隔離世界
    if (EXT && chrome.runtime && chrome.runtime.sendMessage) {
      ensureMermaid.p = new Promise(function (res, rej) {
        try {
          chrome.runtime.sendMessage({ type: 'ds-load-mermaid' }, function (resp) {
            if (chrome.runtime.lastError) { rej(new Error(String(chrome.runtime.lastError.message))); return; }
            if (!resp || !resp.ok) { rej(new Error('mermaid 載入失敗')); return; }
            var n = 0;
            (function wait() {
              if (window.mermaid) {
                try {
                  window.mermaid.initialize(MERMAID_CFG);
                } catch (e) {}
                res(window.mermaid);
                return;
              }
              if (++n > 60) { rej(new Error('mermaid 載入逾時')); return; }
              setTimeout(wait, 100);
            })();
          });
        } catch (e) { rej(e); }
      });
      ensureMermaid.p.catch(function () { ensureMermaid.p = null; });
      return ensureMermaid.p;
    }

    ensureMermaid.p = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = BASE_DIR + 'vendor/mermaid.min.js';
      s.onload = function () {
        try {
          window.mermaid.initialize(MERMAID_CFG);
          res(window.mermaid);
        } catch (e) { rej(e); }
      };
      s.onerror = function () { rej(new Error('mermaid 載入失敗，請確認本機服務有跑')); };
      document.documentElement.appendChild(s);
    });
    return ensureMermaid.p;
  }

  function buildMind(data, full) {
    var out = ['mindmap'];
    out.push('  root(' + sanitizeLabel(data.root || data.title || '主題', 12) + ')');
    (data.branches || []).forEach(function (b, i) {
      out.push('    ' + sanitizeLabel(b.label || '主題' + (i + 1), 10));
      if (full) {
        (b.children || []).forEach(function (c) {
          if (c && c.label) out.push('      ' + sanitizeLabel(c.label, 14));
        });
      }
    });
    return out.join('\n');
  }

  function buildFlow(data, full, hitLabel) {
    var steps = (data.steps && data.steps.length) ? data.steps
      : (data.branches || []).map(function (b) { return { label: b.label, detail: b.detail }; });
    if (!steps.length) steps = [{ label: data.root || '開始', detail: '' }];

    var lines = ['flowchart TD'];
    var ids = [];
    var byLabel = {};
    steps.forEach(function (s, i) {
      var id = 'S' + i;
      ids.push(id);
      var lbl = sanitizeLabel(s.label || ('步驟' + (i + 1)), 22);
      if (full && s.detail) lbl += '<br/>' + sanitizeLabel(s.detail, 40);
      lines.push('  ' + id + '["' + lbl + '"]');
      byLabel[String(s.label || '').trim()] = id;
    });
    for (var i = 0; i < steps.length - 1; i++) lines.push('  S' + i + ' --> S' + (i + 1));

    lines.push('  classDef step fill:#161e2c,stroke:#3b5ba6,color:#dbe4f5,stroke-width:1.3px');
    lines.push('  class ' + ids.join(',') + ' step');
    var hitId = hitLabel ? byLabel[String(hitLabel).trim()] : '';
    if (hitId) {
      lines.push('  classDef hit fill:#1d5a3d,stroke:#35d07f,color:#eafff2,stroke-width:2px');
      lines.push('  class ' + hitId + ' hit');
    }
    return { code: lines.join('\n'), byLabel: byLabel };
  }

  function applyZoom() {
    $('dgmCanvas').style.zoom = dgm.zoom;
  }

  var SVG_CSS = [
    '.mindmap-node .node-bkg,.mindmap-node .label-container{fill:#182238 !important;stroke:#2f3d58 !important;stroke-width:1px !important}',
    '.mindmap-node.section-root .node-bkg,.mindmap-node.section-root .label-container{fill:#1e2a46 !important;stroke:#5b8cff !important;stroke-width:1.6px !important}',
    '.mindmap-node .node-line-{display:none !important}',
    '.mindmap-node span{color:#dbe4f5 !important;fill:#dbe4f5 !important}',
    '.mindmap-node.section-root span{color:#eaf1ff !important;fill:#eaf1ff !important;font-weight:700 !important}',
    'path.mindmap-edge,path.edge{stroke:#3a4a6b !important;stroke-width:1.3px !important}',
    '.flowchart-link{stroke:#3a4a6b !important;stroke-width:1.3px !important}',
    '.nodeLabel,.label span{color:#dbe4f5 !important}'
  ].join('\n');

  function injectSvgStyle(svg) {
    if (!svg) return;
    var st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = SVG_CSS;
    svg.insertBefore(st, svg.firstChild);
  }

  function fitZoom() {
    var wrap = $('dgmWrap'), svg = $('dgmCanvas').querySelector('svg');
    if (!svg) return;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var w = vb && vb.width ? vb.width : 0;
    if (w) {
      svg.removeAttribute('style');
      svg.setAttribute('width', w);
      svg.setAttribute('height', vb.height || 'auto');
    }
    var avail = wrap.clientWidth - 28;
    var nat = w || svg.getBoundingClientRect().width;
    dgm.zoom = nat > avail ? Math.max(0.72, avail / nat) : 1;
    applyZoom();
  }

  function bindNodes() {
    var svg = $('dgmCanvas').querySelector('svg');
    if (!svg) return;
    Array.prototype.forEach.call(svg.querySelectorAll('g.node'), function (g) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', function () {
        var txt = (g.textContent || '').replace(/\s+/g, ' ').trim();
        showNodeInfo(txt);
      });
    });
  }

  function findNodeByText(txt) {
    var d = dgm.data;
    if (!d) return null;
    var best = null;
    function scan(label, detail) {
      if (!label) return;
      if (txt.indexOf(String(label).slice(0, 6)) >= 0 && String(label).length >= 2) best = { label: label, detail: detail || '' };
    }
    scan(d.root || d.title, '');
    (d.branches || []).forEach(function (b) {
      scan(b.label, b.detail);
      (b.children || []).forEach(function (c) { scan(c.label, c.detail); });
    });
    (d.steps || []).forEach(function (s) { scan(s.label, s.detail); });
    return best;
  }

  function showNodeInfo(txt) {
    var n = findNodeByText(txt);
    dgm.info = n || { label: txt, detail: '' };
    renderFoot();
  }

  async function renderDgm() {
    var el = $('dgmCanvas');
    if (!dgm.data) return;
    el.innerHTML = '<div class="dgm-skel">繪製中…<div class="bar"></div><div class="bar" style="max-width:150px"></div></div>';
    var code, byLabel = {};
    if (dgm.mode === 'flow') {
      var f = buildFlow(dgm.data, dgm.full, dgm.hit);
      code = f.code;
      byLabel = f.byLabel;
    } else {
      code = buildMind(dgm.data, dgm.full);
    }
    dgm.byLabel = byLabel;
    try {
      var mm = await ensureMermaid();
      var out = await mm.render('dgm' + (++dgm.seq), code);
      el.innerHTML = out.svg;
      injectSvgStyle(el.querySelector('svg'));
      fitZoom();
      bindNodes();
    } catch (e) {
      el.innerHTML = '<div class="err" style="margin:16px;text-align:left">圖表繪製失敗：' + esc(e && e.message ? e.message : String(e)) +
        '<br><br>可以按「重新畫」再試一次。</div>';
    }
  }

  function renderFoot() {
    var foot = $('dgmFoot');
    foot.innerHTML = '';

    if (dgm.info) {
      var box = document.createElement('div');
      box.className = 'nodeinfo';
      box.innerHTML = '<div class="h">' + esc(dgm.info.label) + '</div>' +
        '<div class="d">' + esc(dgm.info.detail || '（這個節點沒有補充說明）') + '</div>';
      var ask = document.createElement('button');
      ask.className = 'mini a';
      ask.textContent = '問 AI：這一步為什麼重要？';
      ask.onclick = function () {
        var q = '請說明圖中的「' + dgm.info.label + '」在整篇文章裡代表什麼、為什麼重要。';
        closeDgm();
        send(q);
      };
      box.appendChild(ask);
      foot.appendChild(box);
    }

    var q = dgm.data && dgm.data.quiz;
    if (!q || !q.question || !Array.isArray(q.options) || q.options.length < 2) return;

    var head = document.createElement('p');
    head.className = 'q';
    head.innerHTML = '🧭 看圖判斷：' + esc(q.question) + ' <em>（點選一個答案）</em>';
    foot.appendChild(head);

    var correct = Number(q.answer);
    var optionEls = [];

    function paint() {
      optionEls.forEach(function (o, k) {
        o.disabled = dgm.answered !== null;
        o.className = 'opt' +
          (dgm.answered === null ? '' : k === correct ? ' ok' : k === dgm.answered ? ' bad' : '');
      });
      var old = foot.querySelector('.qex');
      if (old) old.remove();
      if (dgm.answered !== null) {
        var ex = document.createElement('div');
        ex.className = 'qex';
        ex.innerHTML = (dgm.answered === correct
            ? '<b style="color:#35d07f">✅ 答對了</b>　'
            : '<b style="color:#ff8f8f">✕ 再想一下</b>　') + esc(q.explain || '');
        foot.appendChild(ex);
      }
    }

    q.options.forEach(function (opt, i) {
      var b = document.createElement('button');
      b.className = 'opt';
      b.textContent = (i + 1) + '. ' + opt;
      b.onclick = function () {
        if (dgm.answered !== null) return;
        dgm.answered = i;
        paint();
        if (i === correct && dgm.mode === 'flow' && q.node) {
          dgm.hit = q.node;
          renderDgm();
        }
      };
      optionEls.push(b);
      foot.appendChild(b);
    });

    paint();
  }

  function normalizeDiagram(d) {
    if (!d || typeof d !== 'object') throw new Error('圖表資料格式錯誤');
    function node(n) {
      if (!n || typeof n !== 'object') return null;
      var label = String(n.label || '').trim();
      if (!label) return null;
      return { label: label, detail: String(n.detail || '').trim() };
    }
    var out = {
      title: String(d.title || '圖解').slice(0, 40),
      root: String(d.root || d.title || '主題').slice(0, 30),
      branches: [],
      steps: [],
      quiz: null
    };
    (Array.isArray(d.branches) ? d.branches : []).slice(0, 6).forEach(function (b) {
      var n = node(b);
      if (!n) return;
      n.children = (Array.isArray(b.children) ? b.children : []).slice(0, 5).map(node).filter(Boolean);
      out.branches.push(n);
    });
    (Array.isArray(d.steps) ? d.steps : []).slice(0, 8).forEach(function (s) {
      var n = node(s);
      if (n) out.steps.push(n);
    });
    if (!out.branches.length && !out.steps.length) throw new Error('模型沒有給出可畫的內容');
    var q = d.quiz;
    if (q && q.question && Array.isArray(q.options) && q.options.length >= 2) {
      out.quiz = {
        question: String(q.question),
        options: q.options.slice(0, 4).map(function (o) { return String(o); }),
        answer: Math.max(0, Math.min(q.options.length - 1, Number(q.answer) || 0)),
        explain: String(q.explain || ''),
        node: String(q.node || '')
      };
    }
    return out;
  }

  async function callJSON(messages) {
    var res = await callChat({
      messages: messages,
      model: prefs.model,
      temperature: 0.2,
      stream: false,
      response_format: { type: 'json_object' }
    });
    var raw = await res.text();
    if (!res.ok) {
      var ej = null;
      try { ej = JSON.parse(raw); } catch (e) {}
      throw new Error(errText(ej, res.status));
    }
    var j = JSON.parse(raw);
    var content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    var s = String(content).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    return JSON.parse(s);
  }

  async function loadDiagram() {
    if (dgm.busy) return;
    var ctx = currentMaterial();
    if (!ctx || !ctx.text) {
      $('dgmCanvas').innerHTML = STANDALONE
        ? '<div class="err" style="margin:16px">請先在下面貼上文章或題目（或按「貼上內容」），再按圖解。</div>'
        : '<div class="err" style="margin:16px">讀不到左側畫面，請按 ⤴ 重新讀取或先「框選範圍」。</div>';
      return;
    }
    dgm.busy = true;
    dgm.hit = '';
    dgm.info = null;
    dgm.answered = null;
    $('dgmFoot').innerHTML = '';
    $('dgmCanvas').innerHTML =
      '<div class="dgm-skel">先抓骨架，再補細節…<div class="bar"></div><div class="bar" style="max-width:170px"></div><div class="bar" style="max-width:110px"></div></div>';
    try {
      var messages = [
        { role: 'system', content: DIAGRAM_SYSTEM },
        { role: 'user', content: '【文章與題目】\n' + clip(ctx.text) + '\n\n請輸出 JSON。' }
      ];
      var d = await callJSON(messages);
      dgm.data = normalizeDiagram(d);
      dgm.full = false;
      dgm.zoom = 1;
      $('dgmTitle').textContent = dgm.data.title;
      $('dgmExpand').textContent = '看細節 ▸';
      await renderDgm();
      renderFoot();
      toast('已畫好骨架，按「看細節」展開');
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      $('dgmCanvas').innerHTML =
        '<div class="err" style="margin:16px;text-align:left">' + esc(msg) +
        (/API Key/i.test(msg) ? '<br><br>請先按右上角 ⚙ 設定 DeepSeek API Key。' : '') +
        '<br><br>可以按「重新畫」再試一次，或直接關掉圖解用對話問我。</div>';
    } finally {
      dgm.busy = false;
    }
  }

  function openDgm(mode) {
    $('sheet').hidden = true;
    $('dgm').hidden = false;
    // 圖解需要橫向空間：自動把面板加寬（關閉時還原）
    if (!STANDALONE && !dgm.prevWidth && prefs.width < 560 && window.innerWidth > 760) {
      dgm.prevWidth = prefs.width;
      applyWidth(Math.min(860, Math.round(window.innerWidth * 0.74)));
      $('dgmWide').classList.add('active');
    }
    dgm.mode = mode === 'flow' ? 'flow' : 'mind';
    $('dgmMind').classList.toggle('on', dgm.mode === 'mind');
    $('dgmFlow').classList.toggle('on', dgm.mode === 'flow');
    if (dgm.data) {
      $('dgmTitle').textContent = dgm.data.title;
      renderDgm();
      renderFoot();
    } else {
      loadDiagram();
    }
  }

  function closeDgm() {
    $('dgm').hidden = true;
    if (dgm.prevWidth) { applyWidth(dgm.prevWidth); dgm.prevWidth = 0; $('dgmWide').classList.remove('active'); }
  }

  $('dgmClose').onclick = closeDgm;
  $('dgmRedraw').onclick = function () { dgm.data = null; loadDiagram(); };
  $('dgmMind').onclick = function () {
    dgm.mode = 'mind';
    dgm.answered = null;
    this.classList.add('on'); $('dgmFlow').classList.remove('on');
    renderDgm();
    renderFoot();
  };
  $('dgmFlow').onclick = function () {
    dgm.mode = 'flow';
    dgm.answered = null;
    this.classList.add('on'); $('dgmMind').classList.remove('on');
    renderDgm();
    renderFoot();
  };
  $('dgmExpand').onclick = function () {
    dgm.full = !dgm.full;
    dgm.answered = null;
    this.textContent = dgm.full ? '◂ 看骨架' : '看細節 ▸';
    renderDgm();
    renderFoot();
  };
  $('dgmZoomIn').onclick = function () { dgm.zoom = Math.min(2.4, dgm.zoom * 1.15); applyZoom(); };
  $('dgmZoomOut').onclick = function () { dgm.zoom = Math.max(0.3, dgm.zoom / 1.15); applyZoom(); };
  $('dgmWide').onclick = function () {
    if (STANDALONE) return;
    if (dgm.prevWidth) {
      applyWidth(dgm.prevWidth); dgm.prevWidth = 0; this.classList.remove('active');
    } else {
      dgm.prevWidth = prefs.width;
      applyWidth(Math.min(860, Math.round(window.innerWidth * 0.74)));
      this.classList.add('active');
    }
    setTimeout(fitZoom, 80);
  };

  /* ============================ 啟動 ============================ */
  var chips = $('chips');
  [['🧠 思維導圖', 'mind'], ['🔀 流程圖', 'flow']].forEach(function (d) {
    var b = document.createElement('button');
    b.className = 'dg';
    b.textContent = d[0];
    b.onclick = function () { openDgm(d[1]); };
    chips.appendChild(b);
  });
  QUICK.forEach(function (q) {
    var b = document.createElement('button');
    b.textContent = q[0];
    b.onclick = function () { send(q[1]); };
    chips.appendChild(b);
  });

  emptyState();
  updateCtxBadge();
  applyWidth(prefs.width);
  watchPage();

  // 擴充功能：工具列圖示 / Alt+Q 都會呼叫這裡
  if (EXT) {
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg) return;
        if (msg.type === 'ds-toggle') { toggle(); return true; }
        if (msg.type === 'ds-open') { showPanel(); return true; }
      });
    } catch (e) {}
  }

  setTimeout(function () {
    refreshCtx(false);
    if (!EXT) loadServerConfig();
  }, 250);

  if (EXT) loadExtState();

  window[NS] = { toggle: toggle, open: showPanel, close: hidePanel, refresh: refreshCtx, state: state, send: send };
})();
