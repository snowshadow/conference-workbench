# 澄清解释回放

这组案例检查 AI 是否能解释概念与前提、承接已经得到的答案，以及在剩余问题不影响当前推进时退出焦点。不是让模型按固定词语或固定数量作答。

## 运行

```sh
# 检查 fixture 与实际服务、存储、焦点选择链路；不请求模型
node scripts/evaluate-clarification.mjs
node --test test/clarification-evaluation.test.js

# 查看案例 ID
node scripts/evaluate-clarification.mjs --list

# 通过当前实际提示词和配置的模型，运行一个案例
node scripts/evaluate-clarification.mjs --live --case profile-promotion-after-023146
node scripts/evaluate-clarification.mjs --live --case synthetic-three-meanings
node scripts/evaluate-clarification.mjs --live --case synthetic-shared-sla-assumption
```

默认读取本项目 `data/workbench.sqlite` 中的大模型设置；`--settings` 可指定另一个设置数据库。此读取使用 SQLite 只读连接，不实例化生产 Store。`EVAL_LLM_MODEL`、`EVAL_LLM_BASE_URL`、`EVAL_LLM_API_KEY`、`EVAL_LLM_REASONING_EFFORT` 可临时覆盖本次评估，不修改配置。不要把密钥写到命令历史里。

每次在 `test-output/clarification-evaluations/` 建立独立目录，各案例使用单独的 Store。保留实际请求、模型回复、最终持久化结果、原文和 `review.md` 人工评分表。API Key 只在内存中使用，不写入这些目录；目录含真实会议节选，已被 Git 忽略。不会创建或修改真实会议，也不启动录音或转录。

默认用固定的、截至该阶段时刻的证据节选，标为 `prefix_excerpt`，不能视为全会覆盖。`--full-prefix` 对文件来源案例读取原文件从开头到该时刻的完整前缀；它会增加模型调用次数。两种模式都排除截止时刻之后的内容，并排除截止时刻尚未说完的发言块。原文本只有发言开始时间，结束时间取下一发言起点，仅用来控制文本截断，不可用于音频定位。

## 固定来源与预期

| ID | 来源与截止 | 检查什么 |
| --- | --- | --- |
| `profile-stability-before-015755` | `09-07 记忆系统架构设计.txt`，01:57:55 前；早期产品圈选、01:47 的稳定性及 01:55–01:57 主动更新讨论 | 解释关注范围、用户取值、依据强弱的区别；解释只是建议，不能把 02:28 明确说出的定义当作此时已经说清 |
| `profile-promotion-after-023146` | 同文件，02:31:46 前，3732–3808 行 | 02:31:15 已明确不是删除存储、而是画像维度呈现；旧删除疑问应退出，不继续换个说法追问 |
| `record-memory-reference-evolution` | 同文件，先截至 02:38:45，再截至 02:51:34；3909–4363 行中必要片段 | 先解释记录／记忆与召回接口的不同；后续承认关联原话已明确，不把整体抽取粒度或返回全部原文也宣称定案 |
| `daily-parameters-out-of-scope` | 例会 `abfd8124-3a36-457a-8883-3c70496df9f8` 的数据库逐字节选，至 12:24.821 | 函数头范围已明确，参数定义未完成并明确不在本次范围；可记部分进展并退出焦点，不将残余细节冒充已解决 |
| `synthetic-three-meanings` | 明确标记的人工测试输入，40 秒 | “稳定”涉及字段结构、用户当前情况、同输入抽取复现三种含义；不硬压成双方争论 |
| `synthetic-shared-sla-assumption` | 不在当前提示词例子中的人工保留测试，30 秒 | 全员认同串行平均耗时，却用它支持高峰服务承诺；应解释共同依赖的未验证前提，不制造双方分歧，也不要求并列 `distinctions` |

JSON 保存了原文件 SHA-256、每条发言原始行号或数据库原始 ID、时间和原样文本。原转录含口误／ASR 错字，没有为了符合预期重写。数据库来源仅固定复制少量原话，不要求同事机器上存在该会议。

`scriptedReply` 只供默认的管线检查使用。`expected` 和 `scriptedReply` 都不会送进模型；真实模型由 `createAIService` 装配当前提示词、执行任务并经 `reduceOrganization` 写回隔离 Store。因此可以看到“模型输出有解释但页面数据未保存”的差别。

## 如何评审

结构检查只回答解释与引用是否保存、焦点是否退出、残余问题是否被误标为全部解决。数组长度不等于说明白了，关键词命中也不等于忠实于原文。

真实模型运行后，逐阶段给解释质量、证据忠实度、当前讨论价值、承接既有答案各 0–2 分，并按 `review.md` 的案例条件核对。必须看实际回复；默认预设回复通过，不能作为提示词效果通过的证据。对于已明确窄问题后又出现新的实质问题，可以继续下一焦点，但不应退回已回答的旧问法。

例会参数案例允许两种合理表达：本次验证范围已明确，可将核心范围问题标记为已解决；若强调后续参数工作还没有完成，也可保留未解决状态并退出焦点。应检查结果有没有错误宣称参数已完成，不以 `resolved` 或 `retired` 某一种状态替代语义判断。另有专门单元测试守住“退出焦点不必等于已解决”的存储与展示路径。
