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
    // ⭐ 兼容两种进入方式：
    // 1) 首页扫码后跳转：options.targetId（或带地址的形式）
    // 2) 微信扫一扫打开「小程序码」：options.scene = 去掉横杠的 targetId（32位十六进制）
    let targetId = this._normalizeTargetId(options && options.targetId);
    if (!targetId && options && options.scene) {
      targetId = this._targetIdFromScene(options.scene);
    }

    if (targetId) {
      this.expectedTargetId = targetId;
      console.log('🎯 期望识别的 targetId:', this.expectedTargetId);
      // 从小程序码/直链进入时，把产品写入首页收藏缓存（返回首页即可切换）
      this.ensureInCollection(targetId);
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

  /**
   * 规范化 targetId：容忍误传带地址的形式 pages/ar/ar?targetId=xxx
   */
  _normalizeTargetId(str) {
    if (!str) return '';
    let s = String(str).trim();
    const m = s.match(/[?&]targetId=([^&#]+)/);
    if (m) s = m[1];
    try { s = decodeURIComponent(s); } catch (e) {}
    return s;
  },

  /**
   * 小程序码 scene 还原为 targetId。
   * 兼容三种形态：
   *   1) 去掉横杠的 32 位 hex（平台 scene 上限 32 字符，推荐）：50ad7636934f4522b831c577dec0564c
   *   2) 完整 UUID：50ad7636-934f-4522-b831-c577dec0564c
   *   3) 带前缀：targetId=xxx 或 pages/ar/ar?targetId=xxx
   */
  _targetIdFromScene(scene) {
    try { scene = decodeURIComponent(String(scene)); } catch (e) {}
    let s = String(scene).trim();
    const m = s.match(/[?&]targetId=([^&#]+)/);
    if (m) s = m[1];
    const hex = s.trim();
    const u = hex.match(/^([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})$/);
    if (u) {
      return `${u[1]}-${u[2]}-${u[3]}-${u[4]}-${u[5]}`;
    }
    return hex; // 非 UUID 形态的短码原样返回
  },

  /**
   * 把产品写入首页收藏缓存（myStickers），返回首页即可看到并切换
   */
  ensureInCollection(targetId) {
    const list = wx.getStorageSync('myStickers') || [];
    if (list.some(item => item.targetId === targetId)) return;
    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: { action: 'getStickerDataByTargetId', targetId: targetId },
      success: (res) => {
        const r = res.result || {};
        if (r.code === 0 && r.data) {
          const list2 = wx.getStorageSync('myStickers') || [];
          if (!list2.some(item => item.targetId === targetId)) {
            list2.push({
              _id: r.data._id,
              targetId: targetId,
              title: r.data.title || '未命名冰箱贴',
              videoUrl: r.data.videoUrl,
              coverUrl: r.data.coverUrl || '',
            });
            wx.setStorageSync('myStickers', list2);
            console.log('📥 已加入首页收藏缓存:', targetId);
          }
        }
      },
      fail: (err) => console.warn('缓存收藏失败', err),
    });
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