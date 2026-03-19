let cryptoKey: CryptoKey | null = null;

// Обработка сообщений от главного потока
self.onmessage = async (event) => {
  const { type, payload, keyData, iv, id } = event.data;

  try {
    if (type === 'INIT_KEY') {
      // Инициализация ключа при старте звонка
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      cryptoKey = keyMaterial;
      self.postMessage({ type: 'KEY_READY' });
    } 
    else if (type === 'CLEAR_KEY') {
      cryptoKey = null;
      self.postMessage({ type: 'KEY_CLEARED' });
    }
    else if (type === 'ENCRYPT_VIDEO' || type === 'ENCRYPT_AUDIO') {
      if (!cryptoKey) {
        self.postMessage({ type: 'ERROR', error: 'Key not initialized', id });
        return;
      }

      // Конвертируем ArrayBuffer обратно в Uint8Array если нужно
      const dataArray = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
      const ivArray = iv instanceof ArrayBuffer ? new Uint8Array(iv) : iv;

      const startTime = performance.now();
      const encryptedBuffer = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: ivArray, // 12 bytes
          tagLength: 128,
        },
        cryptoKey,
        dataArray
      );
      
      // Pack as: [12 bytes IV] + [Ciphertext + AuthTag]
      const result = new Uint8Array(12 + encryptedBuffer.byteLength);
      result.set(ivArray, 0);
      result.set(new Uint8Array(encryptedBuffer), 12);

      const duration = performance.now() - startTime;
      if (duration > 5) {
        console.warn(`[CryptoWorker] Slow encryption: ${duration.toFixed(2)}ms for ${dataArray.byteLength} bytes`);
      }

      const messageType = type === 'ENCRYPT_VIDEO' ? 'ENCRYPTED_VIDEO' : 'ENCRYPTED_AUDIO';
      
      // Отправляем обратно в главный поток готовый пакет
      (self as any).postMessage(
        { 
          type: messageType, 
          data: result.buffer,
          id: id
        },
        [result.buffer] // Transferable object (zero copy)
      );
    }
  } catch (error) {
    console.error('[CryptoWorker] Error:', error);
    self.postMessage({ 
      type: 'ERROR', 
      error: error instanceof Error ? error.message : String(error),
      id: id
    });
  }
};

export {};
