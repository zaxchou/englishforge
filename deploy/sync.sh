#!/bin/sh
# TOEFL Lab 一键同步（开发机跑）：自动递增版本 → NAS 打发布包 → sudo 部署 → 版本断言。
# 用法: sh deploy/sync.sh [版本标签]     # 省略则自动：同日递增 rN，跨日从 r1 开始
# sudo 密码不落盘：运行时经 stdin 传入（NAS_PW 环境变量或交互输入），只进内存。
set -eu
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
TODAY=$(date +%F)

# 自动版本号：读当前 VERSION，同日则 rN+1，跨日 r1
if [ "$#" -ge 1 ]; then
  VER="$1"
else
  CUR=$(cat "$PROJ/VERSION" 2>/dev/null || echo "")
  case "$CUR" in
    "$TODAY".r*) N=$(echo "$CUR" | sed "s/^$TODAY\.r//"); VER="$TODAY.r$((N+1))" ;;
    *) VER="$TODAY.r1" ;;
  esac
fi

echo "== 同步 $VER =="
printf '%s\n' "$VER" > "$PROJ/VERSION"

NAS=${NAS_HOST:-192.168.31.246}
PROJ_REMOTE=${NAS_PATH:-/volume2/Media/BaiduNetdiskWorkspace/myagent-work/zcode/JunEnglish/toefl-lab}

echo "[1/3] NAS 打发布包"
ssh -o BatchMode=yes "$NAS" "sh $PROJ_REMOTE/deploy/prepare-release.sh $VER"

echo "[2/3] 部署（sudo 经 stdin）"
if [ -n "${NAS_PW:-}" ]; then
  printf '%s\n' "$NAS_PW" | ssh -o BatchMode=yes "$NAS" "sudo -S -p '' sh $PROJ_REMOTE/deploy/nas-deploy.sh $VER"
else
  ssh -t "$NAS" "sudo sh $PROJ_REMOTE/deploy/nas-deploy.sh $VER"
fi

echo "[3/3] 外部验收"
PORT=$(grep -E '^TOEFLAB_PORT=' "$PROJ/deploy/production/.env" | cut -d= -f2 | tr -d ' '); PORT=${PORT:-8018}
BODY=$(curl -sk -m 8 "https://$NAS:$PORT/api/health" 2>/dev/null || true)
case "$BODY" in
  *"\"version\":\"$VER\""*) echo "同步完成：$VER 已上线 https://$NAS:$PORT" ;;
  *) echo "警告：外部 health 与 $VER 不一致：$BODY" >&2; exit 2 ;;
esac
