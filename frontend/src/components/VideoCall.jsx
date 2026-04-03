import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL;
const socket = io(API_URL);

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const languageOptions = [
  { code: "en", label: "English", speechCode: "en-US", ttsCode: "en-US" },
  { code: "hi", label: "Hindi", speechCode: "hi-IN", ttsCode: "hi-IN" },
  { code: "te", label: "Telugu", speechCode: "te-IN", ttsCode: "te-IN" },
  { code: "ta", label: "Tamil", speechCode: "ta-IN", ttsCode: "ta-IN" },
  { code: "bn", label: "Bengali", speechCode: "bn-IN", ttsCode: "bn-IN" },
  { code: "fr", label: "French", speechCode: "fr-FR", ttsCode: "fr-FR" },
  { code: "es", label: "Spanish", speechCode: "es-ES", ttsCode: "es-ES" }
];

export default function VideoCall() {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");
  const isJoiningFromLink = Boolean(roomFromUrl);

  const [roomId, setRoomId] = useState(roomFromUrl || "");
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [ownerId, setOwnerId] = useState(null);
  const [status, setStatus] = useState(
    isJoiningFromLink
      ? "Open the link, enter your name, and ask to join"
      : "Create a meeting to become the host"
  );
  const [participants, setParticipants] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [callSeconds, setCallSeconds] = useState(0);
  const [myLanguage, setMyLanguage] = useState("hi");
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [isListening, setIsListening] = useState(false);
  const [myCaption, setMyCaption] = useState("");
  const [translatedCaption, setTranslatedCaption] = useState("");
  const [lastOriginal, setLastOriginal] = useState("");
  const [lastTranslated, setLastTranslated] = useState("");
  const [copied, setCopied] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCamOn, setIsCamOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isBlurOn, setIsBlurOn] = useState(false);

  const localVideoRef = useRef(null);
  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const chatEndRef = useRef(null);
  const subtitleTimeoutRef = useRef(null);
  const mySubtitleTimeoutRef = useRef(null);

  const peersRef = useRef({});
  const cameraStreamRef = useRef(null);
  const outputStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const blurVideoRef = useRef(null);
  const blurCanvasRef = useRef(null);
  const blurProcessedStreamRef = useRef(null);
  const blurAnimationFrameRef = useRef(null);

  const isOwner = ownerId === socket.id;

  const meetingLink = useMemo(() => {
    if (!roomId) return "";
    return `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
  }, [roomId]);

  useEffect(() => {
    startLocalPreview();

    socket.on("joined-room-approved", ({ roomId: approvedRoomId, ownerId }) => {
      setJoined(true);
      setWaitingApproval(false);
      setOwnerId(ownerId);
      setStatus(ownerId === socket.id ? "You started the meeting" : "You joined the meeting");
      startCallTimer();
      updateUrlRoom(approvedRoomId);
      setRoomId(approvedRoomId);
    });

    socket.on("existing-participants", async ({ participants }) => {
      for (const participant of participants) {
        await createOfferToParticipant(participant.socketId);
      }
    });

    socket.on("participant-joined", ({ socketId }) => {
      if (socketId === socket.id) return;
      setStatus("A participant joined");
    });

    socket.on("participant-left", ({ socketId }) => {
      removePeer(socketId);
    });

    socket.on("waiting-for-approval", ({ roomId }) => {
      setWaitingApproval(true);
      setJoined(false);
      setStatus("Waiting for host approval...");
      updateUrlRoom(roomId);
      setRoomId(roomId);
    });

    socket.on("join-request", ({ socketId, name }) => {
      setPendingRequests((prev) => {
        const exists = prev.some((item) => item.socketId === socketId);
        if (exists) return prev;
        return [...prev, { socketId, name }];
      });
      setStatus(`New join request from ${name}`);
    });

    socket.on("join-rejected", () => {
      setWaitingApproval(false);
      setJoined(false);
      setStatus("Host rejected your request");
      alert("Host rejected your request.");
    });

    socket.on("room-state", ({ ownerId, pending, participants }) => {
      setOwnerId(ownerId);
      setParticipants(participants || []);
      setPendingRequests(pending || []);
    });

    socket.on("chat-message-room", (payload) => {
      setChatMessages((prev) => [
        ...prev,
        {
          senderName: payload.senderName,
          text: payload.text,
          time: payload.time,
          mine: payload.senderId === socket.id
        }
      ]);
    });

    socket.on("system-message", (payload) => {
      setChatMessages((prev) => [
        ...prev,
        {
          senderName: "System",
          text: payload.text,
          time: payload.time,
          mine: false,
          system: true
        }
      ]);
    });

    socket.on("receive-translated-message", (payload) => {
      setLastOriginal(payload.originalText);
      setLastTranslated(payload.translatedText);

      if (payload.from !== socket.id) {
        setTranslatedCaption(`${payload.senderName}: ${payload.translatedText}`);

        if (subtitleTimeoutRef.current) {
          clearTimeout(subtitleTimeoutRef.current);
        }

        subtitleTimeoutRef.current = setTimeout(() => {
          setTranslatedCaption("");
        }, 5000);
      }
    });

    socket.on("owner-changed", ({ ownerId }) => {
      setOwnerId(ownerId);
      if (ownerId === socket.id) {
        setStatus("You are now the host");
      }
    });

    socket.on("webrtc-offer", async ({ sdp, caller }) => {
      const pc = createPeerConnection(caller);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("webrtc-answer", {
        target: caller,
        sdp: pc.localDescription
      });
    });

    socket.on("webrtc-answer", async ({ sdp, answerer }) => {
      const pc = peersRef.current[answerer];
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    });

    socket.on("webrtc-ice-candidate", async ({ candidate, from }) => {
      const pc = peersRef.current[from];
      if (!pc || !candidate) return;

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error("ICE candidate error:", error);
      }
    });

    return () => {
      socket.off("joined-room-approved");
      socket.off("existing-participants");
      socket.off("participant-joined");
      socket.off("participant-left");
      socket.off("waiting-for-approval");
      socket.off("join-request");
      socket.off("join-rejected");
      socket.off("room-state");
      socket.off("chat-message-room");
      socket.off("system-message");
      socket.off("receive-translated-message");
      socket.off("owner-changed");
      socket.off("webrtc-offer");
      socket.off("webrtc-answer");
      socket.off("webrtc-ice-candidate");

      stopCallTimer();
      closeAllPeers();
      stopBlurProcessing();
      stopScreenShareTracks();
      stopCameraTracks();
    };
  }, []);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  const startLocalPreview = async () => {
    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      cameraStreamRef.current = cameraStream;
      outputStreamRef.current = cameraStream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = cameraStream;
      }
    } catch (error) {
      console.error("Local media preview error:", error);
      alert("Please allow camera and microphone access.");
    }
  };

  const stopCameraTracks = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
  };

  const stopScreenShareTracks = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }
  };

  const createPeerConnection = (remoteSocketId) => {
    if (peersRef.current[remoteSocketId]) {
      return peersRef.current[remoteSocketId];
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peersRef.current[remoteSocketId] = pc;

    if (outputStreamRef.current) {
      outputStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, outputStreamRef.current);
      });
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      setRemoteStreams((prev) => {
        const exists = prev.some((item) => item.socketId === remoteSocketId);
        if (exists) {
          return prev.map((item) =>
            item.socketId === remoteSocketId ? { ...item, stream } : item
          );
        }

        return [...prev, { socketId: remoteSocketId, stream }];
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc-ice-candidate", {
          target: remoteSocketId,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        removePeer(remoteSocketId);
      }
    };

    return pc;
  };

  const createOfferToParticipant = async (remoteSocketId) => {
    const pc = createPeerConnection(remoteSocketId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("webrtc-offer", {
      target: remoteSocketId,
      sdp: pc.localDescription,
      callerName: name.trim() || "Guest"
    });
  };

  const removePeer = (socketId) => {
    if (peersRef.current[socketId]) {
      peersRef.current[socketId].close();
      delete peersRef.current[socketId];
    }

    setRemoteStreams((prev) => prev.filter((item) => item.socketId !== socketId));
  };

  const closeAllPeers = () => {
    Object.keys(peersRef.current).forEach((socketId) => {
      peersRef.current[socketId].close();
    });
    peersRef.current = {};
    setRemoteStreams([]);
  };

  const replaceOutgoingVideoTrack = async (newVideoTrack) => {
    const peerIds = Object.keys(peersRef.current);

    for (const peerId of peerIds) {
      const pc = peersRef.current[peerId];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }
    }
  };

  const stopBlurProcessing = () => {
    if (blurAnimationFrameRef.current) {
      cancelAnimationFrame(blurAnimationFrameRef.current);
      blurAnimationFrameRef.current = null;
    }

    if (blurProcessedStreamRef.current) {
      blurProcessedStreamRef.current.getTracks().forEach((track) => track.stop());
      blurProcessedStreamRef.current = null;
    }

    blurVideoRef.current = null;
    blurCanvasRef.current = null;
  };

  const buildBlurredStreamFromCamera = async () => {
    if (!cameraStreamRef.current) return null;

    stopBlurProcessing();

    const cameraVideoTrack = cameraStreamRef.current.getVideoTracks()[0];
    const audioTrack = cameraStreamRef.current.getAudioTracks()[0];

    if (!cameraVideoTrack) return null;

    const settings = cameraVideoTrack.getSettings();
    const width = settings.width || 640;
    const height = settings.height || 480;

    const hiddenVideo = document.createElement("video");
    hiddenVideo.srcObject = new MediaStream([cameraVideoTrack]);
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.autoplay = true;

    await hiddenVideo.play().catch(() => {});

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.filter = "blur(8px)";
      ctx.drawImage(hiddenVideo, 0, 0, width, height);
      ctx.filter = "none";
      blurAnimationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    const blurredVideoStream = canvas.captureStream(25);
    const blurredVideoTrack = blurredVideoStream.getVideoTracks()[0];

    const finalTracks = [];
    if (blurredVideoTrack) finalTracks.push(blurredVideoTrack);
    if (audioTrack) finalTracks.push(audioTrack);

    const finalStream = new MediaStream(finalTracks);

    blurVideoRef.current = hiddenVideo;
    blurCanvasRef.current = canvas;
    blurProcessedStreamRef.current = finalStream;

    return finalStream;
  };

  const applyOutputStream = async (stream, options = {}) => {
    outputStreamRef.current = stream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      await replaceOutgoingVideoTrack(videoTrack);
    }

    if (typeof options.screenSharing === "boolean") {
      setIsScreenSharing(options.screenSharing);
    }
  };

  const toggleBlur = async () => {
    if (isScreenSharing) {
      alert("Turn off screen sharing before enabling blur.");
      return;
    }

    if (!cameraStreamRef.current) return;

    if (!isBlurOn) {
      const blurredStream = await buildBlurredStreamFromCamera();
      if (!blurredStream) return;
      await applyOutputStream(blurredStream, { screenSharing: false });
      setIsBlurOn(true);
      setStatus("Blur effect enabled");
    } else {
      stopBlurProcessing();
      await applyOutputStream(cameraStreamRef.current, { screenSharing: false });
      setIsBlurOn(false);
      setStatus("Blur effect disabled");
    }
  };

  const toggleScreenShare = async () => {
    if (!joined) return;

    if (isScreenSharing) {
      stopScreenShareTracks();
      stopBlurProcessing();

      if (isBlurOn) {
        const blurredStream = await buildBlurredStreamFromCamera();
        if (blurredStream) {
          await applyOutputStream(blurredStream, { screenSharing: false });
        } else {
          await applyOutputStream(cameraStreamRef.current, { screenSharing: false });
          setIsBlurOn(false);
        }
      } else {
        await applyOutputStream(cameraStreamRef.current, { screenSharing: false });
      }

      setStatus("Returned to camera");
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });

      screenStreamRef.current = screenStream;

      const screenVideoTrack = screenStream.getVideoTracks()[0];
      const cameraAudioTrack = cameraStreamRef.current?.getAudioTracks?.()[0];

      const tracks = [];
      if (screenVideoTrack) tracks.push(screenVideoTrack);
      if (cameraAudioTrack) tracks.push(cameraAudioTrack);

      const combinedStream = new MediaStream(tracks);

      if (isBlurOn) {
        stopBlurProcessing();
        setIsBlurOn(false);
      }

      await applyOutputStream(combinedStream, { screenSharing: true });
      setStatus("Screen sharing started");

      screenVideoTrack.onended = async () => {
        stopScreenShareTracks();

        if (isBlurOn) {
          const blurredStream = await buildBlurredStreamFromCamera();
          if (blurredStream) {
            await applyOutputStream(blurredStream, { screenSharing: false });
          } else {
            await applyOutputStream(cameraStreamRef.current, { screenSharing: false });
            setIsBlurOn(false);
          }
        } else {
          await applyOutputStream(cameraStreamRef.current, { screenSharing: false });
        }

        setStatus("Screen sharing stopped");
      };
    } catch (error) {
      console.error("Screen share error:", error);
      setStatus("Screen sharing canceled");
    }
  };

  const startMeet = () => {
    const safeName = name.trim() || "Host";
    const newRoomId = generateRoomCode();

    setRoomId(newRoomId);
    updateUrlRoom(newRoomId);

    socket.emit("join-room-request", {
      roomId: newRoomId,
      name: safeName
    });

    setStatus("Starting meeting...");
  };

  const askToJoin = () => {
    if (!roomId) {
      alert("Invalid meeting link.");
      return;
    }

    const safeName = name.trim() || "Guest";

    socket.emit("join-room-request", {
      roomId,
      name: safeName
    });

    setStatus("Sending join request...");
  };

  const approveUser = (targetSocketId) => {
    socket.emit("approve-user", {
      roomId,
      targetSocketId
    });
  };

  const rejectUser = (targetSocketId) => {
    socket.emit("reject-user", {
      roomId,
      targetSocketId
    });
  };

  const sendChatMessage = () => {
    if (!joined || !chatInput.trim()) return;

    socket.emit("chat-message-room", {
      roomId,
      text: chatInput,
      senderName: name.trim() || "Guest"
    });

    setChatInput("");
  };

  const handleChatKeyDown = (e) => {
    if (e.key === "Enter") {
      sendChatMessage();
    }
  };

  const leaveRoom = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }

    if (roomId) {
      socket.emit("leave-room", { roomId });
    }

    closeAllPeers();
    stopBlurProcessing();
    stopScreenShareTracks();

    if (cameraStreamRef.current) {
      outputStreamRef.current = cameraStreamRef.current;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = cameraStreamRef.current;
      }
    }

    const keepRoomId = isJoiningFromLink ? roomFromUrl || "" : "";

    setJoined(false);
    setWaitingApproval(false);
    setOwnerId(null);
    setParticipants([]);
    setPendingRequests([]);
    setChatMessages([]);
    setStatus(
      isJoiningFromLink
        ? "Open the link, enter your name, and ask to join"
        : "Create a meeting to become the host"
    );
    setIsListening(false);
    setMyCaption("");
    setTranslatedCaption("");
    setLastOriginal("");
    setLastTranslated("");
    setCallSeconds(0);
    setRoomId(keepRoomId);
    setIsScreenSharing(false);
    setIsBlurOn(false);

    if (!isJoiningFromLink) {
      window.history.replaceState({}, "", window.location.origin);
    }

    stopCallTimer();
  };

  const copyMeetingLink = async () => {
    if (!meetingLink) return;

    try {
      await navigator.clipboard.writeText(meetingLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  const startCallTimer = () => {
    if (timerRef.current) return;

    timerRef.current = setInterval(() => {
      setCallSeconds((prev) => prev + 1);
    }, 1000);
  };

  const stopCallTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const formatTime = (totalSeconds) => {
    const hrs = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const secs = String(totalSeconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  };

  const translateText = async (text, target) => {
    const response = await fetch(
      `${API_URL}/translate?text=${encodeURIComponent(text)}&target=${encodeURIComponent(target)}`
    );
    const data = await response.json();
    return data.translated || text;
  };

  const startListening = () => {
    if (!joined) return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser. Use Chrome.");
      return;
    }

    const selectedLanguage =
      languageOptions.find((lang) => lang.code === myLanguage) ||
      languageOptions[0];

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;

    recognition.lang = selectedLanguage.speechCode;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setIsListening(true);
      setStatus("Listening...");
    };

    recognition.onresult = async (event) => {
      let interimTranscript = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const currentText = interimTranscript || finalTranscript;
      setMyCaption(currentText);

      if (mySubtitleTimeoutRef.current) {
        clearTimeout(mySubtitleTimeoutRef.current);
      }

      mySubtitleTimeoutRef.current = setTimeout(() => {
        setMyCaption("");
      }, 4000);

      if (finalTranscript.trim()) {
        const translated = await translateText(finalTranscript, targetLanguage);

        setLastOriginal(finalTranscript);
        setLastTranslated(translated);

        socket.emit("send-translated-message", {
          roomId,
          originalText: finalTranscript,
          translatedText: translated,
          fromLang: myLanguage,
          toLang: targetLanguage,
          senderName: name.trim() || "Guest"
        });
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      setStatus(`Speech error: ${event.error}`);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      setStatus(joined ? "Speech recognition stopped" : "Not connected");
    };

    recognition.start();
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsListening(false);
  };

  const toggleMic = () => {
    if (!cameraStreamRef.current) return;

    cameraStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
    });

    setIsMicOn((prev) => !prev);
  };

  const toggleCam = () => {
    if (!cameraStreamRef.current) return;

    cameraStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
    });

    setIsCamOn((prev) => !prev);
  };

  const showStartMeetButton = !isJoiningFromLink && !joined && !waitingApproval;
  const showAskToJoinButton = isJoiningFromLink && !joined && !waitingApproval;

  return (
    <>
      <style>{`
        .vc-root {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 360px;
          gap: 20px;
          align-items: start;
        }

        .vc-toolbar-row {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          justify-content: center;
          margin-bottom: 14px;
        }

        .vc-video-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 20px;
          margin-bottom: 20px;
        }

        .vc-bottom-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 20px;
        }

        @media (max-width: 1100px) {
          .vc-root {
            grid-template-columns: 1fr;
          }

          .vc-chat-panel {
            min-height: auto !important;
          }

          .vc-chat-box {
            min-height: 320px !important;
            max-height: 420px !important;
          }
        }

        @media (max-width: 768px) {
          .vc-toolbar-row {
            flex-direction: column;
            align-items: stretch;
          }

          .vc-toolbar-row > * {
            width: 100%;
            min-width: 0 !important;
          }

          .vc-video-grid {
            grid-template-columns: 1fr;
          }

          .vc-bottom-grid {
            grid-template-columns: 1fr;
          }

          .vc-status-bar {
            flex-direction: column;
            align-items: flex-start;
          }

          .vc-big-subtitle {
            font-size: 20px !important;
          }

          .vc-subtitle-overlay {
            font-size: 15px !important;
            width: 92% !important;
            bottom: 12px !important;
          }

          .vc-chat-input-row {
            flex-direction: column;
          }
        }
      `}</style>

      <div className="vc-root">
        <div>
          <div style={topCardStyle}>
            <div className="vc-toolbar-row">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                style={inputStyle}
              />

              {isJoiningFromLink ? (
                <input
                  type="text"
                  value={roomId}
                  readOnly
                  placeholder="Meeting code"
                  style={inputStyle}
                />
              ) : (
                <div style={meetingCodeInfoStyle}>
                  {roomId ? `Meeting code: ${roomId}` : "New meeting will be created"}
                </div>
              )}

              {showStartMeetButton && (
                <button onClick={startMeet} style={buttonStyle("#2563eb")}>
                  Start Meet
                </button>
              )}

              {showAskToJoinButton && (
                <button onClick={askToJoin} style={buttonStyle("#2563eb")}>
                  Ask to Join
                </button>
              )}

              {(joined || waitingApproval) && (
                <button
                  onClick={copyMeetingLink}
                  style={buttonStyle("#7c3aed")}
                  disabled={!meetingLink}
                >
                  {copied ? "Link Copied" : "Copy Meeting Link"}
                </button>
              )}

              <button
                onClick={toggleMic}
                disabled={!joined}
                style={buttonStyle(!joined ? "#475569" : isMicOn ? "#16a34a" : "#dc2626")}
              >
                {isMicOn ? "Mic On" : "Mic Off"}
              </button>

              <button
                onClick={toggleCam}
                disabled={!joined}
                style={buttonStyle(!joined ? "#475569" : isCamOn ? "#16a34a" : "#dc2626")}
              >
                {isCamOn ? "Camera On" : "Camera Off"}
              </button>

              <button
                onClick={toggleScreenShare}
                disabled={!joined}
                style={buttonStyle(!joined ? "#475569" : isScreenSharing ? "#f59e0b" : "#0ea5e9")}
              >
                {isScreenSharing ? "Stop Share" : "Share Screen"}
              </button>

              <button
                onClick={toggleBlur}
                disabled={!joined || isScreenSharing}
                style={buttonStyle(
                  !joined || isScreenSharing
                    ? "#475569"
                    : isBlurOn
                    ? "#8b5cf6"
                    : "#334155"
                )}
              >
                {isBlurOn ? "Blur On" : "Blur Background"}
              </button>

              <button
                onClick={leaveRoom}
                disabled={!joined && !waitingApproval}
                style={buttonStyle(!joined && !waitingApproval ? "#475569" : "#ef4444")}
              >
                Leave
              </button>
            </div>

            <div className="vc-toolbar-row">
              <select
                value={myLanguage}
                onChange={(e) => setMyLanguage(e.target.value)}
                style={selectStyle}
              >
                {languageOptions.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    My language: {lang.label}
                  </option>
                ))}
              </select>

              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                style={selectStyle}
              >
                {languageOptions.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    Translate incoming to: {lang.label}
                  </option>
                ))}
              </select>

              <button
                onClick={startListening}
                disabled={!joined || isListening}
                style={buttonStyle(!joined || isListening ? "#475569" : "#16a34a")}
              >
                {isListening ? "Listening..." : "Start Translation"}
              </button>

              <button
                onClick={stopListening}
                disabled={!isListening}
                style={buttonStyle(isListening ? "#dc2626" : "#475569")}
              >
                Stop Translation
              </button>
            </div>

            <div style={statusBarStyle} className="vc-status-bar">
              <div>
                <strong>Status:</strong> {status}
              </div>
              <div>
                <strong>Timer:</strong> {formatTime(callSeconds)}
              </div>
              <div>
                <strong>Host:</strong> {isOwner ? "You" : ownerId ? "Another user" : "-"}
              </div>
              <div>
                <strong>Members:</strong> {participants.length}
              </div>
            </div>

            {waitingApproval && (
              <div style={approvalWaitingStyle}>
                Waiting for host approval...
              </div>
            )}

            {isOwner && pendingRequests.length > 0 && (
              <div style={hostApprovalBoxStyle}>
                <div style={hostApprovalTitleStyle}>
                  Join Requests ({pendingRequests.length})
                </div>

                {pendingRequests.map((request) => (
                  <div key={request.socketId} style={requestItemStyle}>
                    <div>
                      <div style={participantNameStyle}>{request.name}</div>
                      <div style={participantSubStyle}>Wants to join this meeting</div>
                    </div>

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        onClick={() => approveUser(request.socketId)}
                        style={smallButtonStyle("#16a34a")}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => rejectUser(request.socketId)}
                        style={smallButtonStyle("#dc2626")}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="vc-video-grid">
            <div style={cardStyle}>
              <div style={videoHeaderStyle}>
                <span>Your Camera</span>
                <span style={pillStyle("#2563eb")}>{name.trim() || "You"}</span>
              </div>

              <div style={videoWrapperStyle}>
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  style={videoStyle}
                />
                <div style={subtitleOverlayStyle} className="vc-subtitle-overlay">
                  {myCaption || " "}
                </div>
              </div>
            </div>

            {remoteStreams.map((item) => {
              const participant = participants.find((p) => p.socketId === item.socketId);

              return (
                <RemoteVideoTile
                  key={item.socketId}
                  stream={item.stream}
                  name={participant?.name || "Participant"}
                />
              );
            })}
          </div>

          <div style={translationFeedCardStyle}>
            <div style={videoHeaderStyle}>
              <span>Translated Subtitle Feed</span>
              <span style={pillStyle("#16a34a")}>Live</span>
            </div>

            <div style={subtitleFeedStyle}>
              <div style={bigSubtitleStyle} className="vc-big-subtitle">
                {translatedCaption || "Translated room speech will appear here"}
              </div>
            </div>
          </div>

          <div className="vc-bottom-grid">
            <div style={panelStyle}>
              <h3 style={panelTitleStyle}>Participants</h3>

              {participants.length === 0 ? (
                <div style={emptyTextStyle}>No participants yet</div>
              ) : (
                participants.map((participant) => (
                  <div key={participant.socketId} style={participantItemStyle}>
                    <div>
                      <div style={participantNameStyle}>
                        {participant.socketId === socket.id
                          ? `${participant.name} (You)`
                          : participant.name}
                      </div>
                      <div style={participantSubStyle}>
                        {participant.socketId === ownerId ? "Host" : "Member"}
                      </div>
                    </div>
                    <div
                      style={statusDotStyle(
                        participant.socketId === ownerId ? "#f59e0b" : "#16a34a"
                      )}
                    />
                  </div>
                ))
              )}
            </div>

            <div style={panelStyle}>
              <h3 style={panelTitleStyle}>Latest Translation</h3>
              <p style={{ marginBottom: "10px", lineHeight: "1.5" }}>
                <strong>Original:</strong> {lastOriginal || "-"}
              </p>
              <p style={{ lineHeight: "1.5" }}>
                <strong>Translated:</strong> {lastTranslated || "-"}
              </p>
            </div>
          </div>
        </div>

        <div style={chatPanelStyle} className="vc-chat-panel">
          <h3 style={panelTitleStyle}>Live Room Chat</h3>

          <div style={chatMessagesBoxStyle} className="vc-chat-box">
            {chatMessages.length === 0 ? (
              <div style={emptyTextStyle}>No messages yet</div>
            ) : (
              chatMessages.map((msg, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    justifyContent: msg.system
                      ? "center"
                      : msg.mine
                      ? "flex-end"
                      : "flex-start",
                    marginBottom: "10px"
                  }}
                >
                  <div
                    style={{
                      maxWidth: msg.system ? "100%" : "85%",
                      background: msg.system
                        ? "rgba(148, 163, 184, 0.12)"
                        : msg.mine
                        ? "#2563eb"
                        : "#1e293b",
                      color: "white",
                      padding: "10px 12px",
                      borderRadius: "14px",
                      border: "1px solid #334155",
                      textAlign: msg.system ? "center" : "left"
                    }}
                  >
                    <div
                      style={{
                        fontSize: "12px",
                        opacity: 0.8,
                        marginBottom: "4px"
                      }}
                    >
                      {msg.senderName} · {msg.time}
                    </div>
                    <div style={{ lineHeight: "1.4" }}>{msg.text}</div>
                  </div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          <div style={chatInputRowStyle} className="vc-chat-input-row">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="Type a room message"
              style={chatInputStyle}
            />
            <button
              onClick={sendChatMessage}
              disabled={!joined}
              style={buttonStyle(!joined ? "#475569" : "#2563eb")}
            >
              Send
            </button>
          </div>

          <div style={meetingLinkBoxStyle}>
            <div style={meetingLinkTitleStyle}>Meeting Link</div>
            <div style={meetingLinkTextStyle}>
              {meetingLink || "Start a meeting to generate the link"}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function RemoteVideoTile({ stream, name }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div style={cardStyle}>
      <div style={videoHeaderStyle}>
        <span>Participant</span>
        <span style={pillStyle("#16a34a")}>{name}</span>
      </div>

      <div style={videoWrapperStyle}>
        <video ref={videoRef} autoPlay playsInline style={videoStyle} />
      </div>
    </div>
  );
}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 10);
}

function updateUrlRoom(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url.toString());
}

const topCardStyle = {
  background: "rgba(15, 23, 42, 0.7)",
  border: "1px solid rgba(148, 163, 184, 0.15)",
  borderRadius: "22px",
  padding: "18px",
  marginBottom: "20px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.25)"
};

const inputStyle = {
  padding: "12px 14px",
  borderRadius: "12px",
  border: "1px solid #475569",
  minWidth: "220px",
  fontSize: "15px",
  background: "#0f172a",
  color: "white",
  outline: "none"
};

const meetingCodeInfoStyle = {
  minWidth: "220px",
  padding: "12px 14px",
  borderRadius: "12px",
  border: "1px solid #334155",
  background: "#0f172a",
  color: "#cbd5e1",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "15px",
  fontWeight: "600"
};

const selectStyle = {
  padding: "12px 14px",
  borderRadius: "12px",
  border: "1px solid #475569",
  minWidth: "220px",
  fontSize: "15px",
  background: "#0f172a",
  color: "white",
  outline: "none"
};

const buttonStyle = (background) => ({
  padding: "12px 16px",
  borderRadius: "12px",
  border: "none",
  background,
  color: "white",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: "700",
  boxShadow: "0 8px 20px rgba(0,0,0,0.18)"
});

const smallButtonStyle = (background) => ({
  padding: "8px 12px",
  borderRadius: "10px",
  border: "none",
  background,
  color: "white",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: "700"
});

const statusBarStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
  padding: "12px 14px",
  background: "rgba(30, 41, 59, 0.8)",
  borderRadius: "14px",
  color: "#cbd5e1",
  fontSize: "14px",
  border: "1px solid #334155"
};

const approvalWaitingStyle = {
  marginTop: "14px",
  padding: "14px",
  borderRadius: "14px",
  background: "rgba(245, 158, 11, 0.15)",
  border: "1px solid rgba(245, 158, 11, 0.35)",
  color: "#fbbf24",
  textAlign: "center",
  fontWeight: "700"
};

const hostApprovalBoxStyle = {
  marginTop: "16px",
  padding: "16px",
  borderRadius: "16px",
  background: "rgba(30, 41, 59, 0.9)",
  border: "1px solid rgba(245, 158, 11, 0.35)"
};

const hostApprovalTitleStyle = {
  fontSize: "18px",
  fontWeight: "700",
  color: "#fbbf24",
  marginBottom: "12px"
};

const cardStyle = {
  background: "rgba(15, 23, 42, 0.75)",
  padding: "16px",
  borderRadius: "24px",
  border: "1px solid rgba(148, 163, 184, 0.15)",
  backdropFilter: "blur(12px)",
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.25)"
};

const translationFeedCardStyle = {
  background: "rgba(15, 23, 42, 0.75)",
  padding: "16px",
  borderRadius: "24px",
  border: "1px solid rgba(148, 163, 184, 0.15)",
  backdropFilter: "blur(12px)",
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.25)",
  marginBottom: "20px"
};

const videoHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "12px",
  fontSize: "18px",
  fontWeight: "700",
  gap: "10px",
  flexWrap: "wrap"
};

const pillStyle = (background) => ({
  background,
  color: "white",
  fontSize: "12px",
  padding: "6px 10px",
  borderRadius: "999px",
  fontWeight: "700"
});

const videoWrapperStyle = {
  position: "relative",
  width: "100%",
  borderRadius: "18px",
  overflow: "hidden",
  background: "black"
};

const videoStyle = {
  width: "100%",
  display: "block",
  background: "black",
  borderRadius: "18px",
  minHeight: "220px",
  objectFit: "cover"
};

const subtitleOverlayStyle = {
  position: "absolute",
  left: "50%",
  bottom: "18px",
  transform: "translateX(-50%)",
  width: "88%",
  minHeight: "34px",
  padding: "12px 16px",
  borderRadius: "14px",
  background: "rgba(0, 0, 0, 0.68)",
  color: "#ffffff",
  textAlign: "center",
  fontSize: "18px",
  fontWeight: "700",
  lineHeight: "1.45",
  textShadow: "0 2px 4px rgba(0,0,0,0.85)",
  pointerEvents: "none",
  wordBreak: "break-word",
  backdropFilter: "blur(6px)"
};

const subtitleFeedStyle = {
  minHeight: "180px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(2, 6, 23, 0.8)",
  borderRadius: "18px",
  border: "1px solid #334155",
  padding: "24px"
};

const bigSubtitleStyle = {
  fontSize: "26px",
  lineHeight: "1.5",
  fontWeight: "700",
  textAlign: "center",
  color: "#f8fafc"
};

const panelStyle = {
  background: "rgba(15, 23, 42, 0.7)",
  border: "1px solid rgba(148, 163, 184, 0.15)",
  borderRadius: "20px",
  padding: "18px",
  backdropFilter: "blur(10px)"
};

const panelTitleStyle = {
  marginBottom: "14px",
  fontSize: "20px",
  fontWeight: "700"
};

const participantItemStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 0",
  borderBottom: "1px solid rgba(148, 163, 184, 0.15)"
};

const requestItemStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
  padding: "12px 0",
  borderBottom: "1px solid rgba(148, 163, 184, 0.15)",
  flexWrap: "wrap"
};

const participantNameStyle = {
  fontSize: "16px",
  fontWeight: "700"
};

const participantSubStyle = {
  fontSize: "13px",
  color: "#94a3b8",
  marginTop: "4px"
};

const statusDotStyle = (color) => ({
  width: "12px",
  height: "12px",
  borderRadius: "50%",
  background: color,
  boxShadow: `0 0 10px ${color}`
});

const chatPanelStyle = {
  background: "rgba(15, 23, 42, 0.72)",
  border: "1px solid rgba(148, 163, 184, 0.15)",
  borderRadius: "22px",
  padding: "18px",
  minHeight: "780px",
  display: "flex",
  flexDirection: "column",
  backdropFilter: "blur(10px)",
  boxShadow: "0 12px 30px rgba(0,0,0,0.25)"
};

const chatMessagesBoxStyle = {
  flex: 1,
  overflowY: "auto",
  background: "rgba(2, 6, 23, 0.65)",
  borderRadius: "16px",
  padding: "12px",
  border: "1px solid #334155",
  marginBottom: "14px",
  minHeight: "500px",
  maxHeight: "640px"
};

const chatInputRowStyle = {
  display: "flex",
  gap: "10px",
  marginBottom: "16px"
};

const chatInputStyle = {
  flex: 1,
  padding: "12px 14px",
  borderRadius: "12px",
  border: "1px solid #475569",
  background: "#0f172a",
  color: "white",
  outline: "none",
  fontSize: "14px"
};

const meetingLinkBoxStyle = {
  background: "rgba(2, 6, 23, 0.65)",
  borderRadius: "16px",
  border: "1px solid #334155",
  padding: "14px"
};

const meetingLinkTitleStyle = {
  fontSize: "14px",
  fontWeight: "700",
  color: "#cbd5e1",
  marginBottom: "8px"
};

const meetingLinkTextStyle = {
  fontSize: "13px",
  color: "#93c5fd",
  wordBreak: "break-all",
  lineHeight: "1.5"
};

const emptyTextStyle = {
  color: "#94a3b8",
  textAlign: "center",
  padding: "20px 0"
};