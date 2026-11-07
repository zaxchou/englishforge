# 词族首段框架

> **2026-11-07 词根模板更新**：8036 的 predict/predictable/unpredictable 现在使用经过独立来源/译文复核的学习档案，直接显示 dict-/dic-「说」、词缀角色、现代构词层级、溯源摘要、可点击词根图和原创学习例句。数据入口 `build/root-universe/learning/dict/entry.json`，独立签署为同目录 `review.json`；通用只读查询 `GET /api/learning?id=<sense_id>`，缺少已核档案时明确 unresolved，不从邻词猜词根。原始事实索引/争议边保持原状；P0013 只保留采集快照、未合并。模板与扩量标准见 [产品逻辑](../docs/word-root-universe/07-词根主导的产品逻辑.md)。验证：从项目目录运行 `node pipeline/root-universe/test-learning.cjs` 与 `node pipeline/root-universe/test-foundation.cjs`。

> **2026-11-07 增补：P0012 已合并进正式索引。** 当前版本 `v-135fb61d622939f15b390b1fa6b2a14a2bc840d3a21e43c788f2a26a22e4593e`：词头11、词义12、词源身份11、关系8、证据44（现代直接覆盖8义、历史5义）。查询示例 `node toefl-lab/root-universe/cli.cjs search fix`。P0012 不可再领取；fixed 按登记收缩条款保留未决（当前修订无 Etymology 章节）。下文正文的数量与"领取P0012"指引为合并前快照。

首段框架已通过独立来源/中文复核、workflow强验收和[最终独立接手审查](../docs/word-root-universe/reviews/07-最终框架接手审查.md:5)。当前正式索引：9词头、10词义、9词源身份、7关系、37证据，0词素/完整成分分析；版本为 `v-94b6303779096665dfaf89e27704fd6e20a627088950424a3e9b2b03a3b11f5b`。数量来自当前索引及[最终验收JSON](../build/qa/root-universe/full-b012c54d-ede1-48e4-b9da-4abdbc3e81b7/result.json:138)，强验收退出0，包含1440/390/320的实际Edge主路径及两层prediction点击/返回回归。原18个候选词义不等于正式覆盖，“约20%”仅指首段工程里程碑，不表示20%单词或词源覆盖。M0机器门禁与独立计划审查已由上游完成。本次最后一轮仅更新交接文档，没有重跑门禁或修改已验收代码/数据。

授权与状态见 [05任务书](../docs/word-root-universe/05-首段框架任务书.md)及[06实现账本](../docs/word-root-universe/06-实现状态与接手.md)。代码不接入原站，不写学习记录，不部署。无新增依赖。

## 运行命令

下面均从工作区 JunEnglish 根运行；脚本内部依自身位置定位项目，换 cwd 时用脚本的绝对路径即可。

```bash
node toefl-lab/root-universe/cli.cjs validate P0001 --stage candidate
node toefl-lab/root-universe/cli.cjs validate P0011 --stage candidate
```

当前两包已有真实独立review，见[来源报告](../docs/word-root-universe/reviews/04-首段样板来源复核.md)。新包或后续内容修订仍先由独立来源/中文复核者只写review.json、review.md，绑定packet原始字节SHA-256，作者不能代签；随后由单一整合者执行或复现以下命令：

```bash
node toefl-lab/root-universe/cli.cjs validate P0001 --stage verified
node toefl-lab/root-universe/cli.cjs validate P0011 --stage verified
node toefl-lab/root-universe/cli.cjs build P0001 P0011
node toefl-lab/root-universe/cli.cjs status
node toefl-lab/root-universe/cli.cjs search predictable
node toefl-lab/root-universe/cli.cjs neighbors P0001:s0002 --depth 1 --layer modern
node toefl-lab/root-universe/cli.cjs neighbors P0001:s0004 --depth 2 --layer historical
node toefl-lab/root-universe/cli.cjs serve --port 8036
```

在浏览器打开 `http://127.0.0.1:8036/`，输入词头、选词义、点邻词、返回、查看出处。上述查询ID已在当前批准索引中；其他未获批的ID返回未知。展开两层时，入口指向距当前义更远的端点，关系箭头保留原方向；点开再返回会恢复此前展开层数和检索词。出处区区分当前批准状态与采集时原始备注。服务只监听127.0.0.1，Ctrl+C停止。测试结束后没有常驻服务。

`build` 自动累加当前版已纳入的包，相同包/字节重复导入幂等；不能靠省略旧包删图。版本是完整确定性索引的 SHA-256，产物位于 `build/root-universe/versions/v-<sha256>/`，包含 index.json、registry.json、manifest.json。manifest 记录父版、包/审查哈希、真实复核身份声明、统计与来源/变更署名。临时版本完整写好并校验，再用同目录文件 rename 原子替换 current.json，旧版本与旧指针保留。内容相同复用既有版本，manifest父版保留首次创建关系，current与该manifest一致，切换前指针另存history。构建锁冲突时拒绝；遇中断遗留 .lock 必须先确认没有执行者，再由整合者处理，不能自动抢锁。

