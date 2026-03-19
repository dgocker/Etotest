import { obfuscateSplit } from './obfuscator';
import { encryptData } from './cryptoUtils';

// Crypto Worker для выноса шифрования из основного потока
let cryptoWorker: Worker | null = null;
let cryptoWorkerReady = false;
let cryptoWorkerInitPromise: Promise<void> | null = null;
const pendingCryptoOps = new Map<number, { 
  resolve: (data: Uint8Array) => void; 
  reject: (err: Error) => void;
  data: Uint8Array;
  frameId: number;
}>();
let cryptoOpId = 0;

function initCryptoWorker(): Promise<void> {
  if (cryptoWorkerInitPromise) return cryptoWorkerInitPromise;
  
  cryptoWorkerInitPromise = new Promise((resolve, reject) => {
    try {
      if (!cryptoWorker) {
        cryptoWorker = new Worker(new URL('../workers/cryptoWorker.ts', import.meta.url), { type: 'module' });
      }
      
      cryptoWorker.onmessage = (event) => {
        const { type, id, error } = event.data;
        
        if (type === 'KEY_READY') {
          cryptoWorkerReady = true;
          resolve();
        } else if (type === 'ENCRYPTED_VIDEO' || type === 'ENCRYPTED_AUDIO') {
          const pending = pendingCryptoOps.get(id);
          if (pending) {
            pendingCryptoOps.delete(id);
            pending.resolve(new Uint8Array(event.data.data));
          }
        } else if (type === 'ERROR') {
          const pending = pendingCryptoOps.get(id);
          if (pending) {
            pendingCryptoOps.delete(id);
            pending.reject(new Error(error));
          }
        }
      };
      
      cryptoWorker.onerror = (err) => {
        cryptoWorkerReady = false;
        cryptoWorkerInitPromise = null;
        reject(err);
      };
    } catch (e) {
      cryptoWorkerReady = false;
      cryptoWorkerInitPromise = null;
      resolve(); 
    }
  });
  return cryptoWorkerInitPromise;
}

async function encryptInWorker(key: CryptoKey, data: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  if (!cryptoWorker || !cryptoWorkerReady) {
    return encryptData(key, data) as Promise<Uint8Array>;
  }
  
  return new Promise((resolve, reject) => {
    const id = ++cryptoOpId;
    pendingCryptoOps.set(id, { resolve, reject, data, frameId: 0 });
    
    try {
      cryptoWorker!.postMessage({
        type: 'ENCRYPT_VIDEO',
        payload: data.buffer.slice(0),
        iv: iv.buffer.slice(0),
        id: id
      });
    } catch (postError) {
      pendingCryptoOps.delete(id);
      reject(postError);
      return;
    }
  });
}

export class AdaptiveH264Engine {
  private video: HTMLVideoElement;
  private onFrame: (data: string) => void;
  private getNetworkMetrics: () => { rtt: number, bufferedAmount: number };
  private onLog?: (msg: string) => void;
  private ws: WebSocket;
  private sharedSecret: CryptoKey | null = null;
  
  private isRunning: boolean = false;
  private lastFrameTime: number = 0;
  private pendingFrames: number = 0;
  private rafId: number | null = null;
  private errorCount: number = 0;
  private isRecovering: boolean = false;
  private pacerInterval: any = null;
  
  private currentFps: number = 20;
  private currentWidth: number = 0;
  private currentHeight: number = 0;
  private currentScale: number = 1.0;

  private encoder: VideoEncoder | null = null;
  private needsKeyframe: boolean = false;
  private isConfigured: boolean = false;
  
  private aiState: 'steady' | 'hold' | 'congested' | 'recovery' = 'steady';
  private lastRttSmoothed: number = 0;
  private readonly SMOOTHING_ALPHA = 0.1;
  
  private lastCongestionTs: number = 0;
  private readonly congestionCooldown: number = 1000;
  
  private pacerTokens: number = 0;
  private lastPacerRun: number = performance.now();

  private targetBitrate: number = 500_000; // Lowered initial target
  private lastConfiguredBitrate: number = 0;
  private minBitrate: number = 200_000; // Lowered min bitrate
  private maxBitrate: number = 4_000_000; // Lowered max bitrate
  private tokenBucketBytes: number = (500_000 / 8) * 0.2; 
  private lastTokenUpdate: number = performance.now();
  private sessionStartTime: number = performance.now();
  
