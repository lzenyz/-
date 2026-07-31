// pages/index/index.js
Page({
  data: {},

  onLoad() {},

  goToAR() {
    wx.navigateTo({
      url: '/pages/ar/ar',
      success: () => {
        console.log('跳转AR页面成功');
      },
      fail: (err) => {
        console.error('跳转AR页面失败', err);
        wx.showToast({
          title: '跳转失败',
          icon: 'none'
        });
      }
    });
  }
});
