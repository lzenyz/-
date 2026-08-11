// pages/ar/ar.js
// 纯 xr-frame 原生 AR 识别页（已彻底移除 EasyAR 插件）。
// 流程：扫码/首页携带 targetId 进入 -> 云函数取该产品数据（识别图 coverUrl + 视频 + 位置）
//       -> 把 coverUrl（云存储照片，与首页同一张）下载到本地作为 2D Marker 识别图
//       -> xr-frame 本地识别/追踪 -> 识别到后自动播放 SBS 透明视频（带音频，跟随产品）。
// 全程只依赖微信云开发：无 EasyAR 域名、无 apiKey/token。
Page({
  data: {
    isInitializing: true,
    initStatus: '正在加载产品数据...',
    isRecognized: false,
    isError: false,
    markerImg: '',     // 本地识别图路径（传给 ar-scene）
    videoUrl: '',      // 视频临时链接（传给 ar-scene）
    planeWidth: 1,
    planeHeight: 1,
    posX: 0,
    posY: 0,
    posZ: 0,
    width: 0,
    height: 0,
    dpi: 1,
  },

  // ⭐ 期望识别的 targetId
  expectedTargetId: null,

  onLoad(options) {
    // ⭐ 兼容两种进入方式：
    // 1) 首页跳转：options.targetId（或带地址的形式）
    // 2) 微信扫一扫打开「小程序码」：options.scene = 去掉横杠的 targetId（32位十六进制）
    let targetId = this._normalizeTargetId(options && options.targetId);
    if (!targetId && options && options.scene) {
      targetId = this._targetIdFromScene(options.scene);
    }

    const sys = wx.getSystemInfoSync();
    this.setData({
      width: sys.windowWidth,
      height: sys.windowHeight,
      dpi: sys.pixelRatio,
    });

    // 先检查相机权限：拒绝后引导去设置开启（与原版行为一致）
    this.checkCameraAuth().then((ok) => {
      if (!ok) {
        console.warn('🚫 相机权限未授权');
        this.setData({ isError: true, isInitializing: false });
        return;
      }

      if (!targetId) {
        console.warn('⚠️ 未传入 targetId');
        this.setData({ isError: true, isInitializing: false });
        wx.showModal({
          title: '提示',
          content: '请扫描产品上的小程序码进入 AR 识别',
          showCancel: false,
        });
        return;
      }

      this.expectedTargetId = targetId;
      console.log('🎯 期望识别的 targetId:', targetId);

      // 从小程序码/直链进入时，把产品写入首页收藏缓存（返回首页即可看到并切换）
      this.ensureInCollection(targetId);
      this._initSticker(targetId);
    });
  },

  /**
   * 检查/申请相机权限：首次弹窗授权，拒绝后引导前往设置开启
   * @returns {Promise<boolean>} 是否已获得相机权限
   */
  checkCameraAuth() {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => {
          const auth = res.authSetting || {};
          const ask = () => {
            wx.authorize({
              scope: 'scope.camera',
              success: () => resolve(true),
              fail: () => {
                this._guideOpenSetting(resolve);
              },
            });
          };

          if (auth['scope.camera'] === false) {
            // 之前明确拒绝过：直接引导去设置
            this._guideOpenSetting(resolve);
          } else if (auth['scope.camera'] === true) {
            resolve(true);
          } else {
            // 从未询问过：发起授权
            ask();
          }
        },
        fail: () => resolve(true), // 读取失败不阻塞，交给 AR 系统自行处理
      });
    });
  },

  /** 引导用户去设置页开启相机权限 */
  _guideOpenSetting(resolve) {
    wx.showModal({
      title: '需要相机权限',
      content: 'AR 识别需要使用相机，请在设置中开启相机权限',
      confirmText: '去设置',
      cancelText: '取消',
      success: (r) => {
        if (r.confirm) {
          wx.openSetting({
            success: (s) => {
              const st = (s && s.authSetting) || {};
              resolve(!!st['scope.camera']);
            },
            fail: () => resolve(false),
          });
        } else {
          resolve(false);
        }
      },
      fail: () => resolve(false),
    });
  },

  /**
   * 加载产品数据：取识别图、视频与位置，准备本地 marker 后交给 ar-scene
   */
  async _initSticker(targetId) {
    try {
      wx.showLoading({ title: '加载产品...', mask: true });
      const result = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: { action: 'getStickerDataByTargetId', targetId: targetId },
      });
      wx.hideLoading();

      console.log('📦 云函数返回结果:', result);
      const r = result.result || {};
      if (r.code !== 0 || !r.data) {
        throw new Error(r.message || '未找到对应的产品数据');
      }

      const { coverUrl, videoUrl, planeWidth, planeHeight, posX, posY, posZ } = r.data;
      if (!coverUrl) throw new Error('该产品未配置识别图（coverUrl）');
      if (!videoUrl) throw new Error('该产品未配置视频（videoUrl）');

      // 1) 把云存储里的产品照片下载到本地，作为 2D Marker 识别图（与首页同一张）
      const markerImg = await this._prepareMarker(coverUrl, targetId);

      // 2) 视频链接：cloud:// 转临时 HTTPS
      let finalVideoUrl = videoUrl;
      if (videoUrl && videoUrl.startsWith('cloud://')) {
        console.log('🔄 转换 cloud:// 视频链接为临时 HTTPS...');
        const res = await wx.cloud.getTempFileURL({ fileList: [videoUrl] });
        if (res.fileList && res.fileList.length > 0 && res.fileList[0].tempFileURL) {
          finalVideoUrl = res.fileList[0].tempFileURL;
          console.log('✅ 转换后视频链接:', finalVideoUrl);
        } else {
          throw new Error('获取视频临时链接失败');
        }
      }

      this.setData({
        markerImg: markerImg,
        videoUrl: finalVideoUrl,
        planeWidth: planeWidth || 1,
        planeHeight: planeHeight || 1,
        posX: posX || 0,
        posY: posY || 0,
        posZ: posZ || 0,
        isInitializing: false,
        initStatus: '请将产品对准摄像头',
      });
      console.log('✅ 产品数据就绪, 识别图:', markerImg);
    } catch (error) {
      console.error('❌ 初始化失败:', error);
      wx.hideLoading();
      this.setData({ isError: true, isInitializing: false });
      wx.showModal({
        title: '加载失败',
        content: (error && error.message) || '加载产品数据失败，请检查网络后重试',
        showCancel: false,
        confirmText: '返回',
        success: () => this.goBack(),
      });
    }
  },

  /**
   * 把识别图（云存储照片）下载到本地，iOS 压缩一次，返回可用的本地路径
   */
  _prepareMarker(coverUrl, targetId) {
    const fs = wx.getFileSystemManager();
    const localPath = `${wx.env.USER_DATA_PATH}/marker_${targetId}.jpg`;

    const download = () => {
      if (coverUrl.startsWith('cloud://')) {
        // 云开发文件：无需配置合法域名
        return wx.cloud.downloadFile({ fileID: coverUrl }).then(res => res.tempFilePath);
      }
      // 普通 https 图片：走 wx.downloadFile（需在后台配置 downloadFile 合法域名）
      return new Promise((resolve, reject) => {
        wx.downloadFile({ url: coverUrl, success: res => resolve(res.tempFilePath), fail: reject });
      });
    };

    return download()
      .then(tempFilePath => {
        // 复制到 USER_DATA_PATH 稳定路径（Android 与 iOS 均可被 xr-frame 使用）
        try {
          fs.copyFileSync(tempFilePath, localPath);
          return localPath;
        } catch (e) {
          console.warn('复制识别图失败，直接使用临时路径:', e);
          return tempFilePath;
        }
      })
      .catch(err => {
        // 下载失败时降级：若原本就是网络链接，直接交给 tracker 尝试
        console.warn('⚠️ 下载识别图失败，尝试直接使用原链接:', err);
        return coverUrl;
      })
      .then(path => {
        if (wx.getSystemInfoSync().platform === 'ios' && !/^https?:/.test(path)) {
          // iOS 平台压缩一次，避免部分机型跟踪图无法加载；压缩失败降级使用原路径
          return new Promise(resolve => {
            wx.compressImage({
              src: path,
              quality: 90,
              success: res => resolve(res.tempFilePath),
              fail: () => {
                console.warn('⚠️ iOS 压缩识别图失败，降级使用原路径');
                resolve(path);
              },
            });
          });
        }
        return path;
      });
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

  /** AR 场景/相机就绪 */
  onARReady() {
    console.log('🎯 AR 已就绪，开始识别');
    this.setData({ initStatus: '请将产品对准摄像头' });
  },

  /** 识别到产品（组件自动播放视频） */
  onTrack() {
    if (this.data.isRecognized) return;
    console.log('🎯 识别到产品，自动播放视频');
    wx.vibrateShort({ type: 'light' });
    this.setData({ isRecognized: true, isInitializing: false });
  },

  /** 视频加载失败 */
  onVideoError(e) {
    const msg = (e && e.detail && e.detail.message) || '视频加载失败';
    console.error('❌ 视频错误:', msg);
    wx.showToast({ icon: 'none', title: '视频加载失败，请重试' });
  },

  /** 识别图加载失败（诊断用） */
  onTrackerError(e) {
    const msg = (e && e.detail && e.detail.message) || '识别图加载失败';
    console.error('❌ 识别图错误:', msg);
    wx.showToast({ icon: 'none', title: '识别图加载失败' });
  },

  /**
   * 任意触摸：唤醒视频音频（iOS 需要一次用户手势才能带声播放，无需额外按钮）
   */
  onTouchStart() {
    const comp = this.selectComponent('#ar-scene');
    if (comp && typeof comp.unlockAudio === 'function') {
      comp.unlockAudio();
    }
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },
});