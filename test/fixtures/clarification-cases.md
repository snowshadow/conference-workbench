# 澄清解释回放

公开仓库只包含完全虚构的对话。案例用于检查解释、引用、分阶段阅读和焦点退出，不把预置回复当作真实模型的质量证据。

## 运行

```sh
# 离线管线回归，不请求模型
node scripts/evaluate-clarification.mjs
node --test test/clarification-evaluation.test.js

# 查看案例
node scripts/evaluate-clarification.mjs --list

# 使用自己配置的模型，产生需人工评审的真实回复
node scripts/evaluate-clarification.mjs --live --case synthetic-template-stability
node scripts/evaluate-clarification.mjs --live --case synthetic-shared-sla-assumption
```

`--live` 默认从本项目 `data/workbench.sqlite` 只读加载大模型设置，须先启动工作台并保存配置。`--settings` 可指定另一个设置数据库；`EVAL_LLM_MODEL`、`EVAL_LLM_BASE_URL`、`EVAL_LLM_API_KEY`、`EVAL_LLM_REASONING_EFFORT` 可临时覆盖，不修改数据库。不要把密钥直接写进命令历史。

每次运行在 `test-output/clarification-evaluations/` 建立独立目录，保存请求、回复、持久化结果和 `review.md`。API Key 仅在内存中使用。默认案例无需本机原始录音或私人转录；不会创建或修改正式会议，也不启动录音。

## 案例

| ID | 验证的行为 |
| --- | --- |
| `synthetic-template-stability` | 区分报名表栏目与内容；不提前引用后续才明确的定义 |
| `synthetic-pin-retains-source` | 公告置顶只改变排序；承接已明确的答案，退出旧问题 |
| `synthetic-summary-reference-evolution` | 第一阶段解释摘要与引用的区别；第二阶段承认引用已明确，保留其他未决项 |
| `synthetic-export-scope` | 文字导出验收与附件工作分开；退出焦点不等于附件已经完成 |
| `synthetic-three-meanings` | 同一词可能包含三种含义，不强行压成两方争论 |
| `synthetic-shared-sla-assumption` | 全员同意测试数据，仍可能共同依赖未验证的前提 |

每条来源标记为 `synthetic`。时间仅用于控制分阶段证据可见范围，不代表音频定位。每阶段只使用已结束的发言；预期结果和预置回复不进入模型请求。

脚本仍支持对自行提供的文件案例使用 `--full-prefix`，读取截止时刻之前完整结束的发言；公开的合成案例不需要此选项。私人评估材料及输出应保存在 Git 忽略的本地目录，提交前检查实际 diff。

## 如何判断结果

离线回放通过只说明当前服务、reducer、存储和焦点选择链路按预置输入工作。真实模型运行后，需逐阶段评审解释质量、证据忠实度、当前讨论价值和承接既有答案的情况。

不要用数组长度、关键词命中或 `resolved` 状态代替语义判断。一个问题可以退出当前焦点，同时仍有留待后续的未完成工作。
