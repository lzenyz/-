// cloudfunctions/quickstartFunctions/index.js
// =====================================================================
// 本云函数负责：
//   1. 冰箱贴数据（getStickerDataByTargetId / getAllStickers / createSticker）
//   2. EasyAR CRS 云识别中转（easyarSearch）：
//      - 在服务端生成 EasyAR token（apiKey/apiSecret 只存在云端，绝不下发到小程序前端）
//      - 调用 EasyAR CRS /search 识别截图
//      - 命中后把跟踪图写入云存储，返回 fileID 给前端
//   3. 诊断（easyarDiagnose）：无需真机即可验证 EasyAR 配置是否可用
// =====================================================================
// EasyAR 配置：优先读取云函数环境变量（可选，正式上线建议）；未配置时自动回退到内置值，
// 因此「不配置任何东西、重新部署一次」即可运行。
//   云开发控制台 -> 云函数 -> quickstartFunctions -> 配置 -> 环境变量：
//     EASYAR_API_KEY、EASYAR_API_SECRET、EASYAR_CRS_APP_ID、EASYAR_CLIENT_END_URL
// =====================================================================
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');

const EASYAR_DEFAULTS = {
  apiKey: '18a4811375ad0afafe65583750daaf2b',
  apiSecret: '13af61cfc5af6c104e60ba8da3f1ced86521cb7d99eab805e007c69939f65891',
  crsAppId: '2a91e0a9dc86ccc03aea7eea21430855',
  clientEndUrl: 'https://2a91e0a9dc86ccc03aea7eea21430855.cn1.crs.easyar.com:8443',
};

const EASYAR = {
  apiKey: process.env.EASYAR_API_KEY || EASYAR_DEFAULTS.apiKey,
  apiSecret: process.env.EASYAR_API_SECRET || EASYAR_DEFAULTS.apiSecret,
  crsAppId: process.env.EASYAR_CRS_APP_ID || EASYAR_DEFAULTS.crsAppId,
  clientEndUrl: process.env.EASYAR_CLIENT_END_URL || EASYAR_DEFAULTS.clientEndUrl,
};

function assertEasyarConfig() {
  const missing = ['EASYAR_API_KEY', 'EASYAR_API_SECRET', 'EASYAR_CRS_APP_ID', 'EASYAR_CLIENT_END_URL']
    .filter(name => !process.env[name]);
  if (missing.length > 0) {
    console.warn('⚠️ EasyAR 环境变量未配置(' + missing.join(',') + ')，已回退使用内置配置；不配置也能运行');
  }
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { action, ...params } = event;

  try {
    switch (action) {
      case 'getStickerDataByTargetId':
        return await getStickerDataByTargetId(params.targetId);
      case 'getAllStickers':
        return await getAllStickers();
      case 'createSticker':
        return await createSticker(params);
      case 'getEasyarToken': {
        const token = await getEasyarToken();
        return { code: 0, message: 'ok', token };
      }
      case 'easyarSearch':
        return await easyarSearch(params);
      case 'easyarDiagnose':
        return await easyarDiagnose();
      case 'getMiniProgramCode':
        return await getMiniProgramCode(params);
      default:
        return {
          code: 400,
          message: `未知的 action: ${action}`
        };
    }
  } catch (error) {
    console.error('云函数执行错误:', error);
    return {
      code: 500,
      message: '服务器内部错误',
      error: error.message
    };
  }
};

/**
 * 根据 targetId 查询冰箱贴数据（包含视频地址与 posX/Y/Z 位置）
 */
