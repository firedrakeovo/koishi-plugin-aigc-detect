// 离线用例：真身 OneBot 适配器解码 → 真身 Argv 解析 → 真身 action（Sightengine 打桩，不消耗额度）
// 运行：npm test（需要先 npm install）
const { Context, Argv, h } = require('koishi')
const { OneBotBot, BaseBot } = require('koishi-plugin-adapter-onebot')

// ── 打桩 Sightengine ───────────────────────────────────────────────────────
let netCalls = []
let scoreMode = 'high'   // high | mid | low | fail | creds
let perUser = {}         // apiUser -> 该通道专属的返回模式（用于多通道降级用例）
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const body = String((init && init.body) || '')
  const user = (body.match(/api_user=([^&]*)/) || [])[1] || ''
  netCalls.push(`${url}#${user}`)
  if (!String(url).includes('sightengine.com')) return realFetch(url, init)
  const mode = perUser[user] || scoreMode
  if (mode === 'fail') {
    return json({ status: 'failure', request: { id: 'req_x', operations: 0 }, error: { type: 'server_error', code: 5, message: 'too many requests' } })
  }
  if (mode === 'quota') {
    return json({ status: 'failure', request: { id: 'req_x', operations: 0 }, error: { type: 'quota_exceeded', code: 4, message: 'quota exceeded for this month' } })
  }
  if (mode === 'toobig') {
    return json({ status: 'failure', request: { id: 'req_x', operations: 0 }, error: { type: 'media_error', code: 2, message: 'Image too big, should be less than 12 megabytes' } })
  }
  if (mode === 'media') {
    return json({ status: 'failure', request: { id: 'req_x', operations: 0 }, error: { type: 'media_error', code: 3, message: 'Could not fetch the media' } })
  }
  if (mode === 'creds') {
    return json({ status: 'failure', request: { id: 'req_x', operations: 0 }, error: { type: 'credentials_error', code: 1, message: 'Incorrect API user or API secret' } })
  }
  const score = mode === 'low' ? 0.05 : mode === 'mid' ? 0.5 : 0.96
  // 与真实响应一致：AI 检测分数在 type.ai_generated，额度消耗在 request.operations
  return json({ status: 'success', request: { id: 'req_1', operations: 5 }, type: { ai_generated: score } })
}

// ── 复刻 core Session#stripped 的相关部分 ─────────────────────────────────
function strippedContent(elements) {
  const els = elements.slice()
  while (els[0]?.type === 'at') {
    els.shift()
    if (els[0]?.type === 'text' && !els[0].attrs.content.trim()) els.shift()
  }
  return els.join('').trim()
}

const IMG = (fileid, rkey) => `[CQ:image,url=https://mult.example.com/download?appid=1407&fileid=${fileid}&rkey=${rkey},file=a.jpg]`

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`✅ ${label}`) }
  else { fail++; console.log(`❌ ${label}${extra ? '\n     → ' + extra : ''}`) }
}

async function makeApp(config = {}) {
  const app = new Context({ prefix: ['。', '.', null], nickname: ['ob'] })
  app.plugin(require('../lib/index.js'), {
    selfCheck: false,
    channels: [{ provider: 'sightengine', label: '测试通道', apiUser: 'test_user', apiSecret: 'test_secret', enabled: true }],
    ...config,
  })
  await new Promise((r) => setTimeout(r, 150))
  return app
}

const fakeBot = Object.create(OneBotBot.prototype)
fakeBot.platform = 'onebot'
fakeBot.selfId = '1411159214'
fakeBot.config = { advanced: { splitMixedContent: true } }
fakeBot.internal = { getMsg: async () => null }
const msgData = (id, raw) => ({
  message_id: +id, message: raw, message_type: 'group', sub_type: 'normal',
  group_id: 123456, user_id: 654321, self_id: 1411159214,
  sender: { user_id: 654321, nickname: 'tester', role: 'member' },
  post_type: 'message', time: Math.floor(Date.now() / 1000),
})

