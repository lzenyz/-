// components/easyar-ar/easyar-ar.js
import CrsClient from '../libs/crs-client';
import { atob } from '../libs/atob';

Component({
  properties: {
    runingCrs: { type: Boolean, value: false },
    tracking: { type: Boolean, value: false },
    config: Object,
    width: { type: Number, value: 0 },
    height: { type: Number, value: 0 },
  },
  observers: {
    'runingCrs, tracking': function (value1, value2) {
      if (value1 && !this.data.arReady) {
        wx.showModal({
          title: 'AR系统未启动',
          content: '可能是你的相机未启动或不支持XR-FRAME',
          showCancel: false,
        });
      }
      if (!value2) {
        this.stopTracking();
      }
    },
  },
  data: {
    loaded: false,
    arReady: false,
    markerImg: '',
    lastTime: 0,
    isSearching: false,
    sceneWidth: 0,
    sceneHeight: 0,
  },
  crsClient: undefined,

  pendingVideo: null,
  isLoading: false,

  lifetimes: {
    attached() {
      const config = this.properties.config;
      if (!config) {
        wx.showModal({
          title: '配置错误',
          content: '请在页面中传递 config 属性',
          showCancel: false,
        });
        return;
      }
      this.config = config;
      this.crsClient = new CrsClient(this.config);
      const sys = wx.getSystemInfoSync();
      if (sys.platform == 'devtools') {
        wx.showModal({
          title: '提示',
          content: '开发工具上不支持AR，请使用手机预览。',
          showCancel: false,
        });
      }
      this.setData({
        sceneWidth: this.properties.width,
        sceneHeight: this.properties.height,
      });
    },
    detached() {
      // 清理
    }
  },
  methods: {
    handleReady({ detail }) {
      this.scene = detail.value;
      this.shadowRoot = this.scene.getElementById('shadow-root');
      this.xrFrameSystem = wx.getXrFrameSystem();
      console.log('✅ XR-Frame 场景已就绪');
    },

    handleARReady: function ({ detail }) {
      this.setData({ arReady: true });
      console.log('✅ AR 系统已就绪');
      if (this.pendingVideo && !this.isLoading) {
        this.tryPlayVideo();
      }
    },

    handleTick() {
      if (!this.data.arReady || !this.properties.runingCrs || !this.crsClient || this.data.isSearching) {
        return;
      }
      const now = Date.now();
      if (now - this.data.lastTime < this.config.minInterval) {
        return;
      }
      this.data.lastTime = now;
      this.data.isSearching = true;

      this.capture()
        .then(base64 => this.crsClient.searchByBase64(base64.split('base64,').pop()))
        .then(res => {
          this.data.isSearching = false;
          console.info('🔍 CRS识别结果:', res);

          if (res.statusCode != 0) {
            return;
          }

          this.triggerEvent('searchSuccess', { targetId: res.result.target.targetId }, {});
          const target = res.result.target;
          this.loadTrackingImage(target.trackingImage.replace(/[\r\n]/g, ''));
        })
        .catch(err => {
          this.data.isSearching = false;
          console.error('❌ CRS识别错误:', err);
        });
    },
    capture() {
      const opt = { type: 'jpg', quality: this.config.jpegQuality };
      if (this.scene.share.captureToDataURLAsync) {
        return this.scene.share.captureToDataURLAsync(opt);
      }
      return Promise.resolve(this.scene.share.captureToDataURL(opt));
    },
    stopTracking() {
      this.setData({ markerImg: '' });
      if (this.scene) {
        const player = this.scene.getElementById('player');
        if (player) this.shadowRoot.removeChild(player);
      }
      this.pendingVideo = null;
      this.isLoading = false;
    },
    loadTrackingImage(img) {
      const filePath = `${wx.env.USER_DATA_PATH}/marker.jpg`;
      wx.getFileSystemManager().writeFile({
        filePath,
        data: img,
        encoding: 'base64',
        success: () => {
          if (wx.getSystemInfoSync().platform == 'ios') {
            this.toTempFile(filePath);
            return;
          }
          this.setData({ markerImg: filePath });
          if (this.pendingVideo && !this.isLoading) {
            this.tryPlayVideo();
          }
        },
        fail: (err) => reject(err),
      });
    },
    toTempFile(filePath) {
      wx.compressImage({
        src: filePath,
        quality: 90,
        success: (res) => {
          console.info('✅ 压缩后图片路径:', res.tempFilePath);
          this.setData({ markerImg: res.tempFilePath });
          if (this.pendingVideo && !this.isLoading) {
            this.tryPlayVideo();
          }
        },
        fail: (err) => {
          console.error('❌ 压缩图片失败:', err);
        },
      });
    },

    // ⭐ 外部调用
    playVideoFromUrl(videoUrl, planeWidth, planeHeight) {
      console.log('🎬 [playVideoFromUrl] 被调用，视频地址:', videoUrl);
      console.log('📐 平面尺寸: width=', planeWidth, 'height=', planeHeight);
      this.pendingVideo = { videoUrl, planeWidth, planeHeight };
      this.isLoading = false;
      if (this.data.arReady && this.data.markerImg) {
        this.tryPlayVideo();
      } else {
        console.log('⏳ 等待 AR 或跟踪图就绪...');
      }
    },

    tryPlayVideo() {
      if (this.isLoading) return;
      if (!this.pendingVideo) return;
      if (!this.data.arReady) {
        console.log('⏳ AR 未就绪，等待...');
        return;
      }
      if (!this.data.markerImg) {
        console.log('⏳ 跟踪图未就绪，等待...');
        return;
      }

      const { videoUrl, planeWidth, planeHeight } = this.pendingVideo;
      this.isLoading = true;

      setTimeout(() => {
        this.loadVideoStandard(videoUrl, planeWidth, planeHeight);
      }, 1000);
    },

    // ⭐ 使用 standard 材质播放视频（黑色背景，稳定可靠）
    loadVideoStandard: async function (videoUrl, planeWidth, planeHeight) {
      console.log('📹 [loadVideoStandard] 使用 standard 材质播放视频');

      if (!this.scene) {
        console.error('❌ scene 未初始化');
        wx.showToast({ icon: 'none', title: 'AR场景未就绪' });
        this.isLoading = false;
        return;
      }

      wx.showToast({ icon: 'none', title: '加载视频中...', duration: 2000 });

      const targetId = 'video_' + Date.now();
      console.log('🆔 生成 assetId:', targetId);

      let asset = this.scene.assets.getAsset('video-texture', targetId);
      if (!asset) {
        console.log('⏳ 加载视频资源...');
        try {
          const v = await this.scene.assets.loadAsset({
            type: 'video-texture',
            assetId: targetId,
            src: videoUrl,
            options: { autoPlay: true, abortAudio: false, loop: true },
          });
          asset = v.value;
          console.log('✅ 视频资源加载完成, 宽高:', asset.width, 'x', asset.height);
        } catch (err) {
          console.error('❌ 加载视频资源失败:', err);
          wx.showToast({ icon: 'none', title: '视频加载失败' });
          this.isLoading = false;
          return;
        }
      } else {
        console.log('♻️ 复用已有视频资源');
      }

      const { width, height } = asset;

      const oldPlayer = this.scene.getElementById('player');
      if (oldPlayer) this.shadowRoot.removeChild(oldPlayer);

      const uniforms = `u_baseColorMap:video-${targetId}`;
      console.log(`🎨 使用材质: standard, uniforms: ${uniforms}`);

      const el = this.scene.createElement(this.xrFrameSystem.XRMesh, {
        geometry: 'plane',
        material: 'standard',
        uniforms: uniforms,
      });

      if (!el) {
        console.error('❌ 创建元素失败');
        wx.showToast({ icon: 'none', title: '创建视频元素失败' });
        this.isLoading = false;
        return;
      }

      const mesh = el.getComponent('mesh');
      if (!mesh) {
        console.error('❌ 未找到 mesh 组件');
        this.isLoading = false;
        return;
      }

      el.setId('player');
      el.visible = true;
      this.shadowRoot.addChild(el);
      console.log('✅ 视频元素已添加到场景');

      const w = planeWidth || 1;
      const h = (planeHeight || 1) * (height / width);
      console.log(`📐 最终平面缩放: w=${w}, h=${h}`);
      const t = el.getComponent(this.xrFrameSystem.Transform);
      if (t) {
        t.scale.setValue(w, 1, h);
      }

      this.isLoading = false;
      this.pendingVideo = null;
      wx.showToast({ icon: 'none', title: '视频播放中' });
      console.log('🎉 [loadVideoStandard] 完成');
    },

    loadVideo: async function (targetId, setting) {
      console.warn('⚠️ loadVideo 已弃用');
    },
    loadModel: function (targetId, setting) {
      console.warn('⚠️ loadModel 不适用');
    },
  },
});