// app.js
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-d7gvb29nqbb6769be',
        traceUser: true,
      });
    }

  },
  globalData: {
    // 首页模式：'all' 显示数据库全部产品（默认）；'collection' 只显示扫码收藏的产品
    homeMode: 'all',
    config: {
      // EasyAR 配置：识别优先走云函数（服务端 token，无需域名、兼容 iOS）；
      // 以下参数用于「云函数暂不可用时」回退到原版前端直连（安卓可立即跑通）。
      apiKey: '18a4811375ad0afafe65583750daaf2b',
      apiSecret: '13af61cfc5af6c104e60ba8da3f1ced86521cb7d99eab805e007c69939f65891',
      crsAppId: '2a91e0a9dc86ccc03aea7eea21430855',
      clientEndUrl: 'https://2a91e0a9dc86ccc03aea7eea21430855.cn1.crs.easyar.com:8443',
      jpegQuality: 0.5,   // 截图质量：降低以减小传输体积，识别更快（CRS 识别足够）
      minInterval: 400,   // 识别间隔：缩短以更快响应
      timeout: 15000,
    }
  }
});