  private sendQueue: { data: Uint8Array; enqueueTime: number }[] = [];
  private frameId: number = 0;
  private droppedFrames: number = 0;
  private droppedFramesWindow: number = 0;
  private droppedFramesRate: number = 0;
  private droppedFramesConsecutive: number = 0;
  private droppedWindowStart: number = performance.now();
  private lastPendingReset: number = performance.now();

  private lastAIUpdate: number = performance.now();
  private lastLogTime: number = 0;
  private lastRtt: number = 0;

  // CPU Metrics (Task 17)
  private encodeDurationLog: number[] = [];
  
  private bytesSentThisSecond: number = 0;
  private lastRateLog: number = 0;
  private lastPacerLog: number = 0;
  private lastCongestionUpdate: number = 0;
  private readonly CONGESTION_UPDATE_INTERVAL: number = 1000;

  private manualMode: boolean = false;
  private manualBitrate: number = 500_000;
  private lastAbrBitrate: number = 500_000;

  // PI Controller for RTT-based adaptation
  private rttTarget = 150; // target RTT in ms
  private errorIntegral = 0;
  private lastRttUpdateTs = 0;
  private readonly KP = 0.5;   // Proportional gain
  private readonly KI = 0.2;   // Integral gain
  private readonly MAX_INTEGRAL = 5000;

  // New GCC-inspired metrics
  private delayTrend: number = 0;
  private readonly OVERUSE_THRESHOLD: number = 80;
  private readonly NORMAL_THRESHOLD: number = 25;
  private rttHistory: number[] = [];
  private lastSmoothedRtt: number = 0;
  private lastUpdateTs: number = 0;
  private probingStartTs: number = 0;
  private isProbing: boolean = false;
  private lastSteadyIncrease: number = 0;

  constructor(
    video: HTMLVideoElement, 
    onFrame: (data: string) => void,
    getNetworkMetrics: () => { rtt: number, bufferedAmount: number },
    ws: WebSocket,
    onLog?: (msg: string) => void,
    sharedSecret: CryptoKey | null = null
  ) {
    this.video = video;
    this.onFrame = onFrame;
    this.getNetworkMetrics = getNetworkMetrics;
    this.ws = ws;
    this.onLog = onLog;
    this.sharedSecret = sharedSecret;
    
    if (sharedSecret) {
      initCryptoWorker().catch(err => {
        if (this.onLog) this.onLog(`⚠️ Crypto Worker init failed: ${err}`);
      });
    }
    this.initEncoder();
  }

