// components/libs/crs-client.js
import { CryptoJS } from './crypto-js';

/**
 * CRS 云识别客户端。
 * 识别/播放的业务逻辑与最早可运行的版本完全一致：
 *   前端截图 -> searchByBase64 -> 拿到 trackingImage(base64) -> 写入本地文件 -> 本地跟踪 -> 播放视频。
 * 网络层做了兼容增强（对上层逻辑完全透明）：
 *   1) 优先走微信云开发云函数（无需配置任何合法域名，token 在服务端生成，兼容 iOS）；
 *   2) 若云函数暂不可用（例如尚未重新部署），自动回退到原版「前端直连 EasyAR」（安卓可立即跑通）。
 * 两条路径返回结构一致，均与 EasyAR 原生响应相同。
 */

const CALL_FUNCTION_NAME = 'quickstartFunctions';
// 超过该长度的 base64 图片改走云存储中转，避免触碰 callFunction 传输大小限制
const DIRECT_BASE64_LIMIT = 200 * 1024; // ~200KB

export default class CrsClient {
  // 前端直连模式缓存的 token（仅在云函数不可用时使用）
  token = null;

  /**
   * @param config {{ apiKey, apiSecret, crsAppId, clientEndUrl, jpegQuality, minInterval }}
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * 云识别。返回结构与 EasyAR 原生一致：
   *   命中   -> { statusCode: 0, result: { target: { targetId, meta, trackingImage } } }
   *   未命中 -> { statusCode: 17, result: { message: '...' } }
   */
  searchByBase64(img) {
    // 优先走云函数（服务端 token、无需域名、iOS 兼容）
    return this._searchViaCloud(img).catch(err => {
      console.warn('⚠️ [CRS] 云函数识别暂不可用，回退前端直连 EasyAR:', (err && (err.errMsg || err.message)) || err);
      return this._searchDirect(img);
    });
  }

  /** 云函数中转（正式上线走这条，不需要域名） */
  _searchViaCloud(img) {
    const data = {
      action: 'easyarSearch',
      notracking: 'false',
    };

    if (img && img.length > DIRECT_BASE64_LIMIT) {
      // 大图先传云存储，再传 fileID，避免 callFunction 传大字段失败
      return this._uploadTempImage(img).then(fileID => {
        data.imageFileID = fileID;
        console.info('📤 [CRS] 图片较大，已上传云存储中转, base64长度:', img.length);
        return this._callCloud(data);
      });
    }

    data.image = img;
    return this._callCloud(data);
  }

  _callCloud(data) {
    return wx.cloud.callFunction({
      name: CALL_FUNCTION_NAME,
      data: data,
    }).then(res => {
      const r = res && res.result;
      if (!r) {
        throw new Error('云函数返回为空');
      }
      // 云函数业务错误（code 非 0），抛出以便上层回退
      if (r.code !== undefined && r.code !== 0) {
        throw new Error(r.error || r.message || ('云函数错误 code=' + r.code));
      }
      if (r.error) {
        throw new Error(r.error);
      }
      // 命中 / 未命中均返回 EasyAR 原始结构
      return r;
    });
  }

  /** 原版直连：前端生成 token 并直接请求 EasyAR CRS（安卓兼容兜底） */
  _searchDirect(img) {
    const params = {
      image: img,
      notracking: 'false',
      appId: this.config.crsAppId,
    };

    return this._queryToken().then(token => {
      return new Promise((resolve, reject) => {
        wx.request({
          url: `${this.config.clientEndUrl}/search`,
          method: 'POST',
          data: params,
          header: {
            'Authorization': token,
            'content-type': 'application/json'
          },
          success: res => resolve(res.data),
          fail: err => reject(err),
        });
      });
    });
  }

  /** 原版：生成 EasyAR token */
  _queryToken() {
    if (this.token) {
      return Promise.resolve(this.token);
    }

    const obj = {
      apiKey: this.config.apiKey,
      expires: 86400,
      timestamp: Date.now(),
      acl: `[{"service":"ecs:crs","effect":"Allow","resource":["${this.config.crsAppId}"],"permission":["READ","WRITE"]}]`,
    };

    const str = Object.keys(obj).sort().map(k => k + obj[k]).join('');
    obj.signature = CryptoJS.SHA256(`${str}${this.config.apiSecret}`, '').toString();

    return new Promise((resolve, reject) => {
      wx.request({
        url: 'https://uac.easyar.com/token/v2',
        method: 'POST',
        data: obj,
        header: {
          'content-type': 'application/json'
        },
        success: res => {
          if (res.data.statusCode != 0) {
            return reject(res.data);
          }
          this.token = res.data.result.token;
          resolve(this.token);
        },
        fail: err => reject(err),
      });
    });
  }

  /** 大图上传云存储临时目录，返回 fileID */
  _uploadTempImage(img) {
    // 先把 base64 写入本地临时文件，再用 filePath 上传，
    // 避免 wx.cloud.uploadFile 传 fileContent 在某些设备上报
    // “parameter.filePath should be string instead of undefined”。
    const fs = wx.getFileSystemManager();
    const tmpPath = `${wx.env.USER_DATA_PATH}/crs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    try {
      fs.writeFileSync(tmpPath, img, 'base64');
    } catch (e) {
      return Promise.reject(new Error('写入临时图片失败: ' + ((e && e.message) || e)));
    }
    const cloudPath = 'crs_tmp/' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.jpg';
    return wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: tmpPath,
    }).then(res => res.fileID);
  }
}