回滚命令：`node toefl-lab/root-universe/cli.cjs rollback v-<实际祖先版本SHA256>`。它核对快照哈希与父链，只切回当前祖先；不删除后继版本或证据。原子切换、失败保留旧current和祖先回滚的合成回归已在workflow快测中通过；正式索引的确定性与幂等在最终full中通过。当前正式首版parent=null，没有可切回的正式祖先；未在生产数据上制造失败或执行真实多版本回滚。

## 模块与公开接口

|文件|接口与职责|
|---|---|
|core.cjs|`project(bundle)`、`compile(bundles, {resolveRegistry})`、`search(index,q)`、`detail(index,id)`、`neighbors(index,id,options)`；纯数据逻辑|
|workspace.cjs|受控ROOT/QA路径、无链接/穿越读写、task、claim、bundle；claim独占、同owner恢复、最多两次累计返工、保留ID/原包/旧review|
|build.cjs|build/current/snapshot/rollback/counts；verified检查、跨包引用快照、不可变版本、锁及原子指针|
|cli.cjs|claim/rework/validate/build/status/search/neighbors/rollback/serve；stdout JSON|
|server.cjs|createServer/listen，纯只读GET，固定静态资源表，不暴露文件系统路径|
|public/|独立搜索、词义、现代/历史/辅助关系、出处与状态界面|
|../pipeline/root-universe/validate-kit.cjs|原schema、taskCheck、validatePacket、publicationPlan、PUBLISH_FIELDS、directCoverageProjection；require无CLI副作用，旧CLI与self-test保留|

bundle 形如 `{p, raw, r}`，分别是 parsed packet、原始Buffer、parsed review。发布投影必须先verified；仅复制批准事实、节点白名单和证据闭包，不序列化整个包。coverage从批准事实重算；候选notes、scope、未审节点不进图。事实保留原方向；对称关系独立处理；检索不自动合并相似拼写、不同词源身份或不同语言。

跨包 reference 的 registry_version/registry_sha256 对照实际不可变registry原始字节；字段及证据重绑定按同来源的URL、版本、片段hash、位置、许可、署名、译文比较。引用存在于包内并不证明已注册。未取得可核对快照时直接拒绝。

邻居默认 depth=1 / maxNodes=40 / maxEdges=80；最大 depth=2 / maxNodes=100 / maxEdges=200，限额超出报错，截断返回 truncated=true。`layer`为all/modern/historical/auxiliary；`direction`为both/out/in，对称边不受单向过滤；`type`可为关系枚举或analysis_component。检索输入最多120字符、结果默认30最大50；不做自动词形还原。HTTP URL最多2048字符，重复/未知参数拒绝，写方法405；未知节点404，缺/坏索引503。

## 许可与来源入口

