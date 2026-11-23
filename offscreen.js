let tesseractWorker = null;
let isInitializing = false;
let initPromise = null;

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

async function getWorker() {
  if (tesseractWorker) return tesseractWorker;
  if (isInitializing) return initPromise;

  isInitializing = true;
  initPromise = (async () => {
    try {
      console.log('[Offscreen] 正在初始化本地 Tesseract Worker...');
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('worker.min.js'),
        corePath: chrome.runtime.getURL('tesseract-core.wasm.js'),
        langPath: chrome.runtime.getURL(''),
        workerBlobURL: false, // 關鍵：MV3 下禁止 blob: URL，直接載入擴充套件本地 worker
        gzip: true,
        logger: (m) => console.log('[Tesseract Progress]', m.status, m.progress)
      });
      console.log('[Offscreen] Tesseract Worker 初始化完成！');
      tesseractWorker = worker;
      isInitializing = false;
      return tesseractWorker;
    } catch (e) {
      isInitializing = false;
      initPromise = null;
      const errMsg = formatError(e);
      console.error('[Offscreen Init Error]', errMsg);
      throw new Error(errMsg);
    }
  })();

  return initPromise;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING_OFFSCREEN') {
    sendResponse({ pong: true });
    return true;
  }

  if (request.action === 'OFFSCREEN_OCR') {
    handleOcr(request.image)
      .then((text) => sendResponse({ success: true, text }))
      .catch((err) => {
        const errorDetails = formatError(err);
        console.error('[Offscreen OCR Error]', errorDetails);
        sendResponse({ success: false, error: errorDetails });
      });
    return true; // 保持異步通道
  }
});

async function handleOcr(imageDataUrl) {
  try {
    const worker = await getWorker();
    const ret = await worker.recognize(imageDataUrl);
    const text = ret?.data?.text ? ret.data.text.trim() : '';
    return text;
  } catch (err) {
    throw new Error(formatError(err));
  }
}
