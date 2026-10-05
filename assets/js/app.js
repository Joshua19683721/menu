/* ==========================================================================
   教學系統入口 — 互動腳本
   功能：關鍵字搜尋、分類篩選、兩者疊加、/ 快速聚焦、網址 hash 帶入分類
   零外部相依；找不到 DOM 元素時安靜退出。
   ========================================================================== */
(function () {
  'use strict';

  var input   = document.getElementById('search');
  var chips   = document.getElementById('chips');
  var empty   = document.getElementById('empty');
  var emptyTm = document.getElementById('emptyTerm');
  if (!input || !chips) return;

  var cards     = Array.prototype.slice.call(document.querySelectorAll('.card[data-tags]'));
  var sections  = Array.prototype.slice.call(document.querySelectorAll('.category'));
  var chipBtns  = Array.prototype.slice.call(chips.querySelectorAll('.chip'));

  var term = '';
  var tag  = 'all';

  /** 把查詢字串切成長度 >= 1 的詞 */
  function tokens(str) {
    return String(str).toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  /** 卡片是否符合目前的搜尋字串（比對 data-tags 與卡片內文） */
  function matchText(card) {
    if (!term) return true;
    var haystack = (card.dataset.tags + ' ' + card.textContent).toLowerCase();
    return tokens(term).every(function (t) { return haystack.indexOf(t) !== -1; });
  }

  /** 卡片是否符合目前的分類籌選 */
  function matchTag(card) {
    if (tag === 'all') return true;
    return (' ' + card.dataset.tags + ' ').indexOf(' ' + tag + ' ') !== -1;
  }

  function apply() {
    var visibleTotal = 0;

    cards.forEach(function (card) {
      var show = matchText(card) && matchTag(card);
      card.classList.toggle('is-hidden', !show);
      if (show) visibleTotal++;
    });

    // 沒有任何卡片時，把整個分類也收起來，避免留下孤立的標題
    sections.forEach(function (section) {
      var any = section.querySelectorAll('.card[data-tags]:not(.is-hidden)').length > 0;
      var isPath = !section.querySelector('.card[data-tags]');
      section.hidden = isPath ? false : !any;
    });

    if (empty) {
      empty.hidden = visibleTotal > 0;
      if (emptyTm && visibleTotal === 0) {
        emptyTm.textContent = [term, tag === 'all' ? '' : tag].filter(Boolean).join(' · ');
      }
    }
  }

  /* ---------- 事件 ---------- */

  input.addEventListener('input', function () {
    term = input.value.trim();
    apply();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && input.value !== '') {
      e.stopPropagation();
      input.value = '';
      term = '';
      apply();
    }
  });

  chipBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      chipBtns.forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      tag = btn.dataset.filter || 'all';
      apply();
    });
  });

  // 「/」聚焦搜尋；Escape 離開搜尋框
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && t === input) {
      input.blur();
    }
  });

  /* ---------- 網址 hash 帶入分類（可分享的篩選狀態） ---------- */
  function readHash() {
    var m = /^#f=(.+)$/.exec(window.location.hash);
    if (!m) return;
    var want = decodeURIComponent(m[1]);
    var hit = chipBtns.filter(function (b) { return b.dataset.filter === want; })[0];
    if (hit) hit.click();
  }

  window.addEventListener('hashchange', readHash);

  /* ---------- 深淺色切換 ---------- */
  var THEME_KEY = 'menu-theme';
  var toggle = document.getElementById('theme-toggle');

  if (toggle) {
    var label = toggle.querySelector('.theme-label');
    var icon = toggle.querySelector('.theme-icon');

    /** 目前實際生效的配色：使用者指定優先，否則看系統 */
    function currentTheme() {
      var explicit = document.documentElement.dataset.theme;
      if (explicit === 'light' || explicit === 'dark') return explicit;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    /** 按鈕永遠顯示「按下去會切到什麼」 */
    function paintToggle() {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      label.textContent = next === 'dark' ? '深色' : '淺色';
      icon.textContent = next === 'dark' ? '🌙' : '☀️';
      toggle.setAttribute('aria-label', '切換到' + (next === 'dark' ? '深色' : '淺色') + '模式');
    }

    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 存不了就算了，本次仍然有效 */ }
      paintToggle();
    });

    paintToggle();
  }

  chipBtns.forEach(function (b, i) { b.setAttribute('aria-pressed', String(i === 0)); });
  apply();
  readHash();
})();
