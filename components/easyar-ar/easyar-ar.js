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
        console.warn('⚠️ runingCrs 已开启但 AR 未就绪，等待中...');
        // 已注释弹窗，避免干扰
        // wx.showModal({
        //   title: 'AR系统未启动',
        //   content: '可能是你的相机未启动或不支持XR-FRAME',
        //   showCancel: false,
        // });
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
      // 组件销毁时清理资源
    },
  },

  methods: {
    /**
     * xr-frame 场景准备就绪
     */
    handleReady({ detail }) {
      this.scene = detail.value;
      this.shadowRoot = this.scene.getElementById('shadow-root');
      this.xrFrameSystem = wx.getXrFrameSystem();
      console.log('✅ XR-Frame 场景已就绪');
    
      // 注册 Effect
      this.xrFrameSystem.registerEffect('my-video-tsbs', scene => scene.createEffect({
        name: "my-video-tsbs",
        images: [{
          key: 'u_baseColorMap',
          default: 'white',
          macro: 'WX_USE_BASECOLORMAP'
        }],
        defaultRenderQueue: 3000,
        passes: [{
          renderStates: {
            cullOn: false,
            blendOn: true,
            blendSrc: this.xrFrameSystem.EBlendFactor.SRC_ALPHA,
            blendDst: this.xrFrameSystem.EBlendFactor.ONE_MINUS_SRC_ALPHA,
            depthWrite: false,
            cullFace: this.xrFrameSystem.ECullMode.BACK,
          },
          lightMode: "ForwardBase",
          useMaterialRenderStates: true,
          shaders: [0, 1]
        }],
        shaders: [
          `#version 100
          uniform highp mat4 u_view;
          uniform highp mat4 u_projection;
          uniform highp mat4 u_world;
          attribute vec3 a_position;
          attribute highp vec2 a_texCoord;
          varying highp vec2 v_UV;
          void main() {
            v_UV = a_texCoord;
            vec4 worldPosition = u_world * vec4(a_position, 1.0);
            gl_Position = u_projection * u_view * worldPosition;
          }`,
          `#version 100
          precision mediump float;
          varying highp vec2 v_UV;
          #ifdef WX_USE_BASECOLORMAP
          uniform sampler2D u_baseColorMap;
          #endif
          void main() {
          #ifdef WX_USE_BASECOLORMAP
            vec4 color = texture2D(u_baseColorMap, vec2(v_UV.x * 0.5, v_UV.y));
            float alpha = texture2D(u_baseColorMap, vec2(v_UV.x * 0.5 + 0.5, v_UV.y)).r;
            gl_FragData[0] = vec4(color.rgb, alpha);
          #else
            gl_FragData[0] = vec4(1.0, 1.0, 1.0, 1.0);
          #endif
          }`
        ]
      }));
    
      // 注册 Material
      this.xrFrameSystem.registerMaterial("videoTransparentSideBySide", scene => 
        scene.createMaterial(scene.assets.getAsset('effect', 'my-video-tsbs'))
      );
      console.log('✅ 自定义 SBS Effect 和 Material 注册成功');
    },

    /**
     * AR 系统准备就绪（相机已启动、跟踪器已初始化）
     */
    handleARReady: function ({ detail }) {
      this.setData({ arReady: true });
      console.log('✅ AR 系统已就绪');
      // 触发自定义事件，通知父页面
      this.triggerEvent('arReady', {});
      if (this.pendingVideo && !this.isLoading) {
        this.tryPlayVideo();
      }
    },

    /**
     * 每帧执行，用于截图并触发云识别
     */
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

    /**
     * 截取当前相机画面
     */
    capture() {
      const opt = { type: 'jpg', quality: this.config.jpegQuality };
      if (this.scene.share.captureToDataURLAsync) {
        return this.scene.share.captureToDataURLAsync(opt);
      }
      return Promise.resolve(this.scene.share.captureToDataURL(opt));
    },

    /**
     * 停止跟踪，清理视频元素
     */
    stopTracking() {
      this.setData({ markerImg: '' });
      if (this.scene) {
        const player = this.scene.getElementById('player');
        if (player) this.shadowRoot.removeChild(player);
      }
      this.pendingVideo = null;
      this.isLoading = false;
    },

    /**
     * 加载跟踪图（识别图）
     */
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

    /**
     * iOS 平台将图片转为临时文件
     */
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

    // ==================== 外部调用接口 ====================

    /**
     * 外部调用：播放视频（⭐ 支持传入位置偏移）
     * @param {string} videoUrl - 视频地址
     * @param {number} planeWidth - 平面宽度
     * @param {number} planeHeight - 平面高度
     * @param {number} posX - X轴偏移（默认0）
     * @param {number} posY - Y轴偏移（默认0）
     * @param {number} posZ - Z轴偏移（默认0）
     */
    playVideoFromUrl(videoUrl, planeWidth, planeHeight, posX = 0, posY = 0, posZ = 0) {
      console.log('🎬 [playVideoFromUrl] 被调用，视频地址:', videoUrl);
      console.log('📐 平面尺寸: width=', planeWidth, 'height=', planeHeight);
      console.log('📍 位置偏移: posX=', posX, 'posY=', posY, 'posZ=', posZ);
      this.pendingVideo = { videoUrl, planeWidth, planeHeight, posX, posY, posZ };
      this.isLoading = false;
      if (this.data.arReady && this.data.markerImg) {
        this.tryPlayVideo();
      } else {
        console.log('⏳ 等待 AR 或跟踪图就绪...');
      }
    },

    /**
     * 尝试播放视频（等待 AR 和跟踪图就绪）
     */
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

      const { videoUrl, planeWidth, planeHeight, posX, posY, posZ } = this.pendingVideo;
      this.isLoading = true;
      this.loadSBSVideo(videoUrl, planeWidth, planeHeight, posX, posY, posZ);
    },

    /**
     * 播放 SBS 格式的透明视频
     */
    loadSBSVideo: async function (videoUrl, planeWidth, planeHeight, posX = 0, posY = 0, posZ = 0) {
      console.log('📹 [loadSBSVideo] 使用 easyar-video-tsbs 材质播放 SBS 透明视频');

      if (!this.scene) {
        console.error('❌ scene 未初始化');
        wx.showToast({ icon: 'none', title: 'AR场景未就绪' });
        this.isLoading = false;
        return;
      }

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

      console.log(`🎨 使用材质: easyar-video-tsbs, uniforms: u_baseColorMap:video-${targetId}`);

      const el = this.scene.createElement(this.xrFrameSystem.XRMesh, {
        geometry: 'plane',
        material: 'videoTransparentSideBySide',
        uniforms: `u_baseColorMap:video-${targetId}`,
      });

      if (!el) {
        console.error('❌ 创建元素失败');
        wx.showToast({ icon: 'none', title: '创建视频元素失败' });
        this.isLoading = false;
        return;
      }

      el.setId('player');
      el.visible = true;
      this.shadowRoot.addChild(el);
      console.log('✅ 视频元素已添加到场景');

      const w = planeWidth || 1;
      const h = w * (2 * height / width);
      console.log(`📐 最终平面缩放: w=${w}, h=${h}`);
      const t = el.getComponent(this.xrFrameSystem.Transform);
      if (t) {
        t.scale.setValue(w, 1, h);
        t.position.setValue(posX, posY, posZ);
      }

      this.isLoading = false;
      this.pendingVideo = null;
      console.log('🎉 [loadSBSVideo] 完成');
    },

    loadVideo: async function (targetId, setting) {
      console.warn('⚠️ loadVideo 已弃用，请使用 playVideoFromUrl');
    },

    loadModel: function (targetId, setting) {
      console.warn('⚠️ loadModel 不适用');
    },
  },
});