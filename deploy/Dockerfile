# EnglishForge 生产镜像：多阶段构建（构建工具不进最终镜像）。
# 与 MyInfobase 同一套 NAS 部署模式：镜像在群晖上 docker build（共享目录里就是源码，无需上传发布包）。
# 运行层用 vite preview 提供静态文件 + /api（同一进程，与 start.bat 本地同一条路）。
# build 需要 devDependencies（vite/tsc 都在 dev 里），所以两层都装全量依赖。
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --no-fund --no-audit
COPY index.html vite.config.ts vite-plugin-db.mjs vite-plugin-db.d.mts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Shanghai
# compose 用 user: 1026:100 覆盖镜像的 node 用户，HOME 会落回 / ——
# 显式指到可写目录，避免 npm/npx 在 /.npm 上 EACCES（实测容器起不来的原因）
ENV HOME=/tmp
WORKDIR /app
# vite 是 devDependency，而本阶段 NODE_ENV=production 会让 npm ci 跳过它（实测容器起不来的第二个原因）
# → 直接从构建阶段拷全量 node_modules，运行层不再跑 npm ci
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
# vite preview 启动时要加载 vite.config.ts（/api 插件在里面），server/ 是插件运行时引用的实现
COPY vite.config.ts vite-plugin-db.mjs vite-plugin-db.d.mts index.html package.json package-lock.json ./
COPY server ./server
# 生产数据库通过挂载提供（compose 里 ENGLISHFORGE_DB=/app/data/englishforge.db）
ENV ENGLISHFORGE_DB=/app/data/englishforge.db
VOLUME ["/app/data"]
EXPOSE 4173
USER node
HEALTHCHECK --interval=60s --timeout=8s --start-period=90s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4173}/api/health" >/dev/null 2>&1 || exit 1
# 直接用 node 跑 vite 入口（不经 npx/npm，运行时不需要任何缓存目录）
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
