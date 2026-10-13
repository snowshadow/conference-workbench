# 豆包文件识别 2.0：TOS 配置指南

在工作台「导入录音」中选择本地音频文件即可。工作台自动将音频分段上传至私有 TOS 存储桶，用有效期为 24 小时的下载链接提交给豆包，取得结果后删除临时副本。本机原录音和转录保留。

首次配置需要开通两项服务：**豆包录音文件识别 2.0** 和 **对象存储 TOS**。实时识别单独使用「流式语音识别 2.0」，无需 TOS。下面以同一火山账号、北京地域为例。

## 1. 创建私有存储桶

1. 打开[火山控制台](https://console.volcengine.com/)，搜索「对象存储 TOS」，按页面提示开通按量付费。无需先买资源包。
2. 创建存储桶，地域选「北京」（`cn-beijing`），存储类型选「标准存储」。以控制台显示的地域编码为准。
3. 桶名使用全局唯一的小写名称，例如 `conference-workbench-你的唯一后缀`。填写时不要包含示例中的中文。
4. 访问权限选「私有」。版本控制保持关闭，暂不配置归档、加速或跨域规则。
5. 记下桶名称和地域编码。工作台的北京地域填写 `cn-beijing`。

建议给前缀 `conference-workbench/transcription/` 设置生命周期规则：对象创建 **2 天后删除**。工作台通常在取得转录结果后立即删除对象；此规则用于清理意外关机、任务失败或删除权限异常留下的副本。生命周期执行并非到点立即完成。

## 2. 为工作台创建存储密钥

在访问控制 IAM 中创建一个用于工作台的子用户，启用编程访问，创建 AccessKey。保存 AccessKey ID 和 AccessKey Secret，稍后只在本机工作台填写。

给子用户添加自定义 IAM 策略。下面把 `YOUR_BUCKET` 替换为刚创建的桶名，资源范围仅限工作台的临时目录。上传时工作台显式设置对象为私有，因此策略同时包含对象 ACL 写入权限。

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "tos:PutObject",
        "tos:GetObject",
        "tos:DeleteObject",
        "tos:PutObjectAcl"
      ],
      "Resource": [
        "trn:tos:::YOUR_BUCKET/conference-workbench/transcription/*"
      ]
    }
  ]
}
```

这组策略供工作台通过 API 操作临时音频，不包含浏览控制台所需的列举桶权限。管理桶时继续使用创建桶的账号即可。配置细节见[官方 IAM 策略说明](https://docs.volcengine.com/docs/TorchObjectStorage/ConfiguringIAMpolicies?lang=zh)及[对象操作权限](https://docs.volcengine.com/docs/TorchObjectStorage/Bucketpolicytemplatesandparameters?lang=zh)。

## 3. 填入工作台

打开工作台「连接设置」→「录音文件转录」：

| 配置项 | 填写内容 |
| --- | --- |
| 文件转录服务 | 火山引擎 |
| 文件识别版本 | 豆包录音文件识别 2.0 |
| TOS 地域 | `cn-beijing`，或存储桶实际地域编码 |
| TOS 存储桶名称 | 刚创建的桶名，不含网址或路径 |
| TOS AccessKey ID | IAM 子用户的 AccessKey ID |
| TOS AccessKey Secret | 同一密钥对的 AccessKey Secret |

语音 API Key 继续使用「实时语音识别」区域已保存的值。**豆包语音 API Key 与 TOS AccessKey 是不同凭据，不能混用。** 如果新建了存储子用户，不必把原来可用的语音 API Key 换成子用户凭据。

点击「保存设置」。密钥保存在本机服务端，网页再次打开时只显示是否已保存；留空会保留现有密钥。已有保存设置优先于 `.env`。

## 4. 用短录音验证

导入一段几秒钟的测试录音。预期依次显示准备录音、上传临时音频、转录录音，最后出现带时间的原文。回听最后一句，核对文字是否完整。再从主账号的 TOS 控制台检查临时目录，确认测试对象已经清理。

「已配置」只表示字段齐全，不代表网络、权限和余额已验证。如果上传失败，检查桶名、地域和存储权限；如果语音服务返回 403，检查豆包录音文件识别 2.0 是否开通，以及语音 API Key 是否属于对应项目。

任务中断后，点击「重试导入」。工作台保留云端任务 ID，先查询原任务；已完成分段不重复转录。若云端已找不到原任务，工作台会明确提示重新提交可能再次计费。若只提示临时副本清理失败，转录已经保存；请修正删除权限，并通过桶生命周期规则或控制台清理副本。

费用分为语音识别和 TOS 的存储、请求、流量费用，均由火山计费。无需公网读桶，也无需额外租用服务器或配置域名。价格以[豆包语音计费](https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh)及 [TOS 计费页](https://www.volcengine.com/pricing?product=TOS&tab=1)为准。
