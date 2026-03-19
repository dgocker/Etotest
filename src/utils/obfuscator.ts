export async function obfuscateSplit(raw: Uint8Array, frameId: number = 0, senderTs: number = 0): Promise<Uint8Array[]> {
  const MAX_CHUNK_SIZE = 16384; // Task 17: Increased to 16KB for TCP efficiency
  const partsCount = Math.ceil(raw.length / MAX_CHUNK_SIZE);
  const parts: Uint8Array[] = [];
  
  const fIdLow  = frameId & 0xFF;
  const fIdHigh = (frameId >> 8) & 0xFF;

  for (let i = 0; i < partsCount; i++) {
    const start = i * MAX_CHUNK_SIZE;
    const end = Math.min(start + MAX_CHUNK_SIZE, raw.length);
    const chunk = raw.subarray(start, end);
    
    const part = new Uint8Array(chunk.length + 11);
    part[0] = 0xFF;        // magic byte
    part[1] = fIdLow;      
    part[2] = fIdHigh;     
    
    // senderTs (4 bytes)
    part[3] = senderTs & 0xFF;
    part[4] = (senderTs >> 8) & 0xFF;
    part[5] = (senderTs >> 16) & 0xFF;
    part[6] = (senderTs >> 24) & 0xFF;
    
    // part index (2 bytes)
    part[7] = i & 0xFF;
    part[8] = (i >> 8) & 0xFF;
    
    // total parts (2 bytes)
    part[9] = partsCount & 0xFF;
    part[10] = (partsCount >> 8) & 0xFF;
    
    part.set(chunk, 11);
    parts.push(part);
  }

  // Task 17: Removed shuffling and FEC duplication for TCP stability
  return parts;
}

export async function deobfuscateAssemble(chunks: Uint8Array[]): Promise<{ data: Uint8Array; senderTs: number }> {
  try {
    const sorted = [...chunks].sort((a, b) => {
      const idxA = a[7] | (a[8] << 8);
      const idxB = b[7] | (b[8] << 8);
      return idxA - idxB;
    });

    // Извлекаем senderTs из первого фрагмента
    const first = sorted[0];
    const senderTs = (first[3] | (first[4] << 8) | (first[5] << 16) | (first[6] << 24)) >>> 0;

    const seen = new Set<string>();
    const deduped = sorted.filter(c => {
      const key = `${c[1]}|${c[2]}|${c[7]}|${c[8]}`; // frameId + partIndex
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const fullSize = deduped.reduce((sum, c) => sum + c.length - 11, 0);
    const result = new Uint8Array(fullSize);
    let offset = 0;

    for (const c of deduped) {
      result.set(c.subarray(11), offset);
      offset += c.length - 11;
    }

    return { data: result, senderTs };
  } catch (e) {
    console.error('❌ deobfuscateAssemble error:', e);
    throw e;
  }
}