async function run(app, { own, quote, userId = '654321', channelId = 'group:123456', dropQuoteContent = false, failForward = false }) {
  const store = { 100: msgData(100, own) }
  if (quote) store[200] = msgData(200, quote)
  fakeBot.internal.getMsg = async (id) => store[String(id)]
  const event = await BaseBot.prototype.getMessage.call(fakeBot, channelId, '100')
  const elements = event.elements
  const content = strippedContent(elements)
  const prefix = ['。', '.'].find((p) => content.startsWith(p)) || ''
  const sent = []
  const stripped = { content, prefix, appel: false, atSelf: false }
  const session = {
    text: (k) => k, platform: 'onebot', channelId, userId,
    elements, bot: fakeBot, stripped,
    quote: dropQuoteContent ? { id: '200' } : event.quote,
    resolve: (v) => (typeof v === 'function' ? v({}) : v),
    send: async (m) => {
      const text = String(m)
      if (failForward && text.includes('<message forward>')) {
        throw new Error('Error with request send_group_forward_msg, retcode: 1200')
      }
      sent.push(text)
      return []
    },
  }
  const argv = { ...Argv.parse(prefix ? content.slice(prefix.length) : content), session, root: true }
  const hit = app.$commander.resolveCommand(argv)
  if (hit) await app.$commander.resolve(hit.name)._actions[0]({ session, options: argv.options || {} }, ...(argv.args || []))
  return { sent, hit: hit ? hit.name : null, content }
}

