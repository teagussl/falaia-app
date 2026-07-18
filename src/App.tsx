import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, Loader2, AlertCircle, X, Volume2 } from "lucide-react";
import { floatTo16BitPCM, arrayBufferToBase64, base64ToFloat32PCM } from "./utils/audio";

type CallStatus = "idle" | "connecting" | "connected" | "error";

export default function App() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [userVolume, setUserVolume] = useState(0);
  const [aiVolume, setAiVolume] = useState(0);

  // WebSockets & Audio contexts
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Playback queues and scheduling refs
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTimeRef = useRef<number>(0);

  // Calculate Root Mean Square (RMS) volume of float32 samples
  const calculateRMS = (samples: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  };

  // Smoothly decay volumes to zero for beautiful fluid visual effects
  useEffect(() => {
    let animationId: number;
    const decay = () => {
      setUserVolume((prev) => Math.max(0, prev - 0.15));
      setAiVolume((prev) => Math.max(0, prev - 0.15));
      animationId = requestAnimationFrame(decay);
    };
    animationId = requestAnimationFrame(decay);
    return () => cancelAnimationFrame(animationId);
  }, []);

  // Stop any ongoing playback
  const stopPlayback = () => {
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (_) {}
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
  };

  // Play incoming 24kHz raw PCM little-endian audio chunk
  const playAudioChunk = (base64Data: string) => {
    if (!outputAudioCtxRef.current) {
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }

    const ctx = outputAudioCtxRef.current;
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const pcmFloat32 = base64ToFloat32PCM(base64Data);

    // Calculate volume for visual feedback
    const rms = calculateRMS(pcmFloat32);
    setAiVolume(Math.min(1.2, rms * 4.5)); // Amplify for better visual representation

    const audioBuffer = ctx.createBuffer(1, pcmFloat32.length, 24000);
    audioBuffer.getChannelData(0).set(pcmFloat32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };

    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      // Add a slight 40ms cushion for network/scheduling jitter
      nextStartTimeRef.current = currentTime + 0.04;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
  };

  const startConversation = () => {
    setStatus("connecting");
    setErrorMessage(null);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/live`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = async () => {
      try {
        // Request microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        micStreamRef.current = stream;

        // Initialize input audio context at 16000Hz (required by Gemini Live API)
        const inputAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        inputAudioCtxRef.current = inputAudioCtx;

        const source = inputAudioCtx.createMediaStreamSource(stream);
        const processor = inputAudioCtx.createScriptProcessor(2048, 1, 1);
        processorRef.current = processor;

        source.connect(processor);
        processor.connect(inputAudioCtx.destination);

        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);

          // Calculate mic volume
          const rms = calculateRMS(inputData);
          if (rms > 0.01) {
            setUserVolume(Math.min(1.2, rms * 5));
          }

          const pcmBuffer = floatTo16BitPCM(inputData);
          const base64 = arrayBufferToBase64(pcmBuffer);

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ audio: base64 }));
          }
        };

        setStatus("connected");
      } catch (err: any) {
        console.error("Microphone access failed:", err);
        setErrorMessage("Não foi possível acessar seu microfone. Por favor, permita o acesso.");
        setStatus("error");
        stopConversation();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.audio) {
          playAudioChunk(msg.audio);
        }
        if (msg.interrupted) {
          stopPlayback();
        }
        if (msg.error) {
          setErrorMessage(msg.error);
          setStatus("error");
          stopConversation();
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    };

    ws.onclose = () => {
      console.log("WebSocket closed");
      setStatus((prev) => (prev === "error" ? "error" : "idle"));
      cleanup();
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setErrorMessage("Falha na conexão de rede.");
      setStatus("error");
      stopConversation();
    };
  };

  const cleanup = () => {
    // Release input nodes
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (_) {}
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }

    // Stop playback sources
    stopPlayback();
  };

  const stopConversation = () => {
    cleanup();
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  };

  const handleToggle = () => {
    if (status === "connected" || status === "connecting") {
      stopConversation();
    } else {
      // AudioContext init block bypass for Safari/iOS
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        const dummyCtx = new AudioCtxClass();
        dummyCtx.resume().catch(() => {});
      }
      startConversation();
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopConversation();
    };
  }, []);

  // Determine current display info
  const isSpeakingAI = aiVolume > 0.08;
  const isSpeakingUser = userVolume > 0.08;
  const combinedVolume = Math.max(aiVolume, userVolume);

  return (
    <div className="flex flex-col items-center justify-between h-screen h-dvh max-h-screen w-full bg-[#030303] text-[#e2e8f0] overflow-hidden p-4 sm:p-6 font-sans select-none relative">
      {/* Atmosphere background glow */}
      <div 
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] sm:w-[500px] sm:h-[500px] pointer-events-none z-0" 
        style={{
          background: "radial-gradient(circle at center, rgba(249, 115, 22, 0.08) 0%, rgba(236, 72, 153, 0.08) 35%, rgba(139, 92, 246, 0.05) 70%, transparent 100%)",
          filter: "blur(60px)",
        }}
      />
      
      {/* Header */}
      <header className="w-full max-w-lg px-4 py-2 sm:py-4 flex justify-between items-center z-10">
        <div className="flex items-center space-x-2.5">
          <div className="w-2 h-2 bg-gradient-to-tr from-amber-500 to-pink-500 rounded-full shadow-[0_0_10px_rgba(236,72,153,0.8)] animate-pulse"></div>
          <span className="text-sm font-bold tracking-[0.25em] uppercase text-white">Falaia</span>
        </div>
        <div className="text-[9px] uppercase tracking-[0.2em] text-slate-400 border border-white/5 px-3 py-0.5 rounded-full bg-white/[0.02] backdrop-blur-md">
          Live Voice • PT-BR
        </div>
      </header>

      {/* Main Center Stage */}
      <main className="flex-1 flex flex-col items-center justify-center z-10 w-full max-w-md relative py-2">
        
        {/* Headline text (recreated from your dream) */}
        <div className="text-center mb-6 sm:mb-8">
          <motion.h1 
            className="text-2xl sm:text-3xl font-light tracking-tight text-white mb-1.5"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {status === "idle" && "Conecte sua voz"}
            {status === "connecting" && "Iniciando conversa..."}
            {status === "connected" && (isSpeakingAI ? "Ouça a resposta" : "Fale naturalmente")}
            {status === "error" && "Ops, algo deu errado"}
          </motion.h1>
          <motion.p 
            className="text-slate-400 text-xs sm:text-sm font-light px-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            {status === "idle" && "Toque no orbe para iniciar uma conversa por voz em tempo real."}
            {status === "connecting" && "Conectando com a inteligência artificial da Falaia."}
            {status === "connected" && (isSpeakingAI ? "A Falaia está falando com você agora." : "O orbe está ouvindo sua voz. Pode falar.")}
            {status === "error" && "Clique no orbe para tentar estabelecer a conexão novamente."}
          </motion.p>
        </div>

        {/* Big Aurora/Nebula Glowing Orb Trigger Container */}
        <div className="relative flex items-center justify-center w-52 h-52 sm:w-60 sm:h-60 mb-6 sm:mb-8">
          <AnimatePresence>
            {/* Ambient dynamic radial shadows that grow/pulse based on state */}
            <motion.div
              className="absolute inset-0 rounded-full pointer-events-none filter blur-[25px] sm:blur-[35px]"
              style={{
                background: "radial-gradient(circle, rgba(249, 115, 22, 0.4) 0%, rgba(236, 72, 153, 0.4) 50%, rgba(139, 92, 246, 0.3) 100%)",
              }}
              animate={{
                scale: status === "connected" 
                  ? (isSpeakingAI ? 1.05 + aiVolume * 0.35 : isSpeakingUser ? 1.05 + userVolume * 0.3 : [1, 1.08, 1])
                  : status === "connecting"
                    ? [1, 1.15, 1]
                    : [1, 1.04, 1],
                opacity: status === "connected" ? 0.6 : status === "connecting" ? 0.7 : 0.35,
              }}
              transition={{
                duration: status === "connected" && (isSpeakingAI || isSpeakingUser) ? 0.1 : 3.5,
                repeat: Infinity,
                repeatType: "reverse",
                ease: "easeInOut",
              }}
            />
          </AnimatePresence>

          {/* Central Orb Button */}
          <motion.button
            id="mic-call-btn"
            onClick={handleToggle}
            className={`relative z-10 flex items-center justify-center w-40 h-40 sm:w-48 sm:h-48 rounded-full cursor-pointer overflow-hidden border border-white/10 shadow-[0_15px_40px_rgba(236,72,153,0.2)]`}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            animate={{
              scale: status === "connected"
                ? (isSpeakingAI ? 1 + aiVolume * 0.15 : isSpeakingUser ? 1 + userVolume * 0.12 : 1)
                : 1
            }}
            transition={{
              type: "spring",
              stiffness: 400,
              damping: 25
            }}
          >
            {/* Dynamic rotating gradient behind to create a living nebula/aurora look */}
            <motion.div
              className="absolute inset-0 w-[200%] h-[200%] -left-1/2 -top-1/2 pointer-events-none"
              style={{
                background: "radial-gradient(circle at center, #ff7e40 0%, #ec4899 45%, #8b5cf6 80%, #6366f1 100%)",
              }}
              animate={{
                rotate: 360,
              }}
              transition={{
                duration: status === "connected" ? 12 : 24,
                repeat: Infinity,
                ease: "linear",
              }}
            />

            {/* Glossy overlay layer for depth */}
            <div className="absolute inset-0 bg-gradient-to-b from-white/10 via-transparent to-black/20 pointer-events-none" />

            {/* Icon Pattern: Translucent 7 overlapping circles from the image */}
            <div className="absolute inset-0 flex items-center justify-center opacity-85 z-10">
              <motion.svg 
                viewBox="0 0 100 100" 
                className="w-16 h-16 sm:w-20 sm:h-20 text-white" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2.2"
                animate={status === "connected" && isSpeakingAI ? {
                  scale: [1, 1.08, 1],
                  opacity: [0.85, 1, 0.85]
                } : status === "connected" && isSpeakingUser ? {
                  scale: [1, 1.04, 1],
                } : {}}
                transition={{
                  duration: 1.5,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              >
                {/* Symmetrical flower of life pattern as in the image */}
                <circle cx="50" cy="50" r="8" stroke="rgba(255,255,255,0.8)" strokeWidth="2.5" />
                <circle cx="50" cy="31" r="8" stroke="rgba(255,255,255,0.5)" />
                <circle cx="66" cy="40.5" r="8" stroke="rgba(255,255,255,0.5)" />
                <circle cx="66" cy="59.5" r="8" stroke="rgba(255,255,255,0.5)" />
                <circle cx="50" cy="69" r="8" stroke="rgba(255,255,255,0.5)" />
                <circle cx="34" cy="59.5" r="8" stroke="rgba(255,255,255,0.5)" />
                <circle cx="34" cy="40.5" r="8" stroke="rgba(255,255,255,0.5)" />
              </motion.svg>
            </div>

            {/* Loading spinner overlay if connecting */}
            {status === "connecting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-sm z-20">
                <Loader2 className="w-12 h-12 text-white animate-spin" />
              </div>
            )}
          </motion.button>
        </div>

        {/* Capsule pill indicator displaying current connection state */}
        <motion.div 
          className="bg-white/[0.04] border border-white/[0.08] backdrop-blur-md px-5 py-2 rounded-full flex items-center justify-center gap-2 text-xs font-semibold tracking-wider uppercase text-slate-200 shadow-xl mb-5 sm:mb-6 z-10"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.3 }}
        >
          <span className={`w-2 h-2 rounded-full ${
            status === "connected" 
              ? isSpeakingAI 
                ? "bg-teal-400 shadow-[0_0_10px_rgba(45,212,191,0.8)]" 
                : "bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.8)] animate-pulse"
              : status === "connecting"
                ? "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)] animate-ping"
                : status === "error"
                  ? "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.8)]"
                  : "bg-slate-500"
          }`} />
          <span>
            {status === "idle" && "Toque para conversar"}
            {status === "connecting" && "Conectando..."}
            {status === "connected" && (isSpeakingAI ? "Falaia Falando..." : "Ouvindo você...")}
            {status === "error" && "Erro na conexão"}
          </span>
        </motion.div>

        {/* Symmetrical modern audio visualizer bars when connected */}
        <div className="h-6 flex items-center justify-center w-full z-10">
          <AnimatePresence>
            {status === "connected" && (
              <motion.div 
                className="flex items-center gap-1.5 h-6"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((barIndex) => {
                  const multiplier = 0.15 + (isSpeakingAI ? aiVolume : isSpeakingUser ? userVolume : 0.03) * (1.2 - Math.abs(barIndex - 6) * 0.15);
                  return (
                    <motion.div
                      key={barIndex}
                      className={`w-1 rounded-full ${
                        isSpeakingAI 
                          ? "bg-teal-400" 
                          : isSpeakingUser 
                            ? "bg-blue-400" 
                            : "bg-slate-700"
                      }`}
                      animate={{ height: `${Math.max(4, Math.min(24, multiplier * 24))}px` }}
                      transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    />
                  );
                })}
              </motion.div>
            )}

            {status === "error" && (
              <motion.button
                onClick={handleToggle}
                className="text-xs bg-rose-950/50 border border-rose-900/60 text-rose-300 px-5 py-2 rounded-full hover:bg-rose-900/60 transition-colors cursor-pointer z-20"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                Tentar Novamente
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full flex justify-center py-2 sm:py-3 z-10">
        <p className="text-slate-700 text-[10px] tracking-[0.25em] uppercase font-semibold">
          Falaia
        </p>
      </footer>
    </div>
  );
}
