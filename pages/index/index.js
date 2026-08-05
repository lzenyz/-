// pages/index/index.js
Page({
  data: {
    stickerList: [],
    isEmpty: true,
    statusBarHeight: 20,
    navBarHeight: 44
  },

  onLoad() {
    // 获取状态栏高度，用于自定义导航栏
    try {
      const sysInfo = wx.getWindowInfo();
      const menuBtn = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusBarHeight: sysInfo.statusBarHeight,
        // 导航栏高度 = (菜单按钮上边界 - 状态栏高度) * 2 + 菜单按钮高度
        navBarHeight: (menuBtn.top - sysInfo.statusBarHeight) * 2 + menuBtn.height
      });
    } catch (e) {
      console.warn('获取系统信息失败', e);
    }
  },

  onShow() {
    this.loadStickerList();
  },

  /**
   * 从本地缓存加载冰箱贴列表
   */
  loadStickerList() {
    const list = wx.getStorageSync('myStickers') || [];
    this.setData({
      stickerList: list,
      isEmpty: list.length === 0
    });
  },

  /**
   * 点击悬浮按钮，调用扫码
   * 扫码成功 → 拉取数据 → 入缓存（去重）→ 直接跳 AR 页
   */
  onScanTap() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (res) => {
        console.log('扫码结果', res);
        const targetId = (res.result || '').trim();
        if (!targetId) {
          wx.showToast({
            title: '二维码内容为空',
            icon: 'none'
          });
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
   * 调云函数拿数据 → 入缓存（去重）→ 跳 AR 页
   */
  fetchStickerDataAndGoAR(targetId) {
    wx.showLoading({ title: '正在获取数据...', mask: true });

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        action: 'getStickerDataByTargetId',
        targetId: targetId
      },
      success: (res) => {
        console.log('云函数返回', res);
        const result = res.result || {};
        if (result.code === 0 && result.data) {
          const added = this.addStickerToCache(result.data);
          // 不论是否重复，都跳转 AR 页（用户扫了码就想去看看）
          this.goToAR();
          if (added) {
            // 延迟提示，避免与跳转动画冲突
            setTimeout(() => {
              wx.showToast({
                title: '已加入收藏',
                icon: 'success',
                duration: 1500
              });
            }, 600);
          } else {
            setTimeout(() => {
              wx.showToast({
                title: '已拥有该冰箱贴',
                icon: 'none',
                duration: 1500
              });
            }, 600);
          }
        } else {
          wx.hideLoading();
          wx.showToast({
            title: result.message || '未找到该冰箱贴',
            icon: 'none'
          });
        }
      },
      fail: (err) => {
        console.error('调用云函数失败', err);
        wx.hideLoading();
        wx.showToast({
          title: '网络异常，请重试',
          icon: 'none'
        });
      },
      complete: () => {
        // loading 在成功分支跳转后由 AR 页接管，失败分支已主动 hide
      }
    });
  },

  /**
   * 将冰箱贴数据加入本地缓存（去重）
   * @returns {boolean} 是否新增成功（true=新增，false=已存在）
   */
  addStickerToCache(sticker) {
    const list = wx.getStorageSync('myStickers') || [];
    const isExist = list.some(item => item.targetId === sticker.targetId);
    if (isExist) {
      return false;
    }

    const newItem = {
      _id: sticker._id,
      targetId: sticker.targetId,
      title: sticker.title || '未命名冰箱贴',
      videoUrl: sticker.videoUrl,
      coverUrl: sticker.coverUrl || ''
    };

    list.push(newItem);
    wx.setStorageSync('myStickers', list);
    return true;
  },

  /**
   * 跳转 AR 页
   */
  goToAR() {
    wx.hideLoading();
    wx.navigateTo({
      url: '/pages/ar/ar',
      success: () => {
        console.log('跳转AR页面成功');
      },
      fail: (err) => {
        console.error('跳转AR页面失败', err);
        wx.showToast({
          title: '跳转失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 点击列表卡片跳转 AR 页
   */
  onStickerTap() {
    this.goToAR();
  }
});
