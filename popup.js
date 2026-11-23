document.addEventListener('DOMContentLoaded', async () => {
  const ocrEngineSelect = document.getElementById('ocrEngine');
  const visionConfig = document.getElementById('visionConfig');
  const apiUrlInput = document.getElementById('apiUrl');
  const modelInput = document.getElementById('model');
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const msg = document.getElementById('msg');

  // 讀取已儲存的設定或預設值
  const settings = await chrome.storage.sync.get({
    ocrEngine: 'tesseract',
    apiUrl: '',
    model: 'gpt-4o-mini',
    apiKey: ''
  });

  ocrEngineSelect.value = settings.ocrEngine;
  apiUrlInput.value = settings.apiUrl;
  modelInput.value = settings.model;
  apiKeyInput.value = settings.apiKey;

  toggleVisionConfig();

  ocrEngineSelect.addEventListener('change', toggleVisionConfig);

  function toggleVisionConfig() {
    visionConfig.style.display = ocrEngineSelect.value === 'vision_api' ? 'block' : 'none';
  }

  // 儲存設定
  saveBtn.addEventListener('click', async () => {
    const newSettings = {
      ocrEngine: ocrEngineSelect.value,
      apiUrl: apiUrlInput.value.trim(),
      model: modelInput.value.trim() || 'gpt-4o-mini',
      apiKey: apiKeyInput.value.trim()
    };

    await chrome.storage.sync.set(newSettings);

    msg.style.display = 'block';
    setTimeout(() => {
      msg.style.display = 'none';
    }, 2000);
  });
});
