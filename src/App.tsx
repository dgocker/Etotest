import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useSecureRelayCall } from './hooks/useSecureRelayCall';
import { Video, VideoOff, Mic, MicOff, PhoneOff, Settings, Info, LogOut, ShieldCheck, Download, RefreshCw, RotateCw, FlipHorizontal } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { logger } from './utils/logger';
import { generateECDHKeyPair, exportPublicKey, importPublicKey, deriveAESKey } from './utils/cryptoUtils';

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomId, setRoomId] = useState<string>('');
  const [isInCall, setIsInCall] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [autoplayFailed, setAutoplayFailed] = useState(false);
  const [isLoopback, setIsLoopback] = useState(false);
  
  const [isLocalMirrored, setIsLocalMirrored] = useState(true);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const myKeyPairRef = useRef<CryptoKeyPair | null>(null);
  const sentKeysRef = useRef<Set<string>>(new Set());

  const socketIdRef = useRef<string>('browser');

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 50));
    logger.log(`[App] ${msg}`);
    
    // Send to server for persistent logging
    fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        logs: [msg], 
        deviceId: socketIdRef.current 
      })
    }).catch(() => {
      // Silent fail for log sending to avoid infinite loops or noise
    });
  }, []);

  useEffect(() => {
    const newSocket = io(window.location.origin);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      socketIdRef.current = newSocket.id || 'browser';
      addLog('Connected to signaling server');
    });

    return () => {
      newSocket.disconnect();
    };
  }, [addLog]);

  const onCallEnded = useCallback(() => {
    setIsInCall(false);
    setRemoteStream(null);
    addLog('Call ended');
  }, [addLog]);

  const { 
    connectionState, 
    stats, 
    isFallbackMode, 
    remoteCanvasRef, 
    joinRoom, 
    cleanup,
    toggleRemoteRotation,
    toggleRemoteMirror,
    toggleRemoteFlipV,
    resetRemoteOrientation,
    forceKeyframe,
    remoteRotation,
    remoteMirror,
    remoteFlipV
  } = useSecureRelayCall(
    socket,
    activeStreamRef,
    setRemoteStream,
    onCallEnded,
    remoteVideoRef,
    setAutoplayFailed,
    addLog,
    isAudioMuted,
    isLoopback
  );

  useEffect(() => {
    if (!socket) return;

    const handleUserJoined = async (peerId: string) => {
      addLog(`Peer joined: ${peerId}. Sending public key...`);
      try {
        if (!myKeyPairRef.current) {
          myKeyPairRef.current = await generateECDHKeyPair();
        }
        const exportedKey = await exportPublicKey(myKeyPairRef.current.publicKey);
        socket.emit('signal', { roomId, signal: { type: 'public-key', key: exportedKey }, to: peerId });
        sentKeysRef.current.add(peerId);
      } catch (e) {
        addLog(`Error sending public key: ${e}`);
      }
    };

    const handleSignal = async (data: { from: string, signal: any }) => {
      if (data.signal.type === 'public-key') {
        addLog(`Received public key from ${data.from}. Deriving shared secret...`);
        try {
          if (!myKeyPairRef.current) {
            myKeyPairRef.current = await generateECDHKeyPair();
          }
          if (!sentKeysRef.current.has(data.from)) {
            // Send our key back if we haven't already
            const exportedKey = await exportPublicKey(myKeyPairRef.current.publicKey);
            socket.emit('signal', { roomId, signal: { type: 'public-key', key: exportedKey }, to: data.from });
            sentKeysRef.current.add(data.from);
          }
          const importedKey = await importPublicKey(data.signal.key);
          const sharedSecret = await deriveAESKey(myKeyPairRef.current.privateKey, importedKey);
          addLog('Shared secret derived successfully. Joining secure room...');
          joinRoom(roomId, roomId, false, sharedSecret);
        } catch (e) {
          addLog(`Error deriving shared secret: ${e}`);
        }
      }
    };

    socket.on('user-joined', handleUserJoined);
    socket.on('signal', handleSignal);

    return () => {
      socket.off('user-joined', handleUserJoined);
      socket.off('signal', handleSignal);
    };
  }, [socket, roomId, joinRoom, addLog]);

  const startCall = async () => {
    if (!roomId) {
      alert('Please enter a room ID');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      activeStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.play().catch(e => console.error('Local video play error', e));
      }
      setIsInCall(true);
      socket?.emit('join-room', roomId);
      addLog(`Joining room: ${roomId}`);

      if (isLoopback) {
        addLog('Loopback mode: Generating self-signed keys...');
        const keyPair = await generateECDHKeyPair();
        const exportedKey = await exportPublicKey(keyPair.publicKey);
        const importedKey = await importPublicKey(exportedKey);
        const sharedSecret = await deriveAESKey(keyPair.privateKey, importedKey);
        addLog('Loopback mode: Shared secret derived. Joining secure room...');
        joinRoom(roomId, roomId, false, sharedSecret);
      } else {
        addLog('Waiting for peer to join to exchange keys...');
        myKeyPairRef.current = await generateECDHKeyPair();
      }
    } catch (err) {
      addLog(`Error accessing media: ${err}`);
      alert('Could not access camera/microphone');
    }
  };

  const endCall = () => {
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(track => track.stop());
      activeStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    myKeyPairRef.current = null;
    sentKeysRef.current.clear();
    cleanup();
    onCallEnded();
  };

  const toggleAudio = () => {
    if (activeStreamRef.current) {
      const audioTrack = activeStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (activeStreamRef.current) {
      const videoTrack = activeStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoMuted(!videoTrack.enabled);
      }
    }
  };

  const handleDownloadLogs = async () => {
    await logger.flush();
    logger.downloadLogs();
  };

  const handleClearLogs = async () => {
    try {
      await fetch('/api/logs/clear', { method: 'POST' });
      setLogs([]);
      addLog('Logs cleared on server');
    } catch (e) {
      addLog('Failed to clear logs');
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <ShieldCheck className="text-zinc-950 w-6 h-6" />
            </div>
            <div>
              <h1 className="font-semibold tracking-tight">Secure Relay</h1>
              <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-mono">End-to-End Encrypted</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleDownloadLogs} className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300" title="Download Logs">
              <Download className="w-4 h-4" />
            </button>
            <button onClick={handleClearLogs} className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300" title="Clear Logs">
              <RefreshCw className="w-4 h-4" />
            </button>
            <div className={`px-3 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider flex items-center gap-1.5 ${
              connectionState === 'connected' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
              connectionState === 'checking' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
              'bg-zinc-800 text-zinc-500 border border-white/5'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                connectionState === 'connected' ? 'bg-emerald-400 animate-pulse' :
                connectionState === 'checking' ? 'bg-amber-400 animate-pulse' :
                'bg-zinc-600'
              }`} />
              {connectionState}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 lg:p-8">
        {!isInCall ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-md mx-auto mt-20"
          >
            <div className="bg-zinc-900 border border-white/5 rounded-3xl p-8 shadow-2xl">
              <h2 className="text-2xl font-light mb-6">Start a Secure Call</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-2 font-mono">Room ID</label>
                  <input
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="Enter unique room name..."
                    className="w-full bg-zinc-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500/50 transition-colors font-mono text-sm"
                  />
                </div>
                
                <div className="flex items-center gap-3 py-2">
                  <input 
                    type="checkbox" 
                    id="loopback" 
                    checked={isLoopback} 
                    onChange={(e) => setIsLoopback(e.target.checked)}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <label htmlFor="loopback" className="text-sm text-zinc-300">Test Mode (Loopback to Self)</label>
                </div>

                <button
                  onClick={startCall}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 active:scale-[0.98]"
                >
                  Enter Secure Room
                </button>
              </div>
              <div className="mt-8 pt-8 border-t border-white/5 space-y-4">
                <div className="flex gap-3 items-start">
                  <div className="p-2 bg-zinc-800 rounded-lg">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-xs font-medium">E2E Encryption</p>
                    <p className="text-[10px] text-zinc-500">AES-GCM 256-bit encryption handled in Web Workers.</p>
                  </div>
                </div>
                <div className="flex gap-3 items-start">
                  <div className="p-2 bg-zinc-800 rounded-lg">
                    <Video className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-xs font-medium">Adaptive H.264</p>
                    <p className="text-[10px] text-zinc-500">Low-latency video with GCC-inspired congestion control.</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-12rem)]">
            {/* Video Area */}
            <div className="lg:col-span-2 space-y-6 flex flex-col">
              <div className="flex-1 relative bg-zinc-900 rounded-3xl overflow-hidden border border-white/5 shadow-2xl group">
                {/* Remote Video */}
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className={`w-full h-full object-cover ${isFallbackMode ? 'hidden' : ''}`}
                />
                <canvas
                  ref={remoteCanvasRef}
                  className={`w-full h-full object-cover ${!isFallbackMode ? 'hidden' : ''}`}
                />
                {!remoteStream && !isLoopback && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/80 backdrop-blur-sm">
                    <div className="w-16 h-16 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mb-4" />
                    <p className="text-sm font-light text-zinc-400">Waiting for peer...</p>
                  </div>
                )}

                {/* Local Video Overlay */}
                <div className="absolute bottom-6 right-6 w-48 aspect-video bg-zinc-800 rounded-2xl overflow-hidden border-2 border-white/10 shadow-2xl z-10 group/local">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover ${isLocalMirrored ? 'scale-x-[-1]' : ''}`}
                  />
                  <div className="absolute bottom-2 left-2 px-2 py-0.5 bg-black/50 backdrop-blur-md rounded-md text-[8px] uppercase tracking-widest font-mono">You</div>
                  <button 
                    onClick={() => setIsLocalMirrored(!isLocalMirrored)}
                    className="absolute top-2 right-2 p-1.5 bg-black/50 backdrop-blur-md rounded-lg text-white opacity-0 group-hover/local:opacity-100 transition-opacity"
                    title="Mirror Local Video"
                  >
                    <FlipHorizontal className="w-3 h-3" />
                  </button>
                </div>

                {/* Controls Overlay */}
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 px-6 py-4 bg-zinc-950/80 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <button 
                    onClick={toggleAudio}
                    className={`p-3 rounded-xl transition-colors ${isAudioMuted ? 'bg-red-500/20 text-red-400' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'}`}
                  >
                    {isAudioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                  </button>
                  <button 
                    onClick={toggleVideo}
                    className={`p-3 rounded-xl transition-colors ${isVideoMuted ? 'bg-red-500/20 text-red-400' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'}`}
                  >
                    {isVideoMuted ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                  </button>
                  <button 
                    onClick={forceKeyframe}
                    className="p-3 rounded-xl bg-zinc-800 text-amber-400 hover:bg-zinc-700 transition-colors"
                    title="Force Keyframe (Manual Recovery)"
                  >
                    <RefreshCw className="w-5 h-5" />
                  </button>
                  <div className="w-px h-8 bg-white/10 mx-2" />
                  <button 
                    onClick={endCall}
                    className="p-3 bg-red-500 hover:bg-red-400 text-white rounded-xl transition-all shadow-lg shadow-red-500/20 active:scale-95"
                  >
                    <PhoneOff className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Stats Bar */}
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Bitrate', value: `${(stats.bitrate / 1000).toFixed(0)}kbps` },
                  { label: 'RTT', value: `${stats.rtt.toFixed(0)}ms` },
                  { label: 'Loss', value: `${(stats.packetLoss * 100).toFixed(1)}%` },
                  { label: 'FPS', value: stats.fps.toFixed(0) }
                ].map((stat, i) => (
                  <div key={i} className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4">
                    <p className="text-[8px] uppercase tracking-widest text-zinc-500 mb-1 font-mono">{stat.label}</p>
                    <p className="text-sm font-medium font-mono">{stat.value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Sidebar / Logs */}
            <div className="flex flex-col gap-6">
              <div className="flex-1 bg-zinc-900 border border-white/5 rounded-3xl flex flex-col overflow-hidden shadow-2xl">
                <div className="p-4 border-b border-white/5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-medium">System Logs</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => window.open('/api/logs/download?type=client', '_blank')}
                      className="text-[10px] text-emerald-500/60 hover:text-emerald-400 transition-colors flex items-center gap-1"
                      title="Download Client Logs"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download</span>
                    </button>
                    <button 
                      onClick={async () => {
                        try {
                          await fetch('/api/logs/clear', { method: 'POST' });
                          setLogs([]);
                          addLog('Server and client logs cleared');
                        } catch (err) {
                          addLog('Failed to clear server logs');
                        }
                      }}
                      className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors"
                      title="Clear Server & Client Logs"
                    >
                      Clear All
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-[10px]">
                  {logs.map((log, i) => (
                    <div key={i} className="flex gap-2 text-zinc-400 border-l border-white/5 pl-2">
                      <span className="text-zinc-600 shrink-0">[{new Date().toLocaleTimeString([], { hour12: false })}]</span>
                      <span className="break-all">{log}</span>
                    </div>
                  ))}
                  {logs.length === 0 && (
                    <div className="h-full flex items-center justify-center text-zinc-600 italic">
                      No logs yet...
                    </div>
                  )}
                </div>
              </div>
              
              <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-3xl p-6">
                <div className="flex items-center gap-3 mb-4">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                  <p className="text-xs font-medium text-emerald-400">Security Verified</p>
                </div>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Your media is encrypted before leaving your device. Keys are exchanged via ECDH and never touch the relay server.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      {autoplayFailed && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-zinc-900 border border-white/10 rounded-3xl p-8 max-w-sm text-center shadow-2xl">
            <div className="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <Video className="w-8 h-8 text-amber-500" />
            </div>
            <h3 className="text-xl font-light mb-4">Autoplay Blocked</h3>
            <p className="text-sm text-zinc-400 mb-8">Browser blocked video playback. Click below to enable media.</p>
            <button
              onClick={() => {
                if (remoteVideoRef.current) remoteVideoRef.current.play();
                setAutoplayFailed(false);
              }}
              className="w-full bg-zinc-100 hover:bg-white text-zinc-950 font-semibold py-4 rounded-xl transition-all"
            >
              Enable Video
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