async function getStickerDataByTargetId(targetId) {
  if (!targetId) {
    return {
      code: 400,
      message: 'targetId 不能为空'
    };
  }

  try {
    const result = await db.collection('fridgeStickers')
      .where({ targetId: targetId })
      .get();

    if (result.data && result.data.length > 0) {
      const sticker = result.data[0];

      console.log('🔍 数据库原始数据:', JSON.stringify(sticker));

      let tempVideoUrl = sticker.videoUrl;
      if (sticker.videoUrl && sticker.videoUrl.startsWith('cloud://')) {
        try {
          const res = await cloud.getTempFileURL({ fileList: [sticker.videoUrl] });
          if (res.fileList && res.fileList.length > 0) {
            tempVideoUrl = res.fileList[0].tempFileURL;
          }
        } catch (e) {
          console.warn('转换视频链接失败', e);
        }
      }

      const coverUrl = sticker.coverUrl || '';

      const posX = sticker.posX !== undefined ? sticker.posX : 0;
      const posY = sticker.posY !== undefined ? sticker.posY : 0;
      const posZ = sticker.posZ !== undefined ? sticker.posZ : 0;

      return {
        code: 0,
        message: '查询成功',
        data: {
          _id: sticker._id,
          targetId: sticker.targetId,
          videoUrl: tempVideoUrl,
          coverUrl: coverUrl,
          planeWidth: sticker.planeWidth || 1,
          planeHeight: sticker.planeHeight || 1,
          title: sticker.title || '未命名冰箱贴',
          description: sticker.description || '',
          posX: posX,
          posY: posY,
          posZ: posZ,
        }
      };
    } else {
      return {
        code: 404,
        message: '未找到对应的冰箱贴数据',
        data: null
      };
    }
  } catch (error) {
    console.error('查询冰箱贴数据失败:', error);
    throw error;
  }
}

async function getAllStickers() {
  try {
    const result = await db.collection('fridgeStickers')
      .orderBy('createTime', 'desc')
      .limit(100)
      .get();
    return {
      code: 0,
      message: '查询成功',
      data: result.data.map(item => ({
        _id: item._id,
        targetId: item.targetId,
        videoUrl: item.videoUrl,
        coverUrl: item.coverUrl || '',
        planeWidth: item.planeWidth || 1,
        planeHeight: item.planeHeight || 1,
        title: item.title || '',
        description: item.description || '',
        createTime: item.createTime,
        posX: item.posX || 0,
        posY: item.posY || 0,
        posZ: item.posZ || 0,
      }))
    };
  } catch (error) {
    console.error('获取列表失败:', error);
    throw error;
  }
}

async function createSticker(params) {
  const { targetId, videoUrl, coverUrl, planeWidth, planeHeight, title, description, posX, posY, posZ } = params;
  if (!targetId || !videoUrl) {
    return { code: 400, message: 'targetId 和 videoUrl 不能为空' };
  }
  try {
    const existResult = await db.collection('fridgeStickers')
      .where({ targetId: targetId })
      .get();
    if (existResult.data.length > 0) {
      await db.collection('fridgeStickers')
        .doc(existResult.data[0]._id)
        .update({
          data: {
            videoUrl, coverUrl: coverUrl || '', planeWidth: planeWidth || 1, planeHeight: planeHeight || 1,
            title: title || '', description: description || '',
            posX: posX || 0, posY: posY || 0, posZ: posZ || 0,
            updateTime: db.serverDate()
          }
        });
      return { code: 0, message: '更新成功' };
    } else {
      await db.collection('fridgeStickers')
        .add({
          data: {
            targetId, videoUrl, coverUrl: coverUrl || '',
            planeWidth: planeWidth || 1, planeHeight: planeHeight || 1,
            title: title || '', description: description || '',
            posX: posX || 0, posY: posY || 0, posZ: posZ || 0,
            createTime: db.serverDate(), updateTime: db.serverDate()
          }
        });
      return { code: 0, message: '创建成功' };
    }
  } catch (error) {
    console.error('创建/更新失败:', error);
    throw error;
  }
}

// ==================== EasyAR 云识别（云函数中转，客户端无需配置任何合法域名） ====================

// 模块级 token 缓存：云函数实例内复用，过期自动刷新
let tokenCache = { token: null, expireAt: 0 };

/**
 * 在服务端生成 EasyAR CRS 的访问 Token（带缓存，过期自动刷新）。
 * 官方推荐做法：不要在客户端（小程序）里放 apiSecret 并做签名，
 * 而是由服务端生成 Token 后使用，可彻底规避 iOS 上因设备时间不准导致的校验失败。
 */
