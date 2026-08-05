// pages/ar/ar.js
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

  onARReady() {
    console.log('🎯 AR 已就绪，开始识别');
    this.setData({
      runingCrs: true,
      tracking: true,
      isInitializing: false,
      initStatus: '请扫描识别图',
    });
  },

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
        let { videoUrl, planeWidth, planeHeight, posX, posY, posZ } = result.result.data;
        
        // ⭐ 打印从数据库读取的原始值（此时没有硬编码覆盖）
        console.log('📍 从数据库读取的位置参数: posX=', posX, 'posY=', posY, 'posZ=', posZ);

        // 确保有默认值（如果字段不存在则为 0）
        posX = posX || 0;
        posY = posY || 0;
        posZ = posZ || 0;

        // 若 videoUrl 是 cloud://，转换为临时 HTTPS
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
          console.log('🎯 传给组件的位置: posX=', posX, 'posY=', posY, 'posZ=', posZ);
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

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },
});