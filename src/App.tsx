import React, { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { 
  Radio, 
  Mic, 
  MicOff, 
  Users, 
  Settings, 
  Signal, 
  Volume2, 
  VolumeX,
  Wifi,
  WifiOff,
  ChevronRight,
  ChevronLeft,
  Activity
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// --- Types ---
interface NodeInfo {
  id: string;
  socketId: string;
  name: string;
  channel: string;
}

export default function App() {
  // --- State ---
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [myId] = useState(() => Math.random().toString(36).substring(7));
  const [myName, setMyName] = useState(() => `User_${myId}`);
  const [currentChannel, setCurrentChannel] = useState("446.100");
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [incomingCall, setIncomingCall] = useState<{ from: string; name: string } | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [micErrorType, setMicErrorType] = useState<string | null>(null);
  const [isNameEditing, setIsNameEditing] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [channelStatus, setChannelStatus] = useState<Map<string, { busy: boolean; activeUsers: Array<{ id: string; name: string }> }>>(new Map());
  const [customChannelInput, setCustomChannelInput] = useState("446.100");
  
  // --- Refs ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const playbackSourceRef = useRef<BufferSource | null>(null);
  const isPlayingRef = useRef(false);
  
  // WebRTC Refs
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // 关闭所有 WebRTC 连接
  const closeAllPeerConnections = () => {
    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();
    audioElementsRef.current.forEach(ae => ae.srcObject = null);
    audioElementsRef.current.clear();
    remoteStreamsRef.current.clear();
  };

  // 播放繁忙提示音（DTMF 类似音）
  const playBusyTone = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    const ctx = audioContextRef.current;
    const now = ctx.currentTime;
    const duration = 0.5; // 0.5 秒
    
    // 创建两个频率的震荡器模拟繁忙音（440Hz + 480Hz）
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc1.frequency.value = 440;
    osc2.frequency.value = 480;
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration);
    osc2.stop(now + duration);
  };

  // --- Initialization ---
  useEffect(() => {
    const newSocket = io();
    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on("connect", () => {
      setConnected(true);
      newSocket.emit("node:online", { id: myId, name: myName, channel: currentChannel });
      newSocket.emit("join-room", currentChannel);
    });

    newSocket.on("disconnect", () => setConnected(false));

    newSocket.on("discovery:update", (updatedNodes: NodeInfo[]) => {
      setNodes(updatedNodes.filter(n => n.id !== myId));
    });

    newSocket.on("ptt:incoming", (data) => {
      setIncomingCall(data);
    });

    newSocket.on("ptt:ended", () => {
      setIncomingCall(null);
    });

    // 频道状态更新
    newSocket.on("channel:status-update", (data: { channel: string; busy: boolean; activeUsers: Array<{ id: string; name: string }> }) => {
      setChannelStatus(prev => {
        const newStatus = new Map(prev);
        newStatus.set(data.channel, { busy: data.busy, activeUsers: data.activeUsers });
        return newStatus;
      });
    });

    // 接收音频数据
    newSocket.on("ptt:audio", (audioData: { samples: number[] }) => {
      const float32Array = new Float32Array(audioData.samples);
      audioQueueRef.current.push(float32Array);
    });

    // WebRTC 信令处理
    newSocket.on("webrtc:offer", async (data: { from: string; offer: RTCSessionDescriptionInit }) => {
      const config = {
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          { urls: ['stun:stun1.l.google.com:19302'] }
        ]
      };
      
      let pc = peerConnectionsRef.current.get(data.from);
      if (!pc) {
        pc = new RTCPeerConnection(config);
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => {
            pc!.addTrack(track, mediaStreamRef.current!);
          });
        }
        pc.ontrack = (event) => {
          console.log("Received remote stream from", data.from);
          const remoteStream = event.streams[0];
          let audioElement = audioElementsRef.current.get(data.from);
          if (!audioElement) {
            audioElement = new Audio();
            audioElement.autoplay = true;
            audioElementsRef.current.set(data.from, audioElement);
          }
          audioElement.srcObject = remoteStream;
          remoteStreamsRef.current.set(data.from, remoteStream);
        };
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            newSocket.emit("webrtc:ice-candidate", {
              to: data.from,
              candidate: event.candidate
            });
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc!.connectionState === 'failed' || pc!.connectionState === 'disconnected') {
            pc!.close();
            peerConnectionsRef.current.delete(data.from);
            const ae = audioElementsRef.current.get(data.from);
            if (ae) ae.srcObject = null;
            audioElementsRef.current.delete(data.from);
            remoteStreamsRef.current.delete(data.from);
          }
        };
        peerConnectionsRef.current.set(data.from, pc);
      }
      
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        newSocket.emit("webrtc:answer", { to: data.from, answer });
      } catch (e) {
        console.error("Error handling offer:", e);
      }
    });

    newSocket.on("webrtc:answer", async (data: { from: string; answer: RTCSessionDescriptionInit }) => {
      const pc = peerConnectionsRef.current.get(data.from);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (e) {
          console.error("Error handling answer:", e);
        }
      }
    });

    newSocket.on("webrtc:ice-candidate", (data: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peerConnectionsRef.current.get(data.from);
      if (pc) {
        try {
          pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error("Error adding ICE candidate:", e);
        }
      }
    });

    return () => {
      closeAllPeerConnections();
      newSocket.disconnect();
    };
  }, [myId, currentChannel, myName]);

  useEffect(() => {
    if (!socket) return;
    socket.emit("node:update-profile", { id: myId, name: myName });
  }, [socket, myId, myName]);

  // --- Channel Management ---
  const changeChannel = (channel: string) => {
    const sanitized = channel.trim();
    if (!sanitized) return;
    setCurrentChannel(sanitized);
    socket?.emit("node:change-channel", sanitized);
    socket?.emit("join-room", sanitized);
    
    // 检查目标频道是否繁忙，如果繁忙则播放提示音
    const targetChannelStatus = channelStatus.get(sanitized);
    if (targetChannelStatus?.busy && !isPTTActive) {
      playBusyTone();
    }
    
    // 切换频道时关闭旧的 WebRTC 连接
    if (isPTTActive) {
      closeAllPeerConnections();
      
      // 延迟后为新频道的节点重新建立连接
      setTimeout(() => {
        nodes.forEach(node => {
          if (node.channel === sanitized && node.id !== myId) {
            const remoteSocketId = node.socketId;
            if (!peerConnectionsRef.current.has(remoteSocketId)) {
              const config = {
                iceServers: [
                  { urls: ['stun:stun.l.google.com:19302'] },
                  { urls: ['stun:stun1.l.google.com:19302'] }
                ]
              };
              const pc = new RTCPeerConnection(config);
              
              if (mediaStreamRef.current) {
                mediaStreamRef.current.getTracks().forEach(track => {
                  pc.addTrack(track, mediaStreamRef.current!);
                });
              }
              
              pc.ontrack = (event) => {
                console.log("Received remote stream from", remoteSocketId);
                const remoteStream = event.streams[0];
                let audioElement = audioElementsRef.current.get(remoteSocketId);
                if (!audioElement) {
                  audioElement = new Audio();
                  audioElement.autoplay = true;
                  audioElementsRef.current.set(remoteSocketId, audioElement);
                }
                audioElement.srcObject = remoteStream;
                remoteStreamsRef.current.set(remoteSocketId, remoteStream);
              };
              
              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  socket?.emit("webrtc:ice-candidate", {
                    to: remoteSocketId,
                    candidate: event.candidate
                  });
                }
              };
              
              pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                  pc.close();
                  peerConnectionsRef.current.delete(remoteSocketId);
                  const ae = audioElementsRef.current.get(remoteSocketId);
                  if (ae) ae.srcObject = null;
                  audioElementsRef.current.delete(remoteSocketId);
                  remoteStreamsRef.current.delete(remoteSocketId);
                }
              };
              
              peerConnectionsRef.current.set(remoteSocketId, pc);
              
              pc.createOffer().then(offer => {
                pc.setLocalDescription(offer);
                  socket?.emit("webrtc:offer", { to: remoteSocketId, offer });
              }).catch(e => console.error("Error creating offer:", e));
            }
          }
        });
      }, 100);
    }
  };

  const normalizeFrequency = (value: string) => {
    const numeric = parseFloat(value);
    if (Number.isNaN(numeric) || !Number.isFinite(numeric)) {
      return value.trim();
    }
    return numeric.toFixed(3);
  };

  const handleApplyFrequency = () => {
    if (!customChannelInput.trim()) return;
    const normalized = normalizeFrequency(customChannelInput);
    setCustomChannelInput(normalized);
    changeChannel(normalized);
  };

  const adjustFrequency = (delta: number) => {
    const base = parseFloat(customChannelInput || currentChannel);
    if (Number.isNaN(base)) return;
    const next = Math.max(0.001, base + delta);
    const formatted = next.toFixed(3);
    setCustomChannelInput(formatted);
    changeChannel(formatted);
  };

  // --- Audio Logic ---
  const getMicErrorMessage = (err: any): { message: string; type: string; instructions: string[] } => {
    console.error("Microphone error details:", err.name, err.message);
    
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      return {
        message: "❌ 麦克风权限被拒绝",
        type: "permission-denied",
        instructions: [
          "1. 检查浏览器地址栏，查找权限提示",
          "2. 点击麦克风图标，选择\"允许\"",
          "3. 刷新页面重试",
          "查看浏览器设置 > 隐私与安全 > 网站权限 > 麦克风"
        ]
      };
    }
    
    if (err.name === "NotFoundError") {
      return {
        message: "❌ 未找到麦克风设备",
        type: "device-not-found",
        instructions: [
          "1. 检查麦克风是否连接",
          "2. 确认麦克风驱动是否正确安装",
          "3. 重启浏览器或计算机后重试",
          "4. 尝试其他浏览器"
        ]
      };
    }
    
    if (err.name === "SecurityError") {
      return {
        message: "❌ 安全错误 - 网站被禁止访问麦克风",
        type: "security-error",
        instructions: [
          "1. 确确保使用 HTTPS 连接（http://localhost 除外）",
          "2. 检查浏览器安全设置",
          "3. 清除浏览器缓存后重试"
        ]
      };
    }

    if (err.name === "TypeError" || err.message?.includes("getUserMedia")) {
      return {
        message: "❌ 麦克风 API 不可用",
        type: "api-not-available",
        instructions: [
          "1. 确保浏览器支持 Web Audio API",
          "2. 检查浏览器版本是否过旧",
          "3. 尝试 Chrome、Firefox 或 Safari 最新版"
        ]
      };
    }

    return {
      message: "❌ 无法访问麦克风",
      type: "unknown-error",
      instructions: [
        "1. 检查浏览器权限设置",
        "2. 检查麦克风设备是否连接",
        `3. 错误详情: ${err.message}`
      ]
    };
  };

  const startPTT = async () => {
    if (isPTTActive) return;
    
    // 检查当前频道是否繁忙
    if (channelStatus.get(currentChannel)?.busy) {
      playBusyTone();
      return;
    }
    
    try {
      setMicError(null);
      setMicErrorType(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      // Initialize Audio Context for visualization and audio processing
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      
      const audioCtx = audioContextRef.current;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyzer = audioCtx.createAnalyser();
      
      // Create ScriptProcessor for real-time audio data
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      let audioBuffer: Float32Array[] = [];
      
      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        // 每4096个样本作为一个音频包
        const samples = Array.from(inputData as ArrayLike<number>);
        audioBuffer.push(new Float32Array(samples));
        
        // 每收集几个包就发送一次（用于备用方案）
        if (audioBuffer.length >= 2) {
          const combinedSamples = new Float32Array(audioBuffer.reduce((acc, arr) => acc + arr.length, 0));
          let offset = 0;
          for (const buf of audioBuffer) {
            combinedSamples.set(buf, offset);
            offset += buf.length;
          }
          
          // 通过 Socket.io 发送音频数据（备用方案）
          socket?.emit("ptt:audio", { 
            channel: currentChannel,
            samples: Array.from(
              combinedSamples.slice(0, Math.min(4096, combinedSamples.length)) as ArrayLike<number>
            )
          });
          audioBuffer = [];
        }
      };
      
      source.connect(analyzer);
      source.connect(processor);
      if (silentGainRef.current) {
        silentGainRef.current.disconnect();
        silentGainRef.current = null;
      }
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);
      silentGainRef.current = silentGain;
      
      processorRef.current = processor;
      
      setIsPTTActive(true);
      audioQueueRef.current = [];
      socket?.emit("ptt:start", { from: myId, name: myName, channel: currentChannel });

      // 为同频道的每个节点建立 WebRTC 连接
      nodes.forEach(node => {
        if (node.channel === currentChannel && node.id !== myId) {
          const remoteSocketId = node.socketId;
          if (!peerConnectionsRef.current.has(remoteSocketId)) {
            const config = {
              iceServers: [
                { urls: ['stun:stun.l.google.com:19302'] },
                { urls: ['stun:stun1.l.google.com:19302'] }
              ]
            };
            const pc = new RTCPeerConnection(config);
            
            if (mediaStreamRef.current) {
              mediaStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, mediaStreamRef.current!);
              });
            }
            
            pc.ontrack = (event) => {
              console.log("Received remote stream from", remoteSocketId);
              const remoteStream = event.streams[0];
              let audioElement = audioElementsRef.current.get(remoteSocketId);
              if (!audioElement) {
                audioElement = new Audio();
                audioElement.autoplay = true;
                audioElementsRef.current.set(remoteSocketId, audioElement);
              }
              audioElement.srcObject = remoteStream;
              remoteStreamsRef.current.set(remoteSocketId, remoteStream);
            };
            
            pc.onicecandidate = (event) => {
              if (event.candidate) {
                socket?.emit("webrtc:ice-candidate", {
                  to: remoteSocketId,
                  candidate: event.candidate
                });
              }
            };
            
            pc.onconnectionstatechange = () => {
              if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                pc.close();
                peerConnectionsRef.current.delete(remoteSocketId);
                const ae = audioElementsRef.current.get(remoteSocketId);
                if (ae) ae.srcObject = null;
                audioElementsRef.current.delete(remoteSocketId);
                remoteStreamsRef.current.delete(remoteSocketId);
              }
            };
            
            peerConnectionsRef.current.set(remoteSocketId, pc);
            
            // 发起 offer
            pc.createOffer().then(offer => {
              pc.setLocalDescription(offer);
              socket?.emit("webrtc:offer", { to: remoteSocketId, offer });
            }).catch(e => console.error("Error creating offer:", e));
          }
        }
      });

      // Simple level detection for visualization
      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      const updateLevel = () => {
        if (!mediaStreamRef.current) return;
        analyzer.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / bufferLength;
        setAudioLevel(average);
        requestAnimationFrame(updateLevel);
      };
      updateLevel();

    } catch (err) {
      console.error("Failed to access microphone:", err);
      const errorInfo = getMicErrorMessage(err as any);
      setMicError(errorInfo.message);
      setMicErrorType(errorInfo.type);
    }
  };

  const stopPTT = () => {
    if (!isPTTActive) return;
    
    setIsPTTActive(false);
    setAudioLevel(0);
    socket?.emit("ptt:stop");
    
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (silentGainRef.current) {
      silentGainRef.current.disconnect();
      silentGainRef.current = null;
    }
    
    // 关闭所有 WebRTC 连接
    closeAllPeerConnections();
  };

  // Play received audio data
  const playAudioBuffer = useCallback(() => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    
    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;
    
    isPlayingRef.current = true;
    const audioData = audioQueueRef.current.shift();
    
    if (audioData) {
      try {
        const audioBuffer = audioCtx.createBuffer(1, audioData.length, audioCtx.sampleRate);
        audioBuffer.getChannelData(0).set(audioData);
        
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
        
        source.onended = () => {
          isPlayingRef.current = false;
          playAudioBuffer();
        };
      } catch (e) {
        console.error("Error playing audio:", e);
        isPlayingRef.current = false;
        playAudioBuffer();
      }
    } else {
      isPlayingRef.current = false;
    }
  }, []);

  // --- Keyboard Listeners ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isPTTActive) {
        e.preventDefault();
        startPTT();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        stopPTT();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isPTTActive, socket]);

  // Auto-play received audio
  useEffect(() => {
    const playInterval = setInterval(() => {
      playAudioBuffer();
    }, 100);
    
    return () => clearInterval(playInterval);
  }, [playAudioBuffer]);

  // --- UI Components ---
  const displayFrequency = normalizeFrequency(currentChannel) || currentChannel;

  return (
    <div className="min-h-screen bg-[#1a1a1a] text-white font-mono flex flex-col items-center justify-center p-2 sm:p-4">
      {/* Device Frame */}
      <div className="w-full max-w-md bg-[#2a2a2a] rounded-[2rem] sm:rounded-[3rem] border-4 sm:border-8 border-[#333] shadow-2xl flex flex-col relative overflow-y-auto sm:overflow-hidden min-h-[540px] sm:min-h-0 aspect-auto sm:aspect-[9/16]">
        
        {/* Top Status Bar */}
        <div className="h-12 bg-[#222] flex items-center justify-between px-4 sm:px-8 border-b border-[#333]">
          <div className="flex items-center gap-2">
            {connected ? <Wifi className="w-4 h-4 text-green-500" /> : <WifiOff className="w-4 h-4 text-red-500" />}
            <span className="text-[10px] uppercase tracking-widest opacity-50">
              {connected ? "在线" : "离线"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Signal className="w-4 h-4 text-blue-400" />
            <span className="text-[10px] uppercase tracking-widest opacity-50">CH-{currentChannel}</span>
          </div>
        </div>

        {/* Main Display Screen */}
        <div className="flex-1 p-4 sm:p-6 flex flex-col gap-4">
          <div className="bg-[#0f140f] rounded-2xl border-2 border-[#1a2a1a] p-3 sm:p-4 flex flex-col gap-4 shadow-inner min-h-[180px] sm:min-h-[200px]">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-[#4ade80] text-xs uppercase tracking-tighter opacity-70">当前频率</h2>
                <div className="text-[#4ade80] text-4xl font-bold tracking-widest">
                  {displayFrequency} MHz
                </div>
              </div>
              <div className="bg-[#4ade80] text-[#0f140f] px-2 py-1 rounded text-[10px] font-bold">
                宽带调频
              </div>
            </div>

            {/* Visualizer / Status */}
            <div className="flex-1 flex items-center justify-center relative">
              <AnimatePresence mode="wait">
                {isPTTActive ? (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="flex flex-col items-center gap-2"
                  >
                    <div className="flex gap-1 items-end h-12">
                      {[...Array(12)].map((_, i) => (
                        <motion.div
                          key={i}
                          animate={{ height: Math.max(4, (audioLevel / 100) * 48 * Math.random()) }}
                          className="w-1 bg-[#4ade80] rounded-full"
                        />
                      ))}
                    </div>
                    <span className="text-[#4ade80] text-[10px] font-bold animate-pulse">正在发送...</span>
                  </motion.div>
                ) : incomingCall ? (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="flex flex-col items-center gap-2"
                  >
                    <Activity className="w-8 h-8 text-blue-400 animate-bounce" />
                    <span className="text-blue-400 text-[10px] font-bold">接收来自: {incomingCall.name}</span>
                  </motion.div>
                ) : (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-[#4ade80] text-[10px] opacity-30 text-center"
                  >
                    待命模式<br/>按空格键对讲
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* User List / Discovery */}
          <div className="flex-1 overflow-hidden flex flex-col gap-2">
            <div className="flex items-center justify-between px-2">
              <span className="text-[10px] uppercase tracking-widest opacity-50 flex items-center gap-1">
                <Users className="w-3 h-3" /> 在线节点 ({nodes.length})
              </span>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 flex flex-col gap-1">
              {nodes.map(node => (
                <div 
                  key={node.socketId} 
                  className={`p-2 rounded-lg border flex items-center justify-between transition-colors ${
                    node.channel === currentChannel ? "bg-[#333] border-[#444]" : "bg-transparent border-transparent opacity-40"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${node.channel === currentChannel ? "bg-green-500" : "bg-gray-500"}`} />
                    <span className="text-xs">{node.name}</span>
                  </div>
                  <span className="text-[8px] opacity-50">CH-{node.channel}</span>
                </div>
              ))}
              {nodes.length === 0 && (
                <div className="text-[10px] opacity-20 text-center py-4 italic">暂无其他节点</div>
              )}
            </div>
          </div>
        </div>

        {/* Controls Section */}
        <div className="bg-[#222] p-4 sm:p-8 flex flex-col gap-6 sm:gap-8 border-t border-[#333]">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest opacity-50">
              <span className="flex items-center gap-1"><Settings className="w-3 h-3" /> 身份标识</span>
              <button
                className="text-blue-400 hover:text-blue-300"
                onClick={() => {
                  setIsNameEditing((prev) => {
                    if (!prev) {
                      setPendingName(myName);
                    }
                    return !prev;
                  });
                }}
              >
                {isNameEditing ? "取消" : "编辑"}
              </button>
            </div>
            {isNameEditing ? (
              <div className="flex gap-2 flex-col sm:flex-row">
                <input
                  value={pendingName}
                  onChange={(e) => setPendingName(e.target.value)}
                  className="flex-1 bg-[#111] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  maxLength={24}
                />
                <button
                  className="px-4 py-2 bg-blue-600 rounded text-sm"
                  onClick={() => {
                    if (!pendingName.trim()) return;
                    setMyName(pendingName.trim());
                    setIsNameEditing(false);
                  }}
                >
                  保存
                </button>
              </div>
            ) : (
              <div className="bg-[#111] border border-[#333] rounded px-3 py-2 text-sm flex items-center justify-between">
                <span>{myName}</span>
                <span className="text-[10px] opacity-40">节点ID: {myId}</span>
              </div>
            )}
            {micError && (
              <div className="bg-red-900/20 border border-red-600 rounded-lg p-3 space-y-2">
                <div className="text-[11px] text-red-400 font-bold">
                  {micError}
                </div>
                {micErrorType && (
                  <div>
                    {/* Error-specific instructions will be shown based on error type */}
                    {micErrorType === "permission-denied" && (
                      <div className="text-[9px] text-red-300/80 leading-relaxed space-y-1">
                        <p>✓ 权限被拒绝，需要手动授予麦克风访问权限：</p>
                        <p className="ml-3">• 点击地址栏左侧的麦克风🎤或摄像机图标</p>
                        <p className="ml-3">• 选择&quot;允许访问麦克风&quot;</p>
                        <p className="ml-3">• 点击下方&quot;重试&quot;按钮</p>
                        <p className="text-red-400 text-[8px] mt-2">📌 如果看不到权限提示图标，请检查浏览器设置：</p>
                        <p className="ml-3 text-[8px]">Chrome: 设置 &gt; 隐私和安全 &gt; 网站权限 &gt; 麦克风</p>
                        <p className="ml-3 text-[8px]">Firefox: 首选项 &gt; 隐私 &gt; 权限</p>
                      </div>
                    )}
                    {micErrorType === "device-not-found" && (
                      <div className="text-[9px] text-red-300/80 leading-relaxed space-y-1">
                        <p>✗ 系统未检测到麦克风设备：</p>
                        <p className="ml-3">• 检查麦克风是否正确连接</p>
                        <p className="ml-3">• 检查驱动程序是否安装（控制面板 &gt; 声音设备）</p>
                        <p className="ml-3">• 尝试其他 USB 接口或重启计算机</p>
                      </div>
                    )}
                    {micErrorType === "security-error" && (
                      <div className="text-[9px] text-red-300/80 leading-relaxed space-y-1">
                        <p>✗ 安全政策阻止了麦克风访问：</p>
                        <p className="ml-3">• 确保网站使用 HTTPS（localhost 除外）</p>
                        <p className="ml-3">• 检查浏览器的企业安全策略</p>
                      </div>
                    )}
                    {micErrorType === "api-not-available" && (
                      <div className="text-[9px] text-red-300/80 leading-relaxed space-y-1">
                        <p>✗ 浏览器不支持此功能：</p>
                        <p className="ml-3">• 更新浏览器到最新版本</p>
                        <p className="ml-3">• 尝试最新版 Chrome、Firefox 或 Safari</p>
                      </div>
                    )}
                  </div>
                )}
                <button
                  onClick={() => {
                    setMicError(null);
                    setMicErrorType(null);
                    // Delay to let state update
                    setTimeout(() => startPTT(), 100);
                  }}
                  className="mt-2 px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-[10px] font-bold transition-colors"
                >
                  🔄 重试
                </button>
              </div>
            )}
          </div>

          {/* Channel Knob Simulation */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[8px] uppercase tracking-[0.3em] opacity-30">频率选择 (MHz)</span>
              <div className="flex items-center gap-2 text-[10px] text-gray-400">
                <div className={`w-2 h-2 rounded-full transition-all ${ 
                  channelStatus.get(currentChannel)?.busy 
                    ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)] animate-pulse" 
                    : "bg-green-500"
                }`} />
                {channelStatus.get(currentChannel)?.busy ? '繁忙' : '空闲'}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={customChannelInput}
                onChange={(e) => setCustomChannelInput(e.target.value)}
                inputMode="decimal"
                className="flex-1 bg-[#111] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="例如 446.006"
              />
              <button
                onClick={handleApplyFrequency}
                className="px-4 py-2 bg-blue-600 rounded text-sm font-bold"
              >
                应用
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => adjustFrequency(-0.005)}
                className="px-3 py-2 bg-[#333] rounded text-sm hover:bg-[#3d3d3d] transition-colors"
              >
                - 0.005 MHz
              </button>
              <button
                onClick={() => adjustFrequency(0.005)}
                className="px-3 py-2 bg-[#333] rounded text-sm hover:bg-[#3d3d3d] transition-colors"
              >
                + 0.005 MHz
              </button>
            </div>
          </div>

          {/* PTT Button */}
          <div className="flex justify-center">
            <motion.button
              onMouseDown={startPTT}
              onMouseUp={stopPTT}
              onMouseLeave={stopPTT}
              onTouchStart={(e) => {
                e.preventDefault();
                startPTT();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                stopPTT();
              }}
              onTouchCancel={(e) => {
                e.preventDefault();
                stopPTT();
              }}
              whileTap={{ scale: 0.95 }}
              className={`w-28 h-28 sm:w-32 sm:h-32 rounded-full border-8 flex items-center justify-center transition-all duration-150 relative ${
                isPTTActive 
                  ? "bg-red-500 border-red-400 shadow-[0_0_40px_rgba(239,68,68,0.4)]" 
                  : "bg-[#333] border-[#444] shadow-lg"
              }`}
            >
              {isPTTActive ? <Mic className="w-10 h-10 sm:w-12 sm:h-12" /> : <MicOff className="w-10 h-10 sm:w-12 sm:h-12 opacity-30" />}
              
              {/* PTT Label */}
              <div className="absolute -bottom-6 text-[9px] sm:text-[10px] font-bold uppercase tracking-widest opacity-50">
                按键通话
              </div>
            </motion.button>
          </div>
        </div>

        {/* Bottom Speaker Grille */}
        <div className="h-10 sm:h-12 bg-[#1a1a1a] flex items-center justify-center gap-1">
          {[...Array(20)].map((_, i) => (
            <div key={i} className="w-1 h-1 bg-[#333] rounded-full" />
          ))}
        </div>
      </div>

      {/* Background Info */}
      <div className="mt-8 text-[10px] opacity-30 uppercase tracking-[0.2em] text-center max-w-xs leading-relaxed">
        NetCom 分布式对讲系统 v1.0<br/>
        P2P 节点发现激活 • 加密通信模拟<br/>
        用户: {myName}
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #333;
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
}
