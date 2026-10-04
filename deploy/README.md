# TOEFL Lab · NAS 部署

沿用 EnglishForge 的部署方法论：**发布包镜像 → 换 tag → 重建容器 → 带版本断言的健康检查**。
首次部署 2026-10-04（r1），地址 `https://192.168.31.246:8018`（自签证书，浏览器首次访问需信任）。

## 架构

- **镜像 = 不可变快照**：`server.mjs + VERSION + web/ + data/ + build/` 打进镜像（含已核对的题库内容），
  版本号即内容版本。镜像零 npm 依赖，构建只是搬运（实测 ~15s）。
- **records = 挂载卷**（用户数据，与镜像版本无关）：NAS 上
  `JunEnglish/data/toefl-lab-production/records/`，与本地开发库 `toefl-lab/records/` **相互独立**。
  首次部署时播种了一份清理过的记录（保留课程观看进度与学习时长，清掉历史测试作答）。
- **源素材 = 只读挂载**：整个 `JunEnglish/` 以 ro 挂到容器 `/media/jun`，
  server 用 `TFL_SIBLING_ROOT=/media/jun` 把 vince托福课 / 新D方 / 819真题 映射回原位；
  `TFL_SET_ROOTS_FROM_DIR=1` 让套题目录一律按 `SOURCE_ROOT + dir` 重建
  （manifest 里的 abs_dir 是开发机 Windows 路径，跨机无效）。
- **TLS（自签）**：证书复用 EnglishForge 的（CN=englishforge，2036 年到期），
  server 按 `TFL_TLS_KEY/CERT` 环境变量加载；留空则回退 http。
  麦克风（口语录音 MediaRecorder）必须 secure context，所以默认开 https。

## 例行发版

```
1. 改 toefl-lab/VERSION（如 2026-10-05.r1），本地回归
2. ssh nas:  sh toefl-lab/deploy/prepare-release.sh <版本>     # 整理 releases/<版本>/，无需 sudo
3. ssh nas:  sudo sh toefl-lab/deploy/nas-deploy.sh <版本>     # 构建→换标签→重建→版本断言，无需人工确认
```

## 回滚

```
ssh nas:  sudo sh toefl-lab/deploy/nas-rollback.sh <旧版本标签>
```

（旧镜像不自动删除，`sudo docker images` 可查；确认不需要后手动清理。）

## 注意

- compose 项目名 `toefl-lab`，**不要**与 NAS 上 MyInfobase 的 `production` 项目混用，
  也不要顺手 `--remove-orphans`（会杀掉别家容器）。
- NAS 上 zaxchou 不在 docker 组，docker 命令需 sudo；`deploy/*.sh` 已把
  `/usr/local/bin` 补进 PATH（非交互 shell 找不到 docker）。
- 本地开发服务（`node server.mjs --port 8018`，读写 `toefl-lab/records/`）与 NAS 生产
  是两套记录。要清本地测试痕迹：先关所有本地页面（防旧标签页回传），再重置 records.json
  并**重启本地服务**（只改文件会被内存里的旧数据写回）。
