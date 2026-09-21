/**
 * koishi-plugin-aigc-detect
 *
 * 群聊里用「ai检测」判断图片是否由 AI 生成。
 *   ① 严格格式：本条消息的文本必须恰好只有「ai检测」（图片本身不算文本）
 *      —— 「ai检测 帮我看看这张 + 图」「ai检测 + 图 + 谢谢」都不触发
 *   ② 图片在本条消息里、或在被引用的消息里都可以；文本要求一样（恰好只有「ai检测」）
 *   ③ 没有图片：完全不响应（只在 debug 日志留一行），避免误触发和刷屏
 * 结果以「合并转发」形式发出：第一条是原图 + 结论，第二条是通道/分数/耗时明细。
 *
 * 默认通道 Sightengine（免费档 2000 次/月、每日封顶 500，含 AI 图像检测模型 genai）。
 * 想换供应商时：在 providers 里加一个实现、并在 Config.channel 的 union 里加一个 const 即可。
 */
const { Schema, h } = require('koishi')

const name = 'aigc-detect'

// 指令名与允许的写法。
// 注意：Koishi 的指令名匹配会先 toLowerCase（Command.normalize），所以「AI检测 / Ai检测」无需注册别名也能命中；
// 但下面这个正则作用在「用户原话」上，大小写必须自己列全。
const COMMAND = 'ai检测'
const ALIASES = ['ai检测', 'AI检测', 'Ai检测', 'aI检测']
const RE_EXACT = new RegExp(`^(?:${ALIASES.join('|')})$`)

// 配置分三组，控制台里会渲染成三个可折叠区块
const Config = Schema.intersect([
  Schema.object({
    channels: Schema.array(Schema.object({
      // 目前只有 sightengine 一种服务商，所以这里不放「服务商」下拉（单选项的 union 在控制台渲染不出控件）；
      // 以后接入阿里云 / 腾讯云时再加回来，并在 providers 里补对应实现。配置文件里仍可手写 provider 字段。
      label: Schema.string().description('备注名（可留空）').comment('只用于日志和结果里显示，比如「主账号」「备用账号」。'),
      apiUser: Schema.string().description('Sightengine · API USER')
        .comment('在 https://sightengine.com 注册后，Dashboard → API keys 里可以看到 API USER 与 API SECRET。免费额度 2000/月（一次检测消耗 5）。'),
      apiSecret: Schema.string().role('secret').description('Sightengine · API SECRET'),
      proxy: Schema.string().description('HTTP 代理（留空=直连）'),
      enabled: Schema.boolean().default(true).description('启用这个通道'),
    })).default([{ label: '主账号', enabled: true }]),
  }).description('检测通道（按顺序依次尝试）')
    .comment('点「添加」可以加多个通道：从上往下按优先级用，前一个不可用（额度用完 / 密钥失效 / 网络失败）会自动切到下一个；失败过的通道会冷却一段时间。'),

  Schema.object({
    selfCheck: Schema.boolean().default(true).description('启动时自动校验各通道的密钥')
      .comment('用 0 消耗的探针（只发凭据、不带 models）逐个验证，结果只写日志。'),
    cooldownMinutes: Schema.natural().default(60).description('通道失败后的冷却时间（分钟）')
      .comment('某个通道因为额度用完 / 密钥失效 / 未订阅而失败后，这段时间内直接跳过它、用下一个通道；到期后会再试一次。'),
    highThreshold: Schema.percent().default(0.8).description('判定「大概率是 AI 生成」的阈值'),
    lowThreshold: Schema.percent().default(0.4).description('判定「疑似 AI 生成」的阈值'),
    cacheHours: Schema.natural().default(24).description('同一张图的结果缓存时长（小时）')
      .comment('按 QQ 图片的 fileid 去重，群友重复发同一张图只消耗一次额度；填 0 表示不缓存。'),
    timeout: Schema.natural().default(15000).role('ms').description('单次请求超时'),
  }).description('判定与缓存'),

  Schema.object({
    forward: Schema.boolean().default(true).description('用「合并转发」（聊天记录）展示结果')
      .comment('关闭后改为一条普通消息：图片 + 结论 + 明细。合并转发需要适配器支持 forward 消息（NapCat/OneBot 支持）。'),
  }).description('回复样式'),

  Schema.object({
    enableUserLimit: Schema.boolean().default(false).description('启用「每人每日次数上限」').comment('默认关闭。'),
    dailyLimitPerUser: Schema.natural().default(10).description('每人每日上限'),
    enableChannelLimit: Schema.boolean().default(false).description('启用「每群每日次数上限」').comment('默认关闭。'),
    dailyLimitPerChannel: Schema.natural().default(50).description('每群每日上限'),
  }).description('每日限额（可选）'),
])

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 从字符串 / 元素数组里取图片地址 */
function collectImages(source) {
  if (!source) return []
  try {
    return h.select(h.normalize(source), 'img').map((item) => item.attrs.src).filter(Boolean)
  } catch (e) {
    return []
  }
}

