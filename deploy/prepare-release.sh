#!/bin/sh
# 整理 TOEFL Lab 发布包 releases/<版本>/。
# 在 NAS 上跑最好（共享目录就是 NAS 本地盘，cp 是本地拷贝，秒级）；开发机跑也可以。
# 不复制 records/docs/pipeline/deploy/releases——镜像只装运行所需（server.mjs/VERSION/web/data/build）。
# 用法: sh deploy/prepare-release.sh <版本标签>   （须与 VERSION 文件一致）
set -eu
[ "$#" -eq 1 ] || { echo "用法: $0 <版本标签，如 2026-10-04.r1>"; exit 1; }
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
REL="$PROJ/releases/$VER"

[ -f "$PROJ/VERSION" ] || { echo "错误：$PROJ/VERSION 不存在" >&2; exit 1; }
CUR=$(cat "$PROJ/VERSION")
[ "$CUR" = "$VER" ] || { echo "错误：VERSION 文件($CUR) 与参数($VER) 不一致——先改 VERSION 再打包" >&2; exit 1; }
[ -f "$PROJ/server.mjs" ] || { echo "错误：找不到 server.mjs" >&2; exit 1; }
[ -d "$PROJ/build" ] && [ -d "$PROJ/data" ] && [ -d "$PROJ/web" ] || { echo "错误：web/data/build 目录不全" >&2; exit 1; }

rm -rf "$REL"
mkdir -p "$REL"
cp "$PROJ/server.mjs" "$PROJ/VERSION" "$REL/"
cp -r "$PROJ/web" "$PROJ/data" "$PROJ/build" "$REL/"
# 已知调试残留不进发布包（工作树里的原件不动，等用户手动清理）
rm -f "$REL/web/_desk_body.html"

# 发布包清单（nas-deploy.sh 靠它确认是有效发布包）
{
  echo "{"
  echo "  \"version\": \"$VER\","
  echo "  \"created\": \"$(date '+%F %T')\","
  echo "  \"contents\": [\"server.mjs\", \"VERSION\", \"web/\", \"data/\", \"build/\"],"
  echo "  \"excluded\": [\"records\", \"docs\", \"pipeline\", \"deploy\", \"releases\", \"skills\", \"server.log\"]"
  echo "}"
} > "$REL/manifest.release.json"

du -sh "$REL"
echo "发布包就绪: $REL"
