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
    config: {
      apiKey: '18a4811375ad0afafe65583750daaf2b',
      apiSecret: '13af61cfc5af6c104e60ba8da3f1ced86521cb7d99eab805e007c69939f65891',
      crsAppId: '2a91e0a9dc86ccc03aea7eea21430855',
      clientEndUrl: 'https://2a91e0a9dc86ccc03aea7eea21430855.cn1.crs.easyar.com:8443',
      jpegQuality: 0.7,
      minInterval: 600,
    }
  }
});