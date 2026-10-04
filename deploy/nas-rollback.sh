#!/bin/sh
# TOEFL Lab 回滚：把 .env 标签切回旧版本镜像并重建容器。
# 用法（在 NAS 上）：sudo sh deploy/nas-rollback.sh <旧版本标签，如 2026-10-04.r1>
set -eu
[ "$#" -eq 1 ] || { echo "用法: $0 <旧版本标签>" >&2; exit 1; }
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"
export PATH=/usr/local/bin:$PATH

docker image inspect "toefl-lab:$VER" >/dev/null 2>&1 || { echo "错误：本机没有镜像 toefl-lab:$VER（docker images 看一下）" >&2; exit 1; }
sed -i "s/^TOEFLAB_TAG=.*/TOEFLAB_TAG=$VER/" "$ENV_FILE"
grep -q "^TOEFLAB_TAG=$VER\$" "$ENV_FILE" || { echo "错误：.env 标签更新失败" >&2; exit 1; }
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate
sleep 3
PORT=$(grep -E '^TOEFLAB_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' '); PORT=${PORT:-8018}
BODY=$(curl -sk -m 8 "https://127.0.0.1:$PORT/api/health" 2>/dev/null || curl -s -m 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
echo "health: $BODY"
case "$BODY" in
  *"\"version\":\"$VER\""*) echo "回滚完成：$VER 已上线" ;;
  *) echo "注意：health 版本与 $VER 不一致，检查 docker logs toefl-lab" >&2; exit 2 ;;
esac
