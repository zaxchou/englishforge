#!/bin/sh
# 回滚：镜像仍在 NAS 本地，把版本标签切回旧版本并重建容器，秒级完成。
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
sed -i "s/^ENGLISHFORGE_TAG=.*/ENGLISHFORGE_TAG=$VER/" "$ENV_FILE"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate
echo "已回滚到 $VER（数据卷不动，进度不丢）"
