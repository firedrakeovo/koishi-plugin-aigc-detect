# koishi-plugin-aigc-detect

群聊里的 **AI 生成图片检测**：发图或回复图片 + `ai检测`，机器人会回一条结果（合并转发或普通消息），告诉你这张图有多大概率是 AI 生成的。

> **支持的服务商：目前只有 [Sightengine](https://sightengine.com)（`models=genai`）**，免费档 2000 额度/月（一次检测消耗 5 额度）。
> 后续会**按需求**考虑接入阿里云「内容安全 2.0 · 图片审核增强版 AIGC 场景」、腾讯云「IMS · 图片 AI 生成识别」等；
> 代码里已按 `provider` 设计好扩展点（`lib/index.js` 的 `providers` + 「检测通道」配置），加一家只需补一个实现。

> ⚠️ **准确率提醒**：任何 AI 图片检测给出的都只是**概率**，不是证据。压缩、截图、二次编辑都会影响结果；请把结论当参考，并自行评估"把图片上传给第三方服务"这件事。

## 用法

| 发什么 | 结果 |
|---|---|
| `ai检测` + 图片（同一条消息，不用打空格也行） | ✅ 检测这张图（严格格式：文本只能有 `ai检测` 二字） |
| `ai检测 帮我看看这张` + 图片 | ❌ 静默（**严格格式**：文本必须恰好只有 `ai检测`） |
| `ai检测` + 图片 + `谢谢` | ❌ 静默（同上，图后也不能多字） |
| **回复一张图片**，只发 `ai检测` | ✅ 检测被引用的那张图 |
| `AI检测` / `Ai检测` / `aI检测` | ✅ 指令名匹配不区分大小写 |
| 回复图片但多打了字（`ai检测 谢谢`） | ❌ 静默（不响应，避免误触发） |
| 不带图、引用的也没有图 | ❌ 静默 |
| `ai检测一下` + 图片 | ❌ 不触发（不是一个独立的词） |

**默认行为（`forward: false`）**：结果是一条**普通消息**，会**引用（回复）**触发它的那条消息 ——

- 本条消息里带图 → 引用**本条消息**；
- 「回复一张图 + 只发 `ai检测`」触发 → 引用**那张原图所在的消息**；

消息里**只放结论与明细，不再重复发送原图**：

```
[原图]
🤖 大概率是 AI 生成
AI 生成概率：96%
────────────
通道：sightengine · 模型：genai
原始分数：0.96
判定阈值：≥0.8 高概率 / ≥0.4 疑似
耗时：812 ms
检测结果仅供参考，不构成确定性结论。
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `channels` | 一个 sightengine 通道 | **检测通道列表（数组）**，从上往下按优先级使用，见下 |
| `forward` | `false` | 关（默认）：**一条普通消息 + 引用触发它的消息**，只放结论与明细、不重发原图。开：改用「合并转发」两条文本节点 —— OneBot 的转发必须整条只含转发节点，所以**开着就没有引用**；发不出转发时会自动降级成普通消息 |
| `selfCheck` | `true` | 插件（重）加载时用**0 消耗**的探针逐个校验通道密钥（只发凭据、不带 `models`），结果写日志 |
| `cooldownMinutes` | `60` | 某个通道失败（额度/密钥/未订阅类）后的冷却时间，期间自动跳过它 |
| `timeout` | `15000` | 单次请求超时（毫秒） |
| `cacheHours` | `24` | 同一张图的结果缓存时长，0=不缓存。按图片 `fileid` 做 key，所以群友重复发同一张图只花一次额度 |
| `highThreshold` | `0.8` | ≥ 此值判「大概率是 AI 生成」 |
| `lowThreshold` | `0.4` | ≥ 此值判「疑似 AI 生成」，再低判「未检出明显特征」 |
| `enableUserLimit` | `false` | **可选**：每人每日次数上限 |
| `dailyLimitPerUser` | `10` | 每人每日上限（仅启用时生效） |
| `enableChannelLimit` | `false` | **可选**：每群（频道）每日次数上限 |
| `dailyLimitPerChannel` | `50` | 每群每日上限（仅启用时生效） |

两个限额默认**关闭**；计数存在进程内存里，重启清零。

### 检测通道（可添加多个，按优先级降级）

控制台里「检测通道」是个**数组**，点 `+` 可以加任意多个条目，每个条目有：

| 字段 | 说明 |
|---|---|
| 备注名 | 只用于日志和结果展示，例如「主账号」「备用账号」 |
| API USER / API SECRET | 该通道的凭据 |
| HTTP 代理 | 该通道单独的代理（留空=直连） |
| 启用 | 关掉就跳过这个通道（不用删掉它） |

> 目前只有 Sightengine 一家服务商，所以配置里**没有「服务商」下拉**（只有一个选项的 union 在控制台渲染不出控件）；代码里已按 `provider` 字段设计好，接入阿里云 / 腾讯云时再加回下拉并补对应实现。手写 `koishi.yml` 时仍可写 `provider: sightengine`，不写则默认 sightengine。

运行规则：

1. **从上往下依次尝试**，第一个成功就用它，结果里会显示用的是哪个通道（如「通道：主账号 · sightengine」）；
2. 某个通道**失败就自动切下一个**：额度用完 / 密钥失效 / 未订阅 / 网络超时都算；
3. 失败过的通道会**冷却 `cooldownMinutes` 分钟**（默认 60），期间直接跳过它，不会每次都白试一遍；到期后再试一次；
4. 未填凭据、或「启用」被关掉的通道直接跳过；
5. 所有通道都失败时，群里会回一条可读的提示并写 warn 日志：图片取不到（链接失效/格式不支持）→ 提示重新发送；图片过大（Sightengine 单张上限 **12MB**）→ 提示压缩后再发；密钥问题 → 提示去控制台检查「检测通道」。**图片类失败不会让通道进入冷却**（那是图片的问题，不是通道的问题），而且 `media_error` 不消耗额度。

> 实际用法示例：加两个 Sightengine 账号（各 2000 额度/月），主账号额度用完会自动走备用账号，不用人工切换。

## 拿密钥（免费额度）

1. 去 https://sightengine.com 注册（邮箱即可）。
2. 在 Dashboard 找到 **API USER** 与 **API SECRET**。
3. 在 **Koishi 控制台 → 插件配置 → aigc-detect → 「检测通道」** 里填 `API USER` / `API SECRET`，保存即可（控制台保存会热重载插件，不用重启）。

保存后控制台**日志页**会立刻给出自检结果，不用等到群里发图：

- 成功：`[I] aigc-detect 密钥校验通过：sightengine 凭据有效（本次校验不消耗额度）`
- 密钥错：`[W] aigc-detect 密钥或连通性校验未通过：sightengine 返回失败：credentials_error Incorrect API user or API secret`
- 没填：`[W] aigc-detect 未配置 Sightengine 的 apiUser / apiSecret…`

这个自检**不消耗额度**（Sightengine 会先校验凭据再校验参数，所以故意不带 `models` 发一次请求：密钥对 → `argument_error`，密钥错 → `credentials_error`，两种情况都是 0 operations）。不想让它发请求也可以关掉（`selfCheck: false`）。

免费档：**2000 次额度/月**（额度 = 官方说的 operation，每日封顶 500），包含 `genai`（AI 图像检测）模型。

> ⚠️ **一次检测消耗 5 次额度**（`models=genai` 是 5 个模型的打包；响应里的 `request.operations` 是实际消耗，转发明细也会显示「本次消耗：N 次额度」）。
> 所以免费档实际约 **400 次检测/月**、**100 次/天**。每天 10 张的话约用掉 1500/2000，**建议保持缓存开启**（同一张图重复发不花额度）；不够用时可以换阿里云 `aigcDetector`（≈0.004 元/张）或升 Sightengine Starter（$29/月 = 1 万额度 ≈ 2000 次检测）。

## 实现要点

- 请求：`POST https://api.sightengine.com/1.0/check.json`，参数 `api_user` / `api_secret` / `models=genai` / `url=<图片地址>`；本地文件（`file://`）走 multipart `media` 上传。
- 响应：AI 分数在 **`type.ai_generated`**（0~1），不是 `genai.score`（2026-09 实测；代码对两种写法都做了兼容）；额度消耗在 `request.operations`。
- 日志：常规流程只写 `debug`（默认等级看不到，不会刷控制台/日志文件），只有真失败才 `warn`。
- 触发规则和 `hero-search`（搜图）保持一致：**严格格式**（消息文本必须恰好只有指令二字）+ 有图（本条或引用）才响应，其余一律静默。
- 扩展服务商：在 `providers` 里加一个实现（入参 `(fetchImpl, channelConfig, globalConfig, imageSrc)`，返回 `{ score, model, operations }`），再在 schema 的「检测通道」里补上对应凭据字段即可；目前只有 `sightengine` 一家，所以没有「服务商」下拉。

## 开发与测试

```bash
npm install            # 安装 devDependencies（koishi、koishi-plugin-adapter-onebot）
npm test               # 离线用例：打桩 Sightengine，36 条路径，不花钱
npm run test:live      # 真实接口冒烟（每张图消耗 5 次额度，需要下面的环境变量）
```

**在本机的 Koishi 应用里联调**（把本仓库软链到应用的 `node_modules/koishi-plugin-aigc-detect` 后）：

Node 是从**文件的真实路径**往上找 `node_modules` 的，所以软链安装时插件找不到应用里的 `koishi`。本地开发时在本仓库建一个垫片即可（`node_modules/` 已被 gitignore，不会提交）：

```bash
mkdir -p node_modules
ln -s ../../koishi-app/node_modules/koishi node_modules/koishi
ln -s ../../koishi-app/node_modules/undici node_modules/undici
ln -s ../../koishi-app/node_modules/koishi-plugin-adapter-onebot node_modules/koishi-plugin-adapter-onebot
```

`test/probe.js` 走**真身** OneBot 适配器解码 + 真身 Argv 解析 + 真身 action，覆盖触发/静默、严格格式、引用兜底、缓存去重、三档阈值、密钥错误、额度耗尽降级、多通道优先级与冷却、图片类错误、限额、自检开关、回复样式等 **36 条路径**。

真实接口测试的密钥用**环境变量**传（不要把密钥写进任何文件）：

```bash
SIGHTENGINE_API_USER=xxx SIGHTENGINE_API_SECRET=yyy npm run test:live
```

## 安全：不要把密钥提交进仓库

- 插件的密钥只写在 Koishi 控制台 / `koishi.yml` 里，**本仓库不含任何密钥**；
- `.gitignore` 已忽略 `koishi.yml`、`.env`、`.npmrc`、`node_modules/`、日志与 `data/`；
- 提交前自查：`grep -rni "apisecret" .`（应当只命中 README 说明与 schema 定义，没有真实值）；
- fork 后想提交自己的配置，请用环境变量或本地未跟踪文件。

## License

MIT © firedrakeovo
