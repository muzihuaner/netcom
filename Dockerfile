# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci

# 复制源代码
COPY . .

# 构建前端产物
RUN npm run build

# 生产阶段
FROM node:20-alpine

WORKDIR /app

# 安装 dumb-init 来优雅处理信号
RUN apk add --no-cache dumb-init

# 复制 package 文件
COPY package*.json ./

# 仅安装生产依赖
RUN npm ci --only=production

# 从构建阶段复制构建产物
COPY --from=builder /app/dist ./dist

# 复制源代码中的必要文件
COPY server.ts tsconfig.json ./
COPY src ./src

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# 使用 dumb-init 作为 PID 1
ENTRYPOINT ["dumb-init", "--"]

# 启动命令
CMD ["node", "--import", "tsx", "server.ts"]
