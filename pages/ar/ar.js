// pages/ar/ar.js
// 纯 xr-frame 原生 AR 识别页（已彻底移除 EasyAR 插件）。
// 流程：扫码/首页携带 targetId 进入 -> 云函数取该产品数据（识别图 coverUrl + 视频 + 位置）
//       -> 把 coverUrl（云存储照片，与首页同一张）下载到本地作为 2D Marker 识别图
//       -> xr-frame 本地识别/追踪 -> 识别到后自动播放 SBS 透明视频（带音频，跟随产品）。
// 全程只依赖微信云开发：无 EasyAR 域名、无 apiKey/token。
//
// 性能优化（本轮）：
//   1. 识别图持久本地缓存（cover_<targetId>.jpg + sidecar），二次进入免下载、秒开；
//   2. 识别图下载 与 视频链接转换 并行执行；
//   3. 拿到产品数据后【尽早】写入首页收藏缓存，消除"退出时首页未渲染"的竞态；
//   4. iOS/鸿蒙(HarmonyOS) 识别图压缩一次，避免部分机型跟踪图无法加载。
Page({
  data: {
    isInitializing: true,
    initStatus: '正在加载产品数据...',
    isRecognized: false,
    isError: false,
    markerImg: '',     // 本地识别图路径（传给 ar-scene）
    videoUrl: '',      // 视频临时链接（传给 ar-scene）
    // true=相机就绪后预加载视频（更流畅，默认）；false=识别到后再加载（兼容兜底）
    preloadVideoOnReady: true,
    planeWidth: 1,
    planeHeight: 1,
    posX: 0,
    posY: 0,
    posZ: 0,
    width: 0,
    height: 0,
    dpi: 1,
  },

  // 期望识别的 targetId
  expectedTargetId: null,

  onLoad(options) {
    // 兼容两种进入方式：
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
        console.warn('相机权限未授权');
        this.setData({ isError: true, isInitializing: false });
        return;
      }

      if (!targetId) {
        console.warn('未传入 targetId');
        this.setData({ isError: true, isInitializing: false });
        wx.showModal({
          title: '提示',
          content: '请扫描产品上的小程序码进入 AR 识别',
          showCancel: false,
        });
        return;
      }

      this.expectedTargetId = targetId;
      console.log('期望识别的 targetId:', targetId);
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
   * 加载产品数据：取识别图、视频与位置，准备本地 marker 后交给 ar-scene。
   * 优化：尽早写入收藏缓存 + 识别图/视频链接并行处理。
   */
  async _initSticker(targetId) {
    try {
      wx.showLoading({ title: '加载产品...', mask: true });
      const result = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: { action: 'getStickerDataByTargetId', targetId: targetId },
      });
      wx.hideLoading();

      console.log('云函数返回结果:', result);
      const r = result.result || {};
      if (r.code !== 0 || !r.data) {
        throw new Error(r.message || '未找到对应的产品数据');
      }

      const { coverUrl, videoUrl, planeWidth, planeHeight, posX, posY, posZ } = r.data;
      if (!coverUrl) throw new Error('该产品未配置识别图（coverUrl）');
      if (!videoUrl) throw new Error('该产品未配置视频（videoUrl）');

      // 1) 尽早写入首页收藏缓存（返回首页即可看到；消除退出时缓存未写入的竞态）
      this._saveToCollection(r.data);

      // 2) 并行：识别图（含持久缓存）下载 + 视频链接转换
      const [markerImg, finalVideoUrl] = await Promise.all([
        this._prepareMarker(coverUrl, targetId),
        this._resolveVideoUrl(videoUrl),
      ]);

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
      console.log('产品数据就绪, 识别图:', markerImg);
    } catch (error) {
      console.error('初始化失败:', error);
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
   * 把产品写入首页收藏缓存（myStickers），已存在则跳过
   */
  _saveToCollection(sticker) {
    if (!sticker || !sticker.targetId) return;
    const list = wx.getStorageSync('myStickers') || [];
    if (list.some(item => item.targetId === sticker.targetId)) return;
    list.push({
      _id: sticker._id,
      targetId: sticker.targetId,
      title: sticker.title || '未命名冰箱贴',
      videoUrl: sticker.videoUrl || '',
      coverUrl: sticker.coverUrl || '',
    });
    wx.setStorageSync('myStickers', list);
    console.log('已加入首页收藏缓存:', sticker.targetId);
  },

  /**
   * 把识别图（云存储照片）下载到本地，并做持久缓存。
   * 缓存文件：USER_DATA_PATH/cover_<targetId>.jpg + cover_<targetId>.json(sidecar 记录 fileID)
   * - 命中缓存且 fileID 未变 -> 直接复用，跳过网络下载（二次进入秒开）；
   * - iOS/鸿蒙压缩一次生成临时文件，避免部分机型跟踪图无法加载；压缩失败降级原路径。
   */
  async _prepareMarker(coverUrl, targetId) {
    const fs = wx.getFileSystemManager();
    const sys = wx.getSystemInfoSync();
    const localPath = `${wx.env.USER_DATA_PATH}/cover_${targetId}.jpg`;
    const sidecarPath = `${wx.env.USER_DATA_PATH}/cover_${targetId}.json`;
    // iOS 或 鸿蒙(HarmonyOS)：压缩一次更稳
    const needCompress = sys.platform === 'ios' || /HarmonyOS|Harmony/i.test(sys.system || '');

    let srcPath = '';
    // 1) 命中持久缓存：本地文件存在且 fileID 一致
    try {
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      fs.accessSync(localPath);
      if (sidecar && sidecar.fileID === coverUrl) {
        srcPath = localPath;
      }
    } catch (e) { /* 未命中 */ }

    // 2) 未命中：下载并持久化
    if (!srcPath) {
      try {
        const tempFilePath = coverUrl.startsWith('cloud://')
          ? (await wx.cloud.downloadFile({ fileID: coverUrl })).tempFilePath
          : await new Promise((resolve, reject) => {
            wx.downloadFile({ url: coverUrl, success: res => resolve(res.tempFilePath), fail: reject });
          });
        try {
          fs.copyFileSync(tempFilePath, localPath);
          fs.writeFileSync(sidecarPath, JSON.stringify({ fileID: coverUrl, t: Date.now() }), 'utf8');
          srcPath = localPath;
        } catch (e) {
          // 持久化失败不阻塞，直接用临时路径
          srcPath = tempFilePath;
        }
      } catch (err) {
        console.warn('下载识别图失败，尝试直接使用原链接:', err);
        srcPath = coverUrl;
      }
    }

    // 3) iOS/鸿蒙：压缩一次生成临时文件；失败降级原路径
    if (needCompress && srcPath && !/^https?:/.test(srcPath)) {
      return new Promise((resolve) => {
        wx.compressImage({
          src: srcPath,
          quality: 90,
          success: res => resolve(res.tempFilePath),
          fail: () => {
            console.warn('压缩识别图失败，降级使用原路径');
            resolve(srcPath);
          },
        });
      });
    }
    return srcPath;
  },

  /**
   * 视频链接：cloud:// 转临时 HTTPS；已是 https 原样返回
   */
  async _resolveVideoUrl(videoUrl) {
    if (videoUrl && videoUrl.startsWith('cloud://')) {
      console.log('转换 cloud:// 视频链接为临时 HTTPS...');
      const res = await wx.cloud.getTempFileURL({ fileList: [videoUrl] });
      if (res.fileList && res.fileList.length > 0 && res.fileList[0].tempFileURL) {
        const url = res.fileList[0].tempFileURL;
        console.log('转换后视频链接:', url);
        return url;
      }
      throw new Error('获取视频临时链接失败');
    }
    return videoUrl;
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

  /** AR 场景/相机就绪 */
  onARReady() {
    console.log('AR 已就绪，开始识别');
    this.setData({ initStatus: '请将产品对准摄像头' });
  },

  /** 识别到产品（组件自动播放视频） */
  onTrack() {
    if (this.data.isRecognized) return;
    console.log('识别到产品，自动播放视频');
    wx.vibrateShort({ type: 'light' });
    this.setData({ isRecognized: true, isInitializing: false });
  },

  /** 视频加载失败 */
  onVideoError(e) {
    const msg = (e && e.detail && e.detail.message) || '视频加载失败';
    console.error('视频错误:', msg);
    wx.showToast({ icon: 'none', title: '视频加载失败，请重试' });
  },

  /** 识别图加载失败（诊断用） */
  onTrackerError(e) {
    const msg = (e && e.detail && e.detail.message) || '识别图加载失败';
    console.error('识别图错误:', msg);
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