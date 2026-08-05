// cloudfunctions/quickstartFunctions/index.js
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

// 云函数入口函数
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
 * 根据 targetId 查询冰箱贴数据
 * @param {string} targetId - EasyAR 识别返回的 targetId
 * @returns {Object} 包含 videoUrl, planeWidth, planeHeight
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
      .where({
        targetId: targetId
      })
      .get();

    if (result.data && result.data.length > 0) {
      const sticker = result.data[0];

      // 收集所有 cloud:// 协议的文件，统一换取临时 HTTPS URL（视频 + 封面图）
      const fileList = [];
      if (sticker.videoUrl && sticker.videoUrl.startsWith('cloud://')) {
        fileList.push(sticker.videoUrl);
      }
      if (sticker.coverUrl && sticker.coverUrl.startsWith('cloud://')) {
        fileList.push(sticker.coverUrl);
      }

      let tempVideoUrl = sticker.videoUrl;
      let tempCoverUrl = sticker.coverUrl || '';
      if (fileList.length > 0) {
        try {
          const tempUrlResult = await cloud.getTempFileURL({ fileList });
          if (tempUrlResult.fileList && tempUrlResult.fileList.length > 0) {
            tempUrlResult.fileList.forEach((item, index) => {
              if (item && item.tempFileURL) {
                if (fileList[index] === sticker.videoUrl) {
                  tempVideoUrl = item.tempFileURL;
                } else if (fileList[index] === sticker.coverUrl) {
                  tempCoverUrl = item.tempFileURL;
                }
              }
            });
          }
        } catch (convertError) {
          console.warn('cloud:// 转 HTTPS 失败，使用原地址:', convertError);
        }
      }

      return {
        code: 0,
        message: '查询成功',
        data: {
          _id: sticker._id,
          targetId: sticker.targetId,
          videoUrl: tempVideoUrl,
          coverUrl: tempCoverUrl,
          planeWidth: sticker.planeWidth || 1,
          planeHeight: sticker.planeHeight || 1,
          // 若数据库 title 为空，默认赋值“未命名冰箱贴”
          title: sticker.title || '未命名冰箱贴',
          description: sticker.description || ''
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

/**
 * 获取所有冰箱贴列表
 */
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
        planeWidth: item.planeWidth || 1,
        planeHeight: item.planeHeight || 1,
        title: item.title || '',
        description: item.description || '',
        createTime: item.createTime
      }))
    };
  } catch (error) {
    console.error('获取冰箱贴列表失败:', error);
    throw error;
  }
}

/**
 * 创建/更新冰箱贴数据
 */
async function createSticker(params) {
  const { targetId, videoUrl, planeWidth, planeHeight, title, description } = params;

  if (!targetId || !videoUrl) {
    return {
      code: 400,
      message: 'targetId 和 videoUrl 不能为空'
    };
  }

  try {
    // 检查是否已存在
    const existResult = await db.collection('fridgeStickers')
      .where({ targetId: targetId })
      .get();

    if (existResult.data.length > 0) {
      // 更新
      const updateResult = await db.collection('fridgeStickers')
        .doc(existResult.data[0]._id)
        .update({
          data: {
            videoUrl: videoUrl,
            planeWidth: planeWidth || 1,
            planeHeight: planeHeight || 1,
            title: title || '',
            description: description || '',
            updateTime: db.serverDate()
          }
        });

      return {
        code: 0,
        message: '更新成功',
        data: updateResult
      };
    } else {
      // 新增
      const addResult = await db.collection('fridgeStickers')
        .add({
          data: {
            targetId: targetId,
            videoUrl: videoUrl,
            planeWidth: planeWidth || 1,
            planeHeight: planeHeight || 1,
            title: title || '',
            description: description || '',
            createTime: db.serverDate(),
            updateTime: db.serverDate()
          }
        });

      return {
        code: 0,
        message: '创建成功',
        data: addResult
      };
    }
  } catch (error) {
    console.error('创建/更新冰箱贴失败:', error);
    throw error;
  }
}
