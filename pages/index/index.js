// pages/index/index.js
Page({
  data: {
    stickerList: [],
    isEmpty: true,
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
  },

  onShow() {
    this.loadStickerList(); // 每次显示都从云端拉取最新数据
  },

  /**
   * 从云数据库获取所有冰箱贴数据（全量列表）
   */
  async loadStickerList() {
    try {
      wx.showLoading({ title: '加载中...', mask: true });
      const res = await wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: { action: 'getAllStickers' }
      });
      wx.hideLoading();

      if (res.result && res.result.code === 0) {
        let list = res.result.data || [];

        // 收集所有 cloud:// 封面链接
        const cloudFileIds = list
          .map(item => item.coverUrl)
          .filter(url => url && typeof url === 'string' && url.startsWith('cloud://'));

        let tempUrlMap = {};
        if (cloudFileIds.length > 0) {
          try {
            const uniqueIds = [...new Set(cloudFileIds)];
            // 从缓存中取已转换的
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
            // 合并缓存和新转换的
            tempUrlMap = { ...cached, ...converted };
            this.data.tempUrlCache = tempUrlMap; // 更新缓存
          } catch (e) {
            console.error('获取临时链接失败', e);
          }
        }

        // 替换封面链接为临时 HTTPS URL（供 image 组件使用）
        const processedList = list.map(item => {
          let coverUrl = item.coverUrl;
          if (coverUrl && coverUrl.startsWith('cloud://') && tempUrlMap[coverUrl]) {
            coverUrl = tempUrlMap[coverUrl];
          }
          return {
            ...item,
            coverUrl: coverUrl || '' // 若无封面则置空，触发 fallback
          };
        });

        this.setData({
          stickerList: processedList,
          isEmpty: processedList.length === 0
        });
      } else {
        throw new Error(res.result?.message || '获取数据失败');
      }
    } catch (err) {
      wx.hideLoading();
      console.error('加载列表失败', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  /**
   * 图片加载失败时的降级处理（将错误链接置空，显示备用图标）
   */
  onImageError(e) {
    const index = e.currentTarget.dataset.index;
    const list = this.data.stickerList;
    if (list[index]) {
      list[index].coverUrl = '';
      this.setData({ stickerList: list });
    }
  },

  /**
   * 扫码添加冰箱贴
   */
  onScanTap() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (res) => {
        const targetId = (res.result || '').trim();
        if (!targetId) {
          wx.showToast({ title: '二维码内容为空', icon: 'none' });
          return;
        }
        this.fetchStickerDataAndGoAR(targetId);
      },
      fail: (err) => {
        console.log('扫码取消或失败', err);
      }
    });
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
      coverUrl: sticker.coverUrl || '' // 存储原始 cloud://
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