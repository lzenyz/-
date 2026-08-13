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
      // 云函数预热：静默调用一次，降低用户首次进入 AR 时的冷启动延迟（可忽略/删除）
      this._warmUpCloud();
    }
  },

  /**
   * 云函数预热：后台静默调用，忽略结果，仅为避免用户首次使用时云函数冷启动过慢
   */
  _warmUpCloud() {
    try {
      wx.cloud.callFunction({ name: 'quickstartFunctions', data: { action: 'getAllStickers' } })
        .then(() => {}, () => {});
    } catch (e) { /* 忽略预热失败 */ }
  },

  globalData: {
    // 首页模式：'collection' 只显示用户扫码收藏的产品（新用户首页为空，扫码后才添加）
    homeMode: 'collection',
  }
});