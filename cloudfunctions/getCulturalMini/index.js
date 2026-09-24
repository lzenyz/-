const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 60000
})
const db = cloud.database()

/**
 * 云函数入口：传统文化AI科普
 * 使用 wx-server-sdk >= 4.0.1 的 cloud.ai() API（CloudBase 内置 deepseek）
 * @param {string} event.prompt 前端传入的文化主题提示词
 * @returns {Object} {code,msg?,data,fromCache?}
 */
exports.main = async (event, context) => {
  try {
    const { prompt } = event
    if (!prompt || typeof prompt !== 'string') {
      return {
        code: -1,
        msg: "参数错误，请传入prompt字符串"
      }
    }
    const userPrompt = prompt.trim()

    // ========== 1. 查询缓存集合 mini_cache ==========
    const cacheResult = await db.collection('mini_cache')
      .where({
        prompt: userPrompt
      })
      .limit(1)
      .get()

    // 缓存命中直接返回，不消耗AI资源点
    if (cacheResult.data.length > 0) {
      return {
        code: 0,
        data: cacheResult.data[0].result,
        fromCache: true
      }
    }

    // ========== 2. 调用 CloudBase AI（wx-server-sdk >= 4.0.1 的 cloud.ai() API） ==========
    const ai = cloud.ai()
    // createModel 只认供应商名（SDK 注册表里的固定十个：deepseek/hunyuan/moonshot/zhipu/...）。
    // 写别的名字会走 Default 路由，拼成 <名字>/chat/completions 这种无效地址。
    const model = ai.createModel('deepseek')
    const aiResp = await model.generateText({
      model: 'deepseek-flash', // 具体对话模型标识，填云开发控制台里已开通的那个
      messages: [
        {
          role: "system",
          content: "你是传统文化科普助手，回答简洁易懂，适合微信小程序展示，语言通俗，分段清晰，不要长篇学术论文，控制在300字以内。"
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      temperature: 0.7
      // 注意：cloud.ai() 的 generateText 不支持 max_tokens，仅靠 System prompt 限制 300 字
    })

    const aiContent = aiResp.text

    // ========== 3. 写入数据库缓存 ==========
    await db.collection('mini_cache').add({
      data: {
        prompt: userPrompt,
        result: aiContent,
        createTime: db.serverDate()
      }
    })

    return {
      code: 0,
      data: aiContent,
      fromCache: false
    }

  } catch (err) {
    console.error("云函数异常：", err)
    return {
      code: -2,
      msg: "AI生成失败",
      error: err.message || String(err)
    }
  }
}
