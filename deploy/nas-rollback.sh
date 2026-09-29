#!/bin/sh
# 回滚：镜像仍在 NAS 本地 → 把 tag 切回已存在的镜像 → 重建 → **同一套版本断言**。
# 不重新构建，所以秒级完成；`docker images englishforge` 可以看有哪些可回滚版本。
# 用法：sudo sh deploy/nas-rollback.sh <旧版本标签>
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <旧版本标签>" >&2
  exit 1
fi
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"

export PATH=/usr/local/bin:$PATH

docker image inspect "englishforge:$VER" >/dev/null 2>&1 || { echo "错误：本地没有镜像 englishforge:$VER" >&2; exit 1; }
grep -q "^ENGLISHFORGE_TAG=" "$ENV_FILE" || { echo "错误：.env 缺少 ENGLISHFORGE_TAG 行" >&2; exit 1; }
sed -i "s/^ENGLISHFORGE_TAG=.*/ENGLISHFORGE_TAG=$VER/" "$ENV_FILE"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

PORT=$(grep -E '^ENGLISHFORGE_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-4173}
i=0
while [ $i -lt 60 ]; do
  # 同 nas-update.sh：探针必须带硬超时（loopback 上偶发卡死，历史上吃掉过 145 秒）
  BODY=$(curl -sk -m 8 "https://127.0.0.1:$PORT/api/health" 2>/dev/null) || BODY=""
  if [ -z "$BODY" ]; then
    BODY=$(wget -T 8 -qO- --no-check-certificate "https://127.0.0.1:$PORT/api/health" 2>/dev/null) || BODY=""
  fi
  if [ -z "$BODY" ]; then
    BODY=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  fi
  case "$BODY" in
    *"\"version\":\"$VER\""*)
      echo "完成：已回滚到 $VER（数据卷不动，进度不丢）"
      exit 0
      ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "错误：回滚健康检查超时，查看日志：docker logs englishforge" >&2
exit 2