正式证据为英文Wiktionary条目自身的短定义/词源片段，采用CC BY-SA 4.0；署名为English Wiktionary contributors，保留具体oldid、history、许可和作者整理/翻译说明。实际许可、原文版本和中文判断见[独立来源报告](../docs/word-root-universe/reviews/04-首段样板来源复核.md:87)，代表入口：[predict修订93715976](https://en.wiktionary.org/w/index.php?title=predict&oldid=93715976)、[photo修订94566754](https://en.wiktionary.org/w/index.php?title=photo&oldid=94566754)。本次文档收尾没有重新联网复核来源。

逐项证据、取得时间和hash在`build/root-universe/packets/<ID>/packet.json`；原始响应及capture元数据在`build/root-universe/snapshots/<ID>/<UUID>/`，当前版本manifest含署名/变更清单。公开再分发仍须保留归属、许可、变更说明及相同方式共享，当前本地验收不等于完成公开发行打包。Kaikki/Wiktionary视为同一来源族，MorphyNet只作候选；不能把未签候选加入正式图。

## 资料、领取和下一包

真实包与快照只放 `build/root-universe/`，QA只放 `build/qa/root-universe/`。P0001/P0011已独立批准并纳入current；claim保留作者交还时的ready_for_review历史状态，累计返工P0001=0、P0011=1（已保存旧包/hash），不能只凭claim判断是否已合并，须读取review和current。登记表保留旧batch兼容字段，并增加 foundation_output_dir；旧docs batch入口不自动迁移受控包。

**P0012 可以直接领取**：[任务登记](../docs/word-root-universe/tasks/P0012.json)，fix/fixed/fixture/prefix/suffix，约6义，来源不足就保留未决。以下 owner 必须替换成执行者的真实编排身份，不能复用前作者身份：

```bash
node toefl-lab/root-universe/cli.cjs claim P0012 "实际执行者身份"
node toefl-lab/pipeline/root-universe/acquire-source.cjs P0012 "实际执行者身份" fix fixed fixture prefix suffix @rights
```

采集器要求claim同owner，只取登记范围；下载数据各在新建快照子目录，脚本与下载数据分开，不执行快照内容。它记录实际API修订、响应hash与取得时间，不自动批准词源。出现429/缺失应有限重试，保留缺口；已经取得的capture索引逐项持久化。

按 P0001/P0011 受控目录内 candidate-plan.json 的结构，人工选择语言、etymology身份、原始定义行和独立关系证据，使用本包新ID；写 P0012/candidate-plan.json、extra-requests.json。原文必须存在于已取得的修订快照，中文单列为作者整理。course_member显式标记须按本地课程核对；assemble会读取授权的本地课程路径逐个校验本包词头，标记不符即拒绝，并只把本包匹配/hash/时间写入scope。然后：

```bash
node toefl-lab/pipeline/root-universe/assemble-candidate.cjs P0012 "实际执行者身份"
node toefl-lab/root-universe/cli.cjs validate P0012 --stage candidate
```

assemble仅用于首次建包，已有packet拒绝覆盖。先写scope/证据与handoff，再交独立复核者写review.json/review.md并签当前packet原始字节hash；作者不能代签。独立批准后，由单一整合者运行：

```bash
node toefl-lab/root-universe/cli.cjs validate P0012 --stage verified
node toefl-lab/root-universe/cli.cjs build P0012
node toefl-lab/root-universe/cli.cjs search fix
```

这里的build会累加current中的P0001/P0011。上述P0012命令是下一包步骤，本次未领取、采集或执行它们。candidate-plan和snapshot只是取得/选择记录，正式事实以packet和当前review闭包为准。若要把P0012加入完整验收，整合者明确更新受控 sample-set.json 的 packet_ids，不能让测试自动跳过失败包。

同owner再次claim会恢复，不重置返工数；他owner被拒绝。返工必须**在修改packet前**执行 `node toefl-lab/root-universe/cli.cjs rework P0012 "实际执行者身份"`，保存旧packet/review/handoff/scope快照、旧hash与累计次数，最多2次。修改后重新candidate，所有review按新字节重签；保留旧ID，删身份的整合修订尚不支持。恢复可由相同实际owner继续，不因复制owner字符串就等于获得真实身份授权。

## 验收与明确后续任务

```bash
node toefl-lab/pipeline/root-universe/test-foundation-fast.cjs
node toefl-lab/pipeline/root-universe/test-foundation.cjs
```

workflow已运行上述两条：fast退出0、70项检查，见[快测结果](../build/qa/root-universe/fast-9f3963be-0660-4d92-a547-509f2a7612f4/result.json)；修订后的full退出0，见[最终强验收](../build/qa/root-universe/full-b012c54d-ede1-48e4-b9da-4abdbc3e81b7/result.json)及同目录exit-code.json和7张截图。最终[独立接手审查ready=true](../docs/word-root-universe/reviews/07-最终框架接手审查.md:5)。这些是已核读的上游运行证据；本次仅文档收尾，没有重跑或沿用旧full作为最终结果。fast是显式synthetic的契约/核心/文件原子切换/恢复反例，持久产物只写QA；真实链接夹具使用os.tmpdir()内新建的唯一目录，验证原safeFile拒绝后先删链接本身、再清理整处夹具，创建/断言/清理失败仍非零。workspace仍拒绝OS临时目录作为数据根，生产ROOT拒绝synthetic构建。full严格读取真实 sample-set 的所有verified包，实际构建正式索引、HTTP检查、启动Edge Playwright并走主路径，保存1440/390/320代表截图、日志、统计和退出码；未批准时非零且not_ready，不用synthetic替代。复用既有Playwright和msedge，覆盖路径、输入上限、错误/未知/缺索引/重试、邻词返回与出处；finally关闭浏览器、上下文和临时HTTP服务。可用现有 `TFL_PLAYWRIGHT` 指向已经安装的模块，不安装依赖。

- **F-redirects**：当前任何redirect输入明确报UNSUPPORTED_REDIRECT；实现merge/split/deprecate注册整合、环/同形隔离与旧ID解析后才能启用。
- **F-revisions**：已纳入版本的同packet字节修订明确报IMMUTABLE_PACKET_REVISION_UNSUPPORTED；需保留ID、批准历史和引用的整合修订协议，不能覆写。
- **F-transfer**：当前无自动claim移交命令；不能换owner抢占。若原执行者不可恢复，由整合者另行记录有依据的移交。
- **后续产品**：完整成分图、全库取数/覆盖、全课程映射、SRS、原站入口与部署未做。机器只能核对形式、字节和已声明矛盾，来源真实性、许可实际授权、未声明同形异源及语言学判断仍依赖独立复核。
