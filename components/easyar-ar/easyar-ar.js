// components/easyar-ar/easyar-ar.js
// 识别与播放逻辑与原版（安卓可跑通）保持一致：
//   handleTick 截图 -> searchByBase64 -> trackingImage(base64) -> loadTrackingImage 写本地文件
//   -> markerImg 就绪 -> tryPlayVideo -> loadSBSVideo 播放视频
import CrsClient from '../libs/crs-client';

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
  _effectsRegistered: false, // Effect/Material 是否已注册
  _videoAsset: null,          // 当前视频纹理资源（用于触摸唤醒音频）
  _audioUnlocked: false,      // 音频是否已被触摸唤醒
  _lastErrToast: 0,           // 识别错误提示节流时间戳

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
      this._videoAsset = null;
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

      // 防止重复注册（handleReady 偶发触发多次时避免报错）
      if (this._effectsRegistered) {
        return;
      }
      this._effectsRegistered = true;

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
      this.triggerEvent('arReady', {});
      if (this.pendingVideo && !this.isLoading) {
        this.tryPlayVideo();
      }
    },

    /**
     * 每帧执行，用于截图并触发云识别（与原版逻辑一致）
     */
    handleTick() {
      try {
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
            const msg = (err && (err.errMsg || err.message)) ? (err.errMsg || err.message) : JSON.stringify(err);
            console.error('❌ CRS识别错误:', msg);
            // 识别异常时在屏幕上提示一次，避免“无反应”难以定位
            const now2 = Date.now();
            if (now2 - this._lastErrToast > 10000) {
              this._lastErrToast = now2;
              wx.showToast({ icon: 'none', title: '识别服务异常:' + String(msg).slice(0, 16) });
            }
          });
      } catch (e) {
        // 兜底：tick 回调内异常不能导致识别循环静默中断
        console.error('❌ [CRS] handleTick 异常:', e);
        this.data.isSearching = false;
      }
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
      this._videoAsset = null;
    },

    /**
     * 加载跟踪图（识别图）到本地，供 xr-ar-tracker 使用（与原版逻辑一致）
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
        fail: (err) => {
          console.error('❌ 写入跟踪图失败:', err);
        },
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
          // iOS 压缩失败时降级使用原路径，保证跟踪图仍能加载
          console.warn('⚠️ 压缩图片失败，降级使用原路径:', err);
          this.setData({ markerImg: filePath });
          if (this.pendingVideo && !this.isLoading) {
            this.tryPlayVideo();
          }
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
     * 播放 SBS 格式的透明视频（与原版逻辑一致，仅补充视频自带音频）
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
            // 音频由视频纹理自带，识别到产品后自动带声播放，不额外创建播放器（无双音冲突）
            options: { autoPlay: true, abortAudio: false, loop: true, audio: true, muted: false },
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

      this._videoAsset = asset;
      const { width, height } = asset;

      const oldPlayer = this.scene.getElementById('player');
      if (oldPlayer) this.shadowRoot.removeChild(oldPlayer);

      console.log(`🎨 使用材质: easyar-video-tsbs, uniforms: u_baseColorMap:video-${targetId}`);

      // 与原版一致：使用 XRMesh 创建视频平面（安卓已验证可渲染）
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

    /**
     * 触摸唤醒音频：iOS 上首次用户触摸时调用，
     * 解除「非用户手势创建播放器被静音」的限制（无需额外按钮，轻点屏幕即可）。
     */
    unlockAudio() {
      if (this._audioUnlocked) return;
      if (this._videoAsset && typeof this._videoAsset.play === 'function') {
        try {
          this._videoAsset.play();
          this._audioUnlocked = true;
          console.log('🎵 [unlockAudio] 触摸已唤醒视频音频');
        } catch (e) {
          console.warn('unlockAudio 失败', e);
        }
      }
    },

    loadVideo: async function (targetId, setting) {
      console.warn('⚠️ loadVideo 已弃用，请使用 playVideoFromUrl');
    },

    loadModel: function (targetId, setting) {
      console.warn('⚠️ loadModel 不适用');
    },
  },
});