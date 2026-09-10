# 本地声纹试验

这项功能为会议说话人提供候选，固定团队成员可跨会议比较，访客样本只在登记它的会议中使用。匹配结果不会自动改名、关联团队成员或登记新样本。火山转录和原有录音流程不变，声纹运行时不可用时仍可手动标记。

## 安装与验证

在项目目录执行：

```sh
python3 scripts/setup-voiceprints.py
```

脚本优先使用已安装的 `uv` 建立 Python 3.12 隔离环境；没有 uv 时，可以用 Python 3.10–3.13 执行。默认目录为 `data/voiceprint-runtime`，通过 `WORKBENCH_VOICEPRINT_RUNTIME` 或 `--runtime-dir` 指定其他位置。服务端和安装脚本需使用同一个目录。

依赖固定为 PyTorch 2.7.1、torchaudio 2.7.1 和 NumPy 2.2.6。模型权重约 28 MB，首次还需下载 Python 依赖。安装验证只下载官方公开的三个演示音频，不读取会议录音；结果写入运行时的 `manifest.json`。日常运行无需连接模型提供方。

模型为 `funasr/campplus`，固定 revision 为 `e4b6ede7ce16997aff4ae69fbca1f0175e2afede`，权重 SHA-256 为 `3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8`。运行时使用官方 3D-Speaker 的 CAM++ 结构，固定代码 revision 为 `065629c313eaf1a01c65c640c46d77e61e9607b4`，保留其 LICENSE 与模型卡。源代码和模型标注 Apache-2.0。

官方来源：[模型卡](https://huggingface.co/funasr/campplus)、[模型结构与独立推理](https://github.com/modelscope/3D-Speaker/blob/main/speakerlab/bin/infer_sv.py)。

## 选择样本

主持人先确认说话人，再从原文选择 2–4 段发言，每段至少 3 秒、总计至少 6 秒。长发言只使用前 30 秒，预览和提特征采用同一区间。团队样本还必须关联已确认的团队成员。需要先回听，选择没有他人插话、杂音或明显失真的单人语音。

只接受已保存的 16 kHz 单声道 PCM，并按转录的 `startSample` / `endSample` 读取。尚未明确归属的未知发言、人工补写而没有录音位置的原文、只有整块时间的转录，以及所取区间与其他人的已知发言重叠的样本都不能用于登记。原始标签为 unknown 的发言，在通过逐条修正明确归属后可以使用。程序会检查静音、严重削波和段间声纹差异；这些检查不能保证片段绝无串音，主持人的回听仍然必要。

声纹片段、特征、来源位置、人工确认的归属和模型版本保存在 `data/voiceprints` 私有目录中。登记数据保留团队或单场会议的作用范围。处理失败或取消的片段留在私有样本目录，不会成为可匹配的登记资料。当前版本没有自动清理原始样本。

## 建议的含义

运行时只在 CPU 子进程中计算 192 维声纹向量。Node 服务通过串行后台任务读取样本、启动计算，并支持取消和超时；不在采集线程内运行模型。

结果中的 `score` 是余弦相似度，不是身份概率。当前用于缩小候选的试验条件为最高余弦分数不低于 0.5、与第二名差距不低于 0.08；片段间相似度也需不低于 0.5。不满足时返回 `unknown`，满足时仍只返回 `candidate`，并始终标注 `calibrated: false`。这些数值尚未用本团队会议校准，不可解释为识别准确率或已确认身份。

应当用不同会议、设备和环境的真实片段进行人工对照，分别观察误认、拒识、短句与重叠发言；公开演示音频的运行成功不能替代这一步。模型更新后旧向量不会与新版本混合比较。来源重新归属或录音区间修改后，相应登记资料不再作为候选依据。

## 服务接口

`createVoiceprintService({ store })` 位于 `server/voiceprints/service.js`，不使用 AI 分析任务队列。

- `status()`：运行时是否可用、模型版本、样本要求、未校准状态。
- `submit('enroll' | 'match', { meetingId, participantId, sourceIds, scope })`：返回独立任务，`scope` 为 `meeting` 或 `team`；团队成员从已确认的 participant 读取。
- `getJob(id)`：返回 `queued`、`running`、`done`、`error` 或 `cancelled`，完成结果在 `result` 中。
- `cancelJob(id)`：取消排队或运行中的任务。
- `listProfiles({ meetingId })`：当前会议可使用的团队资料和本会访客资料，不返回原始向量或音频路径。
- `stop()`：停止接收任务并取消未完成任务。

登记结果包含 `profile`。匹配结果包含 `status: candidate | unknown` 和 `candidates`；候选带作用范围、成员或本会说话人标识、名称、来源和相似度。只有上层界面收到主持人的明确确认后，才能通过 people store 修改身份。
