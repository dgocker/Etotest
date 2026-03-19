export interface VideoPacket {
  frameId: number;
  receiveTime: number;
  senderTs: number; 
  raw: Uint8Array;
  type: 'key' | 'delta';
}

export class H264Decoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private decoder: VideoDecoder | null = null;
  private jitterBuffer: VideoPacket[] = [];
  private targetDelay = 500; // Reduced from 2000ms to 500ms

  private isPlaying = false;
  private onLog?: (msg: string) => void;
  private onRequestKeyframe?: (isPanic: boolean) => void;
  private isConfigured = false;
  private rotation: number = 0; 
  private mirror: boolean = false;
  private flipV: boolean = false;
  
  private currentRtt: number = 0;
  private estimatedOneWay: number = 0;
  private rttHistory: number[] = [];
  private lastRttSmoothed: number = 0;
  
  // Adaptive Jitter Buffer (Task 18 & Jitter Fix)
  private readonly MAX_DELAY = 2000; // Reduced from 10000ms to 2000ms
  private readonly MIN_DELAY = 50; // Reduced from 100ms to 50ms
  private readonly CATCH_UP_THRESHOLD = 500; // Reduced from 2000ms to 500ms

  private firstSenderTs = -1;
  private firstPlayoutTime = -1;
  private lastBufferEmptyTime = 0;
  
  // Statistical Jitter tracking (Task 17)
  private jitterLog: number[] = [];
  private lastReceiveTime = 0;
  private lastSenderTs = 0;

  constructor(canvas: HTMLCanvasElement, onLog?: (msg: string) => void, onRequestKeyframe?: (isPanic: boolean) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.onLog = onLog;
    this.onRequestKeyframe = onRequestKeyframe;
    this.initDecoder();
  }

  private initDecoder() {
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          // Always target portrait orientation
          const isLandscape = frame.displayWidth > frame.displayHeight;
          let angle = this.rotation;
          
          // If the source is landscape, we automatically rotate it to be portrait
          // unless the user has already manually rotated it.
          // This ensures "Always Vertical" as requested.
          if (isLandscape && angle === 0) {
            angle = 90; 
          }

          const isRotated = angle === 90 || angle === 270;
          const displayW = isRotated ? frame.displayHeight : frame.displayWidth;
          const displayH = isRotated ? frame.displayWidth : frame.displayHeight;

          if (this.canvas.width !== displayW || this.canvas.height !== displayH) {
            this.canvas.width = displayW;
            this.canvas.height = displayH;
          }

          this.ctx.save();
          this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
          this.ctx.rotate((angle * Math.PI) / 180);
          this.ctx.scale(this.mirror ? -1 : 1, this.flipV ? -1 : 1);
          this.ctx.drawImage(frame, -frame.displayWidth / 2, -frame.displayHeight / 2);
          this.ctx.restore();
          frame.close();
        },
        error: (e) => {
          if (this.onLog) this.onLog(`❌ Decoder error callback: ${e.message}`);
        }
      });
    } catch (e) {
      if (this.onLog) this.onLog(`❌ Decoder init exception: ${e}`);
    }
  }

  private configure() {
    if (!this.decoder) return;
    try {
      this.decoder.configure({
        codec: "avc1.42e01f", // Task 18: Switched to Baseline Profile for faster decoding
        optimizeForLatency: true
      });
      this.isConfigured = true;
    } catch (e) {
      if (this.onLog) this.onLog(`❌ Decoder configure exception: ${e}`);
    }
  }

  private isKeyFrame(data: Uint8Array): boolean {
    for (let i = 0; i < Math.min(data.length - 4, 500); i++) {
        if (data[i] === 0 && data[i+1] === 0) {
            let offset = 0;
            if (data[i+2] === 1) offset = 3;
            else if (data[i+2] === 0 && data[i+3] === 1) offset = 4;
            if (offset > 0) {
                const nalType = data[i + offset] & 0x1F;
                if (nalType === 5 || nalType === 7 || nalType === 8) return true;
            }
        }
    }
    return false;
  }

  public pushPacket(binary: Uint8Array, frameId: number, fps: number, senderTs: number) {
    if (!this.decoder) return;
    if (!this.isConfigured) this.configure();

    const now = performance.now();
    const type = this.isKeyFrame(binary) ? 'key' : 'delta';
    
    // Automatic Keyframe Request: If we are waiting for a keyframe and get a delta, request one.
    if (this.firstSenderTs === -1 && type === 'delta' && frameId % 30 === 0) {
      if (this.onRequestKeyframe) this.onRequestKeyframe(false);
    }

    if (type === 'key' && this.onLog) {
      this.onLog(`🔑 Keyframe detected: frameId=${frameId}, size=${binary.length}`);
    }

    // Adaptive Jitter Logic (Jitter = variance in arrival time)
    if (this.lastSenderTs > 0) {
      const expectedArrive = this.lastReceiveTime + (senderTs - this.lastSenderTs);
      const jitter = Math.max(0, now - expectedArrive);
      this.jitterLog.push(jitter);
      if (this.jitterLog.length > 100) this.jitterLog.shift();
      
      if (this.jitterLog.length >= 10 && this.jitterLog.length % 10 === 0) {
        const sorted = [...this.jitterLog].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        
        // Adaptive targetDelay: estimatedOneWay + 40 + p95 * 1.3
        const newTarget = Math.min(800, Math.max(this.MIN_DELAY, this.estimatedOneWay + 40 + (p95 * 1.3)));
        
        // Smooth targetDelay to avoid sudden jumps (pro-lags)
        this.targetDelay = this.targetDelay * 0.9 + newTarget * 0.1;
        
        if (Math.abs(newTarget - this.targetDelay) > 20) {
          if (this.onLog) {
            this.onLog(`📊 Adapting targetDelay to ${Math.round(this.targetDelay)}ms (p95=${Math.round(p95)}ms, RTT=${Math.round(this.currentRtt)}ms)`);
          }
        }
      }
    }

    this.lastReceiveTime = now;
    this.lastSenderTs = senderTs;

    const packet: VideoPacket = { frameId, receiveTime: now, senderTs, raw: binary, type };
    this.jitterBuffer.push(packet);
    this.jitterBuffer.sort((a, b) => a.frameId - b.frameId);

    if (!this.isPlaying && this.jitterBuffer.length >= 5) { // Trigger only when we have 5 frames (approx 166ms) to ensure stability
      this.isPlaying = true;
      
      // Check if there was a long gap
      if (this.lastBufferEmptyTime > 0 && now - this.lastBufferEmptyTime > 3000) {
        if (this.onLog) {
          this.onLog(`🔄 Buffer empty for >3s, resetting sync (firstSenderTs=${this.firstSenderTs})`);
        }
        this.firstSenderTs = -1;
        this.firstPlayoutTime = -1;
      }
      this.lastBufferEmptyTime = 0;
      
      if (this.onLog) this.onLog(`▶️ Starting playback, buffer: ${this.jitterBuffer.length}`);
      requestAnimationFrame(this.playNext);
    } 
  }

  private playNext = (now: number) => {
    if (!this.decoder) {
      this.isPlaying = false;
      return;
    }
 
    if (this.jitterBuffer.length === 0) {
      if (this.isPlaying) {
        this.isPlaying = false;
        if (this.onLog) this.onLog(`⚠️ Buffer empty, stopping playback`);
        this.lastBufferEmptyTime = now;
      }
      // Do not call requestAnimationFrame here, let pushPacket restart it
      return;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.lastBufferEmptyTime = 0;
      if (this.onLog) this.onLog(`▶ Resuming playback`);
    }

    const packet = this.jitterBuffer[0];
    
    // Fast Recovery: If buffer is very large (> 1s of video), skip to the latest keyframe
    const bufferDuration = this.jitterBuffer.length * (1000 / 30); // Rough estimate
    if (bufferDuration > 1000) {
      let latestKeyIdx = -1;
      for (let i = this.jitterBuffer.length - 1; i >= 0; i--) {
        if (this.jitterBuffer[i].type === 'key') {
          latestKeyIdx = i;
          break;
        }
      }
      
      if (latestKeyIdx > 0) {
        if (this.onLog) {
          this.onLog(`🚀 FAST RECOVERY: Skipping ${latestKeyIdx} frames to latest keyframe (bufferDuration=${Math.round(bufferDuration)}ms)`);
        }
        // When fast recovery triggers, also request a fresh keyframe to ensure we stay in sync
        if (this.onRequestKeyframe) this.onRequestKeyframe(true);
        
        this.jitterBuffer.splice(0, latestKeyIdx);
        this.firstSenderTs = -1; // Reset sync to the new keyframe
        requestAnimationFrame(this.playNext);
        return;
      }
    }

    if (this.firstSenderTs === -1) {
      if (packet.type !== 'key') {
        if (this.onLog && packet.frameId % 30 === 0) {
          this.onLog(`🗑️ Dropping non-keyframe ${packet.frameId} (waiting for keyframe)`);
        }
        this.jitterBuffer.shift();
        requestAnimationFrame(this.playNext);
        return;
      }
      this.firstSenderTs = packet.senderTs;
      this.firstPlayoutTime = now;
    }

    const videoTimeOffset = packet.senderTs - this.firstSenderTs;
    const targetPlayTime = this.firstPlayoutTime + videoTimeOffset + this.targetDelay;
    
    // Catch-up: if delay is huge, don't just skip everything (which causes freeze).
    // Instead, if we have a large buffer, play frames faster.
    const dropThreshold = Math.max(800, this.targetDelay * 1.5 + this.currentRtt); // Reduced from 2000
    const isPanic = now - targetPlayTime > dropThreshold;
    const isBufferLarge = this.jitterBuffer.length > 15;
    
    if (isPanic || isBufferLarge) {
      if (this.onLog && packet.frameId % 15 === 0) {
        this.onLog(`🚨 CATCH-UP: frame ${packet.frameId} is ${Math.round(now - targetPlayTime)}ms late. Buffer=${this.jitterBuffer.length}. Playing immediately.`);
      }
      // In panic or large buffer, we don't wait. We just decode and move to next frame.
    } else if (now < targetPlayTime) {
      requestAnimationFrame(this.playNext);
      return;
    }

    this.jitterBuffer.shift();
    
    try {
      const chunk = new EncodedVideoChunk({
        type: packet.type,
        timestamp: videoTimeOffset * 1000, 
        data: packet.raw
      });
      if (this.onLog && packet.frameId % 30 === 0) {
        this.onLog(`▶ Playing frame ${packet.frameId}: delay=${Math.round(now - targetPlayTime)}ms, targetDelay=${this.targetDelay}, buffer=${this.jitterBuffer.length}`);
      }
      this.decoder.decode(chunk);
    } catch (e: any) {
      if (this.onLog) this.onLog(`❌ Decode error: ${e.message}`);
      this.firstSenderTs = -1;
    }
    
    // If buffer is still large, play another frame in the same RAF (up to 2 frames per RAF)
    if (this.jitterBuffer.length > 10) {
       // We don't want to loop infinitely, so we just trigger another playNext immediately
       // but limit it to avoid blocking the main thread too much.
       setTimeout(() => this.playNext(performance.now()), 0);
    } else {
       requestAnimationFrame(this.playNext);
    }
  };

  public getStats() {
    return {
      targetDelay: Math.round(this.targetDelay),
      bufferLength: this.jitterBuffer.length,
      firstSenderTs: this.firstSenderTs,
      firstPlayoutTime: this.firstPlayoutTime
    };
  }

  public setRotation(degrees: number) {
    this.rotation = degrees % 360;
    
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.onLog) this.onLog(`🔄 Applied rotation: ${this.rotation}° (mirror=${this.mirror})`);
  }

  public setMirror(enabled: boolean) {
    this.mirror = enabled;
  }

  public setFlipV(enabled: boolean) {
    this.flipV = enabled;
  }

  public updateRTT(rtt: number) {
    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();
    
    const sorted = [...this.rttHistory].sort((a,b)=>a-b);
    let median = sorted[Math.floor(sorted.length/2)];
    
    // Protection against Zombie RTT
    if (median > 2000) {
      median = this.currentRtt || 150;
      this.rttHistory = [median];
    }

    const clamped = Math.min(median, 5000); // Increased from 800 to 5000
    this.lastRttSmoothed = this.lastRttSmoothed 
      ? this.lastRttSmoothed * 0.7 + clamped * 0.3 
      : clamped;

    this.currentRtt = this.lastRttSmoothed;
    this.estimatedOneWay = Math.min(this.currentRtt / 2, 400); // hard cap 400ms one-way
  }

  public destroy() {
    this.isPlaying = false;
    this.jitterBuffer = [];
    if (this.decoder) {
      try { this.decoder.close(); } catch (e) {}
      this.decoder = null;
    }
  }
}
