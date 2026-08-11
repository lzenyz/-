// cloudfunctions/quickstartFunctions/index.js
// =====================================================================
// 云函数职责：
//   1. 冰箱贴数据（getStickerDataByTargetId / getAllStickers / createSticker）
//   2. 生成产品小程序码（getMiniProgramCode，微信原生 wxacode）
// 说明：已移除 EasyAR 云识别相关代码 —— 产品识别改为 xr-frame 原生本地图像跟踪，
//       识别图 = 数据库里该产品的照片（coverUrl，与首页同一张）。
// =====================================================================
const cloud = require('wx-server-sdk');

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
 * 根据 targetId 查询冰箱贴数据（包含视频地址、产品照片 coverUrl 与 posX/Y/Z 位置）
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

      // videoUrl 转临时链接（供视频纹理加载）
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

      // coverUrl 保留原始 cloud://（前端自行转临时链接作为识别图）
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