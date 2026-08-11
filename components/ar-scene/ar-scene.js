// components/ar-scene/ar-scene.js
// 纯 xr-frame 原生 AR 场景组件（已彻底移除 EasyAR 插件）：
//   1. 页面把「云数据库里的产品照片」下载到本地后通过 markerImg 传入，作为 2D Marker 识别图；
//   2. xr-frame 在本地完成图像识别与追踪，无需云识别、无需配置域名、无 apiKey/token；
//   3. 识别到产品后自动播放 SBS 透明视频（视频纹理自带音频，无额外播放器、无双音冲突），
//      视频平面放在世界坐标（Marker 模式下识别点中心即世界原点，1 单位 = 识别物大小），
//      因此视频会跟随产品移动，且 posX/posY/posZ 与数据库语义完全一致。
Component({
  properties: {
    markerImg: { type: String, value: '' }, // 本地识别图路径
    videoUrl: { type: String, value: '' },  // 视频临时链接
    planeWidth: { type: Number, value: 1 },
    planeHeight: { type: Number, value: 1 },
    posX: { type: Number, value: 0 },
    posY: { type: Number, value: 0 },
    posZ: { type: Number, value: 0 },
    width: { type: Number, value: 0 },
    height: { type: Number, value: 0 },
  },

  observers: {
    // 视频地址就绪后立刻预加载视频纹理（尽早缓冲，识别到即可秒播，提升速度）
    videoUrl(url) {
      if (url && this.scene) {
        this._preloadVideo(url);
      }
    },
  },

  data: {
    arReady: false,
    sceneWidth: 0,
    sceneHeight: 0,
  },

  _effectsRegistered: false, // Effect/Material 是否已注册（防重复）
  _videoAsset: null,          // 当前视频纹理资源
  _videoAssetId: '',          // 视频纹理 assetId（uniform 用 video- 前缀引用）
  _videoPreloading: false,
  _videoPreloaded: false,
  _videoRetry: 0,
  _meshCreated: false,        // 视频平面是否已创建
  _tracked: false,            // 当前是否识别到 marker
  _audioUnlocked: false,      // 音频是否已被触摸唤醒

  lifetimes: {
    attached() {
      const sys = wx.getSystemInfoSync();
      if (sys.platform === 'devtools') {
        wx.showModal({
          title: '提示',
          content: '开发工具上不支持 AR，请使用手机预览。',
          showCancel: false,
        });
      }
      this.setData({
        sceneWidth: this.properties.width,
        sceneHeight: this.properties.height,
      });
    },
    detached() {
      if (this._videoAsset && typeof this._videoAsset.release === 'function') {
        try { this._videoAsset.release(); } catch (e) { /* 忽略 */ }
      }
      this._videoAsset = null;
    },
  },

  methods: {
    /** xr-frame 场景就绪 */
    handleReady({ detail }) {
      this.scene = detail.value;
      this.shadowRoot = this.scene.getElementById('shadow-root');
      this.xrFrameSystem = wx.getXrFrameSystem();
      console.log('✅ XR-Frame 场景已就绪');

      // 防止重复注册（handleReady 偶发触发多次时避免报错）
      if (this._effectsRegistered) return;
      this._effectsRegistered = true;
      this._registerSbsEffect();

      // 若视频地址已就绪，立即开始预加载
      if (this.properties.videoUrl) {
        this._preloadVideo(this.properties.videoUrl);
      }
    },

    /** AR 系统准备就绪（相机已启动、跟踪器已初始化） */
    handleARReady() {
      this.setData({ arReady: true });
      console.log('✅ AR 系统已就绪');
      this.triggerEvent('arReady', {});

      if (this.properties.videoUrl) {
        this._preloadVideo(this.properties.videoUrl);
      }

      // 部分机型在 ar-ready 之前就已识别到 marker，这里检查初始状态
      // EARTrackerState: Init=0, Detecting=1, Detected=2, Error=3
      try {
        const trackerEl = this.scene && this.scene.getElementById('arTracker');
        const tracker = trackerEl && trackerEl.getComponent(this.xrFrameSystem.ARTracker);
        if (tracker && tracker.state === 2) {
          console.log('🎯 AR 就绪时 marker 已处于识别状态');
          this._onTracked();
        }
      } catch (e) {
        console.warn('检查 tracker 初始状态失败(可忽略):', e);
      }
    },

    /** 追踪状态切换：识别到/丢失（e.detail.value 为 boolean） */
    handleTrackerSwitch(e) {
      const active = !!(e && e.detail && e.detail.value);
      console.log('📡 ar-tracker-switch:', active);
      if (active) {
        this._onTracked();
      } else {
        this._tracked = false;
      }
    },

    /** 识别到产品：通知页面并自动播放视频 */
    _onTracked() {
      if (this._tracked) return;
      this._tracked = true;
      console.log('🎯 识别到产品，自动播放视频');
      this.triggerEvent('track', {});

      if (this._videoPreloaded) {
        this._showVideo();
      } else if (this.properties.videoUrl) {
        this._preloadVideo(this.properties.videoUrl);
      }
    },

    /** 预加载视频纹理（含失败重试） */
    async _preloadVideo(url) {
      if (this._videoPreloading || this._videoPreloaded) return;
      if (!this.scene || !url) return;
      this._videoPreloading = true;

      const assetId = 'video_' + Date.now() + '_' + this._videoRetry;
      try {
        const res = await this.scene.assets.loadAsset({
          type: 'video-texture',
          assetId: assetId,
          src: url,
          // 音频由视频纹理自带：识别到产品后自动带声播放，不额外创建播放器（无双音冲突）
          options: { autoPlay: true, abortAudio: false, loop: true, audio: true, muted: false },
        });
        this._videoAsset = res.value;
        this._videoAssetId = assetId;
        this._videoPreloaded = true;
        this._videoPreloading = false;
        console.log('✅ 视频资源已预加载, 宽高:', this._videoAsset.width, 'x', this._videoAsset.height);

        // 视频加载完成时若已识别到 marker，立即创建平面并播放
        if (this._tracked) {
          this._showVideo();
        }
      } catch (err) {
        this._videoPreloading = false;
        this._videoRetry += 1;
        const msg = (err && (err.errMsg || err.message)) || String(err);
        if (this._videoRetry <= 2) {
          console.warn('⚠️ 视频加载失败，准备重试:', msg);
          setTimeout(() => this._preloadVideo(url), 1200);
          return;
        }
        console.error('❌ 视频资源加载失败:', msg);
        this.triggerEvent('videoError', { message: msg });
      }
    },

    /** 创建 SBS 透明视频平面并播放（渲染逻辑与原版一致，跟随产品） */
    _showVideo() {
      if (this._meshCreated || !this._videoAsset) return;
      const asset = this._videoAsset;
      const assetId = this._videoAssetId;
      if (!assetId) return;

      try {
        const oldPlayer = this.scene.getElementById('player');
        if (oldPlayer) this.shadowRoot.removeChild(oldPlayer);

        const el = this.scene.createElement(this.xrFrameSystem.XRMesh, {
          geometry: 'plane',
          material: 'videoTransparentSideBySide',
          uniforms: `u_baseColorMap:video-${assetId}`,
        });
        if (!el) {
          console.error('❌ 创建视频元素失败');
          this.triggerEvent('videoError', { message: '创建视频元素失败' });
          return;
        }

        el.setId('player');
        el.visible = true;
        this.shadowRoot.addChild(el);
        console.log('✅ 视频元素已添加到场景');

        // 平面宽度取数据库设置；高度按 SBS 视频（左颜色+右 alpha）可见区域比例计算
        const w = this.properties.planeWidth || 1;
        const h = w * (2 * asset.height / asset.width);
        const t = el.getComponent(this.xrFrameSystem.Transform);
        if (t) {
          t.scale.setValue(w, 1, h);
          t.position.setValue(this.properties.posX, this.properties.posY, this.properties.posZ);
        }

        // 确保开始播放（部分机型需要显式 play 唤醒）
        if (typeof asset.play === 'function') {
          try { asset.play(); } catch (e) { /* 忽略 */ }
        }

        this._meshCreated = true;
        console.log('🎉 视频已开始播放');
      } catch (err) {
        console.error('❌ 创建视频平面异常:', err);
        this.triggerEvent('videoError', { message: '创建视频平面异常' });
      }
    },

    /** 触摸唤醒音频：iOS 首次用户触摸时调用，解除静音限制（无需额外按钮） */
    unlockAudio() {
      if (this._audioUnlocked) return;
      const asset = this._videoAsset;
      if (asset && typeof asset.play === 'function') {
        try {
          asset.play();
          this._audioUnlocked = true;
          console.log('🎵 [unlockAudio] 触摸已唤醒视频音频');
        } catch (e) {
          console.warn('unlockAudio 失败', e);
        }
      }
    },

    /** 注册 SBS 透明视频 Effect / Material（xr-frame 原生 API，与 EasyAR 无关） */
    _registerSbsEffect() {
      const fs = this.xrFrameSystem;
      fs.registerEffect('my-video-tsbs', scene => scene.createEffect({
        name: 'my-video-tsbs',
        images: [{
          key: 'u_baseColorMap',
          default: 'white',
          macro: 'WX_USE_BASECOLORMAP',
        }],
        defaultRenderQueue: 3000,
        passes: [{
          renderStates: {
            cullOn: false,
            blendOn: true,
            blendSrc: fs.EBlendFactor.SRC_ALPHA,
            blendDst: fs.EBlendFactor.ONE_MINUS_SRC_ALPHA,
            depthWrite: false,
            cullFace: fs.ECullMode.BACK,
          },
          lightMode: 'ForwardBase',
          useMaterialRenderStates: true,
          shaders: [0, 1],
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
          }`,
        ],
      }));

      fs.registerMaterial('videoTransparentSideBySide', scene =>
        scene.createMaterial(scene.assets.getAsset('effect', 'my-video-tsbs'))
      );
      console.log('✅ 自定义 SBS Effect 和 Material 注册成功');
    },
  },
});