/** 本条消息自己的纯文本（剥掉指令前缀、丢掉图片/at 等元素） */
function getOwnText(session) {
  try {
    const stripped = session.stripped || {}
    const raw = stripped.content || ''
    const content = stripped.prefix ? raw.slice(stripped.prefix.length) : raw
    return h.parse(content)
      .filter((el) => el.type === 'text')
      .map((el) => (el.attrs && el.attrs.content != null ? el.attrs.content : el.toString()))
      .join('')
      .trim()
  } catch (e) {
    return ''
  }
}

/**
 * 图片指纹。QQ 的图片地址每次都带不同的 rkey（同一张图 URL 也会变），
 * 所以优先用 fileid 做 key，缓存才真的能命中。
 */
function imageKey(src) {
  try {
    const url = new URL(src)
    const fileid = url.searchParams.get('fileid')
    if (fileid) return `qq:${url.searchParams.get('appid') || ''}:${fileid}`
    return `url:${url.origin}${url.pathname}`
  } catch (e) {
    return `raw:${src}`
  }
}

/** 这个错误是否意味着「该通道短期内别再用」（额度/密钥/订阅类） */
function isFatalError(message) {
  return /credentials_error|incorrect api user|api_secret|api_user|quota|insufficient|欠费|余额|not subscribed|subscri|unknown model|not allowed|rate limit|too many requests|429/i.test(String(message || ''))
}

/** 日志里只放短文本，避免把整条消息（含超长图片 URL）写进日志 */
function short(value, max = 40) {
  const text = String(value == null ? '' : value)
  return text.length > max ? `${text.slice(0, max)}…(${text.length}字)` : text
}

function localDay(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

// ── 通道实现 ────────────────────────────────────────────────────────────────

async function callSightengine(fetchImpl, ch, config, src) {
  const endpoint = 'https://api.sightengine.com/1.0/check.json'
  let body
  if (/^https?:\/\//i.test(src)) {
    body = new URLSearchParams({
      api_user: ch.apiUser,
      api_secret: ch.apiSecret,
      models: 'genai',
      url: src,
    })
  } else {
    // 本地文件（file:// 或路径）：走 multipart 上传
    const file = src.startsWith('file://') ? require('url').fileURLToPath(src) : src
    const buf = require('fs').readFileSync(file)
    const form = new FormData()
    form.append('api_user', ch.apiUser)
    form.append('api_secret', ch.apiSecret)
    form.append('models', 'genai')
    form.append('media', new Blob([buf]), 'image.jpg')
    body = form
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(config.timeout),
  })
  const data = await response.json()
  if (data.status !== 'success') {
    const detail = data.error ? `${data.error.type || ''} ${data.error.message || ''}`.trim() : String(data.status)
    throw new Error(`sightengine 返回失败：${detail}`)
  }
  // 实测（2026-09）：models=genai 的分数在 type.ai_generated 里，而不是 genai.score；
  // 同时兼容旧的 genai.score / ai_generated.score 写法，避免上游改版又炸。
  const score = [data.type && data.type.ai_generated, data.genai && data.genai.score, data.ai_generated && data.ai_generated.score]
    .find((v) => typeof v === 'number')
  if (typeof score !== 'number') throw new Error(`sightengine 响应里没有 type.ai_generated 字段（keys: ${Object.keys(data).join(',')}）`)
  return { score, model: 'genai', operations: data.request && data.request.operations, raw: data }
}