async function getEasyarToken(forceRefresh) {
  assertEasyarConfig();
  const now = Date.now();
  if (!forceRefresh && tokenCache.token && tokenCache.expireAt > now + 60 * 1000) {
    return tokenCache.token;
  }

  const { apiKey, apiSecret, crsAppId } = EASYAR;

  const obj = {
    apiKey: apiKey,
    expires: 86400,
    timestamp: now,
    acl: `[{"service":"ecs:crs","effect":"Allow","resource":["${crsAppId}"],"permission":["READ","WRITE"]}]`,
  };

  // 签名：参数按键名排序 -> key+value 拼接 -> 末尾追加 apiSecret -> sha256 hex
  const str = Object.keys(obj).sort().map(k => k + obj[k]).join('');
  obj.signature = crypto.createHash('sha256').update(`${str}${apiSecret}`, 'utf8').digest('hex');

  const res = await requestJson({
    hostname: 'uac.easyar.com',
    port: 443,
    path: '/token/v2',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify(obj));

  if (res.httpStatusCode < 200 || res.httpStatusCode >= 300) {
    throw new Error(`EasyAR token 接口 HTTP ${res.httpStatusCode}: ${JSON.stringify(res.data)}`);
  }
  if (res.data.statusCode !== 0) {
    throw new Error(`EasyAR token 接口错误 ${res.data.statusCode}: ${res.data.msg || ''}`);
  }

  const expires = (res.data.result && res.data.result.expires) || 86400;
  tokenCache.token = res.data.result.token;
  tokenCache.expireAt = Date.now() + expires * 1000;
  return tokenCache.token;
}

/**
 * 云识别搜索：把客户端传来的图片（base64，或云存储中转的 fileID）
 * 在服务端转发给 EasyAR CRS /search，命中后把跟踪图写入云存储并返回 fileID。
 */
async function easyarSearch(params) {
  assertEasyarConfig();
  const image = params && params.image;
  const imageFileID = params && params.imageFileID;
  const notracking = (params && params.notracking) || 'false';

  let imgBase64 = null;
  let tmpFileID = null;

  try {
    if (imageFileID) {
      // 客户端上传到云存储的大图：云函数下载后转 base64 再转发
      tmpFileID = imageFileID;
      const dl = await cloud.downloadFile({ fileID: imageFileID });
      imgBase64 = dl.fileContent.toString('base64');
      console.info('📥 [CRS] 已从云存储下载大图, base64长度:', imgBase64.length);
    } else if (image) {
      if (/^https?:\/\//i.test(String(image))) {
        imgBase64 = await downloadToBase64(image);
      } else {
        imgBase64 = image;
      }
    } else {
      return { error: 'image 不能为空' };
    }

    if (!imgBase64 || imgBase64.length < 100) {
      return { error: '图片内容为空' };
    }

    let token = await getEasyarToken();
    let res = await requestCRSSearch(token, imgBase64, notracking);

    // token 过期（业务码 4001024 或 HTTP 401/403）时刷新 token 重试一次
    if (
      res.httpStatusCode === 401 || res.httpStatusCode === 403 ||
      (res.data && res.data.statusCode === 4001024)
    ) {
      token = await getEasyarToken(true);
      res = await requestCRSSearch(token, imgBase64, notracking);
    }

    // EasyAR 在“未识别到目标”时返回 HTTP 404 + body{statusCode:17}，属正常业务响应
    if (!res.data) {
      return { error: `CRS /search 请求失败 HTTP ${res.httpStatusCode}` };
    }

    const body = res.data;
    if (body.statusCode === 0 && body.result && body.result.target) {
      const target = body.result.target;
      // 与原版 EasyAR 返回结构保持一致：直接下发 trackingImage(base64)，
      // 前端 loadTrackingImage 写本地文件后交给 xr-ar-tracker 本地跟踪。
      // （不做多余的上传云存储，命中响应更快）
      return {
        statusCode: 0,
        result: {
          target: {
            targetId: target.targetId,
            meta: target.meta,
            trackingImage: String(target.trackingImage || '').replace(/[\r\n]/g, ''),
          },
        },
      };
    }

    // 未识别到目标或业务错误：原样返回（statusCode=17 等），由前端继续扫描
    return body;
  } finally {
    // 清理客户端上传的临时图片，避免云存储堆积
    if (tmpFileID) {
      try {
        await cloud.deleteFile({ fileList: [tmpFileID] });
      } catch (e) {
        console.warn('清理临时图片失败(可忽略):', tmpFileID, e && e.message);
      }
    }
  }
}

/**
 * 生成产品小程序码（贴在产品上，用户微信扫一扫直接进入 AR 识别页）。
 * 说明：wxacode.getUnlimited 的 scene 最多 32 个字符，
 * 因此把 36 位 UUID 去掉横杠（32 位十六进制）作为 scene；
 * AR 页收到 scene 后会还原为 UUID。
 * @param {{ targetId: string, envVersion?: string }} params
 */
async function getMiniProgramCode(params) {
  const targetId = params && params.targetId;
  if (!targetId) {
    return { code: 400, message: 'targetId 不能为空' };
  }
  const scene = String(targetId).replace(/-/g, '');
  if (scene.length > 32) {
    return { code: 400, message: 'targetId 过长，无法生成小程序码(>32字符)' };
  }
  const envVersion = (params && params.envVersion) || 'release'; // release / trial / develop
  try {
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene: scene,
      page: 'pages/ar/ar',
      checkPath: false,
      envVersion: envVersion,
      width: 430,
    });
    return {
      code: 0,
      message: 'ok',
      data: res.buffer.toString('base64'),
    };
  } catch (e) {
    console.error('生成小程序码失败:', e);
    return {
      code: 500,
      message: '生成失败',
      error: (e && (e.errMsg || e.message)) || String(e),
    };
  }
}

