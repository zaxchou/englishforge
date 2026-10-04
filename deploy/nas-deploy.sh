#!/bin/sh
# TOEFL Lab NAS 部署/更新（沿用 EnglishForge 方法论：发布包镜像 → 换 tag → 重建容器 →
# 带版本断言的健康检查。没有确认线上版本 = 请求版本，就不算成功）。
#
# 用法（在 NAS 上，共享目录已在 NAS 本地盘，无需先做文件同步）：
#   sudo sh deploy/nas-deploy.sh <版本标签，如 2026-10-04.r1>   # 首次部署/更新
#   sudo sh deploy/nas-rollback.sh                              # 回滚见 deploy/README.md
#
# 前置（开发机，无需 sudo）：
#   sh deploy/prepare-release.sh <版本标签>   # 整理 releases/<版本>/ 发布包 + 种子 records
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <版本标签，如 2026-10-04.r1>" >&2
  exit 1
fi
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
REL="$PROJ/releases/$VER"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"

# Synology 非交互 shell 的 PATH 不含 docker（/usr/local/bin），必须补
export PATH=/usr/local/bin:$PATH
command -v docker >/dev/null || { echo "错误：找不到 docker（需要 ContainerManager 套件）" >&2; exit 1; }

[ -d "$REL" ] || { echo "错误：$REL 不存在。先在开发机跑：sh deploy/prepare-release.sh $VER" >&2; exit 1; }
[ -f "$REL/manifest.release.json" ] || { echo "错误：$REL 不是有效发布包（缺 manifest.release.json）" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "错误：$ENV_FILE 不存在" >&2; exit 1; }
grep -q "^TOEFLAB_TAG=" "$ENV_FILE" || { echo "错误：.env 缺少 TOEFLAB_TAG 行" >&2; exit 1; }

echo "== 部署 toefl-lab $VER =="
T0=$(date +%s)

# 磁盘粗检（镜像约 300MB，留 1GB 余量）
AVAIL_KB=$(df -Pk /volume2 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 1048576 ]; then
  echo "错误：/volume2 可用空间不足 1GB（${AVAIL_KB}KB）" >&2
  exit 1
fi

echo "[1/4] 构建镜像 toefl-lab:$VER（纯搬运，无编译，应很快）"
# Dockerfile 在 deploy/（部署资产不进发布包），构建上下文 = 发布包目录
docker build -f "$PROJ/deploy/Dockerfile" -t "toefl-lab:$VER" "$REL"
T1=$(date +%s)

echo "[2/4] 更新 .env 版本标签"
sed -i "s/^TOEFLAB_TAG=.*/TOEFLAB_TAG=$VER/" "$ENV_FILE"
grep -q "^TOEFLAB_TAG=$VER\$" "$ENV_FILE" || { echo "错误：.env 标签更新失败" >&2; exit 1; }

echo "[3/4] 重建容器"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate
T2=$(date +%s)

echo "[4/4] 健康检查 + 版本断言"
PORT=$(grep -E '^TOEFLAB_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-8018}
i=0
while [ $i -lt 60 ]; do
  BODY=$(curl -sk -m 8 "https://127.0.0.1:$PORT/api/health" 2>/dev/null) || BODY=""
  if [ -z "$BODY" ]; then
    BODY=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null) || BODY=""
  fi
  if [ -z "$BODY" ]; then
    # 宿主机端口在重建窗口期可能抖动，容器内探针兜底（绕过端口映射）
    BODY=$(docker exec toefl-lab wget -qO- --no-check-certificate "https://127.0.0.1:8018/api/health" 2>/dev/null \
      || docker exec toefl-lab wget -qO- "http://127.0.0.1:8018/api/health" 2>/dev/null) || BODY=""
  fi
  case "$BODY" in
    *'"ok":true'*)
      case "$BODY" in
        *"\"version\":\"$VER\""*)
          T3=$(date +%s)
          echo "完成：健康检查与版本断言通过，$VER 已上线（https://$(grep -E '^NAS_IP=' "$ENV_FILE" | cut -d= -f2):$PORT）"
          echo "阶段耗时：构建 $((T1-T0))s · 换标签 $((T2-T1))s · 重建+断言 $((T3-T2))s · 总计 $((T3-T0))s"
          exit 0
          ;;
        *)
          echo "错误：health 版本与 $VER 不一致（容器没换完或镜像里 VERSION 不对）：$BODY" >&2
          exit 2
          ;;
      esac
      ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "错误：健康检查超时（2 分钟），查看日志：sudo docker logs toefl-lab" >&2
exit 2
