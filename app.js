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
  }
});