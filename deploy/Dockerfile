# EnglishForge 生产镜像：多阶段构建（构建工具不进最终镜像）。
# 与 MyInfobase 同一套 NAS 部署模式：镜像在群晖上 docker build（共享目录里就是源码，无需上传发布包）。
# 运行层用 vite preview 提供静态文件 + /api（同一进程，与 start.bat 本地同一条路）。
# build 需要 devDependencies（vite/tsc 都在 dev 里），所以两层都装全量依赖。
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --no-fund --no-audit
COPY index.html vite.config.ts vite-plugin-db.mjs tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Shanghai
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --no-fund --no-audit && npm cache clean --force
COPY --from=build /build/dist ./dist
# vite preview 启动时要加载 vite.config.ts（/api 插件在里面），server/ 是插件运行时引用的实现
COPY vite.config.ts vite-plugin-db.mjs index.html ./
COPY server ./server
# 生产数据库通过挂载提供（compose 里 ENGLISHFORGE_DB=/app/data/englishforge.db）
ENV ENGLISHFORGE_DB=/app/data/englishforge.db
VOLUME ["/app/data"]
EXPOSE 4173
USER node
HEALTHCHECK --interval=60s --timeout=8s --start-period=90s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4173}/api/health" >/dev/null 2>&1 || exit 1
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
