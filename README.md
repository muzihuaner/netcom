基于互联网的模拟对讲通联平台
================================

NetCom 是一个基于 WebRTC + WebSockets 的去中心化模拟对讲系统。用户在浏览器中即可体验频道切换、按键通话（PTT）与实时节点发现，模拟传统无线对讲机的交互体验。
![netcom.quickso.cn_(Surface Duo).png](https://files.seeusercontent.com/2026/04/01/sI2t/netcomquicksocn_Surface-Duo.png)

## ✨ 功能亮点

- **PTT 严格按键逻辑**：支持空格键长按 / 鼠标长按触发发射，松开即结束，实时显示波形动画。
- **频道隔离**：支持任意频率输入（可手动输入或 ±0.005 MHz 微调），只有位于相同频率的节点可以互通语音。
- **节点发现与在线状态**：实时推送加入/离开/换频道事件，显示在线节点列表并高亮同频道成员。
- **身份管理**：为每个节点生成 UUID，可在 UI 中修改昵称，实时同步到其他节点。
- **错误提示**：当浏览器拒绝麦克风权限时给出清晰指引，方便排查。
- **真实 WebRTC 媒体流**：基于 RTCPeerConnection 建立点对点连接，实现低延迟高质量的语音转发；自动管理同频道节点的连接生命周期，同时避免本地回放自身音频，体验更接近实体对讲机。
- **频道占用提示**：实时显示频率占用指示灯（绿色=空闲，红色脉冲=繁忙），尝试在已占用频率说话时播放繁忙提示音。

## 🏗️ 架构概述

```
┌────────────┐        ┌──────────────┐        ┌────────────┐
│  Browser A │◄──────►│  Socket.io   │◄──────►│  Browser B │
│  React UI  │  ws    │  Signaling   │  ws    │  React UI  │
└────────────┘        └──────────────┘        └────────────┘
        │                       │                        │
        └──── WebRTC/Audio ─────┴──── WebRTC/Audio ──────┘ (未来可扩展)
```

- **信令层**：使用 Socket.io 实现节点上线、频道切换、PTT 状态广播和 WebRTC 信令交换（offer/answer/ICE candidate）。
- **发现机制**：服务器维护一份在线节点 Map，任何状态变化都会广播 `discovery:update` 给所有客户端。
- **音频通路**：使用 WebRTC 建立点对点媒体流连接，实现低延迟、高质量的语音转发；同频道节点自动建立 RTC 连接，断开连接时自动清理。

## 🧰 技术栈

- **前端**：React 19、Vite 6、Tailwind（通过 @tailwindcss/vite 4.x）、Lucide Icons、Framer Motion、WebRTC。
- **后端**：Node.js、Express、Socket.io，使用单个 `server.ts` 同时托管信令与前端资源。
- **音频与动画**：Web Audio API 用于音量分析，WebRTC 用于 P2P 媒体流传输，Framer Motion 提供 UI 动效。

## 🚀 快速开始

### 本地开发

```bash
cd netcom
npm install
npm run dev  # http://localhost:3000
```

> 默认 `NODE_ENV=development`，`server.ts` 会以中间件模式启动 Vite。生产构建可使用 `npm run build && NODE_ENV=production node dist/server.js`（自行配置打包输出）。

### Docker 部署

#### 方式一：使用 docker-compose（推荐）

最简单的方式，一条命令启动整个应用：

```bash
docker-compose up -d
```

然后访问 `http://localhost:3000`

查看日志：
```bash
docker-compose logs -f netcom
```

停止服务：
```bash
docker-compose down
```

#### 方式二：手动构建和运行

**构建镜像**：
```bash
docker build -t netcom:latest .
```

**运行容器**：
```bash
docker run -d \
  --name netcom \
  -p 3000:3000 \
  -e NODE_ENV=production \
  netcom:latest
```

**运行参数解释**：
- `-d` 后台运行
- `--name netcom` 容器名称
- `-p 3000:3000` 端口映射（主机:容器）
- `-e NODE_ENV=production` 设置生产环境
- `netcom:latest` 镜像名称和标签

**查看容器日志**：
```bash
docker logs -f netcom
```

**停止容器**：
```bash
docker stop netcom
docker rm netcom
```

#### Docker 注意事项

- 镜像基于 `node:20-alpine`，体积约 200MB
- 内部暴露端口为 3000
- 支持 WebRTC 和 WebSocket，需要确保防火墙允许这些协议
- 如果在云服务器运行，需要配置正确的 STUN 服务器地址

**多节点本地测试**（Docker）：

在同一网络中启动多个容器：
```bash
# 创建自定义网络
docker network create netcom-network

# 启动多个容器
docker run -d --name netcom1 --network netcom-network -p 3001:3000 netcom:latest
docker run -d --name netcom2 --network netcom-network -p 3002:3000 netcom:latest
docker run -d --name netcom3 --network netcom-network -p 3003:3000 netcom:latest

# 在浏览器中访问
# http://localhost:3001
# http://localhost:3002
# http://localhost:3003
```

## 🕹️ 使用指南

1. 打开多个浏览器标签页访问 `http://localhost:3000`，每个标签页代表一个节点。
2. 点击“编辑”按钮可修改昵称，保存后所有节点即时同步。
3. 在“频率选择”区域输入目标频率（MHz），或者使用 ±0.005 MHz 按钮微调，点击“应用”后即切换到该频率。
4. 按住空格或长按中央 PTT 按钮发射（移动端支持触摸按压），松开即可停止；自身不会回放说话声音，同频率其他节点会显示来电状态。
5. 节点列表会显示在线节点数量，并高亮与自己同频道的节点。

## 🧪 开发脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Express + Vite 开发服务器（含 Socket.io 信令） |
| `npm run build` | 构建前端产物到 dist 目录 |
| `npm run preview` | 使用 Vite Preview 预览构建结果 |
| `npm run lint` | TypeScript 类型检查 |
| `npm run clean` | 删除 dist 目录 |
| `NODE_ENV=production node --import tsx server.ts` | 生产环境运行（需先执行 npm run build） |

## 🐳 Docker 部署参考文件

- `Dockerfile` - 多阶段构建（开发 → 生产）
- `.dockerignore` - Docker 构建时忽略的文件
- `docker-compose.yml` - Docker Compose 配置文件


## ❓ 常见问题 (FAQ)

### Docker 相关

**Q: Docker 镜像大小？**  
A: 约 200MB（基于 Alpine 优化）。使用多阶段构建减少最终镜像大小。

**Q: 如何在生产环境使用自定义 STUN 服务器配置？**  
A: 在 `src/App.tsx` 的 `createPeerConnection` 中修改 `iceServers` 配置，或通过环境变量动态传入 STUN 地址。

**Q: 多个容器实例如何共享状态？**  
A: 目前每个实例维护独立状态。若需要跨实例同步（如分布式部署），建议引入 Redis 或中心数据库存储频道、节点状态。

### 生产部署

**Q: 如何在 HTTPS 环境运行？**  
A: 在反向代理（如 Nginx）配置 HTTPS，WebRTC 和 WebSocket 需要 HTTPS 或本地 localhost。示例 Nginx 配置可参考独立文档。

**Q: 支持生产级扩展吗？**  
A: 可通过 Nginx/Traefik 等反向代理负载均衡多个 NetCom 实例，但需在应用层实现状态同步（引入消息队列或数据库）。

**Q: 如何监控应用健康状态？**  
A: Docker Compose 中包含 healthcheck 配置（`wget http://localhost:3000`），可基于此实现自动重启和监控。

### WebRTC 相关

**Q: 为什么无法建立 P2P 连接？**  
A: 检查以下几点：
- STUN 服务器是否可达（当前使用 stun.l.google.com）
- 防火墙是否允许 UDP 出站
- 浏览器是否支持 WebRTC（Chrome、Firefox、Safari 等）
- 同频道节点是否在线

**Q: 同频道最多可以有多少个节点同时说话？**  
A: 理论上支持 N 个节点，但受网络带宽和浏览器 WebRTC 实现限制。建议测试场景中控制在 5-10 个节点。

**Q: 跨域名/IP 使用会怎样？**  
A: 不同源需要配置 CORS（已在 `server.ts` 中启用）。WebRTC 连接不受同源限制，但 Socket.io 需要 CORS 支持。

### 故障排查

**连接失败**：检查浏览器控制台的 WebSocket 连接、防火墙、STUN 服务器。

**没有声音**：确认麦克风权限已授予、检查 WebRTC offers/answers 是否正确交换。

**CPU 占用高**：可能是音频处理循环或 WebRTC 编码压力，建议减少同时连接的节点数。

---

欢迎 Fork/PR，一起完善这款“互联网对讲机”。