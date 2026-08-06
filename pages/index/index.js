// pages/index/index.js
Page({
  data: {
    stickerList: [],
    isEmpty: true,
    statusBarHeight: 20,
    navBarHeight: 44,
    tempUrlCache: {}
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
    this.loadStickerList();
  },

  async loadStickerList() {
    const list = wx.getStorageSync('myStickers') || [];
    if (list.length === 0) {
      this.setData({ stickerList: [], isEmpty: true });
      return;
    }

    // 收集所有 cloud:// 封面链接
    const cloudFileIds = list
      .map(item => item.coverUrl)
      .filter(url => url && url.startsWith('cloud://'));

    let tempUrlMap = {};
    if (cloudFileIds.length > 0) {
      try {
        const uniqueIds = [...new Set(cloudFileIds)];
        const needConvert = uniqueIds.filter(id => !this.data.tempUrlCache[id]);
        let converted = {};
        if (needConvert.length > 0) {
          const res = await wx.cloud.getTempFileURL({ fileList: needConvert });
          if (res.fileList) {
            res.fileList.forEach(item => {
              if (item.tempFileURL) {
                converted[item.fileID] = item.tempFileURL;
                this.data.tempUrlCache[item.fileID] = item.tempFileURL;
              }
            });
          }
        }
        tempUrlMap = { ...this.data.tempUrlCache, ...converted };
      } catch (e) {
        console.error('获取临时链接失败', e);
      }
    }

    const newList = list.map(item => {
      let coverUrl = item.coverUrl;
      if (item.coverUrl && item.coverUrl.startsWith('cloud://') && tempUrlMap[item.coverUrl]) {
        coverUrl = tempUrlMap[item.coverUrl];
      }
      return { ...item, coverUrl };
    });

    this.setData({
      stickerList: newList,
      isEmpty: false
    });
  },

  // ⭐ 图片加载失败时的降级处理
  onImageError(e) {
    const index = e.currentTarget.dataset.index;
    const list = this.data.stickerList;
    if (list[index]) {
      list[index].coverUrl = ''; // 清空错误链接，触发 fallback
      this.setData({ stickerList: list });
    }
  },

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

  fetchStickerDataAndGoAR(targetId) {
    wx.showLoading({ title: '正在获取数据...', mask: true });

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: { action: 'getStickerDataByTargetId', targetId: targetId },
      success: (res) => {
        const result = res.result || {};
        if (result.code === 0 && result.data) {
          this.addStickerToCache(result.data);
          // ⭐ 跳转时带上 targetId
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

  addStickerToCache(sticker) {
    const list = wx.getStorageSync('myStickers') || [];
    const isExist = list.some(item => item.targetId === sticker.targetId);
    if (isExist) return false;

    list.push({
      _id: sticker._id,
      targetId: sticker.targetId,
      title: sticker.title || '未命名冰箱贴',
      videoUrl: sticker.videoUrl,
      coverUrl: sticker.coverUrl || '' // 存储 cloud://
    });
    wx.setStorageSync('myStickers', list);
    return true;
  },

  // ⭐ 跳转 AR 页，带上 targetId 参数
  goToAR(targetId) {
    wx.navigateTo({
      url: `/pages/ar/ar?targetId=${encodeURIComponent(targetId)}`,
      fail: (err) => {
        console.error('跳转AR页面失败', err);
        wx.showToast({ title: '跳转失败', icon: 'none' });
      }
    });
  },

  // ⭐ 点击卡片时，获取 targetId 并跳转
  onStickerTap(e) {
    const targetId = e.currentTarget.dataset.targetId;
    if (targetId) {
      this.goToAR(targetId);
    } else {
      wx.showToast({ title: '数据异常', icon: 'none' });
    }
  }
});