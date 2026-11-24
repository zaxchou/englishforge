# TOEFL Lab 生产镜像。
# 与 EnglishForge 同方法论：不在 NAS 上构建任何东西——发布包（releases/<版本>/）
# 由开发机整理好、经共享目录已在 NAS 本地盘上，镜像只做搬运。
# 本服务零 npm 依赖（纯 node server.mjs），没有依赖安装层。
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai
# 与 .env 的 CONTAINER_UID/GID 一致。复制时设置属主，避免递归 chown 再写一层。
# records/ 由 compose 挂载进来，写权限由宿主目录决定。
ARG CONTAINER_UID=1026
ARG CONTAINER_GID=100
COPY --chown=${CONTAINER_UID}:${CONTAINER_GID} server.mjs review-hub.mjs course-plan.mjs root-practice.mjs root-dict.mjs lesson-vocab.mjs number-trainer.mjs number-trainer-store.mjs number-trainer-audio.mjs VERSION ./
COPY --chown=${CONTAINER_UID}:${CONTAINER_GID} web ./web
COPY --chown=${CONTAINER_UID}:${CONTAINER_GID} data ./data
COPY --chown=${CONTAINER_UID}:${CONTAINER_GID} build ./build
COPY --chown=${CONTAINER_UID}:${CONTAINER_GID} root-universe ./root-universe
COPY --chown=${CONTAINER_UID}:${CONTAINER_GID} pipeline/root-universe/validate-kit.cjs ./pipeline/root-universe/validate-kit.cjs
EXPOSE 8018
USER ${CONTAINER_UID}:${CONTAINER_GID}
# 自签 TLS 下健康探针要 --no-check-certificate；两种协议都试，先 https 后 http
HEALTHCHECK --interval=60s --timeout=8s --start-period=30s --retries=3 \
  CMD (wget -qO- --no-check-certificate "https://127.0.0.1:8018/api/health" 2>/dev/null || wget -qO- "http://127.0.0.1:8018/api/health" 2>/dev/null) | grep -q '"ok":true' || exit 1
CMD ["node", "server.mjs", "--port", "8018"]
