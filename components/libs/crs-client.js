import { CryptoJS } from "./crypto-js";

export default class CrsClient {
    // 生成的token，在有效期内不用更新
    token = null;
    /**
     * @param config {{ cloudKey: string, token: string, clientEndUrl: string, jpegQuality: number }, canvas: WebGLCanvas}
     */
    constructor(config) {
        this.config = config;
    }

    searchByBase64(img) {
        const params = {
            image: img,
            notracking: 'false',
            appId: this.config.crsAppId,
        };

        return this.queryToken().then(token => {
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

    /**
     * 生成token
     */
    queryToken() {
        if (this.token) {
            return Promise.resolve(this.token);
        }

        const obj = {
            'apiKey': this.config.apiKey,
            'expires': 86400,
            'timestamp': Date.now(),
            'acl': `[{"service":"ecs:crs","effect":"Allow","resource":["${this.config.crsAppId}"],"permission":["READ","WRITE"]}]`
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
}
