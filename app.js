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
    // 首页模式：'collection' 只显示用户扫码收藏的产品（新用户首页为空，扫码后才添加）
    homeMode: 'collection',
  }
});