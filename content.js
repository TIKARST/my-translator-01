(() => {
  // 避免重複注入
  if (window.__EXT_TRANSLATOR_INJECTED__) return;
  window.__EXT_TRANSLATOR_INJECTED__ = true;

  // 頁面注入時立刻預熱喚醒 MV3 Service Worker，消除剛打開網頁時的冷啟動延遲
  chrome.runtime.sendMessage({ action: 'PING' }).catch(() => {});

  // 1. 強制解除防複製限制（CSS 穿透 + 事件攔截）
  const unlockStyle = document.createElement('style');
  unlockStyle.id = '__ext_unlock_style__';
  unlockStyle.textContent = `
    *, *::before, *::after {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
    }
  `;
  (document.head || document.documentElement).appendChild(unlockStyle);

  // 在捕獲階段攔截常見的防複製/防選取事件
  ['selectstart', 'copy', 'contextmenu'].forEach((eventType) => {
    window.addEventListener(eventType, (e) => {
      e.stopPropagation();
    }, true);
  });

  // 2. 建立 Shadow DOM 隔離浮窗容器（防止網頁原有樣式污染）
  const host = document.createElement('div');
  host.id = '__ext_translator_root__';
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    zIndex: '2147483647',
    pointerEvents: 'none'
  });
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // 浮窗樣式
  const style = document.createElement('style');
  style.textContent = `
    .trans-popup {
      position: fixed;
      display: none;
      width: 320px;
      max-width: 90vw;
      padding: 12px 14px;
      background: #18181b;
      color: #f4f4f5;
      font-size: 14px;
      line-height: 1.6;
      border-radius: 8px;
      border: 1px solid #3f3f46;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.2);
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      box-sizing: border-box;
      z-index: 2147483647;
    }
    .trans-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      border-bottom: 1px solid #27272a;
      padding-bottom: 6px;
    }
    .trans-title {
      font-size: 12px;
      font-weight: 600;
      color: #a1a1aa;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .trans-close {
      background: none;
      border: none;
      color: #71717a;
      font-size: 16px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .trans-close:hover {
      color: #f4f4f5;
    }
    .trans-content {
      word-break: break-word;
      white-space: pre-wrap;
      max-height: 280px;
      overflow-y: auto;
      margin-bottom: 10px;
      font-size: 14px;
      color: #fafafa;
    }
    .trans-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .trans-btn {
      background: #27272a;
      color: #e4e4e7;
      border: 1px solid #3f3f46;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s;
    }
    .trans-btn:hover {
      background: #3f3f46;
      color: #fff;
    }
    .trans-btn-success {
      background: #059669 !important;
      border-color: #10b981 !important;
      color: #fff !important;
    }
    .trans-badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      background: #27272a;
      color: #a1a1aa;
      white-space: nowrap;
    }
    /* 截圖遮罩與選框 */
    .ocr-mask {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      cursor: crosshair;
      z-index: 2147483646;
      pointer-events: auto;
      user-select: none;
    }
    .ocr-hint {
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(24, 24, 27, 0.9);
      color: #38bdf8;
      border: 1px solid #38bdf8;
      padding: 8px 18px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      pointer-events: none;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    }
    .ocr-box {
      position: absolute;
      border: 2px solid #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
      pointer-events: none;
    }
  `;
  shadow.appendChild(style);

  // 浮窗主元素
  const popup = document.createElement('div');
  popup.className = 'trans-popup';
  shadow.appendChild(popup);

  // 狀態追蹤變數
  let isAltPressed = false;
  let currentRequestId = 0; // 請求版本號，用於作廢鬆開 Alt 後才返回的過期結果
  let popupSource = 'manual'; // 'alt'（Alt 懸停觸發，鬆手即關） | 'manual'（劃詞/截圖觸發，點擊外部關閉）
  let hoverTimer = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let lastHoveredElement = null;

  function hidePopup() {
    popup.style.display = 'none';
  }

  function clearAltStateAndHide() {
    isAltPressed = false;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    currentRequestId++; // 作廢所有仍在路上的 Alt 翻譯請求
    if (popupSource === 'alt') {
      hidePopup();
    }
  }

  function showPopup({ title = '翻譯結果', content = '', original = '', x = 20, y = 20, isLoading = false, badge = '微軟 Edge 翻譯', source = 'manual' }) {
    popupSource = source;

    // 智慧視窗邊界限制
    const width = 320;
    const padding = 15;
    let safeX = Math.min(x, window.innerWidth - width - padding);
    safeX = Math.max(padding, safeX);

    let safeY = y + 10;
    if (safeY + 180 > window.innerHeight) {
      safeY = Math.max(padding, y - 200);
    }

    popup.style.left = `${safeX}px`;
    popup.style.top = `${safeY}px`;
    popup.style.display = 'block';

    if (isLoading) {
      popup.innerHTML = `
        <div class="trans-header">
          <span class="trans-title">${title}</span>
          <button class="trans-close">&times;</button>
        </div>
        <div class="trans-content" style="color: #a1a1aa; display: flex; align-items: center; gap: 8px;">
          <span>⏳ ${content || '處理中...'}</span>
        </div>
      `;
      shadow.querySelector('.trans-close').onclick = hidePopup;
      return;
    }

    let bodyHtml = `<div style="font-weight:500;">${escapeHtml(content)}</div>`;
    if (original) {
      bodyHtml += `<div style="margin-top:8px; font-size:12px; color:#a1a1aa; border-top:1px dashed #3f3f46; padding-top:6px;">原文：${escapeHtml(original)}</div>`;
    }

    popup.innerHTML = `
      <div class="trans-header">
        <span class="trans-title">${title}</span>
        <button class="trans-close">&times;</button>
      </div>
      <div class="trans-content">${bodyHtml}</div>
      <div class="trans-footer">
        <span class="trans-badge">${badge}</span>
        <button id="__ext_copy_btn" class="trans-btn">複製譯文</button>
      </div>
    `;

    shadow.querySelector('.trans-close').onclick = hidePopup;

    const copyBtn = shadow.getElementById('__ext_copy_btn');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(content);
          copyBtn.innerText = '已複製 ✓';
          copyBtn.classList.add('trans-btn-success');
          setTimeout(() => {
            if (copyBtn) {
              copyBtn.innerText = '複製譯文';
              copyBtn.classList.remove('trans-btn-success');
            }
          }, 2000);
        } catch (e) {
          copyBtn.innerText = '複製失敗';
        }
      };
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function extractElementText(target) {
    if (!target || target === document.body || target === document.documentElement) return '';
    const text = target.innerText?.trim() || target.textContent?.trim() || target.alt || target.title || target.value || '';
    return text.length > 0 && text.length < 400 ? text : '';
  }

  // -------------------------------------------------------------
  // 場景 A：劃詞翻譯與 Alt 懸停翻譯
  // -------------------------------------------------------------

  // 1. 拖曳劃詞
  document.addEventListener('mouseup', (e) => {
    if (isSelectingArea) return;
    if (e.composedPath().includes(popup)) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text && text.length > 0 && text.length < 4000) {
        try {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          triggerTextTranslate(text, rect.left, rect.bottom, 'manual');
        } catch (err) {
          triggerTextTranslate(text, e.clientX, e.clientY, 'manual');
        }
      }
    }, 15);
  }, true);

  // 2. 追蹤游標位置 + 按住 Alt 懸停翻譯
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    lastHoveredElement = e.target;

    if (isSelectingArea) return;

    // 若未按住 Alt，確保清理狀態並直接返回
    if (!e.altKey) {
      if (isAltPressed) {
        clearAltStateAndHide();
      }
      return;
    }

    isAltPressed = true;
    if (e.composedPath().includes(popup)) return;

    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!isAltPressed) return;
      const targetText = extractElementText(e.target);
      if (targetText) {
        triggerTextTranslate(targetText, e.clientX, e.clientY + 10, 'alt');
      }
    }, 150);
  }, true);

  function triggerTextTranslate(text, x, y, source = 'manual') {
    const reqId = ++currentRequestId;

    showPopup({
      title: '文字翻譯',
      content: '正在翻譯...',
      x,
      y,
      isLoading: true,
      source
    });

    chrome.runtime.sendMessage({ action: 'TRANSLATE', text }, (response) => {
      // 若為 Alt 觸發但用戶已鬆開 Alt，或已有更新的請求發出，直接丟棄過期結果，絕不重新彈窗
      if (reqId !== currentRequestId) return;
      if (source === 'alt' && !isAltPressed) return;

      if (chrome.runtime.lastError) {
        showPopup({
          title: '通訊異常',
          content: chrome.runtime.lastError.message,
          x,
          y,
          source
        });
        return;
      }
      if (!response || !response.success) {
        showPopup({
          title: '翻譯失敗',
          content: response?.error || '接口無回應',
          x,
          y,
          source
        });
        return;
      }
      showPopup({
        title: '譯文',
        content: response.result,
        x,
        y,
        badge: '微軟 Edge 翻譯',
        source
      });
    });
  }

  // 點擊空白處關閉浮窗
  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes(popup) && !isSelectingArea) {
      hidePopup();
    }
  }, true);

  // -------------------------------------------------------------
  // 場景 B：Alt + S 框選截圖 OCR 翻譯
  // -------------------------------------------------------------
  let isSelectingArea = false;
  let ocrMask = null;
  let ocrBox = null;
  let startX = 0;
  let startY = 0;

  function startAreaSelection() {
    if (isSelectingArea) return;
    isSelectingArea = true;
    clearAltStateAndHide();
    hidePopup();

    ocrMask = document.createElement('div');
    ocrMask.className = 'ocr-mask';

    const hint = document.createElement('div');
    hint.className = 'ocr-hint';
    hint.innerText = '📐 請拖曳滑鼠框選區域（圖片/Canvas/字幕）| ESC 或右鍵取消';
    ocrMask.appendChild(hint);

    ocrBox = document.createElement('div');
    ocrBox.className = 'ocr-box';
    ocrBox.style.display = 'none';
    ocrMask.appendChild(ocrBox);

    shadow.appendChild(ocrMask);

    let isDragging = false;

    ocrMask.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      ocrBox.style.left = `${startX}px`;
      ocrBox.style.top = `${startY}px`;
      ocrBox.style.width = '0px';
      ocrBox.style.height = '0px';
      ocrBox.style.display = 'block';
    };

    ocrMask.onmousemove = (e) => {
      if (!isDragging) return;
      e.preventDefault();
      e.stopPropagation();

      const curX = e.clientX;
      const curY = e.clientY;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      ocrBox.style.left = `${x}px`;
      ocrBox.style.top = `${y}px`;
      ocrBox.style.width = `${w}px`;
      ocrBox.style.height = `${h}px`;
    };

    ocrMask.onmouseup = (e) => {
      if (!isDragging) return;
      isDragging = false;
      e.preventDefault();
      e.stopPropagation();

      const endX = e.clientX;
      const endY = e.clientY;
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);

      cancelAreaSelection();

      if (width > 12 && height > 12) {
        triggerAreaOcr({
          x,
          y,
          width,
          height,
          dpr: window.devicePixelRatio || 1
        });
      }
    };

    ocrMask.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelAreaSelection();
    };
  }

  function cancelAreaSelection() {
    if (ocrMask && ocrMask.parentNode) {
      ocrMask.parentNode.removeChild(ocrMask);
    }
    ocrMask = null;
    ocrBox = null;
    isSelectingArea = false;
  }

  function triggerAreaOcr(area) {
    showPopup({
      title: '截圖辨識翻譯',
      content: '正在截取畫面並離線識別文字 (Tesseract)...',
      x: area.x,
      y: area.y + area.height + 10,
      isLoading: true,
      source: 'manual'
    });

    chrome.runtime.sendMessage({ action: 'OCR_TRANSLATE', area }, (response) => {
      if (chrome.runtime.lastError) {
        showPopup({
          title: '辨識異常',
          content: chrome.runtime.lastError.message,
          x: area.x,
          y: area.y + area.height + 10,
          source: 'manual'
        });
        return;
      }
      if (!response || !response.success) {
        showPopup({
          title: '辨識失敗',
          content: response?.error || 'OCR 引擎無回應',
          x: area.x,
          y: area.y + area.height + 10,
          source: 'manual'
        });
        return;
      }

      const res = response.result;
      const translation = typeof res === 'string' ? res : (res.translation || '');
      const original = typeof res === 'object' ? (res.original || '') : '';

      showPopup({
        title: '截圖辨識譯文',
        content: translation,
        original,
        x: area.x,
        y: area.y + area.height + 10,
        badge: 'Tesseract 離線 OCR',
        source: 'manual'
      });
    });
  }

  // -------------------------------------------------------------
  // 快捷鍵與 Alt 狀態生命週期監聽（捕獲階段優先響應）
  // -------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    // Alt + S 啟動截圖選框
    if (e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      e.preventDefault();
      e.stopPropagation();
      startAreaSelection();
      return;
    }

    if (e.key === 'Escape') {
      if (isSelectingArea) {
        e.preventDefault();
        cancelAreaSelection();
      } else if (popup.style.display === 'block') {
        hidePopup();
      }
      return;
    }

    // 記錄 Alt 按下狀態，若游標已停留在元素上則短暫延遲後自動翻譯（避免與 Alt+S 衝突）
    if (e.key === 'Alt' && !e.repeat) {
      isAltPressed = true;
      if (!isSelectingArea && lastHoveredElement) {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (!isAltPressed || isSelectingArea) return;
          const targetText = extractElementText(lastHoveredElement);
          if (targetText) {
            triggerTextTranslate(targetText, lastMouseX, lastMouseY + 10, 'alt');
          }
        }, 120);
      }
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    // 鬆開 Alt 時立刻銷毀 Alt 懸停黑框並作廢未完成請求
    if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight' || !e.altKey) {
      if (isAltPressed) {
        clearAltStateAndHide();
      }
    }
  }, true);

  // Windows 下按 Alt 容易觸發瀏覽器右上角選單導致網頁失焦，必須用 blur 兜底清理
  window.addEventListener('blur', () => {
    clearAltStateAndHide();
  });

  // 接收來自 background 的快捷鍵指令
  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === 'TRIGGER_SELECTION') {
      startAreaSelection();
    }
  });
})();