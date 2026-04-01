import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "0.0.0.0";

  // 模拟 MQTT 的节点发现机制
  // 存储在线节点: { socketId: { id, name, channel, ip } }
  const nodes = new Map();
  
  // 跟踪每个频道的 PTT 活跃状态: { channel: { socketId: { id, name } } }
  const channelStatus = new Map();

  io.on("connection", (socket) => {
    console.log("Node connected:", socket.id);

    // 节点上线 (模拟 MQTT Publish)
    socket.on("node:online", (nodeInfo) => {
      const info = { ...nodeInfo, socketId: socket.id };
      nodes.set(socket.id, info);
      
      // 广播给所有节点 (模拟 MQTT Subscribe)
      io.emit("discovery:update", Array.from(nodes.values()));
      console.log(`Node ${info.name} joined channel ${info.channel}`);
    });

    // 频道切换
    socket.on("node:change-channel", (newChannel) => {
      const info = nodes.get(socket.id);
      if (info) {
        info.channel = newChannel;
        nodes.set(socket.id, info);
        io.emit("discovery:update", Array.from(nodes.values()));
      }
    });

    socket.on("node:update-profile", ({ name }) => {
      const info = nodes.get(socket.id);
      if (info && name) {
        info.name = name;
        nodes.set(socket.id, info);
        io.emit("discovery:update", Array.from(nodes.values()));
      }
    });

    // PTT 信令 (模拟对讲机呼叫控制)
    socket.on("ptt:start", (data) => {
      // 广播给同一频道的其他节点
      const sender = nodes.get(socket.id);
      if (sender) {
        // 更新频道状态
        if (!channelStatus.has(sender.channel)) {
          channelStatus.set(sender.channel, new Map());
        }
        channelStatus.get(sender.channel).set(socket.id, { id: sender.id, name: sender.name });
        
        // 广播频道状态更新
        io.emit("channel:status-update", {
          channel: sender.channel,
          busy: channelStatus.get(sender.channel).size > 0,
          activeUsers: Array.from(channelStatus.get(sender.channel).values())
        });
        
        socket.to(sender.channel).emit("ptt:incoming", {
          from: sender.id,
          name: sender.name,
          channel: sender.channel
        });
      }
    });

    socket.on("ptt:stop", () => {
      const sender = nodes.get(socket.id);
      if (sender) {
        // 更新频道状态
        if (channelStatus.has(sender.channel)) {
          channelStatus.get(sender.channel).delete(socket.id);
          
          // 如果频道没有人说话了，广播更新
          const isChannelBusy = channelStatus.get(sender.channel).size > 0;
          io.emit("channel:status-update", {
            channel: sender.channel,
            busy: isChannelBusy,
            activeUsers: Array.from(channelStatus.get(sender.channel).values())
          });
        }
        
        socket.to(sender.channel).emit("ptt:ended", { from: sender.id });
      }
    });

    // 音频数据转发
    socket.on("ptt:audio", (audioData) => {
      const sender = nodes.get(socket.id);
      if (sender) {
        // 仅转发给同频道的其他节点
        socket.to(sender.channel).emit("ptt:audio", audioData);
      }
    });

    // WebRTC 信令转发 (P2P 发现后的连接建立)
    socket.on("webrtc:offer", ({ to, offer }) => {
      io.to(to).emit("webrtc:offer", { from: socket.id, offer });
    });

    socket.on("webrtc:answer", ({ to, answer }) => {
      io.to(to).emit("webrtc:answer", { from: socket.id, answer });
    });

    socket.on("webrtc:ice-candidate", ({ to, candidate }) => {
      io.to(to).emit("webrtc:ice-candidate", { from: socket.id, candidate });
    });

    socket.on("webrtc:signal", ({ to, signal }) => {
      io.to(to).emit("webrtc:signal", { from: socket.id, signal });
    });

    socket.on("disconnect", () => {
      const nodeInfo = nodes.get(socket.id);
      nodes.delete(socket.id);
      
      // 清理频道状态
      if (nodeInfo && channelStatus.has(nodeInfo.channel)) {
        channelStatus.get(nodeInfo.channel).delete(socket.id);
        const isChannelBusy = channelStatus.get(nodeInfo.channel).size > 0;
        io.emit("channel:status-update", {
          channel: nodeInfo.channel,
          busy: isChannelBusy,
          activeUsers: Array.from(channelStatus.get(nodeInfo.channel).values())
        });
      }
      
      io.emit("discovery:update", Array.from(nodes.values()));
      console.log("Node disconnected:", socket.id);
    });

    // 加入 Socket 房间以实现频道广播
    socket.on("join-room", (room) => {
      // 离开旧房间
      const currentRooms = Array.from(socket.rooms);
      currentRooms.forEach(r => {
        if (r !== socket.id) socket.leave(r);
      });
      socket.join(room);
    });
  });

  // Vite 适配
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`Intercom Server running on http://${HOST}:${PORT}`);
  });
}

startServer();