/**
 * 诊断：验证 EasyAR 配置是否可用（无需真机）。
 * 在开发者工具控制台执行：
 *   wx.cloud.callFunction({ name: 'quickstartFunctions', data: { action: 'easyarDiagnose' } })
 */
async function easyarDiagnose() {
  const info = {
    code: 0,
    message: '诊断完成',
    data: {
      source: process.env.EASYAR_API_KEY ? 'environment' : 'builtin',
      hasApiKey: !!EASYAR.apiKey,
      hasApiSecret: !!EASYAR.apiSecret,
      hasCrsAppId: !!EASYAR.crsAppId,
      hasClientEndUrl: !!EASYAR.clientEndUrl,
    },
  };
  try {
    const token = await getEasyarToken();
    info.data.tokenOk = !!token;
    info.data.tokenLength = token ? token.length : 0;
  } catch (e) {
    info.data.tokenOk = false;
    info.data.tokenError = (e && e.message) || String(e);
  }
  return info;
}

/**
 * 调用 EasyAR CRS /search（服务端，不受小程序域名白名单限制）
 */
function requestCRSSearch(token, imageBase64, notracking) {
  const url = new URL(EASYAR.clientEndUrl);
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const path = (url.pathname === '/' ? '' : url.pathname) + '/search';
  const body = JSON.stringify({
    image: imageBase64,
    notracking: notracking,
    appId: EASYAR.crsAppId,
  });
  return requestJson({
    hostname: url.hostname,
    port: port,
    path: path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
    },
  }, body);
}

/**
 * 把临时 CDN URL 下载为 base64
 */
function downloadToBase64(urlStr) {
  const u = new URL(urlStr);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return requestJson({
    hostname: u.hostname,
    port: port,
    path: u.pathname + u.search,
    method: 'GET',
    headers: {},
  }, null, true).then(res => Buffer.from(res.raw).toString('base64'));
}

/**
 * 将跟踪图写入云存储，返回 fileID（避免把大 base64 塞进云函数返回值，超过 1MB 会被拦截）
 */
async function saveTrackingImage(targetId, trackingImageBase64) {
  const buffer = Buffer.from(String(trackingImageBase64 || '').replace(/[\r\n]/g, ''), 'base64');
  const cloudPath = `markers/${targetId}.jpg`;
  const res = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer,
  });
  return res.fileID;
}

/**
 * 通用 HTTPS 请求（使用 Node 内置 https，无需额外依赖）。
 * @param {object} options { hostname, port, path, method, headers }
 * @param {string|null} body POST 请求体
 * @param {boolean} raw true 时返回原始 Buffer（用于下载图片）
 */
function requestJson(options, body, raw) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers);
    if (body != null && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(Object.assign({ timeout: 20000 }, options, { headers }), (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) {
          return resolve({ httpStatusCode: res.statusCode, raw: buf });
        }
        try {
          resolve({ httpStatusCode: res.statusCode, data: JSON.parse(buf.toString('utf8')) });
        } catch (e) {
          reject(new Error('接口返回非 JSON: ' + buf.toString('utf8').slice(0, 200)));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}