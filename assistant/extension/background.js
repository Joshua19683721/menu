/**
 * AI 解題助手 — 背景服務
 * 1) 需要畫圖時，把 mermaid 注入到「這個分頁的隔離世界」（面板才看得到 window.mermaid）
 * 2) 點工具列圖示 = 顯示／隱藏右側面板（和 Alt+Q 一樣）
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ds-load-mermaid') return;
  if (!sender || !sender.tab || sender.tab.id == null) {
    sendResponse({ ok: false, error: 'no tab' });
    return;
  }

  var target = { tabId: sender.tab.id };
  if (sender.frameId != null) target.frameIds = [sender.frameId];

  chrome.scripting.executeScript({
    target: target,
    files: ['vendor/mermaid.min.js']
  }).then(function () {
    sendResponse({ ok: true });
  }).catch(function (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });

  return true; // 非同步回應
});

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ds-toggle' }, function () {
    void chrome.runtime.lastError;
  });
});
