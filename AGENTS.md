# TOEFL Lab 项目规则

- 当前工作以本目录为准，不混用已归档sentence-forge代码。
- 用户已于2026-10-12长期授权正常NAS发布、服务重启和本项目旧镜像清理；无需逐版本再次询问。
- 执行前阅读 [长期部署授权](docs/deployment-authorization.md)，按其中范围备份、验证及保留回滚。
- 教材原件与学习数据必须保留；发布和镜像清理不包括其他应用或数据卷。
- 镜像清理使用deploy/clean-project-images.sh；不执行全局prune。

## 开发约定（oil-dev）

- 快测：`node pipeline/test_number_trainer_model.mjs`（0.14s，规则层）；按模块换 `test_number_trainer_{server,local_audio,audio}.mjs`
- 重测：`node pipeline/test_number_trainer_browser.cjs`（分钟级，三端浏览器回归）；整批收尾或合并主干前统一跑
- 门禁：快测+重测全过且退出码落盘核对（`命令 > log 2>&1; echo REAL_EXIT=$?`）后才 commit+deploy
- 高风险：`records/`（学习记录，绝不写主站 vocab/course/exam 字段）、`deploy/**`（发布脚本）、`server.mjs`（全站挂载点）
- 禁改：`data/`（教材/课程内容，不进 git）；`build/` 不进公开仓库
- 新增服务端文件必须同时进 `deploy/Dockerfile` 与 `deploy/prepare-release.sh`（含 manifest），否则镜像启动即 import 失败
- 改 `deploy/*.sh` 禁用 Python 文本模式写文件（CRLF 会让 NAS 的 sh 跑挂），必须二进制写回 LF
- TTS 输入必须带终止标点、连续相同数字需显式分隔（裸数字串会被续读/糊音，事故记录在 build/qa/number-trainer/）
