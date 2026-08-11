// pages/index/index.js
Page({
  data: {
    stickerList: [],
    isEmpty: true,
    navTitle: 'AR 冰箱贴',
    emptyTitle: '暂无产品',
    emptySub: '商家还没有上架产品',
    statusBarHeight: 20,
    navBarHeight: 44,
    tempUrlCache: {} // 缓存已转换的临时链接，避免重复请求
  },

  onLoad() {
    try {
      const sysInfo = wx.getWindowInfo();
      const menuBtn = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusBarHeight: sysInfo.statusBarHeight,
        navBarHeight: (menuBtn.top - sysInfo.statusBarHeight) * 2 + menuBtn.height
      });
    } catch (e) {
      console.warn('获取系统信息失败', e);
    }

    // 根据首页模式设置标题与空状态文案
    if (this._homeMode() === 'collection') {
      this.setData({
        navTitle: '我的冰箱贴收藏',
        emptyTitle: '还没有收藏的产品',
        emptySub: '请扫描产品上的二维码，添加后可在这里查看',
      });
    }
  },

  onShow() {
    this.loadStickerList(); // 每次显示都刷新
  },

  /**
   * 首页模式：'all' 展示数据库全部产品（默认）；'collection' 只显示扫码收藏的产品
   */
  _homeMode() {
    return (getApp().globalData && getApp().globalData.homeMode) || 'collection';
  },

  /**
   * 加载首页产品列表
   */
  async loadStickerList() {
    if (this._homeMode() === 'collection') {
      await this._loadCollected();
    } else {
      await this._loadAllFromDb();
    }
  },

  /**
   * 收藏模式：只渲染用户扫码收藏的产品（本地缓存 myStickers）。
   * 每次先与数据库做一次「数据校准」：用数据库里该产品的实时 coverUrl 回填缓存，
   * 修复旧版本遗留的「coverUrl 为空/失效」导致安卓端图片不显示的问题。
   */
  async _loadCollected() {
    const cache = wx.getStorageSync('myStickers') || [];
    console.log('📋 本地收藏缓存:', cache);
    if (!cache.length) {
      this.setData({ stickerList: [], isEmpty: true });
      return;
    }

    const cacheMap = {};
    cache.forEach(item => { if (item.targetId) cacheMap[item.targetId] = item; });

    // 从数据库刷新收藏产品的实时数据（coverUrl 以数据库为准）
    let list = cache;
    try {
      const res = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: { action: 'getAllStickers' },
      });
      const result = res.result || {};
      if (result.code === 0) {
        const all = result.data || [];
        list = all
          .filter(item => cacheMap[item.targetId])
          .map(item => ({
            _id: item._id,
            targetId: item.targetId,
            title: item.title || cacheMap[item.targetId].title || '未命名冰箱贴',
            videoUrl: item.videoUrl || cacheMap[item.targetId].videoUrl || '',
            coverUrl: item.coverUrl || cacheMap[item.targetId].coverUrl || '',
          }));
        if (list.length) {
          // 写回修复后的缓存
          wx.setStorageSync('myStickers', list);
          console.log('🔄 收藏数据已与数据库校准:', list.map(i => i.targetId));
        }
      }
    } catch (err) {
      console.error('刷新收藏数据失败，使用本地缓存', err);
      list = cache;
    }

    const processedList = await this._resolveCovers(list);
    this.setData({
      stickerList: processedList,
      isEmpty: processedList.length === 0,
    });
  },

  /**
   * 默认模式：展示数据库里的所有产品（含图片），图片走云存储临时链接
   */
  async _loadAllFromDb() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: { action: 'getAllStickers' },
      });
      const result = res.result || {};
      if (result.code === 0) {
        const list = result.data || [];
        const processedList = await this._resolveCovers(list);
        this.setData({
          stickerList: processedList,
          isEmpty: processedList.length === 0
        });
      } else {
        this.setData({ stickerList: [], isEmpty: true });
      }
    } catch (err) {
      console.error('加载产品列表失败', err);
      this.setData({ stickerList: [], isEmpty: true });
    }
  },

  /**
   * 把封面解析成可显示路径。
   * 云存储文件（cloud://）优先「下载到本地文件」再显示——安卓/iOS 通用、免域名、
   * 不受临时链接域名校验影响（与 AR 页识别图下载机制一致，双端已验证）。
   * 下载失败才回退临时 HTTPS 链接；本次会话内存缓存，避免重复返回首页反复下载。
   */
  async _resolveCovers(list) {
    if (!list || list.length === 0) return [];
    const localCache = this._coverLocalMap || (this._coverLocalMap = {});

    const resolved = await Promise.all(list.map(async (item) => {
      const raw = (item.coverUrl && typeof item.coverUrl === 'string') ? item.coverUrl : '';
      if (!raw) {
        console.warn('⚠️ 该产品未配置封面图(coverUrl 为空):', item.targetId);
        return { ...item, coverUrl: '', cloudFileId: '' };
      }

      if (raw.startsWith('cloud://')) {
        // 1) 会话内已下载过，直接复用本地文件
        if (localCache[raw]) {
          return { ...item, coverUrl: localCache[raw], cloudFileId: raw };
        }
        // 2) 下载到本地（downloadFile 是云 SDK 接口，无需配置任何域名）
        try {
          const res = await wx.cloud.downloadFile({ fileID: raw });
          localCache[raw] = res.tempFilePath;
          return { ...item, coverUrl: res.tempFilePath, cloudFileId: raw };
        } catch (err) {
          console.warn('⚠️ 下载封面失败，回退临时链接:', err);
          // 3) 回退临时 HTTPS 链接（iOS 通常可显示）
          try {
            const tRes = await wx.cloud.getTempFileURL({ fileList: [raw] });
            const url = tRes.fileList && tRes.fileList[0] && tRes.fileList[0].tempFileURL;
            return { ...item, coverUrl: url || '', cloudFileId: raw };
          } catch (e3) {
            return { ...item, coverUrl: raw, cloudFileId: raw };
          }
        }
      }

      // 非 cloud://（外部 https 等）：原样保留
      return { ...item, coverUrl: raw, cloudFileId: '' };
    }));

    return resolved;
  },

  /**
   * 图片加载失败时的兜底处理（正常情况下封面已是本地文件，不会走到这里）：
   *   1) 有 cloud:// 来源且未兜底过 -> 再尝试下载到本地一次；
   *   2) 仍失败或没有来源 -> 置空显示备用图标。
   */
  onImageError(e) {
    const index = e.currentTarget.dataset.index;
    const list = this.data.stickerList;
    const failed = list[index];
    if (!failed) return;

    if (failed.cloudFileId && !failed._coverFallbackDone) {
      failed._coverFallbackDone = true;
      console.warn('⚠️ 图片加载失败，尝试下载云文件到本地:', failed.cloudFileId);
      wx.cloud.downloadFile({
        fileID: failed.cloudFileId,
        success: (res) => {
          failed.coverUrl = res.tempFilePath;
          this.setData({ stickerList: list });
        },
        fail: (err) => {
          console.error('下载封面失败:', err);
          failed.coverUrl = '';
          this.setData({ stickerList: list });
        },
      });
      return;
    }

    console.warn('⚠️ 图片加载失败(可能是文件不存在):', failed.coverUrl);
    failed.coverUrl = '';
    this.setData({ stickerList: list });
  },


  /**
   * 扫码添加冰箱贴
   * 兼容三种二维码内容（生成二维码时推荐用第 1 种）：
   *   1) 纯 targetId：50ad7636-934f-4522-b831-c577dec0564c
   *   2) 页面地址：pages/ar/ar?targetId=50ad7636-...
   *   3) 小程序码（未来若使用）：res.path = pages/ar/ar?targetId=...
   */
  onScanTap() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (res) => {
        const targetId = this._extractTargetId(res.result) || this._extractTargetId(res.path);
        if (!targetId) {
          wx.showToast({ title: '二维码内容无效', icon: 'none' });
          return;
        }
        console.log('🎯 扫码解析到 targetId:', targetId);
        this.fetchStickerDataAndGoAR(targetId);
      },
      fail: (err) => {
        console.log('扫码取消或失败', err);
      }
    });
  },

  /**
   * 从二维码原文中解析 targetId。
   * 兼容多种形态：
   *   1) pages/ar/ar?targetId=UUID
   *   2) pages/ar/ar?scene=32位hex（小程序码 scene）
   *   3) 完整 UUID：50ad7636-934f-4522-b831-c577dec0564c
   *   4) 去掉横杠的 32 位 hex（自动还原为 UUID）
   *   5) 自定义短码（原样返回）
   */
  _extractTargetId(str) {
    if (!str) return '';
    let text = String(str).trim();

    // 1) 取 ?targetId= 或 ?scene= 的值
    const m = text.match(/[?&](?:targetId|scene)=([^&#]+)/);
    if (m) {
      try {
        text = decodeURIComponent(m[1]);
      } catch (e) {
        text = m[1];
      }
    } else {
      // 2) 纯 scene 字符串（微信扫一扫某些情况下直接返回 scene 值）
      const sceneMatch = text.match(/^scene=([^&#]+)$/);
      if (sceneMatch) {
        try {
          text = decodeURIComponent(sceneMatch[1]);
        } catch (e) {
          text = sceneMatch[1];
        }
      }
    }

    // 3) 32 位 hex（去掉横杠的 UUID）自动还原为带横杠的 UUID
    const u = text.match(/^([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})$/);
    if (u) {
      return `${u[1]}-${u[2]}-${u[3]}-${u[4]}-${u[5]}`;
    }

    // 4) 完整 UUID 或自定义短码，原样返回
    if (/^[A-Za-z0-9][A-Za-z0-9\-_.~]{1,64}$/.test(text)) {
      return text;
    }
    return '';
  },

  /**
   * 根据 targetId 获取数据并跳转 AR（同时存入本地缓存作为收藏）
   */
  fetchStickerDataAndGoAR(targetId) {
    wx.showLoading({ title: '正在获取数据...', mask: true });

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: { action: 'getStickerDataByTargetId', targetId: targetId },
      success: (res) => {
        const result = res.result || {};
        if (result.code === 0 && result.data) {
          this.addStickerToCache(result.data);
          this.goToAR(targetId);
          wx.hideLoading();
          setTimeout(() => {
            wx.showToast({ title: '已加入收藏', icon: 'success', duration: 1500 });
          }, 600);
        } else {
          wx.hideLoading();
          wx.showToast({ title: result.message || '未找到该冰箱贴', icon: 'none' });
        }
      },
      fail: (err) => {
        console.error('调用云函数失败', err);
        wx.hideLoading();
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      }
    });
  },

  /**
   * 将单个冰箱贴数据存入本地缓存（收藏功能）
   */
  addStickerToCache(sticker) {
    const list = wx.getStorageSync('myStickers') || [];
    const isExist = list.some(item => item.targetId === sticker.targetId);
    if (isExist) return false;

    list.push({
      _id: sticker._id,
      targetId: sticker.targetId,
      title: sticker.title || '未命名冰箱贴',
      videoUrl: sticker.videoUrl,
      coverUrl: sticker.coverUrl || ''
    });
    wx.setStorageSync('myStickers', list);
    return true;
  },

  /**
   * 跳转到 AR 页面，携带 targetId
   */
  goToAR(targetId) {
    wx.navigateTo({
      url: `/pages/ar/ar?targetId=${encodeURIComponent(targetId)}`,
      fail: (err) => {
        console.error('跳转AR页面失败', err);
        wx.showToast({ title: '跳转失败', icon: 'none' });
      }
    });
  },

  /**
   * 点击卡片，跳转 AR 展示对应冰箱贴
   */
  onStickerTap(e) {
    const targetId = e.currentTarget.dataset.targetId;
    if (targetId) {
      this.goToAR(targetId);
    } else {
      wx.showToast({ title: '数据异常', icon: 'none' });
    }
  }
});