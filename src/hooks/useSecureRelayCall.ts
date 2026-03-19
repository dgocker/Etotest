import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { AdaptiveH264Engine } from '../utils/AdaptiveH264Engine';
import { H264Decoder } from '../utils/H264Decoder';
import { deobfuscateAssemble } from '../utils/obfuscator';
import { encryptData, decryptData } from '../utils/cryptoUtils';
import { logger } from '../utils/logger';

const RELAY_TOKEN_REMOVED = true;

export function useSecureRelayCall(
  socket: Socket | null,
  activeStreamRef: React.MutableRefObject<MediaStream | null>,
  setRemoteStream: (stream: MediaStream | null) => void,
  onCallEnded: () => void,
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>,
  setAutoplayFailed: (failed: boolean) => void,
  addLog: (msg: string) => void,
  isAudioMuted: boolean,
  isLoopback: boolean = false
) {
  const [remoteRotation, setRemoteRotation] = useState<number>(0);
  const [remoteMirror, setRemoteMirror] = useState<boolean>(false);
  const [remoteFlipV, setRemoteFlipV] = useState<boolean>(false);
  const [connectionState, setConnectionState] = useState<'disconnected' | 'checking' | 'connected'>('disconnected');
  const [stats, setStats] = useState({ rtt: 0, packetLoss: 0, bitrate: 0, resolution: '', fps: 0, quality: 0, scale: 0, droppedFrames: 0, netState: 'Normal' });

  const resetRemoteOrientation = useCallback(() => {
    setRemoteRotation(0);
    setRemoteMirror(false);
    setRemoteFlipV(false);
    if (h264DecoderRef.current) {
      h264DecoderRef.current.setRotation(0);
      h264DecoderRef.current.setMirror(false);
      h264DecoderRef.current.setFlipV(false);
    }
  }, []);

  const toggleRemoteRotation = useCallback(() => {
    setRemoteRotation(prev => {
      const next = (prev + 90) % 360;
      if (h264DecoderRef.current) h264DecoderRef.current.setRotation(next);
      return next;
    });
  }, []);

  const toggleRemoteMirror = useCallback(() => {
    setRemoteMirror(prev => {
      const next = !prev;
      if (h264DecoderRef.current) h264DecoderRef.current.setMirror(next);
      return next;
    });
  }, []);

  const toggleRemoteFlipV = useCallback(() => {
    setRemoteFlipV(prev => {
      const next = !prev;
      if (h264DecoderRef.current) h264DecoderRef.current.setFlipV(next);
      return next;
    });
  }, []);
  const [metricHistory, setMetricHistory] = useState<{ts: number, rtt: number, fps: number, bitrate: number, state: string}[]>([]);
  const rttRef = useRef<number>(0);
  const [isFallbackMode, setIsFallbackMode] = useState<boolean>(false);
  const remoteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const h264DecoderRef = useRef<H264Decoder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const queueRef = useRef<Uint8Array[]>([]);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const isAppendingRef = useRef(false);
  const currentRoomIdRef = useRef<string | null>(null);
  const currentRoomTokenRef = useRef<string | null>(null);
  const remoteSupportsWebMRef = useRef<boolean>(false); // Task 14: Safe default
  const mySupportsWebMRef = useRef<boolean>(false);
  const obfBufferRef = useRef<{ [frameId: number]: Uint8Array[] }>({});
  const sharedSecretRef = useRef<CryptoKey | null>(null);
  
  // Fallback refs
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const adaptiveEngineRef = useRef<AdaptiveH264Engine | null>(null);
  const remoteImgRef = useRef<HTMLImageElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const lastAudioLogTimeRef = useRef<number>(0);
  const audioChunkCountRef = useRef<number>(0);
  const firstJpegReceivedRef = useRef<boolean>(false);
  const startTimeRef = useRef<number>(0);
  const audioJitterBufferRef = useRef<{ data: ArrayBuffer | Uint8Array, senderTs: number }[]>([]);

  const bytesReceivedRef = useRef<number>(0);
  const lastBitrateCalcTimeRef = useRef<number>(Date.now());
  const lastLargeBufferTimeRef = useRef<number>(0);
  // Unique ID for this session so we ignore pongs sent by the remote peer
  const fragmentCleanupInterval = useRef<number | null>(null);
  const mySidRef = useRef<string>(Math.random().toString(36).substring(7));
  const isCleanedUpRef = useRef(false);
  const orientationListenerRef = useRef<(() => void) | null>(null);


  const startPing = (ws: WebSocket) => {
    if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
    let pingCounter = 0;
    pingIntervalRef.current = window.setInterval(() => {
      const buffered = ws.bufferedAmount || 0;
      if (ws.readyState === WebSocket.OPEN) {
        pingCounter++;
        if (pingCounter >= 5) { // Every 500ms (5 * 100ms)
           ws.send(JSON.stringify({ type: 'ping', ts: performance.now(), sid: mySidRef.current }));
           pingCounter = 0;
        }
      }
      
      // Task 17 Refined: More permissive for high-bitrate video (256KB, 5s)
      if (buffered > 262144) {
        if (lastLargeBufferTimeRef.current === 0) lastLargeBufferTimeRef.current = Date.now();
        if (Date.now() - lastLargeBufferTimeRef.current > 5000) {
          addLog('🚨 Critical buffer overflow (256KB+ for 5s), reconnecting...');
          ws.close(4001, 'Buffer overflow');
        }
      } else {
        lastLargeBufferTimeRef.current = 0;
      }
      
      const now = Date.now();
      const elapsed = Math.max(0.1, (now - lastBitrateCalcTimeRef.current) / 1000);
      const bitrate = Math.round((bytesReceivedRef.current * 8) / elapsed / 1024); // kbps
      bytesReceivedRef.current = 0;
      lastBitrateCalcTimeRef.current = now;


      const engineStats = adaptiveEngineRef.current ? adaptiveEngineRef.current.getStats() : null;
      const newState = (engineStats as any)?.state || 'Normal';
      
      setStats(prev => ({ 
        ...prev, 
        fps: engineStats?.fps || 0, 
        quality: engineStats?.quality || 0, 
        scale: engineStats?.scale || 0,
        droppedFrames: engineStats?.droppedFrames || 0,
        netState: newState,
        bitrate
      }));

      setMetricHistory(prev => {
        const newEntry = {
          ts: Date.now(),
          rtt: rttRef.current,
          delta: (engineStats as any)?.delta || 0,
          threshold: (engineStats as any)?.threshold || 0,
          fps: engineStats?.fps || 0,
          bitrate: bitrate,
          quality: 0, // Quality is no longer a fixed scale in GCC
          drp: (engineStats as any)?.droppedFramesRate || 0,
          ai: (engineStats as any)?.aiState || '?',
          bl: wsRef.current?.bufferedAmount || 0,
          state: newState

        };
        const updated = [...prev, newEntry];
        return updated.length > 2000 ? updated.slice(updated.length - 2000) : updated;
      });
    }, 100); // 10 times a second for high-resolution logging
  };

  useEffect(() => {
    // Automatic orientation sync removed to avoid double-rotation issues with VideoFrame.
    // Users can still use manual rotation buttons if needed.
    const handler = () => {
      const angle = screen.orientation?.angle ?? (window.orientation as number) ?? 0;
      addLog(`📱 Device orientation changed: ${angle}deg (Not syncing automatically)`);
    };

    window.addEventListener('orientationchange', handler);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', handler);
    }
    
    return () => {
      window.removeEventListener('orientationchange', handler);
      if (screen.orientation) {
        screen.orientation.removeEventListener('change', handler);
      }
    };
  }, [addLog]);

  const cleanup = useCallback(() => {
    addLog('🧹 Cleaning up call resources...');
    isCleanedUpRef.current = true;

    if (fragmentCleanupInterval.current) {
      clearInterval(fragmentCleanupInterval.current);
      fragmentCleanupInterval.current = null;
    }

    // Task 329: Stop engine and clear crypto key
    if (adaptiveEngineRef.current) {
      adaptiveEngineRef.current.stop();
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (e) {}
    }
    if (adaptiveEngineRef.current) {
      adaptiveEngineRef.current.stop();
      adaptiveEngineRef.current = null;
    }
    if (h264DecoderRef.current) {
      h264DecoderRef.current.destroy();
      h264DecoderRef.current = null;
    }
    setIsFallbackMode(false);
    if (fallbackVideoRef.current) {
      fallbackVideoRef.current.srcObject = null;
      fallbackVideoRef.current.remove();
      fallbackVideoRef.current = null;
    }
    if (remoteImgRef.current) {
      remoteImgRef.current.remove();
      remoteImgRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.style.display = 'block';
      remoteVideoRef.current.style.opacity = '0.01';
      remoteVideoRef.current.style.position = 'absolute';
      remoteVideoRef.current.style.width = '1px';
      remoteVideoRef.current.style.height = '1px';
      remoteVideoRef.current.style.pointerEvents = 'none';
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    cleanupPCMAudio();
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (orientationListenerRef.current) {
      window.removeEventListener('orientationchange', orientationListenerRef.current);
      orientationListenerRef.current = null;
    }
    setConnectionState('disconnected');
    queueRef.current = [];
    obfBufferRef.current = {};
    currentRoomIdRef.current = null;
    
    // 🔥 CRITICAL FIX: Explicitly drop the in-memory AES-GCM Key 
    // to preserve Perfect Forward Secrecy and prevent key material leaks
    sharedSecretRef.current = null;
    
    // FIX: Reset RTT and other metrics for clean next call
    rttRef.current = 0;
    bytesReceivedRef.current = 0;
    lastBitrateCalcTimeRef.current = Date.now();
    lastLargeBufferTimeRef.current = 0;
    firstJpegReceivedRef.current = false;

    if (remoteCanvasRef.current) {
      const ctx = remoteCanvasRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, remoteCanvasRef.current.width, remoteCanvasRef.current.height);
    }
    if (remoteVideoRef.current) {
      if (remoteVideoRef.current.src?.startsWith('blob:')) {
        URL.revokeObjectURL(remoteVideoRef.current.src);
      }
      remoteVideoRef.current.src = '';
    }
  }, [remoteVideoRef, addLog]);


  const addPadding = (originalBuffer: ArrayBuffer, type: number = 0, senderTs: number = 0) => {
    const originalView = new Uint8Array(originalBuffer);
    const originalSize = originalView.length;
    
    // Audio (type 1/3): tiny padding
    const paddingSize = (type === 1 || type === 3)
      ? Math.floor(Math.random() * 10) + 5   
      : Math.floor(Math.random() * 400) + 100;

    const totalSize = 9 + originalSize + paddingSize; // Task 17: 9-byte header (1 + 4 + 4)
    const paddedBuffer = new ArrayBuffer(totalSize);
    const paddedView = new DataView(paddedBuffer);
    const paddedUint8 = new Uint8Array(paddedBuffer);
    
    paddedUint8[0] = type;
    paddedView.setUint32(1, originalSize, true);
    paddedView.setUint32(5, senderTs, true); // Task 17: senderTs at pos 5
    paddedUint8.set(originalView, 9);
    
    for (let i = 9 + originalSize; i < totalSize; i++) {
      paddedUint8[i] = Math.floor(Math.random() * 256);
    }
    return paddedBuffer;
  };

  const removePadding = (paddedBuffer: ArrayBuffer) => {
    const paddedView = new DataView(paddedBuffer);
    const type = new Uint8Array(paddedBuffer)[0];
    const originalSize = paddedView.getUint32(1, true);
    const senderTs = paddedView.getUint32(5, true); // Task 17
    return { 
      data: paddedBuffer.slice(9, 9 + originalSize),
      type,
      senderTs
    };
  };

  const processQueue = () => {
    if (!sourceBufferRef.current || isAppendingRef.current || queueRef.current.length === 0) return;
    
    if (queueRef.current.length > 30) {
      addLog(`⚠️ Queue getting large: ${queueRef.current.length} chunks`);
    }

    try {
      if (!sourceBufferRef.current.updating) {
        isAppendingRef.current = true;
        const data = queueRef.current.shift();
        if (data) sourceBufferRef.current.appendBuffer(data);
      }
    } catch (e) {
      console.error('Error appending buffer', e);
      addLog(`❌ Error appending buffer: ${e}`);
      isAppendingRef.current = false;
    }
  };

  // PCM Audio Receiver
  const receiverAudioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const SAMPLE_RATE = 8000; // Reduced from 16000 to save bandwidth (128kbps instead of 256kbps)

  const initAudioContexts = () => {
    if (isCleanedUpRef.current) return;
    if (!audioContextRef.current) {

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {});
      }
    }
    if (!receiverAudioContextRef.current) {
      receiverAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      if (receiverAudioContextRef.current.state === 'suspended') {
        receiverAudioContextRef.current.resume().catch(() => {});
      }
      
      // Create a silent oscillator to keep the audio context active and force Android to use media volume
      const osc = receiverAudioContextRef.current.createOscillator();
      const gain = receiverAudioContextRef.current.createGain();
      gain.gain.value = 0; // Silent
      osc.connect(gain);
      gain.connect(receiverAudioContextRef.current.destination);
      osc.start();
    }
  };

  const playAudioChunk = (chunk: ArrayBuffer | Uint8Array, senderTs: number = 0) => {
    if (!receiverAudioContextRef.current) {
      receiverAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }

    // Task 17: Use Jitter Buffer for A/V Sync
    audioJitterBufferRef.current.push({ data: chunk, senderTs });
    if (audioJitterBufferRef.current.length > 150) audioJitterBufferRef.current.shift(); // Relaxed safety cap

    if (!(receiverAudioContextRef.current as any)._isLoopStarted) {
      (receiverAudioContextRef.current as any)._isLoopStarted = true;
      const playLoop = () => {
        if (isCleanedUpRef.current) return;
        
        if (audioJitterBufferRef.current.length > 0 && h264DecoderRef.current) {
          const packet = audioJitterBufferRef.current[0];
          const stats = h264DecoderRef.current.getStats();
          if (stats.firstPlayoutTime > 0) {
            const videoOffset = packet.senderTs - stats.firstSenderTs;
            const targetPlayTime = stats.firstPlayoutTime + videoOffset + stats.targetDelay;
            const now = performance.now();

            if (now < targetPlayTime) {
              setTimeout(playLoop, 10);
              return;
            }
            
            // Catch-up: if audio is too old (>500ms), drop it
            if (now - targetPlayTime > (h264DecoderRef.current?.getStats()?.dropThreshold || 500)) {
               audioJitterBufferRef.current.shift();
               setTimeout(playLoop, 5);
               return;
            }
          }

          const ctx = receiverAudioContextRef.current!;
          if (ctx.state === 'suspended') ctx.resume();

          const audioBuffer = ctx.createBuffer(1, packet.data.byteLength, SAMPLE_RATE);
          const pcm8 = new Uint8Array(packet.data);
          const f32 = new Float32Array(pcm8.length);
          for (let i = 0; i < pcm8.length; i++) f32[i] = (pcm8[i] / 127.5) - 1.0;
          audioBuffer.copyToChannel(f32, 0);

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);

          // We use the AudioContext's currentTime for precise scheduling if possible, 
          // but since we already waited for targetPlayTime in JS domain, playing immediately is fine.
          source.start(0);
          
          audioJitterBufferRef.current.shift();
        }
        setTimeout(playLoop, 20);
      };
      playLoop();
    }
  };

  const cleanupPCMAudio = () => {
    if (receiverAudioContextRef.current) {
      receiverAudioContextRef.current.close();
      receiverAudioContextRef.current = null;
    }
    nextPlayTimeRef.current = 0;
  };

  const startPCMAudioSender = (stream: MediaStream) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }
    
    // Prevent multiple script processors
    if ((audioContextRef.current as any)._isSenderStarted) return;
    (audioContextRef.current as any)._isSenderStarted = true;

    const source = audioContextRef.current.createMediaStreamSource(stream);
    
    // 8 kHz mono, буфер 256 сэмпла (~32 мс)
    const scriptProcessor = audioContextRef.current.createScriptProcessor(256, 1, 1);

    scriptProcessor.onaudioprocess = async (e) => {
      if (isAudioMuted) return; // Skip processing if mic is muted to prevent static
      
      const inputData = e.inputBuffer.getChannelData(0);
      const outputData = e.outputBuffer.getChannelData(0);
      // Convert to 8-bit PCM to save 50% bandwidth vs 16-bit
      const pcm8 = new Uint8Array(inputData.length);

      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        // Map -1.0...1.0 to 0...255
        pcm8[i] = Math.floor((s + 1.0) * 127.5);
        outputData[i] = 0; // Ensure silence
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        if (!sharedSecretRef.current) return;
        
        let finalBuffer: ArrayBuffer;
        try {
          const encrypted = await encryptData(sharedSecretRef.current, pcm8);
          finalBuffer = encrypted.buffer as ArrayBuffer;
        } catch (err) {
          return;
        }
        
        const senderTs = startTimeRef.current > 0 ? Math.floor(performance.now() - startTimeRef.current) : 0;
        const buffered = wsRef.current.bufferedAmount || 0;
        if (buffered < 256000) {
          wsRef.current.send(addPadding(finalBuffer, 3, senderTs)); 
        }
      }
    };

    const gainNode = audioContextRef.current.createGain();
    gainNode.gain.value = 0; // Mute output
    
    source.connect(scriptProcessor);
    scriptProcessor.connect(gainNode);
    gainNode.connect(audioContextRef.current.destination);
    addLog('🎙️ PCM sender started');
  };

  const startRecording = () => {
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      addLog('⏳ WebSocket connecting, recording will start on open');
      return;
    }

    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      addLog('⚠️ Cannot start recording: websocket not ready');
      return;
    }

    addLog('🎥 Starting media recording (H.264 Priority)...');
    
    // If engine is already running, just force an I-frame instead of destroying it
    // This prevents "frozen" frames during micro-reconnects
    if (adaptiveEngineRef.current && adaptiveEngineRef.current.isRunningNow()) {
      addLog('🔄 Engine already running, forcing I-frame');
      adaptiveEngineRef.current.forceKeyframe();
      return;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (e) {}
    }
    if (adaptiveEngineRef.current) {
      adaptiveEngineRef.current.stop();
      adaptiveEngineRef.current = null;
    }

    if (activeStreamRef.current) {
      startPCMAudioSender(activeStreamRef.current);
      
      // In Secure Relay mode, we force our custom H.264 engine over standard WebM
      // because it provides much better latency control (catch-up logic) and 
      // is specifically tuned for 150-300kbps "survival" scenarios.
      addLog('🚀 Using H.264 + PCM Audio (Forced for all devices)');
      startFallbackRecording();
    } else {
      addLog('⚠️ Cannot start recording: stream or websocket not ready');
    }
  };

  const startFallbackRecording = () => {
    if (!activeStreamRef.current) return;

    if (!fallbackVideoRef.current) {
      fallbackVideoRef.current = document.createElement('video');
      fallbackVideoRef.current.muted = true;
      fallbackVideoRef.current.playsInline = true;
      fallbackVideoRef.current.autoplay = true;
      // Use absolute positioning instead of display: none to prevent browsers (like iOS Safari) from pausing the video
      fallbackVideoRef.current.style.position = 'absolute';
      fallbackVideoRef.current.style.width = '1px';
      fallbackVideoRef.current.style.height = '1px';
      fallbackVideoRef.current.style.opacity = '0.01';
      fallbackVideoRef.current.style.pointerEvents = 'none';
      fallbackVideoRef.current.style.zIndex = '-1';
      document.body.appendChild(fallbackVideoRef.current);
    }
    
    const video = fallbackVideoRef.current;
    
    if (video.srcObject !== activeStreamRef.current) {
      video.srcObject = activeStreamRef.current;
    }
    
    // Always try to play to ensure it's not paused
    video.play().catch(e => {
      console.error('Fallback video play error', e);
      addLog(`❌ Fallback video play error: ${e}`);
    });

    if (!adaptiveEngineRef.current) {
      adaptiveEngineRef.current = new AdaptiveH264Engine(
        video,
        (dataUrl) => {
          // This callback is no longer used for sending frames directly, 
          // as obfuscation is now handled inside AdaptiveH264Engine
        },
        () => {
          return {
            rtt: rttRef.current,
            bufferedAmount: wsRef.current?.bufferedAmount || 0
          };
        },
        wsRef.current!,
        addLog,
        sharedSecretRef.current  // \u2190 Pass E2EE key so video frames are encrypted
      );
    }
    
    if (h264DecoderRef.current) {
      h264DecoderRef.current.setMirror(remoteMirror);
      h264DecoderRef.current.setRotation(remoteRotation);
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'rotation', value: remoteRotation, mirror: remoteMirror, sid: mySidRef.current }));
    }
    
    adaptiveEngineRef.current.start();
    addLog('🚀 Adaptive H.264 Engine started');
  };

  const setRemoteSupportsWebM = (supports: boolean) => {
    const changed = remoteSupportsWebMRef.current !== supports;
    remoteSupportsWebMRef.current = supports;
    console.log('Remote supports WebM:', supports);
    addLog(`ℹ️ Remote supports WebM: ${supports}`);
    
    if (changed && connectionState === 'connected') {
      addLog('🚀 Remote WebM support changed, restarting recording...');
      startRecording();
    }
  };

  const [secureEmojis, setSecureEmojis] = useState<string[]>(['🔒', '🛡️', '📡', '✨']);

  const generateEmojis = (seed: string) => {
    const emojiList = [
      '🍎', '🦊', '🚀', '💎', '🌈', '🌙', '🍀', '🔥', 
      '🧊', '⚡', '🦄', '🎈', '🎨', '🎭', '🎸', '🏆',
      '🛸', '🪐', '🍄', '🌵', '🌸', '🐳', '🦜', '🦁'
    ];
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    
    const result = [];
    for (let i = 0; i < 4; i++) {
      const index = Math.abs((hash + i * 7) % emojiList.length);
      result.push(emojiList[index]);
    }
    setSecureEmojis(result);
  };

  const connectToRelay = (roomId: string, roomToken: string, sharedSecret: CryptoKey | null, retryCount: number = 0) => {
    isCleanedUpRef.current = false;
    currentRoomIdRef.current = roomId;
    currentRoomTokenRef.current = roomToken;
    sharedSecretRef.current = null; // Task 15: Reset before setting new one
    sharedSecretRef.current = sharedSecret;

    generateEmojis(roomId);
    setConnectionState('checking');
    addLog(`🔗 Connecting to Secure Relay room: ${roomId}`);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/secure-relay?room=${roomId}&token=${roomToken}${isLoopback ? '&loopback=true' : ''}`;
    
    addLog(`📡 WebSocket URL: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      initAudioContexts();
      console.log('Connected to Secure Relay');

      addLog('✅ WebSocket connected to Relay');
      setConnectionState('connected');
      setRemoteStream(new MediaStream()); // Trick Dashboard into thinking we have a stream
      
      // Force a fresh I-frame on reconnect to prevent artifacts
      if (adaptiveEngineRef.current) {
        adaptiveEngineRef.current.forceKeyframe();
      }
      
      // Send OS info to help receiver correct orientation (Android fix)
      const isAndroid = /Android/i.test(navigator.userAgent);
      
      if (isAndroid) {
        ws.send(JSON.stringify({ type: 'info', os: 'android', sid: mySidRef.current }));
        addLog('📱 Signaling: I am on Android (sender)');
      }
      
      startTimeRef.current = performance.now();
      
      // Task 17: Log shared secret hash for consistency check
      if (sharedSecretRef.current) {
        crypto.subtle.exportKey('raw', sharedSecretRef.current).then(raw => {
          const hash = new Uint8Array(raw).slice(0, 4).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
          addLog(`🔐 E2EE Shared Secret Hash: ${hash}`);
        });
      }

      startRecording();
      startPing(ws);

      // Task 329: Interval-based cleanup for fragmented frames
      if (fragmentCleanupInterval.current) clearInterval(fragmentCleanupInterval.current);
      fragmentCleanupInterval.current = window.setInterval(() => {
        const now = Date.now();
        for (const key in obfBufferRef.current) {
          const k = parseInt(key);
          const entry = obfBufferRef.current[k];
          const age = now - ((entry as any).timestamp || 0);
          if (age > 30000) {
            delete obfBufferRef.current[k];
          }
        }
      }, 5000);
    };

    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
      addLog(`❌ WebSocket error (State: ${ws.readyState}, Buffered: ${ws.bufferedAmount})`);
      // Fallback: if we are stuck in 'checking', set to 'disconnected' to allow manual retry or auto-retry in onclose
      if (connectionState === 'checking') setConnectionState('disconnected');
    };

    const isFallbackMode = !remoteSupportsWebMRef.current || !mySupportsWebMRef.current;
    // Skip MediaSource entirely if we are using custom H.264/PCM mode
    const isMediaSourceSupported = !isFallbackMode && (typeof window.MediaSource !== 'undefined' || typeof (window as any).ManagedMediaSource !== 'undefined');
    let isMediaSourceFailed = isFallbackMode;
    
    if (isFallbackMode) {
      addLog(`ℹ️ MediaSource skipped in Secure Relay (H.264/PCM) mode`);
    } else {
      addLog(`ℹ️ MediaSource support: ${isMediaSourceSupported ? (window.MediaSource ? 'Standard' : 'Managed') : 'None'}`);
    }
    
    if (isMediaSourceSupported) {
      try {
        const MediaSourceClass = window.MediaSource || (window as any).ManagedMediaSource;
        const mediaSource = new MediaSourceClass();
        
        mediaSource.addEventListener('sourceclose', () => addLog('ℹ️ MediaSource closed'));
        mediaSource.addEventListener('sourceended', () => addLog('ℹ️ MediaSource ended'));

        if (remoteVideoRef.current) {
          remoteVideoRef.current.src = URL.createObjectURL(mediaSource);
          remoteVideoRef.current.play()
            .then(() => {
              setAutoplayFailed(false);
              addLog('✅ Remote video playback started');
            })
            .catch(e => {
              console.error('Play failed', e);
              addLog(`⚠️ Remote video play failed: ${e.name}`);
              if (e.name !== 'AbortError') {
                setAutoplayFailed(true);
              }
            });
        }

        mediaSource.addEventListener('sourceopen', () => {
          addLog('ℹ️ MediaSource sourceopen event');
          try {
            const isFallbackMode = !remoteSupportsWebMRef.current || !mySupportsWebMRef.current;
            let mimeType = 'video/webm; codecs="vp8, opus"';
            
            if (isFallbackMode) {
              // If we are in fallback mode, we are likely receiving MP4 from iOS or to iOS
              // Check what the remote supports to guess what they are sending
              if (!mySupportsWebMRef.current) {
                mimeType = 'audio/mp4';
              } else {
                mimeType = 'audio/webm; codecs=opus';
              }
              addLog(`🎙️ Initializing SourceBuffer for audio-only: ${mimeType}`);
            } else {
              if (!MediaSourceClass.isTypeSupported(mimeType)) mimeType = 'video/webm';
              addLog(`🎥 Initializing SourceBuffer for video+audio: ${mimeType}`);
            }

            if (!MediaSourceClass.isTypeSupported(mimeType)) {
              addLog(`⚠️ MimeType ${mimeType} not supported by MediaSource, trying fallback...`);
              if (mimeType.includes('webm')) mimeType = 'audio/webm';
              else mimeType = 'audio/mp4';
            }

            const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBufferRef.current = sourceBuffer;
            addLog(`✅ SourceBuffer created (${mimeType})`);
            
            sourceBuffer.addEventListener('error', (e) => addLog(`❌ SourceBuffer error event: ${e}`));
            sourceBuffer.addEventListener('abort', () => addLog('⚠️ SourceBuffer abort event'));

            sourceBuffer.addEventListener('updateend', () => {
              isAppendingRef.current = false;
              processQueue(); // Task 10: Guaranteed reset and process next
            });

            
            // Process any queued chunks that arrived before sourceopen
            processQueue();
          } catch (e) {
            addLog(`❌ SourceBuffer error: ${e}`);
            isMediaSourceFailed = true;
          }
        });
      } catch (e) {
        console.error('MediaSource initialization failed', e);
        addLog(`❌ MediaSource init failed: ${e}`);
        isMediaSourceFailed = true;
      }
    } else {
      isMediaSourceFailed = true;
    }

    ws.onmessage = async (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        bytesReceivedRef.current += event.data.length;
        try {
          const trimmed = event.data.trim();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
          const msg = JSON.parse(trimmed);
          
          if (msg.type === 'ping') {
            if (msg.sid !== mySidRef.current) {
              ws.send(JSON.stringify({ type: 'pong', ts: msg.ts, sid: msg.sid }));
            } else if (isLoopback) {
              // In loopback mode, we receive our own ping. Treat it as a pong to measure RTT.
              const rtt = Math.max(0, performance.now() - msg.ts);
              rttRef.current = rtt;
              setStats(prev => ({ ...prev, rtt }));
              if (adaptiveEngineRef.current) adaptiveEngineRef.current.updateRTT(rtt);
              if (h264DecoderRef.current) h264DecoderRef.current.updateRTT(rtt);
            }
            return;
          }
          if (msg.type === 'pong') {
            if (msg.sid !== mySidRef.current) return;
            const rtt = Math.max(0, performance.now() - msg.ts);
            rttRef.current = rtt;
            setStats(prev => ({ ...prev, rtt }));
            if (adaptiveEngineRef.current) adaptiveEngineRef.current.updateRTT(rtt);
            if (h264DecoderRef.current) h264DecoderRef.current.updateRTT(rtt);
            return;
          }
          if (msg.type === 'rotation') {
            if (h264DecoderRef.current) {
              h264DecoderRef.current.setRotation(msg.value);
              if (msg.mirror !== undefined) {
                h264DecoderRef.current.setMirror(msg.mirror);
              }
            }
            // Update local state if needed (though these are usually for manual overrides)
            setRemoteRotation(msg.value);
            if (msg.mirror !== undefined) setRemoteMirror(msg.mirror);
            return;
          }
          if (msg.type === 'requestKeyframe') {
            if (adaptiveEngineRef.current) {
              adaptiveEngineRef.current.forceKeyframe();
              addLog('🚀 Remote requested keyframe, forcing now');
            }
            return;
          }
        } catch (e) {
          logger.log(`❌ Error parsing string message: ${e}`);
        }
      } else if (event.data instanceof ArrayBuffer) {
        bytesReceivedRef.current += event.data.byteLength;
        const part = new Uint8Array(event.data);
        
        if (part[0] === 1 || part[0] === 3) {
          try {
            const paddingInfo = removePadding(event.data);
            let audioData: ArrayBuffer | Uint8Array = paddingInfo.data;
            if (part[0] === 3 && sharedSecretRef.current) {
              audioData = await decryptData(sharedSecretRef.current, new Uint8Array(audioData));
            }
            playAudioChunk(audioData, paddingInfo.senderTs);
          } catch (e) {
            logger.log(`❌ Error processing audio ArrayBuffer: ${e}`);
          }
          return;
        }

        if (part[0] === 0xFF) {
          const frameId = part[1] | (part[2] << 8);
          const totalParts = part[9] | (part[10] << 8);
          if (!obfBufferRef.current[frameId]) {
            obfBufferRef.current[frameId] = [];
            (obfBufferRef.current[frameId] as any).timestamp = Date.now();
          }
          obfBufferRef.current[frameId].push(part);

          if (obfBufferRef.current[frameId].length === totalParts) {
            if (frameId % 30 === 0) {
              addLog(`\uD83D\uDCAF Video frame parts: frameId=${frameId}, total=${totalParts}, received=${obfBufferRef.current[frameId].length}`);
            }
            const chunksToProcess = obfBufferRef.current[frameId];
            delete obfBufferRef.current[frameId];
            try {
              let { data: clean, senderTs } = await deobfuscateAssemble(chunksToProcess);
              if (sharedSecretRef.current) {
                try {
                  clean = await decryptData(sharedSecretRef.current, clean);
                } catch (e) { 
                  logger.log(`❌ Error decrypting video ArrayBuffer: ${e}`);
                  return; 
                }
              }
              
              if (!firstJpegReceivedRef.current) {
                addLog(`🔐 First E2EE video frame decrypted successfully`);
                firstJpegReceivedRef.current = true;
              }
              
              if (!h264DecoderRef.current && remoteCanvasRef.current) {
                h264DecoderRef.current = new H264Decoder(remoteCanvasRef.current, addLog, (isPanic) => {
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'requestKeyframe' }));
                    if (isPanic) addLog('📡 PANIC: Sent requestKeyframe to peer');
                    else if (Math.random() < 0.1) addLog('📡 SYNC: Sent requestKeyframe to peer');
                  }
                });
                h264DecoderRef.current.setRotation(remoteRotation);
                h264DecoderRef.current.setMirror(remoteMirror);
              }
              if (h264DecoderRef.current) {
                const currentFps = adaptiveEngineRef.current?.getStats()?.fps || 24;
                // @ts-ignore
                h264DecoderRef.current.pushPacket(clean, frameId, currentFps, senderTs);
              }

              setIsFallbackMode(true);

            } catch (e) {
              logger.log(`❌ Error processing video ArrayBuffer: ${e}`);
            }
          }
        }
      } else if (event.data instanceof Blob) {
        const arrayBuffer = await (event.data as Blob).arrayBuffer();
        bytesReceivedRef.current += arrayBuffer.byteLength;
        const part = new Uint8Array(arrayBuffer);
        
        if (part[0] === 1 || part[0] === 3) {
          try {
            const { data, senderTs } = removePadding(arrayBuffer);
            let audioData: ArrayBuffer | Uint8Array = data;
            if (part[0] === 3 && sharedSecretRef.current) {
              audioData = await decryptData(sharedSecretRef.current, new Uint8Array(audioData));
            }
            playAudioChunk(audioData, senderTs);
          } catch (e) {
            logger.log(`❌ Error processing audio Blob: ${e}`);
          }
          return;
        }
        
        if (part[0] === 0xFF) {
          const frameId = part[1] | (part[2] << 8);
          const totalParts = part[9] | (part[10] << 8);
          if (!obfBufferRef.current[frameId]) {
            obfBufferRef.current[frameId] = [];
            (obfBufferRef.current[frameId] as any).timestamp = Date.now();
          }
          obfBufferRef.current[frameId].push(part);

          if (obfBufferRef.current[frameId].length === totalParts) {
            if (frameId % 30 === 0) {
              addLog(`\uD83D\uDCAF Video frame parts (Blob): frameId=${frameId}, total=${totalParts}, received=${obfBufferRef.current[frameId].length}`);
            }
            const chunksToProcess = obfBufferRef.current[frameId];
            delete obfBufferRef.current[frameId];
            try {
              let { data: clean, senderTs } = await deobfuscateAssemble(chunksToProcess);
              if (sharedSecretRef.current) {
                try {
                  clean = await decryptData(sharedSecretRef.current, clean);
                } catch (e) { 
                  logger.log(`❌ Error decrypting video Blob: ${e}`);
                  return; 
                }
              }
              if (!firstJpegReceivedRef.current) {
                addLog(`🔐 First E2EE video frame decrypted successfully`);
                firstJpegReceivedRef.current = true;
              }
              if (!h264DecoderRef.current && remoteCanvasRef.current) {
                h264DecoderRef.current = new H264Decoder(remoteCanvasRef.current, addLog);
                h264DecoderRef.current.setRotation(remoteRotation);
                h264DecoderRef.current.setMirror(remoteMirror);
              }
              if (h264DecoderRef.current) {
                const currentFps = adaptiveEngineRef.current?.getStats()?.fps || 24;
                // @ts-ignore
                h264DecoderRef.current.pushPacket(clean, frameId, currentFps, senderTs);
              }

              setIsFallbackMode(true);

            } catch (e) {
              logger.log(`❌ Error processing video Blob: ${e}`);
            }
          }
        }
      }
    };

    ws.onclose = (e) => {
      addLog(`🔌 WebSocket closed: ${e.code} ${e.reason}`);
      
      // Retry logic: only if we still have a roomId (not cleaned up) and not a clean close
      if (currentRoomIdRef.current && currentRoomTokenRef.current && retryCount < 3 && e.code !== 1000 && e.code !== 1005) {
        addLog(`🔄 Connection lost, retrying... (${retryCount + 1}/3)`);
        setTimeout(() => {
          if (currentRoomIdRef.current && currentRoomTokenRef.current) {
            connectToRelay(currentRoomIdRef.current, currentRoomTokenRef.current, sharedSecretRef.current, retryCount + 1);
          }
        }, 2000);
      } else {
        // If we exhausted retries or it was a clean close, just clean up
        if (currentRoomIdRef.current && retryCount >= 3) {
          addLog('❌ Connection failed after 3 retries');
        }
        cleanup();
        onCallEnded();
      }
    };
  };

  // Compatibility with Dashboard.tsx
  const initiateCall = (targetSocketId: string) => {
    startRecording();
  };

  const setVideoQuality = useCallback((mode: 'auto' | 'high' | 'medium' | 'low' | 'verylow') => {
    if (!adaptiveEngineRef.current) return;
    if (mode === 'auto') {
      adaptiveEngineRef.current.setManualMode(false);
    } else {
      adaptiveEngineRef.current.setManualMode(true);
      let bitrate = 500_000;
      if (mode === 'high') bitrate = 2_500_000;
      else if (mode === 'medium') bitrate = 1_200_000;
      else if (mode === 'low') bitrate = 600_000;
      else if (mode === 'verylow') bitrate = 200_000;
      adaptiveEngineRef.current.setManualBitrate(bitrate);
    }
  }, []);

  const applyRotation = useCallback((angle: number) => {
    if (h264DecoderRef.current) {
      h264DecoderRef.current.setRotation(angle);
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.style.transform = `rotate(${angle}deg)`;
    }
  }, [remoteVideoRef]);

  const joinRoom = (roomId: string, roomToken: string, supportsWebM?: boolean, sharedSecret: CryptoKey | null = null) => {
    if (supportsWebM !== undefined) {
      mySupportsWebMRef.current = supportsWebM;
    }
    connectToRelay(roomId, roomToken, sharedSecret);
  };

  return {
    initiateCall,
    initAudioContexts,
    cleanup,
    peerConnection: { current: null },
    connectionState,
    setVideoQuality,
    applyRotation,
    stats,
    secureEmojis,
    joinRoom,
    startRecording,
    setRemoteSupportsWebM,
    isFallbackMode,
    remoteCanvasRef,
    metricHistory,
    resumeAudio: async () => {
      addLog('🎙️ resumeAudio called');
      if (isCleanedUpRef.current) {
        addLog('⚠️ resumeAudio skipped: cleaned up');
        return;
      }
      if (!audioContextRef.current) {

        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        addLog('🎙️ AudioContext initialized via manual action');
      }
      const ctx = audioContextRef.current;
      addLog(`🎙️ AudioContext state: ${ctx.state}`);
      if (ctx.state === 'suspended') {
        await ctx.resume();
        addLog('🎙️ AudioContext resumed via manual action');
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.play().catch(() => {});
      }
    },
    forceKeyframe: () => {
      if (adaptiveEngineRef.current) {
        adaptiveEngineRef.current.forceKeyframe();
        addLog('🚀 Manual keyframe forced');
      }
    },
    toggleRemoteRotation,
    toggleRemoteMirror,
    toggleRemoteFlipV,
    resetRemoteOrientation,
    remoteRotation,
    remoteMirror,
    remoteFlipV
  };
}
