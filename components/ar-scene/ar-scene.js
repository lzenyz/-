// components/ar-scene/ar-scene.js
// 纯 xr-frame 原生 AR 场景组件（已彻底移除 EasyAR 插件）：
//   1. 页面把「云数据库里的产品照片」下载到本地后通过 markerImg 传入，作为 2D Marker 识别图；
//   2. xr-frame 在本地完成图像识别与追踪，无需云识别、无需配置域名、无 apiKey/token；
//   3. 识别到产品后自动播放 SBS 透明视频（视频纹理自带音频，无额外播放器、无双音冲突）。
//
// 播放策略（本轮针对鸿蒙/流畅度优化）：
//   - 视频统一使用 autoPlay:true（解码器加载即启动，避免鸿蒙等机型"卡首帧"）；
//   - 鸿蒙(HarmonyOS) 机型：跳过预加载，采用最稳的"识别到后再加载播放"；
//   - 安卓/iOS：相机就绪(ar-ready)后预加载（autoPlay 预热后暂停，识别到再续播），兼顾流畅；
//   - 播放看门狗：识别后若 1.5s 仍未进入播放态，自动 seek(0)+play() 强制唤醒。
Component({
  properties: {
    markerImg: { type: String, value: '' }, // 本地识别图路径
    videoUrl: { type: String, value: '' },  // 视频临时链接
    preloadVideoOnReady: { type: Boolean, value: true }, // true=ar-ready 后预加载；false=识别后再加载
    planeWidth: { type: Number, value: 1 },
    planeHeight: { type: Number, value: 1 },
    posX: { type: Number, value: 0 },
    posY: { type: Number, value: 0 },
    posZ: { type: Number, value: 0 },
    width: { type: Number, value: 0 },
    height: { type: Number, value: 0 },
  },

  observers: {
    // videoUrl 就绪后（若已 ar-ready 且开启预加载）尝试预加载
    videoUrl(url) {
      if (url) {
        this._maybePreload();
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
  _videoLoading: false,
  _videoLoaded: false,
  _videoRetry: 0,
  _videoPausedByPreload: false, // 预加载后是否已暂停（识别时需续播）
  _meshCreated: false,        // 视频平面是否已创建
  _tracked: false,            // 当前是否识别到 marker
  _audioUnlocked: false,      // 音频是否已被触摸唤醒
  _isHarmony: false,          // 是否鸿蒙系统

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
      this._isHarmony = /HarmonyOS|Harmony/i.test((sys.system || '') + ' ' + (sys.model || ''));
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
    },

    /** AR 系统准备就绪（相机已启动、跟踪器已初始化） */
    handleARReady() {
      this.setData({ arReady: true });
      console.log('✅ AR 系统已就绪');
      this.triggerEvent('arReady', {});

      // 相机就绪后预加载视频（安卓/iOS；鸿蒙跳过，走识别后再加载的最稳路径）
      this._maybePreload();

      // 部分机型在 ar-ready 之前就已识别到 marker，这里检查初始状态
      // EARTrackerState: Init=0, Detecting=1, Detected=2, Error=3
      try {
        const trackerEl = this.scene && this.scene.getElementById('arTracker');
        const tracker = trackerEl && trackerEl.getComponent(this.xrFrameSystem.ARTracker);
        if (tracker && tracker.state === 2) {
          console.log('🎯 AR 就绪时 marker 已处于识别状态');
          this._onTracked();
        } else if (tracker && tracker.state === 3) {
          console.error('❌ 识别图加载失败:', tracker.errorMessage);
          this.triggerEvent('trackerError', { message: tracker.errorMessage || '识别图加载失败' });
        }
      } catch (e) {
        console.warn('检查 tracker 初始状态失败(可忽略):', e);
      }
    },

    /** 满足条件时预加载视频（仅开启、非鸿蒙、已 ar-ready 时执行一次） */
    _maybePreload() {
      if (!this.properties.preloadVideoOnReady) return;
      if (this._isHarmony) return; // 鸿蒙先用"识别后再加载"保证能播
      if (!this.data.arReady) return;
      if (this._videoLoaded || this._videoLoading) return;
      const url = this.properties.videoUrl;
      if (!url) return;
      this._loadVideo(url, true);
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

    /** 追踪器状态（诊断用）：识别图加载出错时上报 */
    handleTrackerState(e) {
      const tracker = e && e.detail && e.detail.value;
      if (!tracker) return;
      if (tracker.state === 3) {
        console.error('❌ 识别图加载失败:', tracker.errorMessage);
        this.triggerEvent('trackerError', { message: tracker.errorMessage || '识别图加载失败' });
      }
    },

    /** 识别到产品：通知页面并加载/播放视频 */
    _onTracked() {
      if (this._tracked) return;
      this._tracked = true;
      console.log('🎯 识别到产品，加载并播放视频');
      this.triggerEvent('track', {});

      if (this._videoLoaded) {
        this._showVideo();
      } else if (this.properties.videoUrl) {
        this._loadVideo(this.properties.videoUrl, false);
      }
    },

    /**
     * 加载视频纹理（含失败重试）。
     * 统一使用 autoPlay:true（解码器加载即启动，避免卡首帧）。
     * @param {string} url 视频地址
     * @param {boolean} preload true=预加载（autoPlay 预热后暂停，识别时续播）；false=识别时加载（直接播放）
     */
    async _loadVideo(url, preload) {
      if (this._videoLoading || this._videoLoaded) return;
      if (!this.scene || !url) return;
      this._videoLoading = true;

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
        this._videoLoaded = true;
        this._videoLoading = false;
        this._videoPausedByPreload = false;
        console.log('✅ 视频资源加载完成, 宽高:', this._videoAsset.width, 'x', this._videoAsset.height, 'preload:', preload);

        // 预加载：autoPlay 已启动解码，稍后暂停避免识别前出声（同时完成解码预热）
        if (preload) {
          setTimeout(() => {
            // 若已识别/已展示，不再暂停
            if (this._tracked || this._meshCreated) return;
            const a = this._videoAsset;
            if (a && typeof a.pause === 'function') {
              try {
                a.pause();
                this._videoPausedByPreload = true;
                console.log('⏸️ 预加载视频已预热并暂停，等待识别');
              } catch (e) { /* 忽略 */ }
            }
          }, 200);
        }

        // 加载完成时若已识别到 marker，立即创建平面并播放
        if (this._tracked) {
          this._showVideo();
        }
      } catch (err) {
        this._videoLoading = false;
        this._videoRetry += 1;
        const msg = (err && (err.errMsg || err.message)) || String(err);
        if (this._videoRetry <= 2) {
          console.warn('⚠️ 视频加载失败，准备重试:', msg);
          setTimeout(() => this._loadVideo(url, preload), 1200);
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

        // 确保播放（含对卡在首帧的机型做 seek+play 唤醒）
        this._ensurePlaying(asset);

        this._meshCreated = true;
        console.log('🎉 视频已开始播放');
      } catch (err) {
        console.error('❌ 创建视频平面异常:', err);
        this.triggerEvent('videoError', { message: '创建视频平面异常' });
      }
    },

    /**
     * 确保视频进入播放态：
     *   1) 立即 play()（若被预加载暂停则续播）；
     *   2) 1.5s 后检查 EVideoState，若仍未播放则 seek(0)+play() 强制唤醒（专治鸿蒙等机型卡首帧）。
     */
    _ensurePlaying(asset) {
      const doPlay = () => {
        if (typeof asset.play === 'function') {
          try { asset.play(); } catch (e) { /* 忽略 */ }
        }
      };
      doPlay();

      setTimeout(() => {
        try {
          const xrfs = wx.getXrFrameSystem && wx.getXrFrameSystem();
          const Playing = xrfs && xrfs.EVideoState && xrfs.EVideoState.Playing;
          if (Playing !== undefined && asset.state !== undefined && asset.state !== Playing) {
            console.warn('⚠️ 视频未进入播放态，seek(0)+play 唤醒');
            if (typeof asset.seek === 'function') {
              try { asset.seek(0); } catch (e) { /* 忽略 */ }
            }
            setTimeout(doPlay, 100);
          } else if (asset.state === undefined) {
            // state 不可用时，兜底再 play 一次
            doPlay();
          }
        } catch (e) {
          doPlay();
        }
      }, 1500);
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