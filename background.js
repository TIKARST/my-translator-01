function formatError(err) {
  if (!err) return '未知錯誤 (null/undefined)';
  if (typeof err === 'string') return err;
  if (err.stack) return err.stack;
  if (err.message) return err.message;
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return json;
  } catch (_) {}
  return String(err);
}

// 監聽來自 content_scripts 或 popup 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'TRANSLATE') {
    handleTranslate(request.text)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: formatError(err) }));
    return true; // 保持異步通道
  }

  if (request.action === 'OCR_TRANSLATE') {
    handleOcrTranslate(sender.tab, request.area)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: formatError(err) }));
    return true;
  }
});

// 監聽快捷鍵指令 (Alt + S)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-translate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_SELECTION' }).catch(() => {});
    }
  }
});

/**
 * 文字翻譯：使用微軟 Edge 官方原生翻譯介面（全球直連、穩定免 Key、免代理）
 */
async function handleTranslate(text) {
  if (!text || !text.trim()) return '';

  // 1. 微軟 Edge 翻譯介面
  try {
    const edgeUrl = 'https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false';
    const res = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
      },
      body: JSON.stringify([text.trim()])
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data[0]?.translations?.[0]?.text) {
        return data[0].translations[0].text;
      }
    }
  } catch (e) {
    console.warn('Edge 翻譯接口連線異常，切換至備援引擎...', e);
  }

  // 2. 備援引擎：Google 翻譯
  try {
    const googleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text.trim())}`;
    const res = await fetch(googleUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data[0]) {
        return data[0].map(item => item[0]).join('');
      }
    }
  } catch (e) {
    console.warn('Google 翻譯備援失敗...', e);
  }

  // 3. 備援引擎：MyMemory
  try {
    const myMemoryUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.trim())}&langpair=auto|zh-CN`;
    const res = await fetch(myMemoryUrl);
    if (res.ok) {
      const data = await res.json();
      if (data?.responseData?.translatedText) {
        return data.responseData.translatedText;
      }
    }
  } catch (e) {
    console.warn('MyMemory 備援失敗...', e);
  }

  throw new Error('翻譯介面連線逾時，請檢查網路連線');
}

/**
 * 確保 Offscreen Document 存在並就緒
 */
let creatingDocument = null;
async function setupOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length > 0) return;
  }

  if (creatingDocument) {
    await creatingDocument;
    return;
  }

  try {
    creatingDocument = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Offline OCR text recognition with local Tesseract.js'
    });
    await creatingDocument;
  } catch (err) {
    if (!err.message.includes('Only a single offscreen document may be created')) {
      throw err;
    }
  } finally {
    creatingDocument = null;
  }
}

/**
 * 傳送訊息至 Offscreen Document（含握手與重試機制）
 */
async function sendToOffscreen(message, maxRetries = 6) {
  await setupOffscreenDocument();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });

      if (response !== undefined) {
        return response;
      }
    } catch (err) {
      if (attempt === maxRetries - 1) {
        throw new Error(`Offscreen 通訊失敗: ${formatError(err)}`);
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }
  throw new Error('Offscreen Document 逾時無回應');
}

/**
 * 截圖選區並使用本地 Tesseract.js 進行離線 OCR，再交由微軟 Edge 翻譯
 */
async function handleOcrTranslate(tab, area) {
  if (!tab || !tab.id) {
    throw new Error('未獲取到有效標籤頁');
  }

  // 1. 截取當前標籤頁畫面
  const windowId = tab.windowId || null;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  if (!dataUrl) {
    throw new Error('截圖失敗，無法讀取視窗畫面');
  }

  // 2. 根據 devicePixelRatio 精準裁切選區
  const croppedBase64 = await cropImage(dataUrl, area);

  // 3. 檢查設定：預設走本地 Tesseract.js 離線辨識
  const settings = await chrome.storage.sync.get({
    ocrEngine: 'tesseract',
    apiUrl: '',
    apiKey: '',
    model: ''
  });

  if (settings.ocrEngine === 'vision_api' && settings.apiUrl && settings.apiKey) {
    return await callCustomVisionModel(croppedBase64, settings);
  }

  // 4. 調用 Offscreen Document 執行本機 Tesseract OCR
  const ocrRes = await sendToOffscreen({
    action: 'OFFSCREEN_OCR',
    image: croppedBase64
  });

  if (!ocrRes || !ocrRes.success) {
    const detail = ocrRes?.error || '未知 OCR 錯誤';
    throw new Error(`離線 OCR 辨識異常: ${detail}`);
  }

  const recognizedText = ocrRes.text ? ocrRes.text.trim() : '';
  if (!recognizedText) {
    return {
      translation: '未在選框內辨識到清晰英文字元，請嘗試放大框選區域。',
      original: ''
    };
  }

  // 5. 將辨識出來的文字直接傳遞給微軟 Edge 翻譯接口
  const translation = await handleTranslate(recognizedText);

  return {
    translation,
    original: recognizedText
  };
}

/**
 * 利用 OffscreenCanvas 與 createImageBitmap 在後台安全高效率裁剪圖像
 */
async function cropImage(dataUrl, area) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const dpr = area.dpr || 1;

  const sx = Math.max(0, Math.round(area.x * dpr));
  const sy = Math.max(0, Math.round(area.y * dpr));
  const sw = Math.max(10, Math.round(area.width * dpr));
  const sh = Math.max(10, Math.round(area.height * dpr));

  const bitmap = await createImageBitmap(blob, sx, sy, sw, sh);
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });

  // 轉換為 Base64 Data URL
  const arrayBuffer = await croppedBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return 'data:image/png;base64,' + btoa(binary);
}

/**
 * 備用：若使用者主動設定了第三方 OpenAI 相容視覺 API
 */
async function callCustomVisionModel(imageBase64Url, config) {
  const baseUrl = config.apiUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey.trim()}`
  };

  const prompt = `識別截圖中的所有文字，並翻譯成中文。只需直接輸出中文翻譯結果：`;
  const payload = {
    model: config.model || 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageBase64Url } }
        ]
      }
    ],
    temperature: 0.1
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`視覺 API 錯誤 (${response.status}): ${errText.slice(0, 120)}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content?.trim();
  content = (content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  return {
    translation: content || '未獲取到譯文',
    original: ''
  };
}
