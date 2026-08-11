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
    return (getApp().globalData && getApp().globalData.homeMode) || 'all';
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
   * 收藏模式：只渲染用户扫码收藏的产品（本地缓存 myStickers）
   */
  async _loadCollected() {
    const list = wx.getStorageSync('myStickers') || [];
    const processedList = await this._resolveCovers(list);
    this.setData({
      stickerList: processedList,
      isEmpty: processedList.length === 0
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
   * 把列表中的 cloud:// 封面转换为临时 HTTPS 链接供 image 显示；非 cloud:// 原样保留
   */
  async _resolveCovers(list) {
    if (!list || list.length === 0) return [];

    const cloudFileIds = list
      .map(item => item.coverUrl)
      .filter(url => url && typeof url === 'string' && url.startsWith('cloud://'));

    let tempUrlMap = {};
    if (cloudFileIds.length > 0) {
      try {
        const uniqueIds = [...new Set(cloudFileIds)];
        const cached = this.data.tempUrlCache || {};
        const needConvert = uniqueIds.filter(id => !cached[id]);
        let converted = {};
        if (needConvert.length > 0) {
          const result = await wx.cloud.getTempFileURL({ fileList: needConvert });
          if (result.fileList) {
            result.fileList.forEach(item => {
              if (item.tempFileURL) {
                converted[item.fileID] = item.tempFileURL;
              }
            });
          }
        }
        tempUrlMap = { ...cached, ...converted };
        this.data.tempUrlCache = tempUrlMap;
      } catch (e) {
        console.error('获取临时链接失败', e);
      }
    }

    return list.map(item => {
      let coverUrl = item.coverUrl;
      if (coverUrl && coverUrl.startsWith('cloud://') && tempUrlMap[coverUrl]) {
        coverUrl = tempUrlMap[coverUrl];
      }
      return {
        ...item,
        coverUrl: coverUrl || '' // 若无封面则置空，触发 fallback
      };
    });
  },

  /**
   * 图片加载失败时的降级处理（将错误链接置空，显示备用图标）
   */
  onImageError(e) {
    const index = e.currentTarget.dataset.index;
    const list = this.data.stickerList;
    const failed = list[index];
    if (failed) {
      console.warn('⚠️ 图片加载失败(可能是域名未配置或文件不存在):', failed.coverUrl);
      failed.coverUrl = '';
      this.setData({ stickerList: list });
    }
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
   * 从二维码原文中解析 targetId
   */
  _extractTargetId(str) {
    if (!str) return '';
    const text = String(str).trim();
    const m = text.match(/[?&]targetId=([^&#]+)/);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }
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