// pages/ar/ar.js
// 页面逻辑与原版（安卓可跑通）保持一致：onARReady 启动识别 -> onSearchSuccess 匹配 targetId
// -> fetchStickerData 查数据库 -> playVideoFromUrl 播放
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

  // ⭐ 存储期望识别的 targetId
  expectedTargetId: null,

  onLoad(options) {
    // ⭐ 从页面参数获取期望的 targetId
    if (options && options.targetId) {
      this.expectedTargetId = decodeURIComponent(options.targetId);
      console.log('🎯 期望识别的 targetId:', this.expectedTargetId);
    } else {
      console.warn('⚠️ 未传入 targetId，将响应任意识别结果');
    }

    const sys = wx.getSystemInfoSync();
    this.setData({
      width: sys.windowWidth,
      height: sys.windowHeight,
      dpi: sys.pixelRatio,
    });
    console.log('📱 AR页面加载，配置:', this.data.config);
  },

  onARReady() {
    console.log('🎯 AR 已就绪，开始识别');
    this.setData({
      runingCrs: true,
      tracking: true,
      isInitializing: false,
      initStatus: this.expectedTargetId ? '请扫描对应的冰箱贴' : '请扫描识别图',
    });
  },

  onSearchSuccess(e) {
    const { targetId } = e.detail;
    console.log('🔍 识别到目标，targetId:', targetId);

    // ⭐ 如果页面设定了期望的 targetId，则只响应匹配的
    if (this.expectedTargetId) {
      if (targetId !== this.expectedTargetId) {
        console.warn(`❌ 识别到 ${targetId}，但期望的是 ${this.expectedTargetId}，忽略本次识别`);
        wx.vibrateShort({ type: 'light' });
        return;
      }
      console.log('✅ targetId 匹配，加载数据');
    }

    if (this.data.isVideoLoaded) {
      console.log('⏭️ 视频已加载，跳过重复识别');
      return;
    }

    this.setData({
      runingCrs: false, // ⭐ 停止持续识别，避免干扰
      isRecognized: true,
      isVideoLoading: true,
    });

    this.fetchStickerData(targetId);
  },

  async fetchStickerData(targetId) {
    console.log('📞 开始查询数据库，targetId:', targetId);
    try {
      wx.showLoading({ title: '加载数据...' });
      const result = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: { action: 'getStickerDataByTargetId', targetId: targetId },
      });
      wx.hideLoading();

      console.log('📦 云函数返回结果:', result);

      if (result.result && result.result.code === 0 && result.result.data) {
        let { videoUrl, planeWidth, planeHeight, posX, posY, posZ } = result.result.data;
        posX = posX || 0;
        posY = posY || 0;
        posZ = posZ || 0;

        // 如果 videoUrl 是 cloud://，转换为临时 HTTPS
        if (videoUrl && videoUrl.startsWith('cloud://')) {
          console.log('🔄 转换 cloud:// 链接为临时 HTTPS...');
          const res = await wx.cloud.getTempFileURL({ fileList: [videoUrl] });
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
          easyarComponent.playVideoFromUrl(videoUrl, planeWidth, planeHeight, posX, posY, posZ);
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

  /**
   * 任意触摸：唤醒视频音频（iOS 需要一次用户手势才能带声播放，无需额外按钮）
   */
  onTouchStart() {
    const easyarComponent = this.selectComponent('#easyar-ar');
    if (easyarComponent && typeof easyarComponent.unlockAudio === 'function') {
      easyarComponent.unlockAudio();
    }
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },
});