# 语料署名与许可（CORPUS NOTICE）

本仓库中由真实语料派生的题目（`src/data/pilots/`）必须按下列许可署名。
每道题都带 `sourceRef`，形如 `张俊杰第7课16-22段 / tatoeba:479775` 或 `.../ ud-en-ewt:ewt-ud-train.conllu:1001`，
其中 `tatoeba:<id>` / `ud-en-ewt:<sent_id>` 就是逐题出处，用来回溯到原始句子。

## 使用的语料

| 语料 | 许可 | 用途 | 是否入仓库 |
|---|---|---|---|
| [Tatoeba](https://tatoeba.org/) 英文句 | **CC BY 2.0 FR** | 主宾格句（含真实镜像句）、物主代词 | 派生题入仓库，**须署名**（见下） |
| [UD_English-EWT](https://github.com/UniversalDependencies/UD_English-EWT) | **CC BY-SA 4.0** | 主宾格句（借其词元/时态/依存标注推导镜像句） | 派生题入仓库，**须署名 + 相同方式共享** |
| UD_English-Pronouns | CC BY-SA 4.0 | **已弃用**（语言学测试句集，不像人话），不再产出 | — |

## 署名文本

若再发布/分享本仓库派生内容，请保留：

> 练习句与例句来自 Tatoeba（CC BY 2.0 FR，逐题 `tatoeba:<id>`）与 Universal Dependencies 英文树库
> UD_English-EWT（CC BY-SA 4.0，逐题 `ud-en-ewt:<sent_id>`），均按各自许可使用。

## 注意事项

- **CC BY-SA 有传染性**：如果对本仓库中源自 UD_English-EWT 的派生数据做了改编并对外发布，该部分数据需以相同方式共享（ShareAlike）。
- **不改写原始句子**：题目的正确选项都是语料原句（仅做最小改造的干扰项会标 `constructed` / `transformed`），便于核对与署名。
- **不引入下列来源**：ETS/TOEFL/TOEIC/GRE（仅允许 ≤3 份个人非商用、禁演绎再发布）、TPO（非 ETS 产品、无任何许可）、IELTS/剑桥样题（禁转载）、CET-4/6（无开放许可，且阅读文章常另含第三方版权）。
- **非商用语料（FCE / NUCLE / JFLEG / EFCAMDAT 等）只可本地使用，不得提交入库**。详见 `docs/curriculum/corpus-coverage-spike.md` 与内存中的许可边界记录。
