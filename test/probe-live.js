// 真实接口冒烟测试（会消耗额度：一次检测 5 次）
// 运行：SIGHTENGINE_API_USER=xxx SIGHTENGINE_API_SECRET=yyy node test/probe-live.js [图片URL...]
// 不带参数时用两张对照图：Pollinations 现场生成的 AI 图 + Sightengine 官方真实照片
const { Context, Argv, h } = require('koishi')

const apiUser = process.env.SIGHTENGINE_API_USER
const apiSecret = process.env.SIGHTENGINE_API_SECRET
if (!apiUser || !apiSecret) {
  console.error('请用环境变量传入密钥：SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET')
  process.exit(1)
}

const config = {
  selfCheck: false,
  channels: [{ label: '冒烟测试', apiUser, apiSecret, enabled: true }],
}

const IMAGES = process.argv.slice(2)
if (!IMAGES.length) {
  IMAGES.push(
    'https://image.pollinations.ai/prompt/cyberpunk-city?width=512&height=512&nologo=true', // AI 生成（扩散模型）
    'https://sightengine.com/assets/img/examples/example7.jpg',                             // 真实照片
  )
}

;(async () => {
  const app = new Context({ prefix: [null], nickname: ['ob'] })
  app.plugin(require('../lib/index.js'), { ...config, selfCheck: false })
  await new Promise((r) => setTimeout(r, 200))
  const cmd = app.$commander.resolve('ai检测')

  for (const url of IMAGES) {
    const content = `ai检测 <img src="${url}"/>`
    const elements = h.parse(content)
    const sent = []
    const session = {
      text: (k) => k, platform: 'onebot', channelId: 'group:smoke', userId: '0',
      elements, stripped: { content, prefix: '', appel: false, atSelf: false },
      bot: undefined, quote: null,
      resolve: (v) => (typeof v === 'function' ? v({}) : v),
      send: async (m) => { sent.push(String(m)); return [] },
    }
    const argv = { ...Argv.parse(content), session, root: true }
    const hit = app.$commander.resolveCommand(argv)
    if (!hit) { console.log(`❌ 指令没命中：${url}`); continue }
    await cmd._actions[0]({ session, options: {} }, ...(argv.args || []))
    console.log(`\n=== ${url}`)
    for (const s of sent) console.log(s.replace(/^<message forward>/, '').replace(/<\/message>/g, '\n---\n'))
  }
  process.exit(0)
})()