;(async () => {
  const app = await makeApp()
  const cmd = app.$commander.resolve('ai检测')
  console.log(`指令：${cmd?.name}  别名：${JSON.stringify(Object.keys(cmd?._aliases || {}))}\n`)

  // ① 普通：ai检测 + 图片（无空格）
  scoreMode = 'high'; netCalls = []
  let r = await run(app, { own: `ai检测${IMG('F1', 'R1')}` })
  check('① ai检测 + 图片 → 合并转发 + 大概率结论', r.sent.length === 1 && r.sent[0].includes('<message forward>') && r.sent[0].includes('大概率是 AI 生成') && r.sent[0].includes('96%'), r.sent.join(' | ').slice(0, 200))
  check('①b 转发里带原图与明细', r.sent[0].includes('mult.example.com') && r.sent[0].includes('原始分数：0.96') && r.sent[0].includes('仅供参考'))
  check('①c 明细里带额度消耗', r.sent[0].includes('本次消耗：5 次额度'), r.sent[0].slice(0, 240))

  // ② 大写别名
  netCalls = []
  r = await run(app, { own: `AI检测 ${IMG('F2', 'R1')}` })
  check('② AI检测（大写别名）+ 图片 → 触发', r.hit === 'ai检测' && r.sent.length === 1 && r.sent[0].includes('forward'), JSON.stringify(r.sent).slice(0, 160))

  // ③ 严格格式：指令和图之间多打了文字 → 静默
  r = await run(app, { own: `ai检测 帮我看看这张${IMG('F3', 'R1')}` })
  check('③ ai检测 帮我看看这张 + 图片 → 静默（严格格式）', r.sent.length === 0, JSON.stringify(r.sent).slice(0, 160))

  // ③b 图后面跟文字 → 同样静默
  r = await run(app, { own: `ai检测${IMG('F3b', 'R1')} 谢谢` })
  check('③b ai检测 + 图片 + 谢谢 → 静默（严格格式）', r.sent.length === 0, JSON.stringify(r.sent).slice(0, 160))

  // ④ 回复图片 + 只发指令（own 里带 [CQ:reply,id=200]，跟真实 QQ 回复一致）
  r = await run(app, { own: '[CQ:reply,id=200]ai检测', quote: IMG('F4', 'R1') })
  check('④ 回复图片 + 只发 ai检测 → 触发', r.sent.length === 1 && r.sent[0].includes('forward'), JSON.stringify(r.sent).slice(0, 200))

  // ④b 适配器没把被引用消息带进来 → 插件自己 getMessage 兜底
  r = await run(app, { own: '[CQ:reply,id=200]ai检测', quote: IMG('F4b', 'R1'), dropQuoteContent: true })
  check('④b 适配器未带 quote.content → 自行 getMessage 兜底', r.sent.length === 1 && r.sent[0].includes('forward'), JSON.stringify(r.sent).slice(0, 200))

  // ⑤ 回复图片 + 多打了字 → 静默
  r = await run(app, { own: '[CQ:reply,id=200]ai检测 谢谢', quote: IMG('F5', 'R1') })
  check('⑤ 回复图片 + ai检测 谢谢 → 静默', r.sent.length === 0, JSON.stringify(r.sent))

  // ⑥ 无图 → 静默
  r = await run(app, { own: 'ai检测' })
  check('⑥ 只发 ai检测（无图）→ 静默', r.sent.length === 0 && r.hit === 'ai检测', JSON.stringify(r.sent))

  // ⑦ 回复纯文字 → 静默
  r = await run(app, { own: '[CQ:reply,id=200]ai检测', quote: '这是一条没有图片的消息' })
  check('⑦ 回复纯文字消息 + ai检测 → 静默', r.sent.length === 0, JSON.stringify(r.sent))

  // ⑧ 粘连词 → 指令都不该命中
  r = await run(app, { own: `ai检测一下${IMG('F6', 'R1')}` })
  check('⑧ ai检测一下 + 图片 → 未命中指令', r.hit === null, String(r.hit))

  // ⑨ 缓存：同一 fileid、不同 rkey 第二次应命中缓存且不再发请求
  scoreMode = 'high'; netCalls = []
  await run(app, { own: `ai检测${IMG('F7', 'AAA')}` })
  const firstCalls = netCalls.length
  r = await run(app, { own: `ai检测${IMG('F7', 'BBB')}` })
  check('⑨ 同图（rkey 变化）第二次命中缓存', netCalls.length === firstCalls && r.sent[0].includes('命中缓存'), `netCalls=${netCalls.length} first=${firstCalls} sent=${r.sent[0]?.slice(0, 120)}`)

  // ⑩ 阈值分档
  scoreMode = 'mid'
  r = await run(app, { own: `ai检测${IMG('F8', 'R1')}` })
  check('⑩ score=0.5 → 疑似 AI 生成', r.sent[0].includes('疑似 AI 生成'), r.sent[0]?.slice(0, 120))
  scoreMode = 'low'
  r = await run(app, { own: `ai检测${IMG('F9', 'R1')}` })
  check('⑩b score=0.05 → 未检出明显特征', r.sent[0].includes('未检出明显的 AI 生成特征'), r.sent[0]?.slice(0, 120))

  // ⑪ 服务报错 → 提示失败（不静默）+ 日志 warn
  scoreMode = 'fail'
  r = await run(app, { own: `ai检测${IMG('F10', 'R1')}` })
  check('⑪ 通道报错 → 回「所有检测通道暂时都不可用」', r.sent.length === 1 && r.sent[0].includes('都不可用'), JSON.stringify(r.sent).slice(0, 160))

  // ⑪b 密钥错误 → 明确提示去控制台改（用新实例，避免上一例把唯一通道打进冷却）
  scoreMode = 'creds'
  const appCreds = await makeApp()
  r = await run(appCreds, { own: `ai检测${IMG('F10b', 'R1')}` })
  check('⑪b 密钥错误 → 提示检查 apiUser / apiSecret', r.sent.length === 1 && r.sent[0].includes('密钥无效'), JSON.stringify(r.sent).slice(0, 160))

  // ⑫ 未配置密钥
  const appNoKey = await makeApp({ channels: [] })
  r = await run(appNoKey, { own: `ai检测${IMG('F11', 'R1')}` })
  check('⑫ 没有可用通道 → 明确提示', r.sent.length === 1 && r.sent[0].includes('检测通道'), JSON.stringify(r.sent).slice(0, 160))

  // ⑬ 用户限额（开启后生效，默认关闭）
  const appUserLimit = await makeApp({ enableUserLimit: true, dailyLimitPerUser: 1 })
  scoreMode = 'high'
  await run(appUserLimit, { own: `ai检测${IMG('F12', 'R1')}`, userId: '111' })
  r = await run(appUserLimit, { own: `ai检测${IMG('F13', 'R1')}`, userId: '111' })
  check('⑬ 用户限额=1 → 第二次被拒', r.sent.length === 1 && r.sent[0].includes('额度用完') && r.sent[0].includes('每人'), JSON.stringify(r.sent).slice(0, 160))
  r = await run(appUserLimit, { own: `ai检测${IMG('F14', 'R1')}`, userId: '222' })
  check('⑬b 换个人不受影响', r.sent.length === 1 && r.sent[0].includes('forward'))

  // ⑭ 群限额
  const appChLimit = await makeApp({ enableChannelLimit: true, dailyLimitPerChannel: 1 })
  await run(appChLimit, { own: `ai检测${IMG('F15', 'R1')}`, channelId: 'group:1' })
  r = await run(appChLimit, { own: `ai检测${IMG('F16', 'R1')}`, channelId: 'group:1' })
  check('⑭ 群限额=1 → 第二次被拒', r.sent.length === 1 && r.sent[0].includes('额度用完') && r.sent[0].includes('每群'), JSON.stringify(r.sent).slice(0, 160))
  r = await run(appChLimit, { own: `ai检测${IMG('F17', 'R1')}`, channelId: 'group:2' })
  check('⑭b 换个群不受影响', r.sent.length === 1 && r.sent[0].includes('forward'))

  // ⑮ 默认不启用限额：连发 3 次都应正常
  const appNoLimit = await makeApp()
  let okCount = 0
  for (const f of ['G1', 'G2', 'G3']) {
    const rr = await run(appNoLimit, { own: `ai检测${IMG(f, 'R1')}`, userId: '333' })
    if (rr.sent.length === 1 && rr.sent[0].includes('forward')) okCount++
  }
  check('⑮ 默认不启用限额 → 连续 3 次都正常', okCount === 3, `okCount=${okCount}`)

  // ⑯ 多条消息含 2 张图 → 明细提示只检测第一张
  r = await run(appNoLimit, { own: `ai检测${IMG('H1', 'R1')}${IMG('H2', 'R1')}` })
  check('⑯ 两张图 → 明细提示只检测第一张', r.sent[0].includes('含 2 张图'), r.sent[0]?.slice(0, 200))

  // ⑰ 启动自检：默认开启时会立刻打一次请求；关掉就不打
  netCalls = []
  const appSelfCheck = await makeApp({ selfCheck: true })
  await new Promise((r) => setTimeout(r, 200))
  check('⑰ 启动自检（默认开，0 消耗探针）→ 启动时调用一次 /check.json', netCalls.length === 1, `netCalls=${netCalls.length}`)
  netCalls = []
  await makeApp({ selfCheck: false })
  await new Promise((r) => setTimeout(r, 200))
  check('⑰b selfCheck=false → 启动时不调接口', netCalls.length === 0, `netCalls=${netCalls.length}`)

  // ⑱ 回复样式开关：forward=false 时发普通消息（非合并转发）
  const appPlain = await makeApp({ forward: false })
  scoreMode = 'high'
  r = await run(appPlain, { own: `ai检测${IMG('I1', 'R1')}` })
  check('⑱ forward=false → 发普通消息（不含 forward 标签）',
    r.sent.length === 1 && !r.sent[0].includes('<message forward>') && r.sent[0].includes('大概率是 AI 生成') && r.sent[0].includes('原始分数'),
    JSON.stringify(r.sent).slice(0, 200))
  const appFwd = await makeApp({ forward: true })
  r = await run(appFwd, { own: `ai检测${IMG('I2', 'R1')}` })
  check('⑱b forward=true → 仍是合并转发', r.sent[0].includes('<message forward>'), JSON.stringify(r.sent).slice(0, 120))

  // ⑲ 多通道优先级：通道1 额度用完 → 自动切通道2，并让通道1 进入冷却
  perUser = { chan_a: 'quota' }
  netCalls = []
  const appMulti = await makeApp({
    channels: [
      { provider: 'sightengine', label: '主账号', apiUser: 'chan_a', apiSecret: 'x', enabled: true },
      { provider: 'sightengine', label: '备用账号', apiUser: 'chan_b', apiSecret: 'y', enabled: true },
    ],
  })
  r = await run(appMulti, { own: `ai检测${IMG('J1', 'R1')}` })
  check('⑲ 通道1 额度用完 → 自动用通道2',
    r.sent.length === 1 && r.sent[0].includes('备用账号') && r.sent[0].includes('已跳过 1 个不可用通道'),
    r.sent[0] && r.sent[0].slice(0, 240))
  const calls1 = netCalls.length
  r = await run(appMulti, { own: `ai检测${IMG('J2', 'R1')}` })
  check('⑲b 通道1 已在冷却 → 第二次只调通道2（1 次请求）', netCalls.length - calls1 === 1, `delta=${netCalls.length - calls1}`)

  // ⑳ 所有通道都失败 → 明确提示
  perUser = { chan_a: 'quota', chan_b: 'quota' }
  r = await run(appMulti, { own: `ai检测${IMG('J3', 'R1')}` })
  check('⑳ 所有通道都失败 → 提示暂时不可用', r.sent.length === 1 && r.sent[0].includes('都不可用'), JSON.stringify(r.sent).slice(0, 160))

  // ㉑ 未填凭据 / 停用的通道自动跳过
  perUser = {}
  const appSkip = await makeApp({
    channels: [
      { provider: 'sightengine', label: '空凭据', enabled: true },
      { provider: 'sightengine', label: '已停用', apiUser: 'chan_a', apiSecret: 'x', enabled: false },
      { provider: 'sightengine', label: '可用的', apiUser: 'chan_b', apiSecret: 'y', enabled: true },
    ],
  })
  r = await run(appSkip, { own: `ai检测${IMG('J4', 'R1')}` })
  check('㉑ 跳过未填凭据 / 已停用的通道，用第三个', r.sent.length === 1 && r.sent[0].includes('可用的'), r.sent[0] && r.sent[0].slice(0, 200))

  // ㉒ 图片过大 → 明确提示，且图片类失败不该把通道打进冷却
  scoreMode = 'toobig'
  const appBig = await makeApp()
  r = await run(appBig, { own: `ai检测${IMG('K1', 'R1')}` })
  check('㉒ 图太大 → 提示压缩后再发', r.sent.length === 1 && r.sent[0].includes('12MB'), JSON.stringify(r.sent).slice(0, 160))
  scoreMode = 'high'
  netCalls = []
  r = await run(appBig, { own: `ai检测${IMG('K2', 'R1')}` })
  check('㉒b 图片类失败不冷却通道 → 下一张仍用同一通道', netCalls.length === 1 && r.sent[0].includes('forward'), `netCalls=${netCalls.length}`)

  // ㉓ 取不到图（media_error）
  scoreMode = 'media'
  const appMedia = await makeApp()
  r = await run(appMedia, { own: `ai检测${IMG('K3', 'R1')}` })
  check('㉓ media_error → 提示重新发送图片', r.sent.length === 1 && r.sent[0].includes('重新发送'), JSON.stringify(r.sent).slice(0, 160))

  // ㉔ 合并转发发送失败（NapCat retcode 1200）→ 自动降级为普通消息
  scoreMode = 'high'
  const appFb = await makeApp({ forward: true })
  r = await run(appFb, { own: `ai检测${IMG('L1', 'R1')}`, failForward: true })
  check('㉔ 转发失败 → 自动用普通消息重发（含结论与明细）',
    r.sent.length === 1 && !r.sent[0].includes('<message forward>') && r.sent[0].includes('大概率是 AI 生成') && r.sent[0].includes('原始分数'),
    JSON.stringify(r.sent).slice(0, 240))

  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
})()
