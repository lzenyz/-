Page({
  data: {
    config: getApp().globalData.config,
    isInitializing: true,
    initStatus: '正在启动AR...',
    isRecognized: false,
    isError: false,
    isVideoLoading: false,
    runingCrs: false,
    tracking: false,
    width: 0,
    height: 0,
    dpi: 1,
    isVideoLoaded: false,
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    this.setData({
      width: sys.windowWidth,
      height: sys.windowHeight,
      dpi: sys.pixelRatio,
    });
    console.log('📱 AR页面加载，配置:', this.data.config);
  },

  onReady() {
    setTimeout(() => {
      this.setData({
        runingCrs: true,
        tracking: true,
        isInitializing: false,
        initStatus: '请扫描识别图',
      });
      console.log('✅ AR 启动，开始扫描');
    }, 1500);
  },

  // ===== 监听识别成功事件 =====
  onSearchSuccess(e) {
    const { targetId } = e.detail;
    console.log('🎯 识别到目标，targetId:', targetId);

    if (this.data.isVideoLoaded) {
      console.log('⏭️ 视频已加载，跳过重复识别');
      return;
    }

    this.setData({
      runingCrs: false,
      isRecognized: true,
      isVideoLoading: true,
    });

    this.fetchStickerData(targetId);
  },

  // ===== 查询云数据库 =====
  async fetchStickerData(targetId) {
    console.log('📞 开始查询数据库，targetId:', targetId);
    try {
      wx.showLoading({ title: '加载数据...' });
      const result = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: {
          action: 'getStickerDataByTargetId',
          targetId: targetId,
        },
      });
      wx.hideLoading();
      console.log('📦 云函数返回结果:', result);

      if (result.result && result.result.code === 0 && result.result.data) {
        let { videoUrl, planeWidth, planeHeight } = result.result.data;
        console.log('📄 数据库原始数据: videoUrl=', videoUrl, 'planeWidth=', planeWidth, 'planeHeight=', planeHeight);

        // 如果 videoUrl 是 cloud://，前端转换（获取最新链接）
        if (videoUrl && videoUrl.startsWith('cloud://')) {
          console.log('🔄 转换 cloud:// 链接为临时 HTTPS...');
          const res = await wx.cloud.getTempFileURL({
            fileList: [videoUrl]
          });
          if (res.fileList && res.fileList.length > 0) {
            videoUrl = res.fileList[0].tempFileURL;
            console.log('✅ 转换后链接:', videoUrl);
          } else {
            throw new Error('获取临时链接失败');
          }
        }

        console.log('📦 最终视频地址:', videoUrl);
        const easyarComponent = this.selectComponent('#easyar-ar');
        if (easyarComponent) {
          console.log('✅ 找到 easyar-ar 组件，准备播放');
          // ⭐ 调用正确的方法
          easyarComponent.playVideoFromUrl(videoUrl, planeWidth, planeHeight);
          this.setData({ isVideoLoading: false, isVideoLoaded: true });
        } else {
          throw new Error('未找到 easyar-ar 组件');
        }
      } else {
        throw new Error(result.result?.message || '未找到冰箱贴数据');
      }
    } catch (error) {
      console.error('❌ 查询失败:', error);
      wx.hideLoading();
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      this.setData({ isVideoLoading: false });
    }
  },

  // ===== 返回首页 =====
  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },
});