  private initEncoder() {
    try {
      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const startTime = performance.now();
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this.processEncodedFrame(data, startTime);
        },
        error: (e) => {
          if (this.onLog) this.onLog(`❌ VideoEncoder error: ${e.message}`);
          this.handleEncoderError();
        }
      });
    } catch (e) {
      if (this.onLog) this.onLog(`❌ Encoder init exception: ${e}`);
      setTimeout(() => {
        if (this.isRunning && !this.encoder) this.initEncoder();
      }, 1000);
    }
  }

  private handleEncoderError() {
    if (this.isRecovering || this.errorCount > 3) return;
    this.isRecovering = true;
    this.errorCount++;
    this.pendingFrames = 0;
    
    setTimeout(async () => {
      try {
        if (this.encoder) { this.encoder.close(); this.encoder = null; }
        this.isConfigured = false;
        this.initEncoder();
        this.isRecovering = false;
      } catch (err) {
        if (this.onLog) this.onLog(`❌ Error recovering encoder: ${err}`);
      }
    }, 1000);
  }

  private async processEncodedFrame(data: Uint8Array, startTime: number) {
    // === NEW: FRAME SIZE LIMITER (Complexity Protection) ===
    if (data.length > 250000) {
      if (this.onLog) this.onLog(`🚨 CRITICAL: Frame size too large (${Math.round(data.length/1024)}KB). Dropping to prevent buffer bloat.`);
      this.needsKeyframe = true;
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.4);
      this.applyBitrateToParams();
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
      return;
    }

    try {
      let finalData: Uint8Array = data;
      if (this.onLog && this.frameId % 30 === 0) this.onLog(`✅ Encoded frame ${this.frameId} (size=${data.length})`);

      // === NEW: ACTUAL TOKEN CONSUMPTION ===
      this.tokenBucketBytes -= data.length;

      if (this.sharedSecret) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        finalData = await encryptInWorker(this.sharedSecret, data, iv).catch(err => {
          return encryptData(this.sharedSecret, data) as Promise<Uint8Array>;
        });
      }
    
      const senderTs = Math.floor(performance.now() - this.sessionStartTime);
      const parts = await obfuscateSplit(finalData, this.frameId++, senderTs);
      for (const part of parts) {
        this.sendQueue.push({
          data: new Uint8Array(part),
          enqueueTime: performance.now()
        });
      }
      
      this.encodeDurationLog.push(performance.now() - startTime);
      if (this.encodeDurationLog.length > 30) this.encodeDurationLog.shift();
      
    } catch (e) {
       if (this.onLog) this.onLog(`❌ VideoEncoder output processing error: ${e}`);
    } finally {
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
    }
  }

  private configureEncoder(width: number, height: number) {
    if (!this.encoder || width === 0 || height === 0) return;
    
    try {
      this.encoder.configure({
        codec: "avc1.64001f", // Switched to High Profile for better compression
        width: width,
        height: height,
        bitrate: this.targetBitrate,
        bitrateMode: 'variable',
        latencyMode: "realtime",
        // @ts-ignore
        avc: { format: "annexb", key_frame_interval: 60 }
      });
      this.currentWidth = width;
      this.currentHeight = height;
      this.isConfigured = true;
      this.needsKeyframe = true;
      
      // NEW: Clear the send queue when resolution changes.
      // The old frames are likely stale and will just cause delay.
      if (this.sendQueue.length > 0) {
        if (this.onLog) this.onLog(`🧹 Clearing sendQueue (${this.sendQueue.length} frames) due to reconfiguration`);
        this.sendQueue = [];
      }
      // Give a small boost for the new I-frame to pass through the pacer
      this.tokenBucketBytes = Math.max(this.tokenBucketBytes, 40000); 

      if (this.onLog) this.onLog(`⚙️ Baseline Profile Config: ${width}x${height} @ ${Math.round(this.targetBitrate/1024)}k (GOP=60)`);
    } catch (e: any) {
      if (this.onLog) this.onLog(`❌ Encoder configuration failed: ${e}`);
    }
  }

  private applyBitrateToParams() {
    if (!this.encoder || !this.isConfigured) return;
    
    const diffRatio = Math.abs(this.targetBitrate - this.lastConfiguredBitrate) / (this.lastConfiguredBitrate || 1);
    if (diffRatio >= 0.05) {
      try {
        this.encoder.configure({
          codec: "avc1.64001f", // High Profile
          width: this.currentWidth,
          height: this.currentHeight,
          bitrate: this.targetBitrate,
          bitrateMode: 'variable',
          latencyMode: "realtime",
          // @ts-ignore
          avc: { format: "annexb", key_frame_interval: 60 }
        });
        this.lastConfiguredBitrate = this.targetBitrate;
      } catch (e) {
        if (this.onLog) this.onLog(`❌ Encoder configure exception: ${e}`);
      }
    }

    const kbps = this.targetBitrate / 1024;
    if (kbps < 500) this.currentFps = 15;
    else if (kbps < 1000) this.currentFps = 24;
    else this.currentFps = 30;
  }

  private updateCongestionControl() {
    if (this.manualMode) return; 

    const now = performance.now();
    const metrics = this.getNetworkMetrics();
    const buffered = metrics.bufferedAmount;
    const queueDelay = this.sendQueue.length > 0 ? now - this.sendQueue[0].enqueueTime : 0;
    
    let stateChanged = false;
    const oldBitrate = this.targetBitrate;

    // GCC Overuse Detection - Relaxed thresholds
    const isOveruse = this.delayTrend > this.OVERUSE_THRESHOLD * 2.0 || queueDelay > 400 || buffered > 400000;
    
    if (isOveruse) {
      if (this.aiState !== 'congested') {
         this.aiState = 'congested';
         // Softer cut for extreme RTT (0.7 instead of 0.6)
         const cutFactor = this.lastSmoothedRtt > 1000 ? 0.7 : 0.9;
         this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * cutFactor);
         stateChanged = true;
         if (this.onLog) this.onLog(`🚨 GCC Overuse: trend=${this.delayTrend.toFixed(1)}, qDelay=${Math.round(queueDelay)}ms, RTT=${Math.round(this.lastSmoothedRtt)}ms, cutting to ${Math.round(this.targetBitrate/1024)}k`);
      }
    } else {
      // Recovery or Steady
      if (this.aiState === 'congested') {
        this.aiState = 'recovery';
        stateChanged = true;
      }

      if (this.aiState === 'recovery') {
        // Faster recovery: multiplicative + additive
        const recoveryFactor = this.lastSmoothedRtt < 250 ? 1.15 : 1.08; // Increased from 1.08/1.04
        this.targetBitrate = Math.min(this.maxBitrate, this.targetBitrate * recoveryFactor + 100000); // Increased additive boost 
        
        if (this.targetBitrate >= oldBitrate * 1.1 || this.lastSmoothedRtt < 150) { 
           this.aiState = 'steady';
        }
      } else if (this.aiState === 'steady') {
        // Steady state: faster growth if RTT is low
        if (now - this.lastSteadyIncrease > 300) { 
          const growthFactor = this.lastSmoothedRtt < 150 ? 1.10 : 1.05; 
          this.targetBitrate = Math.min(this.maxBitrate, this.targetBitrate * growthFactor + 10000);
          this.lastSteadyIncrease = now;
        }

        // Probing: quickly jump to test capacity
        // DISABLED: Aggressive probing causes self-induced congestion
        /*
        if (!this.isProbing && now - this.probingStartTs > 8000) { 
          this.isProbing = true;
          this.probingStartTs = now;
          if (this.onLog) this.onLog(`🔍 Probing network capacity (3.5x)...`);
        }

        if (this.isProbing) {
          if (now - this.probingStartTs < 250) {
            this.targetBitrate = Math.min(this.maxBitrate, oldBitrate * 3.5);
          } else {
            this.isProbing = false;
            this.probingStartTs = now; // Reset timer
          }
        }
        */
      }
    }

    if (Math.abs(this.targetBitrate - oldBitrate) > 1000 || stateChanged) {
      this.applyBitrateToParams();
    }
  }

  public updateRTT(rtt: number) {
    const now = performance.now();
    this.lastRtt = rtt;
    
    // === NEW PROTECTION AGAINST ZOMBIE RTT (SPIKES) ===
    if (rtt > 3000) { // Increased from 1500 to 3000ms
      if (this.onLog) this.onLog(`🚨 EXTREME RTT SPIKE ${rtt}ms — dropping bitrate by 50% and flushing queue`);
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
      this.sendQueue = []; // Force clear stale frames
      this.applyBitrateToParams();
      this.rttHistory = [this.lastSmoothedRtt || 200]; // return to last normal
      return;
    }

    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();
    
    const sorted = [...this.rttHistory].sort((a, b) => a - b);
    const medianRtt = sorted[Math.floor(sorted.length / 2)];

    // Increased clamp to 5000ms to allow adaptation to extreme delays
    const clampedRtt = Math.min(medianRtt, 5000); 

    // Asymmetric Smoothing: faster recovery when RTT drops
    const prevSmoothed = this.lastSmoothedRtt || clampedRtt;
    const alpha = (clampedRtt < prevSmoothed) ? 0.5 : 0.2; 
    this.lastSmoothedRtt = prevSmoothed * (1 - alpha) + clampedRtt * alpha;
    
    // Delay Trend (Derivative)
    const dt = (now - this.lastUpdateTs) / 1000;
    if (dt >= 0.2) {
      this.delayTrend = (this.lastSmoothedRtt - prevSmoothed) / dt;
      this.lastUpdateTs = now;
      this.updateCongestionControl();
    }
  }

  public setManualMode(enabled: boolean) {
    this.manualMode = enabled;
    this.errorIntegral = 0; // Reset PI on mode toggle
    if (enabled) {
      this.lastAbrBitrate = this.targetBitrate;
      this.targetBitrate = this.manualBitrate;
      if (this.onLog) this.onLog(`🛠️ Manual mode enabled, bitrate fixed to ${Math.round(this.manualBitrate/1024)}k`);
    } else {
      this.targetBitrate = this.lastAbrBitrate;
      if (this.onLog) this.onLog(`🔄 Auto mode (ABR) restored, target bitrate ${Math.round(this.targetBitrate/1024)}k`);
    }
    this.applyBitrateToParams();
  }

  public setManualBitrate(bitrate: number) {
    this.manualBitrate = bitrate;
    
    if (this.manualMode) {
      // Safe transition: reset everything before re-configuring
      this.sendQueue = [];
      this.tokenBucketBytes = 0;
      this.targetBitrate = bitrate;
      
      if (this.encoder) {
        this.needsKeyframe = true;
        this.encoder.flush(); // flush the encoder queue to prevent deadlock
      }
      
      this.applyBitrateToParams();
      if (this.onLog) this.onLog(`🛠️ Manual bitrate → ${Math.round(bitrate/1024)}k (queue cleared, forced I-frame)`);
    }
  }

  public getStats() {
    const { rtt, bufferedAmount } = this.getNetworkMetrics();
    const avgEncode = this.encodeDurationLog.length > 0 
      ? this.encodeDurationLog.reduce((a,b)=>a+b, 0) / this.encodeDurationLog.length 
      : 0;
    
    // Estimated actual FPS: 1000 / (avgEncode + time_per_frame_at_target_fps)
    const actualFps = Math.min(this.currentFps, 1000 / (avgEncode + (1000 / this.currentFps)));

    return {
      fps: Math.round(actualFps),
      droppedFrames: this.droppedFrames,
      droppedFramesRate: this.droppedFramesRate,
      state: this.aiState === 'congested' ? 'Overuse' : 'Normal',
      aiState: this.aiState,
      targetBitrate: Math.round(this.targetBitrate / 1024),
      rtt: rtt,
      bl: bufferedAmount,
      qDelay: this.sendQueue.length > 0 ? performance.now() - this.sendQueue[0].enqueueTime : 0,
      qLen: this.sendQueue.length,
      cpu: Math.round(avgEncode) // ms per frame
    };
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const now = performance.now();
    this.sessionStartTime = now;
    this.lastAIUpdate = now;
    this.lastTokenUpdate = now;
    this.lastPacerRun = now;
    this.lastCongestionTs = 0;
    this.aiState = 'steady';
    this.targetBitrate = 500_000;
    this.frameId = 0;
    this.applyBitrateToParams();
    if (this.onLog) this.onLog(`🚀 Sender started: Fixed 1Mbps, GCC disabled, GOP=60`);
    this.pacerInterval = setInterval(() => this.runPacer(performance.now()), 10);
    this.rafId = requestAnimationFrame(this.loop);
  }

  public async stop() {
    this.isRunning = false;
    this.sendQueue = [];
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.pacerInterval) clearInterval(this.pacerInterval);
    this.pacerInterval = null;
    
    if (cryptoWorker) {
      cryptoWorker.postMessage({ type: 'CLEAR_KEY' });
    }

    if (this.encoder) {
      try { this.encoder.close(); } catch (e) {}
      this.encoder = null;
      this.isConfigured = false;
    }
  }

  public isRunningNow() {
    return this.isRunning;
  }

  public forceKeyframe() {
    this.needsKeyframe = true;
  }

  private loop = async (now: number) => {
    if (!this.isRunning) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.lastFrameTime = now;
      this.lastTokenUpdate = now;
      this.rafId = requestAnimationFrame(this.loop);
      return;
    }

    this.updateCongestionControl();

    const timeDeltaMs = now - this.lastTokenUpdate;
    if (timeDeltaMs > 0) {
      // Fill bucket based on target bitrate
      const tokensToAdd = (this.targetBitrate / 8) * (timeDeltaMs / 1000);
      const maxBurst = (this.targetBitrate / 8) * 1.5; // 1.5s burst
      this.tokenBucketBytes = Math.min(this.tokenBucketBytes + tokensToAdd, maxBurst);
      
      // === NEW: DEBT CAPPING ===
      // Cap the debt to prevent long recovery times (e.g., 5-6 seconds) after a huge frame.
      // If debt is too high, we just "forgive" some of it to allow recovery within ~0.2 second.
      const maxDebt = -this.targetBitrate / 40; // Max 0.2 second of debt at current bitrate
      if (this.tokenBucketBytes < maxDebt) {
        this.tokenBucketBytes = maxDebt;
      }
      
      this.lastTokenUpdate = now;
    }
    
    // Watchdog for pending frames to prevent permanent freeze
    if (this.pendingFrames > 0 && now - this.lastPendingReset > 1500) { 
      if (this.onLog) this.onLog(`🚨 Watchdog: Encoder stuck with ${this.pendingFrames} frames. Force resetting encoder...`);
      this.handleEncoderError(); // This will re-init the encoder
      this.lastPendingReset = now;
    }

    const frameInterval = 1000 / this.currentFps;
    if (now - this.lastFrameTime >= frameInterval) {
      const { bufferedAmount } = this.getNetworkMetrics();
      const queueBytes = this.sendQueue.reduce((acc, q) => acc + q.data.length, 0);
      
      // Dynamic thresholds based on bitrate
      // Increased maxWsBuffer to 500KB to allow I-frames to pass without blocking deltas
      const maxWsBuffer = Math.max(500000, (this.targetBitrate / 8) * 1.5); 
      const isInternalQueuePanic = this.sendQueue.length > 60 || queueBytes > 1536000;
      
      // Resolution scaling based on RTT
      if (this.lastSmoothedRtt > 1500) {
        this.currentScale = 0.3;
      } else if (this.lastSmoothedRtt > 800) {
        this.currentScale = 0.5;
      } else if (this.lastSmoothedRtt > 400) {
        this.currentScale = 0.75;
      } else {
        this.currentScale = 1.0;
      }
      
      // FPS scaling
      if (this.lastSmoothedRtt > 1200) {
        this.currentFps = 10;
      } else if (this.lastSmoothedRtt > 600) {
        this.currentFps = 15;
      } else if (this.lastSmoothedRtt > 300) {
        this.currentFps = 20;
      } else {
        this.currentFps = 30;
      }
      
      const possessesTokens = this.tokenBucketBytes > 0;
      
      if (bufferedAmount > maxWsBuffer || isInternalQueuePanic || !possessesTokens) { 
        this.droppedFrames++;
        this.droppedFramesWindow++;
        this.droppedFramesConsecutive++;
        if (this.droppedFramesConsecutive >= 3) this.needsKeyframe = true;
        this.lastFrameTime = now;
        
        if (this.onLog && this.frameId % 60 === 0) {
          let reason = "";
          if (bufferedAmount > maxWsBuffer) reason += `WS_BUF(${Math.round(bufferedAmount/1024)}K > ${Math.round(maxWsBuffer/1024)}K) `;
          if (isInternalQueuePanic) reason += `Q_PANIC(${this.sendQueue.length}f, ${Math.round(queueBytes/1024)}K) `;
          if (!possessesTokens) reason += `NO_TOKENS(${Math.round(this.tokenBucketBytes/1024)}K) `;
          this.onLog(`Skipping frame: ${reason}`);
        }

        if ((isInternalQueuePanic || bufferedAmount > maxWsBuffer * 1.5) && now - this.lastCongestionTs > this.congestionCooldown) {
          if (this.onLog) {
            this.onLog(`🚨 Congestion Panic: qLen=${this.sendQueue.length}, qBytes=${Math.round(queueBytes/1024)}KB, wsBuf=${Math.round(bufferedAmount/1024)}KB, clearing all!`);
          }
          this.sendQueue = [];
          // Don't zero out tokens completely, allow a small burst for the next I-frame
          this.tokenBucketBytes = 20000; 
          this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5); // Slightly less aggressive cut
          this.applyBitrateToParams();
          this.aiState = 'congested';
          this.lastCongestionTs = now;
        }
      } else {
        this.lastFrameTime = now;
        const success = await this.processFrame(now);
        if (success) {
          this.droppedFramesConsecutive = 0;
          this.lastPendingReset = now; // Activity detected
        }
      }
    }

    if (now - this.droppedWindowStart >= 1000) {
      this.droppedFramesRate = this.droppedFramesWindow;
      this.droppedFramesWindow = 0;
      this.droppedWindowStart = now;
      
      const kbps = Math.round((this.bytesSentThisSecond * 8) / 1024);
      this.bytesSentThisSecond = 0;
      
      if (this.onLog && this.isRunning) {
        const queueBytes = this.sendQueue.reduce((acc, q) => acc + q.data.length, 0);
        this.onLog(`📤 Send rate: ${kbps} kbps, buffer: ${this.sendQueue.length} frames (${Math.round(queueBytes/1024)}KB), tokens=${Math.round(this.tokenBucketBytes/1024)}KB`);
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private runPacer(now: number) {
    if (this.sendQueue.length > 0 && this.onLog && now - this.lastPacerLog > 1000) {
      this.onLog(`🏃 Pacer: queue=${this.sendQueue.length}, tokens=${Math.round(this.pacerTokens)}`);
      this.lastPacerLog = now;
    }

    if (this.sendQueue.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    
    const pacerDeltaMs = now - this.lastPacerRun;
    if (pacerDeltaMs <= 0) return;
    this.lastPacerRun = now;
    
    const bytesPerMs = (this.targetBitrate / 8) / 1000;
    const maxPacerBurst = Math.max(5000, bytesPerMs * 1000); // 1000ms burst (increased from 500)
    // Increased multiplier to 4.0x when queue is large to burst through congestion
    const multiplier = this.sendQueue.length > 5 ? 4.0 : 1.5; // Increased from 2.5/1.2
    this.pacerTokens = Math.min(maxPacerBurst, this.pacerTokens + (bytesPerMs * multiplier) * pacerDeltaMs);
    
    while (this.sendQueue.length > 0 && this.pacerTokens >= 0) {
      const chunk = this.sendQueue[0].data;
      this.ws.send(chunk);
      this.pacerTokens -= chunk.length;
      this.bytesSentThisSecond += chunk.length;
      this.sendQueue.shift();
    }
  }
  
  private async processFrame(now: number): Promise<boolean> {
    if (this.onLog && this.frameId % 300 === 0) {
      this.onLog(`🎬 processFrame: pending=${this.pendingFrames}, queue=${this.sendQueue.length}, state=${this.aiState}, tokens=${Math.round(this.tokenBucketBytes/1024)}K`);
    }
    
    // Increased pending limit to 6 to allow for complex frame spikes
    if (this.pendingFrames > 6 || this.video.paused || this.video.ended || this.video.readyState < 2) {
      if (this.onLog && this.frameId % 120 === 0) {
         if (this.pendingFrames > 6) this.onLog(`⚠️ processFrame skipped: too many pending frames (${this.pendingFrames})`);
         else this.onLog(`⚠️ processFrame skipped: video state (paused=${this.video.paused}, ended=${this.video.ended}, readyState=${this.video.readyState})`);
      }
      return false;
    }
    if (!this.encoder) {
      this.initEncoder();
      if (!this.encoder) return false;
    }

    try {
      // Ensure the video element has a valid frame before constructing VideoFrame
      if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
        if (this.onLog && this.frameId % 120 === 0) this.onLog(`⚠️ processFrame skipped: video dimensions are 0`);
        return false;
      }

      const timestamp = Math.round(performance.now() * 1000);
      const frame = new VideoFrame(this.video, { timestamp });
      
      const inputW = frame.displayWidth;
      const inputH = frame.displayHeight;
      const finalScale = this.currentScale;
      
      const targetW = Math.floor((inputW * finalScale) / 2) * 2;
      const targetH = Math.floor((inputH * finalScale) / 2) * 2;
      
      if (!this.isConfigured || targetW !== this.currentWidth || targetH !== this.currentHeight) {
        this.configureEncoder(targetW, targetH);
      }
      
      // Task 17: Don't force keyframe if congested (saves bits)
      if (this.frameId % 90 === 0 && this.aiState !== 'congested') {
        this.needsKeyframe = true;
      }

      if (this.encoder.encodeQueueSize > 4) {
          if (this.onLog) this.onLog(`⚠️ Encoder queue full (${this.encoder.encodeQueueSize})`);
          frame.close(); 
          return false;
      }

      this.pendingFrames++;
      this.encoder.encode(frame, { keyFrame: this.needsKeyframe || this.frameId === 0 });
      this.needsKeyframe = false;
      frame.close();
      return true;
    } catch (e) {
      if (this.onLog) this.onLog(`❌ Encoder encode exception: ${e}`);
      return false;
    }
  }
}
