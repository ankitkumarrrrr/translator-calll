const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("AI Translator Video Call server is running");
});

app.get("/translate", async (req, res) => {
  try {
    const { text, target } = req.query;

    if (!text || !target) {
      return res.status(400).json({ error: "text and target are required" });
    }

    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
        target
      )}&dt=t&q=${encodeURIComponent(text)}`;

    const response = await fetch(url);
    const data = await response.json();

    const translated = Array.isArray(data?.[0])
      ? data[0].map((item) => item[0]).join("")
      : text;

    res.json({ translated });
  } catch (error) {
    console.error("Translate error:", error);
    res.status(500).json({ error: "Translation failed" });
  }
});

const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || "*";

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ["GET", "POST"]
  }
});

/*
rooms[roomId] = {
  ownerId: socketId,
  approved: [socketId],
  pending: [{ socketId, name }],
  names: { [socketId]: name }
}
*/
const rooms = {};

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      ownerId: null,
      approved: [],
      pending: [],
      names: {}
    };
  }
  return rooms[roomId];
}

function getRoomState(roomId) {
  const room = rooms[roomId];

  if (!room) {
    return {
      roomId,
      ownerId: null,
      pending: [],
      participants: []
    };
  }

  return {
    roomId,
    ownerId: room.ownerId,
    pending: room.pending,
    participants: room.approved.map((socketId) => ({
      socketId,
      name: room.names[socketId] || "Guest"
    }))
  };
}

function emitRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const state = getRoomState(roomId);

  room.approved.forEach((socketId) => {
    io.to(socketId).emit("room-state", state);
  });

  if (room.ownerId) {
    io.to(room.ownerId).emit("room-state", state);
  }
}

function removeSocketFromRoom(roomId, socketId) {
  const room = rooms[roomId];
  if (!room) return;

  room.approved = room.approved.filter((id) => id !== socketId);
  room.pending = room.pending.filter((item) => item.socketId !== socketId);
  delete room.names[socketId];

  if (room.ownerId === socketId) {
    room.ownerId = room.approved.length > 0 ? room.approved[0] : null;
    if (room.ownerId) {
      io.to(room.ownerId).emit("owner-changed", {
        roomId,
        ownerId: room.ownerId
      });
    }
  }

  io.to(roomId).emit("participant-left", {
    socketId
  });

  if (room.approved.length === 0 && room.pending.length === 0) {
    delete rooms[roomId];
  } else {
    emitRoomState(roomId);
  }
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room-request", ({ roomId, name }) => {
    const room = ensureRoom(roomId);
    const safeName = (name || "Guest").trim() || "Guest";

    room.names[socket.id] = safeName;

    if (!room.ownerId) {
      room.ownerId = socket.id;
      room.approved.push(socket.id);
      socket.join(roomId);

      socket.emit("joined-room-approved", {
        roomId,
        ownerId: room.ownerId
      });

      socket.emit("existing-participants", {
        participants: []
      });

      emitRoomState(roomId);
      return;
    }

    if (room.approved.includes(socket.id)) {
      socket.emit("joined-room-approved", {
        roomId,
        ownerId: room.ownerId
      });

      const existingParticipants = room.approved
        .filter((id) => id !== socket.id)
        .map((id) => ({
          socketId: id,
          name: room.names[id] || "Guest"
        }));

      socket.emit("existing-participants", {
        participants: existingParticipants
      });

      emitRoomState(roomId);
      return;
    }

    const alreadyPending = room.pending.some((item) => item.socketId === socket.id);
    if (!alreadyPending) {
      room.pending.push({
        socketId: socket.id,
        name: safeName
      });
    }

    io.to(room.ownerId).emit("join-request", {
      roomId,
      socketId: socket.id,
      name: safeName
    });

    socket.emit("waiting-for-approval", {
      roomId
    });

    emitRoomState(roomId);
  });

  socket.on("approve-user", ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.ownerId !== socket.id) return;

    const pendingUser = room.pending.find((item) => item.socketId === targetSocketId);
    if (!pendingUser) return;

    room.pending = room.pending.filter((item) => item.socketId !== targetSocketId);

    if (!room.approved.includes(targetSocketId)) {
      room.approved.push(targetSocketId);
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.join(roomId);

      targetSocket.emit("joined-room-approved", {
        roomId,
        ownerId: room.ownerId
      });

      const existingParticipants = room.approved
        .filter((id) => id !== targetSocketId)
        .map((id) => ({
          socketId: id,
          name: room.names[id] || "Guest"
        }));

      targetSocket.emit("existing-participants", {
        participants: existingParticipants
      });

      socket.to(roomId).emit("participant-joined", {
        socketId: targetSocketId,
        name: room.names[targetSocketId] || "Guest"
      });

      io.to(roomId).emit("system-message", {
        text: `${room.names[targetSocketId] || "Guest"} joined the room`,
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })
      });
    }

    emitRoomState(roomId);
  });

  socket.on("reject-user", ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.ownerId !== socket.id) return;

    room.pending = room.pending.filter((item) => item.socketId !== targetSocketId);

    io.to(targetSocketId).emit("join-rejected", {
      roomId
    });

    emitRoomState(roomId);
  });

  socket.on("webrtc-offer", ({ target, sdp, callerName }) => {
    io.to(target).emit("webrtc-offer", {
      sdp,
      caller: socket.id,
      callerName
    });
  });

  socket.on("webrtc-answer", ({ target, sdp }) => {
    io.to(target).emit("webrtc-answer", {
      sdp,
      answerer: socket.id
    });
  });

  socket.on("webrtc-ice-candidate", ({ target, candidate }) => {
    io.to(target).emit("webrtc-ice-candidate", {
      candidate,
      from: socket.id
    });
  });

  socket.on("chat-message-room", ({ roomId, text, senderName }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.approved.includes(socket.id)) return;
    if (!text || !text.trim()) return;

    io.to(roomId).emit("chat-message-room", {
      senderId: socket.id,
      senderName: senderName || room.names[socket.id] || "Guest",
      text: text.trim(),
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })
    });
  });

  socket.on("send-translated-message", (payload) => {
    const { roomId, originalText, translatedText, fromLang, toLang, senderName } =
      payload;

    const room = rooms[roomId];
    if (!room) return;
    if (!room.approved.includes(socket.id)) return;

    io.to(roomId).emit("receive-translated-message", {
      originalText,
      translatedText,
      fromLang,
      toLang,
      senderName: senderName || room.names[socket.id] || "Guest",
      from: socket.id
    });
  });

  socket.on("leave-room", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const leavingName = room.names[socket.id] || "Guest";
    socket.leave(roomId);
    removeSocketFromRoom(roomId, socket.id);

    if (rooms[roomId]) {
      io.to(roomId).emit("system-message", {
        text: `${leavingName} left the room`,
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      const exists =
        room.approved.includes(socket.id) ||
        room.pending.some((item) => item.socketId === socket.id);

      if (exists) {
        const leavingName = room.names[socket.id] || "Guest";
        removeSocketFromRoom(roomId, socket.id);

        if (rooms[roomId]) {
          io.to(roomId).emit("system-message", {
            text: `${leavingName} disconnected`,
            time: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit"
            })
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});