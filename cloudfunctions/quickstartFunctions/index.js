// cloudfunctions/quickstartFunctions/index.js
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
 * 根据 targetId 查询冰箱贴数据（包含 posX/Y/Z）
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

      // 打印原始数据（用于调试）
      console.log('🔍 数据库原始数据:', JSON.stringify(sticker));

      // 只转换 videoUrl（需要播放），coverUrl 保留 fileID
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

      // ⭐ coverUrl 保留原始 cloud:// fileID，不转换
      const coverUrl = sticker.coverUrl || '';

      // 位置字段
      const posX = sticker.posX !== undefined ? sticker.posX : 0;
      const posY = sticker.posY !== undefined ? sticker.posY : 0;
      const posZ = sticker.posZ !== undefined ? sticker.posZ : 0;

      console.log('📤 返回的位置: posX=', posX, 'posY=', posY, 'posZ=', posZ);

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