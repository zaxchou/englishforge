#!/bin/sh
# NAS 版本更新（方法论见 MyInfobase/docs/deploy-handoff.md）：
# 构建指定版本的**发布包镜像**（不在 NAS 上编译）→ 换 tag → 重建容器 →
# **带版本断言的健康检查**（没确认线上版本 ≠ 请求版本就不算成功）。
#
# 用法（在 NAS 上）：sudo sh deploy/nas-update.sh <git短哈希>
# 前置：开发机先跑 `node scripts/release.mjs` 生成 releases/<版本>/（源码经共享目录已同步）。
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <版本标签，如 git 短哈希 4cf9d4c>（对应 releases/<版本>/）" >&2
  exit 1
fi
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
REL="$PROJ/releases/$VER"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"

export PATH=/usr/local/bin:$PATH

[ -d "$REL" ] || { echo "错误：$REL 不存在。先在开发机跑：node scripts/release.mjs" >&2; exit 1; }
[ -f "$REL/manifest.json" ] || { echo "错误：$REL/manifest.json 不存在，不是有效发布包" >&2; exit 1; }
[ -f "$REL/VERSION" ] || { echo "错误：$REL/VERSION 缺失（程序要靠它自报版本，健康断言会失败）" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "错误：$ENV_FILE 不存在，先完成首次部署配置" >&2; exit 1; }
# sed 守卫：.env 里没有这一行时 sed 会**静默什么都不做** —— 那样会"发版成功"却跑着旧 tag
grep -q "^ENGLISHFORGE_TAG=" "$ENV_FILE" || { echo "错误：.env 缺少 ENGLISHFORGE_TAG 行" >&2; exit 1; }

echo "== 更新 englishforge -> $VER =="
sed -n '1,8p' "$REL/manifest.json"

# 磁盘粗检（构建需约 1GB 余量）
AVAIL_KB=$(df -Pk "$(dirname "$PROJ")" | awk 'NR==2 {print $4}')
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 1048576 ]; then
  echo "错误：可用空间不足 1GB（${AVAIL_KB}KB）" >&2
  exit 1
fi

echo "[1/4] 构建镜像 englishforge:$VER（发布包已预编译：npm ci 层应全程 CACHED）"
docker build -t "englishforge:$VER" "$REL"

echo "[2/4] 更新 .env 版本标签"
sed -i "s/^ENGLISHFORGE_TAG=.*/ENGLISHFORGE_TAG=$VER/" "$ENV_FILE"
grep -q "^ENGLISHFORGE_TAG=$VER\$" "$ENV_FILE" || { echo "错误：.env 标签更新失败" >&2; exit 1; }

echo "[3/4] 重建容器"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

echo "[4/4] 健康检查 + **版本断言**"
PORT=$(grep -E '^ENGLISHFORGE_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-4173}
i=0
while [ $i -lt 60 ]; do
  # 配了 TLS 打 https（自签用 -k/--no-check-certificate）。**探针必须有硬超时**：
  # 实测容器刚重建后 loopback 上偶发一次 145 秒卡死（无超时的 wget 会一直等），
  # 有界探针最多丢一轮、下一轮就过。curl -m 优先（超时语义可靠），wget -T 兜底。
  BODY=$(curl -sk -m 8 "https://127.0.0.1:$PORT/api/health" 2>/dev/null) || BODY=""
  if [ -z "$BODY" ]; then
    BODY=$(wget -T 8 -qO- --no-check-certificate "https://127.0.0.1:$PORT/api/health" 2>/dev/null) || BODY=""
  fi
  if [ -z "$BODY" ]; then
    BODY=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  fi
  case "$BODY" in
    *'"ok":true'*)
      case "$BODY" in
        *"\"version\":\"$VER\""*)
          echo "完成：健康检查与版本断言通过，$VER 已上线（https://$(grep -E '^NAS_IP=' "$ENV_FILE" | cut -d= -f2):$PORT）"
          exit 0
          ;;
        *)
          # 容器起来了但自报版本不是请求版本：绝对不算成功（tag 与程序版本分裂是最难查的事故）
          echo "错误：health 版本与 $VER 不一致（多半是容器还没换完或镜像里 VERSION 不对）：$BODY" >&2
          exit 2
          ;;
      esac
      ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "错误：健康检查超时（2 分钟），查看日志：docker logs englishforge" >&2
exit 2
