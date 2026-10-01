# Codex reviewer ↔ Zcode coder 自动协作协议

2026-10-01。用户已明确授权两边自动开发/复审、互发项目交接，直到任一方额度用尽；不授权新的充值、部署、删历史、替用户完成真人审签/效果试验。

## 总调度职责

每次启动先阅读 [30 总调度职责与阶段进程](../30-总调度职责与阶段进程.md) 和 orchestration-status.json。Codex负责阶段排序与验收并发布下一任务；Zcode负责执行与交付，不自行越过待审批次。用户已直接授权本职责；下一份结果确认读取30即可，无需人工转贴。

## 状态与分工

Codex 只复审、规划、写审查/任务文件；Zcode 写应用代码、必要测试和实施报告。现有未提交修改属于各自所有者，不清理/覆盖另一方工作。只操作 sentence-forge；不要把 app 自己的模型调用余额当 agent 无限预算。

任务单是 tasks/000001.json 起递增；Codex 单独写。Zcode 只读任务、单独写 results/同号.json 和 signals/coder.json。Codex 单独写 reviews/同号.json 和 signals/reviewer.json。发布用临时文件+原子替换；正式 task/result/review 一旦 ready 不再覆盖，纠正另起版本引用原号。任何一方检测 STOP.json 就停止，不因额度重置自行重启。

Zcode 成功完成消息接入后写 signals/coder.json：connected=true、schedulerId、checkedAt。截至首轮结果000001，coder已接入；实时连接状态以signals/coder.json为准。

## 每批流程

Zcode 找最小的未有 result 的任务，开始时写 coder.json status=working/taskId；只处理一个任务，不重入。完成后提交自己这批改动（不代提交 reviewer 未提交文档），写结果再等待复审，不能边审边继续改受审文件。

result 必需：taskId、status=ready|blocked|quota_exhausted、baseCommit、headCommit、changedFiles、reportPath、checks（命令、退出码及真实结果）、remaining、workingTreeNotes、finishedAt。blocked/quota 不伪造 ready。若项目代码正在被其他用户改动，说明并等待稳定版本；不能擅自 stash/revert。

Codex 检查 coder 已 connected、有新 result，再读取稳定 commit/差异及报告。复审按用户学习目标和 26–29，不仅找 bug。隔离数据验证关键反例和正常用户路径；记录实际测试范围。检查代码是否在复审中漂移，漂移则返回 needs_snapshot，不对变动文件签通过。

review 必需：taskId、headCommit、verdict=changes_requested|accepted|needs_snapshot|blocked、reportPath、findings、nextTaskId、finishedAt。Codex 在完成实质复审后写 review，再写下一 task。只认对应版本的新证据，旧问题已修就关，不重复制造文档和测试。

两边各自配置约 5 分钟自动唤醒。无新文件只快速检查，不反复全量测试，不写空进展报告，不把等待耗完额度当工作。重入锁应能识别正在运行的自己，不靠固定 sleep 占用会话。

## 下一批范围

先收口 29 A1（只选 A/冲突理由却认证）和 A2（自动递增 take 破坏重试幂等），接着按 27 D0-2 统一会话、播放、录音和正式首测，并将 28 学习者完整主流程原型与 D0 并行。随后 D1 可学习三课、D2 小范围个体生成；全图事实核验沿实际近期路径推进，不批量上架633草稿。

真人反馈/事实审签不能由 agent 冒充；需要本人体验时标 awaiting_user 并保留其他可推进任务，勿无限停在反复问许可。循环只推进原已授权项目范围。

## 停止

STOP.json 的 reason 可为 user_stop/quota_exhausted/permission_blocked/no_actionable_work。观察到账户硬限额或 quota 异常就停止，不充值、不换账号/模型绕过、不等自动重置继续。写交接和剩余任务。未知额度不能臆测已耗尽。

通信失败或连续三次实质推进被同一外部条件阻塞，记录阻塞并停轮询，不无限生成重复请求。审查/编码到无可推进事项也停止，不制造缺陷耗 token。用户可在任何一边说停止，写 STOP 并关闭各自调度；恢复只接受用户新指令。
