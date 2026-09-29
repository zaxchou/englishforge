# englishforge 生产镜像（单阶段：**不在 NAS 上编译** —— 方法论见 MyInfobase/docs/deploy-handoff.md）
#
# dist 由开发机预编译、随发布包发（scripts/release.mjs 现场跑 tsc -b + vite build），
# 镜像只搬运：
#   1) COPY package.json/lock —— 内容每次发版恒定（release 脚本把 version 归一 0.0.0 并断言），
#      所以这一层之后的 npm ci **缓存永久命中**，部署不再重跑依赖安装；
#   2) COPY dist / VERSION / 运行时文件 —— 每次发版只打掉这些便宜层。
# 注意两个踩过的坑：
#   · vite 是 devDependency（vite preview 要靠它跑 /api 插件），**不能 --omit=dev**；
#   · NODE_ENV=production 必须放在 npm ci **之后** —— 放前面 npm 会跳过 devDependencies（容器曾因此起不来）。
#   · compose 用 user:1026 覆盖镜像用户 → HOME 会落回 /，显式指到可写目录（vite 写 .vite-temp）。
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# 使用国内镜像源避免 npmjs 直连超时
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --no-fund --no-audit && npm cache clean --force
ENV NODE_ENV=production TZ=Asia/Shanghai
ENV HOME=/tmp
COPY dist ./dist
# VERSION 放在依赖层之后：它每次发版都变，只应打掉本来就必变的层
COPY VERSION ./
# vite preview 启动时加载 vite.config.ts（/api 插件），server/ 是插件运行时引用的实现
COPY vite.config.ts vite-plugin-db.mjs vite-plugin-db.d.mts index.html ./
COPY server ./server
# 生产数据库通过挂载提供（compose 里 ENGLISHFORGE_DB=/app/data/englishforge.db）
ENV ENGLISHFORGE_DB=/app/data/englishforge.db
VOLUME ["/app/data"]
# 容器以 compose 的 user:1026 运行，而 COPY 的文件属 root —— vite 加载 TS 配置时把打包结果
# 写到 **vite.config.ts 旁边**（/app/ 目录本身），非 root 写不进去 → EACCES 崩溃循环
# （与 node_modules/.vite-temp 同族的坑，上一版镜像就是这么挂的）。整体交给容器运行身份。
# UID/GID 默认值 = .env 的 CONTAINER_UID/GID（zaxchou 1026:100，已核实）；若改身份要传 --build-arg。
ARG CONTAINER_UID=1026
ARG CONTAINER_GID=100
RUN chown -R ${CONTAINER_UID}:${CONTAINER_GID} /app
EXPOSE 4173
USER node
HEALTHCHECK --interval=60s --timeout=8s --start-period=90s --retries=3 \
  CMD wget -qO- --no-check-certificate "https://127.0.0.1:${PORT:-4173}/api/health" >/dev/null 2>&1 \
    || wget -qO- "http://127.0.0.1:${PORT:-4173}/api/health" >/dev/null 2>&1 || exit 1
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