const providers = {
  sightengine: callSightengine,
}

/**
 * 0 消耗的凭据探针：故意不带 models 发一次请求。
 * 实测（2026-09-21）Sightengine 会先校验凭据、再校验参数，所以
 *   密钥错误 → {"error":{"type":"credentials_error"}}（0 operations）
 *   密钥正确 → {"error":{"type":"argument_error","message":"Missing argument. Please specify models"}}（0 operations）
 * 这样启动自检就不会消耗额度。
 */
async function probeCredentials(fetchImpl, ch, timeout) {
  const response = await fetchImpl('https://api.sightengine.com/1.0/check.json', {
    method: 'POST',
    body: new URLSearchParams({ api_user: ch.apiUser, api_secret: ch.apiSecret }),
    signal: AbortSignal.timeout(timeout),
  })
  const data = await response.json()
  if (data.status === 'success') return
  const error = data.error || {}
  if (error.type === 'credentials_error') throw new Error(`credentials_error ${error.message || ''}`.trim())
  // 参数类错误说明凭据已经通过校验
  if (error.type === 'argument_error') return
  throw new Error(`status=${data.status} ${error.type || ''} ${error.message || ''}`.trim())
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

function apply(ctx, config) {
  /** 通道的服务商（配置里没写就默认 sightengine） */
  const providerOf = (ch) => (ch && ch.provider) || 'sightengine'

  /** 按配置顺序取出可用的通道（跳过停用 / 空行 / 未实现的服务商） */
  const channelList = () => (config.channels || [])
    .filter((ch) => ch && ch.enabled !== false && providers[providerOf(ch)])

  const channelName = (ch, i) => (ch.label ? `${ch.label}` : `${providerOf(ch)}#${i + 1}`)

  const hasCredentials = (ch) => providerOf(ch) === 'sightengine'
    ? !!(ch.apiUser && ch.apiSecret)
    : false

  if (!channelList().length) {
    ctx.logger.warn('没有可用的检测通道，「ai检测」暂不可用（Koishi 控制台 → 插件配置 → aigc-detect → 检测通道 里添加并填写凭据）')
  }

  // 带代理的 fetch（按通道的 proxy 构造并缓存）
  const fetchCache = new Map()
  const resolveFetch = (ch) => {
    const uri = ch && ch.proxy
    if (!uri) return globalThis.fetch
    if (fetchCache.has(uri)) return fetchCache.get(uri)
    try {
      const { ProxyAgent } = require('undici')
      const agent = new ProxyAgent({ uri })
      const wrapped = (url, init) => globalThis.fetch(url, { ...init, dispatcher: agent })
      fetchCache.set(uri, wrapped)
      return wrapped
    } catch (e) {
      ctx.logger.warn(`代理初始化失败（${uri}），改为直连：${e.message}`)
      return globalThis.fetch
    }
  }

  // 启动自检：逐个通道用 0 消耗的凭据探针校验，结果写日志、不阻塞启动
  if (config.selfCheck) {
    const list = channelList()
    for (let i = 0; i < list.length; i++) {
      const ch = list[i]
      if (!hasCredentials(ch)) {
        ctx.logger.warn(`通道 ${i + 1}（${channelName(ch, i)}）还没填凭据，会被跳过`)
        continue
      }
      probeCredentials(resolveFetch(ch), ch, config.timeout)
        .then(() => ctx.logger.info(`通道 ${i + 1}（${channelName(ch, i)}）凭据有效（本次校验不消耗额度）`))
        .catch((e) => ctx.logger.warn(`通道 ${i + 1}（${channelName(ch, i)}）校验未通过：${e.message}`))
    }
  }

  // 失败通道的冷却表：index -> 到期时间戳
  const deadUntil = new Map()
  const isDead = (i) => (deadUntil.get(i) || 0) > Date.now()

  // 结果缓存：imageKey -> { score, model, raw, at }
  const cache = new Map()
  const cacheGet = (key) => {
    if (!config.cacheHours || !key) return null
    const hit = cache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > config.cacheHours * 3600 * 1000) {
      cache.delete(key)
      return null
    }
    return hit
  }
  const cacheSet = (key, value) => {
    if (!config.cacheHours || !key) return
    cache.set(key, value)
    while (cache.size > 2000) cache.delete(cache.keys().next().value)
  }

  // 每日计数：`${day}|${kind}|${id}` -> number（进程内存，重启即清零）
  const counters = new Map()
  const countUp = (kind, id) => {
    const day = localDay()
    for (const key of counters.keys()) {
      if (!key.startsWith(`${day}|`)) counters.delete(key)
    }
    const key = `${day}|${kind}|${id}`
    const value = (counters.get(key) || 0) + 1
    counters.set(key, value)
    return value
  }

  ctx.on('dispose', () => {
    cache.clear()
    counters.clear()
  })

  ctx
    .command(`${COMMAND} [message:text]`, '检测图片是否由 AI 生成')
    .action(async (argv, message) => {
      const session = argv.session

      // 取图：本条消息 → 引用消息（适配器没带进来时自己再拉一次）
      let quote = null
      try {
        quote = session.quote || null
      } catch (e) {}
      const ownText = getOwnText(session)
      const ownImages = collectImages(session.elements)
      let quotedImages = quote ? collectImages(quote.content || quote.elements) : []
      if (!ownImages.length && !quotedImages.length && quote && quote.id && session.bot && typeof session.bot.getMessage === 'function') {
        const quoted = await session.bot
          .getMessage(session.channelId, quote.id)
          .catch((e) => {
            ctx.logger.warn(`获取被引用消息失败：${e.message}`)
            return null
          })
        if (quoted) quotedImages = collectImages(quoted.content || quoted.elements)
      }

      ctx.logger.debug(`收到：文本=${JSON.stringify(short(ownText))} 本条图=${ownImages.length} 引用图=${quotedImages.length}`)

      // 严格格式：不满足就完全不响应
      const images = ownImages.length ? ownImages : quotedImages
      if (!images.length) {
        ctx.logger.debug(`忽略（没有图片）：文本=${JSON.stringify(short(ownText))}`)
        return
      }
      if (!RE_EXACT.test(ownText)) {
        ctx.logger.debug(`忽略（不是严格的「${COMMAND}+图片」格式）：文本=${JSON.stringify(short(ownText))}`)
        return
      }

      const list = channelList()
      if (!list.length || !list.some(hasCredentials)) {
        await session.send(`「${COMMAND}」还没有可用的检测通道，请管理员到 Koishi 控制台 → 插件配置 → aigc-detect → 「检测通道」里添加并填写凭据。`)
        return
      }

      // 限额（默认关闭）
      if (config.enableUserLimit && config.dailyLimitPerUser) {
        const used = countUp('user', session.userId)
        if (used > config.dailyLimitPerUser) {
          await session.send(`今天「${COMMAND}」的额度用完啦（每人 ${config.dailyLimitPerUser} 次/天）。`)
          return
        }
      }
      if (config.enableChannelLimit && config.dailyLimitPerChannel) {
        const used = countUp('channel', session.channelId)
        if (used > config.dailyLimitPerChannel) {
          await session.send(`本群今天「${COMMAND}」的额度用完啦（每群 ${config.dailyLimitPerChannel} 次/天）。`)
          return
        }
      }

      const src = images[0]
      const key = imageKey(src)
      const started = Date.now()
      let result = cacheGet(key)
      const cached = !!result
      let skipped = 0
      if (!result) {
        const failures = []
        for (let i = 0; i < list.length; i++) {
          const ch = list[i]
          const name = channelName(ch, i)
          if (!hasCredentials(ch)) {
            failures.push(`${name}：未填凭据`)
            continue
          }
          if (isDead(i)) {
            skipped++
            failures.push(`${name}：冷却中（此前失败）`)
            continue
          }
          try {
            const res = await providers[providerOf(ch)](resolveFetch(ch), ch, config, src)
            result = { ...res, channelName: name, provider: providerOf(ch), channelIndex: i }
            cacheSet(key, { ...result, at: Date.now() })
            break
          } catch (e) {
            failures.push(`${name}：${e.message}`)
            ctx.logger.warn(`ai检测 通道 ${name} 失败：${e.message}`)
            if (isFatalError(e.message)) {
              deadUntil.set(i, Date.now() + (config.cooldownMinutes || 60) * 60 * 1000)
              skipped++
            }
          }
        }
        if (!result) {
          ctx.logger.warn(`ai检测 所有通道都失败：${failures.join(' | ')}`)
          const joined = failures.join(' | ')
          let tip
          if (/too big|less than 12 ?megabytes/i.test(joined)) {
            tip = '这张图太大了（检测服务单张上限 12MB），压缩一下再发给我吧。'
          } else if (/media_error/i.test(joined)) {
            tip = '图片没能被检测服务取到（可能是链接已失效或格式不支持），请重新发送一次图片。'
          } else if (failures.every((f) => /未填凭据|credentials_error/i.test(f))) {
            tip = `检测服务的密钥无效或未填写，请管理员到 Koishi 控制台检查「${COMMAND}」插件的「检测通道」。`
          } else {
            tip = '所有检测通道暂时都不可用（额度用尽或服务异常），请稍后再试或查看 Koishi 日志。'
          }
          await session.send(tip)
          return
        }
      }
      const elapsed = Date.now() - started

      const score = result.score
      const percent = Math.round(score * 100)
      let verdict
      if (score >= config.highThreshold) verdict = '🤖 大概率是 AI 生成'
      else if (score >= config.lowThreshold) verdict = '🤔 疑似 AI 生成'
      else verdict = '🖼️ 未检出明显的 AI 生成特征'

      const summary = `${verdict}\nAI 生成概率：${percent}%`
      const details = [
        `通道：${result.channelName || '（缓存）'}${result.provider && result.provider !== result.channelName ? ` · ${result.provider}` : ''}${result.model ? ` · 模型：${result.model}` : ''}${skipped ? ` · 已跳过 ${skipped} 个不可用通道` : ''}`,
        `原始分数：${score}`,
        `判定阈值：≥${config.highThreshold} 高概率 / ≥${config.lowThreshold} 疑似`,
        `耗时：${elapsed} ms${cached ? '（命中缓存，未消耗额度）' : ''}`,
      ]
      if (!cached && typeof result.operations === 'number') details.push(`本次消耗：${result.operations} 次额度`)
      if (images.length > 1) details.push(`本条消息含 ${images.length} 张图，本次只检测了第一张`)
      details.push('检测结果仅供参考，不构成确定性结论。')
      const detailText = details.join('\n')

      if (config.forward) {
        // 合并转发（聊天记录）：第一条是原图 + 结论，第二条是明细
        const head = h('message', {}, [h('img', { src }), h.text(`\n${summary}`)])
        const tail = h('message', {}, h.text(detailText))
        await session.send(h('message', { forward: true }, [head, tail]))
      } else {
        // 普通消息：图片 + 结论 + 明细，一次发完
        await session.send([h('img', { src }), h.text(`\n${summary}\n\n${detailText}`)])
      }
    })
}

module.exports = { name, Config, apply }
