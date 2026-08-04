// components/easyar-ar/easyar-ar.js
// const EasyAR = requirePlugin("EasyARMega");  // ← 名称改为 EasyARMega
import CrsClient from '../libs/crs-client';
import { atob } from '../libs/atob';

Component({
  properties: {
    // 是否运行云识别
    runingCrs: { type: Boolean, value: false },
    // 是否开启跟踪
    tracking: { type: Boolean, value: false },
    // 全局配置（包含 apiKey, crsAppId 等）
    config: Object,
    // 组件宽度
    width: { type: Number, value: 0 },
    // 组件高度
    height: { type: Number, value: 0 },
  },

  observers: {
    'runingCrs, tracking': function (value1, value2) {
      // 如果正在运行识别但 AR 未就绪，提示用户
      if (value1 && !this.data.arReady) {
        wx.showModal({
          title: 'AR系统未启动',
          content: '可能是你的相机未启动或不支持XR-FRAME',
          showCancel: false,
        });
      }
      // 如果 tracking 被关闭，停止跟踪并清理视频
      if (!value2) {
        this.stopTracking();
      }
    },
  },

  data: {
    loaded: false,
    arReady: false,        // AR 系统是否就绪
    markerImg: '',         // 识别图路径，用于 xr-ar-tracker
    lastTime: 0,           // 上次识别时间，用于限频
    isSearching: false,    // 是否正在识别中
    sceneWidth: 0,
    sceneHeight: 0,
  },

  crsClient: undefined,    // 云识别客户端实例
  pendingVideo: null,      // 待播放的视频信息
  isLoading: false,        // 是否正在加载视频

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
      // 初始化云识别客户端
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
    
      // --- 1. 注册 Effect ---
      // 注意：第二个参数是工厂函数 (scene) => scene.createEffect({...})
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
          // 顶点着色器
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
          // 片元着色器
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
    
      // --- 2. 注册 Material ---
      // 注意：用 scene.assets.getAsset('effect', 'my-video-tsbs') 获取 Effect 实例
      this.xrFrameSystem.registerMaterial("videoTransparentSideBySide", scene => 
        scene.createMaterial(scene.assets.getAsset('effect', 'my-video-tsbs'))
      );
    
      console.log('✅ 自定义 SBS Effect 和 Material 注册成功');
    },


    // handleReady({ detail }) {
    //   this.scene = detail.value;
    //   this.shadowRoot = this.scene.getElementById('shadow-root');
    //   this.xrFrameSystem = wx.getXrFrameSystem();
    //   console.log('✅ XR-Frame 场景已就绪');
      
    //     // --- 1. 注册 Effect (着色器模板) ---
    //     // 必须在场景就绪后，使用 this.xrFrameSystem 来注册
    //     this.xrFrameSystem.registerEffect('my-video-tsbs', {
    //       name: "my-video-tsbs",
    //       images: [{
    //         key: 'u_baseColorMap',
    //         default: 'white',
    //         macro: 'WX_USE_BASECOLORMAP'
    //       }],
    //       defaultRenderQueue: 3000, // 透明物体渲染队列
    //       passes: [{
    //         renderStates: {
    //           cullOn: false,
    //           blendOn: true, // 开启混合
    //           blendSrc: this.xrFrameSystem.EBlendFactor.SRC_ALPHA,
    //           blendDst: this.xrFrameSystem.EBlendFactor.ONE_MINUS_SRC_ALPHA,
    //           depthWrite: false,
    //           cullFace: this.xrFrameSystem.ECullMode.BACK,
    //         },
    //         lightMode: "ForwardBase",
    //         useMaterialRenderStates: true,
    //         shaders: [0, 1]
    //       }],
    //       shaders: [
    //         // 顶点着色器
    //         `#version 100
    //         uniform highp mat4 u_view;
    //         uniform highp mat4 u_projection;
    //         uniform highp mat4 u_world;
    //         attribute vec3 a_position;
    //         attribute highp vec2 a_texCoord;
    //         varying highp vec2 v_UV;
    //         void main() {
    //           v_UV = a_texCoord;
    //           vec4 worldPosition = u_world * vec4(a_position, 1.0);
    //           gl_Position = u_projection * u_view * worldPosition;
    //         }`,
    //         // 片元着色器 - 核心：分离左右画面
    //         `#version 100
    //         precision mediump float;
    //         varying highp vec2 v_UV;
    //         #ifdef WX_USE_BASECOLORMAP
    //         uniform sampler2D u_baseColorMap;
    //         #endif
    //         void main() {
    //         #ifdef WX_USE_BASECOLORMAP
    //           // 左半边 (0~0.5) 取 RGB 颜色
    //           vec4 color = texture2D(u_baseColorMap, vec2(v_UV.x * 0.5, v_UV.y));
    //           // 右半边 (0.5~1.0) 取 Alpha 遮罩
    //           float alpha = texture2D(u_baseColorMap, vec2(v_UV.x * 0.5 + 0.5, v_UV.y)).r;
    //           gl_FragData[0] = vec4(color.rgb, alpha);
    //         #else
    //           gl_FragData[0] = vec4(1.0, 1.0, 1.0, 1.0);
    //         #endif
    //         }`
    //       ]
    //     });
      
    //     // --- 2. 注册 Material (材质) ---
    //     // 使用 setTimeout 确保 Effect 注册完成
    //     setTimeout(() => {
    //       try {
    //         this.xrFrameSystem.registerMaterial("videoTransparentSideBySide", (scene) => {
    //           // 通过名称引用我们刚刚注册的 Effect
    //           return scene.createMaterial("my-video-tsbs");
    //         });
    //         console.log('✅ 自定义 SBS 材质注册成功');
    //       } catch (e) {
    //         console.error('❌ 注册材质失败:', e);
    //       }
    //     }, 100);

    //   // 手动注册 SBS 透明视频材质
    //   // setTimeout(() => {
    //   // try {
    //   // this.xrFrameSystem.registerMaterial("videoTransparentSideBySide", (scene) => {
    //   // return scene.createMaterial(scene.assets.getAsset("effect", "easyar-video-tsbs"));
    //   // });
    //   // console.log('✅ SBS 透明材质手动注册成功');
    //   // } catch (e) {
    //   // console.warn('⚠️ 手动注册材质失败，可能已由 AR Session 自动注册', e);
    //   // }
    //   // }, 500); // 延迟 500 毫秒
    // },

    /**
     * AR 系统准备就绪（相机已启动、跟踪器已初始化）
     */
    handleARReady: function ({ detail }) {
      this.setData({ arReady: true });
      console.log('✅ AR 系统已就绪');
      // 如果有待播放的视频，尝试播放
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
      // 限频：避免频繁请求
      if (now - this.data.lastTime < this.config.minInterval) {
        return;
      }
      this.data.lastTime = now;
      this.data.isSearching = true;

      // 截图 -> 发送云识别
      this.capture()
        .then(base64 => this.crsClient.searchByBase64(base64.split('base64,').pop()))
        .then(res => {
          this.data.isSearching = false;
          console.info('🔍 CRS识别结果:', res);

          // statusCode != 0 表示未识别到目标
          if (res.statusCode != 0) {
            return;
          }

          // 识别成功，触发父组件事件，传递 targetId
          this.triggerEvent('searchSuccess', { targetId: res.result.target.targetId }, {});
          const target = res.result.target;
          // 加载识别图用于跟踪
          this.loadTrackingImage(target.trackingImage.replace(/[\r\n]/g, ''));
        })
        .catch(err => {
          this.data.isSearching = false;
          console.error('❌ CRS识别错误:', err);
        });
    },

    /**
     * 截取当前相机画面
     * @returns {Promise<string>} base64 图片数据
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
     * @param {string} img - base64 格式的图片数据
     */
    loadTrackingImage(img) {
      const filePath = `${wx.env.USER_DATA_PATH}/marker.jpg`;
      wx.getFileSystemManager().writeFile({
        filePath,
        data: img,
        encoding: 'base64',
        success: () => {
          // iOS 需要额外压缩处理
          if (wx.getSystemInfoSync().platform == 'ios') {
            this.toTempFile(filePath);
            return;
          }
          this.setData({ markerImg: filePath });
          // 跟踪图加载完成后，尝试播放待播放的视频
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
     * 外部调用：播放视频（支持 SBS 透明视频）
     * @param {string} videoUrl - 视频地址
     * @param {number} planeWidth - 平面宽度
     * @param {number} planeHeight - 平面高度
     */
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

      const { videoUrl, planeWidth, planeHeight } = this.pendingVideo;
      this.isLoading = true;

      // 延迟执行，确保场景稳定
      setTimeout(() => {
        this.loadSBSVideo(videoUrl, planeWidth, planeHeight);
      }, 1000);
    },

    // ==================== 透明视频播放核心逻辑 ====================

    /**
     * 播放 SBS 格式的透明视频
     * 参考官方文档：https://www.easyar.cn/doc/zh-cn/develop/wechat/mega/transparent-video.html
     * @param {string} videoUrl - SBS 视频地址
     * @param {number} planeWidth - 平面宽度
     * @param {number} planeHeight - 平面高度
     */
    loadSBSVideo: async function (videoUrl, planeWidth, planeHeight) {
      console.log('📹 [loadSBSVideo] 使用 easyar-video-tsbs 材质播放 SBS 透明视频');

      if (!this.scene) {
        console.error('❌ scene 未初始化');
        wx.showToast({ icon: 'none', title: 'AR场景未就绪' });
        this.isLoading = false;
        return;
      }

      wx.showToast({ icon: 'none', title: '加载视频中...', duration: 2000 });

      // 生成唯一的 assetId
      const targetId = 'video_' + Date.now();
      console.log('🆔 生成 assetId:', targetId);

      // 1. 加载视频纹理
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

      // 2. 移除旧的视频元素
      const oldPlayer = this.scene.getElementById('player');
      if (oldPlayer) this.shadowRoot.removeChild(oldPlayer);

      // 3. 创建带有 SBS 透明材质的平面
      // 注意：easyar-video-tsbs 材质由 AR Session 自动注册和管理[reference:2]
      // 直接使用即可，无需手动注册
      console.log(`🎨 使用材质: easyar-video-tsbs, uniforms: u_baseColorMap:video-${targetId}`);

      const el = this.scene.createElement(this.xrFrameSystem.XRMesh, {
        geometry: 'plane',
        material: 'videoTransparentSideBySide',  // SBS 透明材质[reference:3][reference:4]
        uniforms: `u_baseColorMap:video-${targetId}`,
      });

      if (!el) {
        console.error('❌ 创建元素失败');
        wx.showToast({ icon: 'none', title: '创建视频元素失败' });
        this.isLoading = false;
        return;
      }

      // 4. 将元素添加到场景
      el.setId('player');
      el.visible = true;
      this.shadowRoot.addChild(el);
      console.log('✅ 视频元素已添加到场景');

      // 5. 设置平面缩放，保持视频宽高比
      // 5. 设置平面缩放，保持视频宽高比（仅由 planeWidth 决定）
      const w = planeWidth || 1;
      const h = w * (2*height / width);   // 使用动态视频比例
      console.log(`📐 最终平面缩放: w=${w}, h=${h}`);
      const t = el.getComponent(this.xrFrameSystem.Transform);
      if (t) {
        t.scale.setValue(w, 1, h);
  // 位置偏移保持不变

        
        // ⭐ 设置位置偏移（单位：米）
        // 参数顺序：X（左右）, Y（上下）, Z（前后）
        const offsetX = 0.16;   // 向右移 5 厘米
        const offsetY = 0.00;   // 向上移 2 厘米
        const offsetZ = 0.00;   // 向前（朝相机）移 3 厘米
        t.position.setValue(offsetX, offsetY, offsetZ);
      }

      // 6. 完成
      this.isLoading = false;
      this.pendingVideo = null;
      wx.showToast({ icon: 'none', title: '视频播放中' });
      console.log('🎉 [loadSBSVideo] 完成');
    },

    // ==================== 已弃用的方法 ====================

    loadVideo: async function (targetId, setting) {
      console.warn('⚠️ loadVideo 已弃用，请使用 playVideoFromUrl');
    },

    loadModel: function (targetId, setting) {
      console.warn('⚠️ loadModel 不适用');
    },
  },
});