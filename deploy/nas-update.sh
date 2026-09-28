#!/bin/sh
# NAS 版本更新：从项目目录构建指定标签的镜像并重建容器，然后做健康检查。
# 用法（在 NAS 上）：sudo sh deploy/nas-update.sh <git短哈希或标签>
# 说明：源码经共享目录已自动同步到 NAS（/volume2/Media/...），无需上传发布包；
#       本 NAS 的 docker 需要 root；非登录 shell 要手动补 PATH（脚本里已处理）。
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <版本标签，如 git 短哈希 4cf9d4c>" >&2
  exit 1
fi
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"

export PATH=/usr/local/bin:$PATH

[ -f "$ENV_FILE" ] || { echo "错误：$ENV_FILE 不存在，先完成首次部署配置（复制 .env.example）" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "错误：$COMPOSE_FILE 不存在（把 deploy/compose.yaml 复制过去）" >&2; exit 1; }
[ -f "$PROJ/package.json" ] || { echo "错误：$PROJ 不像项目根目录" >&2; exit 1; }

echo "== 更新 englishforge -> $VER =="

# 磁盘粗检（构建需约 1GB 余量）
AVAIL_KB=$(df -Pk "$PROJ" | awk 'NR==2 {print $4}')
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 1048576 ]; then
  echo "错误：可用空间不足 1GB（${AVAIL_KB}KB）" >&2
  exit 1
fi

echo "[1/4] 构建镜像 englishforge:$VER（在 NAS 上 npm ci + build，约几分钟）"
# Dockerfile 在 deploy/ 下，上下文用整个项目根（.dockerignore 已排除 node_modules/dist/data）
docker build -f "$PROJ/deploy/Dockerfile" -t "englishforge:$VER" "$PROJ"

echo "[2/4] 更新 .env 版本标签"
sed -i "s/^ENGLISHFORGE_TAG=.*/ENGLISHFORGE_TAG=$VER/" "$ENV_FILE"

echo "[3/4] 重建容器"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

echo "[4/4] 健康检查"
PORT=$(grep -E '^ENGLISHFORGE_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-4173}
i=0
while [ $i -lt 60 ]; do
  # 配了 TLS 打 https（自签证书要 --no-check-certificate），否则回退 http
  BODY=$(wget -qO- --no-check-certificate "https://127.0.0.1:$PORT/api/health" 2>/dev/null \
    || wget -qO- "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  case "$BODY" in
    *'"ok":true'*)
      echo "完成：健康检查通过，$VER 已上线（http://$(grep -E '^NAS_IP=' "$ENV_FILE" | cut -d= -f2):$PORT）"
      exit 0
      ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "错误：健康检查超时（2 分钟），查看日志：docker logs englishforge" >&2
exit 2
