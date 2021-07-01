export const isMiniProgram = (function () {
  // 通过关键 api 是否存在来判断小程序环境
  try {
    return !!(wx && wx.request && wx.connectSocket);
  } catch (e) {
    return false;
  }
})();

export const isBrowser = (function () {
  try {
    if (isMiniProgram) return false;

    return typeof window !== 'undefined' && typeof window.document !== 'undefined'
  } catch (e) {
    return false;
  }
})();

export const delay = timeout => new Promise(resolve => setTimeout(() => resolve(), timeout));

export function arrayBufferToHexStringArray(buffer) {
  try {
    if (typeof buffer === 'string') {
      let result = [''];

      buffer.split('').forEach((str, index) => {
        result[result.length - 1] += str;

        if (index % 2) {
          result.push('');
        }
      });

      // 干掉最后多出来一项
      result.splice(result.length - 1, 1);

      return result;
    }

    if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') {
      throw 'invalid array buffer';
    }
    const dataView = new DataView(buffer);

    const hexStrArr = [];

    for (let i = 0, l = dataView.byteLength; i < l; i++) {
      const str = dataView.getUint8(i);
      let hex = (str & 0xff).toString(16);
      hex = (hex.length === 1) ? `0${hex}` : hex;
      hexStrArr.push(hex.toUpperCase());
    }

    return hexStrArr;
  } catch (err) {
    console.error('arrayBufferToHexStringArray error', err);
    return [];
  }
}

export function hexToArrayBuffer(hex) {
  return new Uint8Array(hex.match(/[\da-f]{2}/gi).map(h => parseInt(h, 16))).buffer;
}

export function noop() {
}

export function isEmpty(any) {
  if (!any) return true;

  if (Array.isArray(any)) {
    return any.length === 0;
  }

  for (const k in any) {
    return false;
  }

  return true;
}

export function usePromise() {
  let resolve;
  let reject;

  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  return { promise, resolve, reject };
}

export function isObject(obj) {
  let type = typeof obj;
  return type === 'function' || type === 'object' && !!obj;
}

export const pify = (api, context = wx) => (params, ...others) => new Promise((resolve, reject) => {
  api.call(context, { ...params, success: resolve, fail: reject }, ...others);
});

export const appendParams = (url, data) => {
  const paramArr = [];

  for (let key in data) {
    if (typeof data[key] !== 'undefined') {
      if (isObject(data[key])) {
        data[key] = JSON.stringify(data[key]);
      }
      paramArr.push(`${key}=${encodeURIComponent(data[key])}`);
    }
  }

  if (!paramArr.length) return url;

  return (url.indexOf('?') > -1 ? `${url}&` : `${url}?`) + paramArr.join('&');
};

export const tryCallHandler = (context, eventName, ...params) => {
  if (typeof context[`_${eventName}Handler`] === 'function') {
    context[`_${eventName}Handler`](...params);
  }
};

export function hexToStr(hex) {
  const trimedStr = String(hex).trim();
  const rawStr = trimedStr.substr(0, 2).toLowerCase() === "0x"
    ? trimedStr.substr(2) : trimedStr;
  const len = rawStr.length;

  if (len % 2 !== 0) {
    throw 'Illegal Format ASCII Code';
  }

  let curCharCode;
  const resultStr = [];

  for (let i = 0; i < len; i = i + 2) {
    curCharCode = parseInt(rawStr.substr(i, 2), 16); // ASCII Code Value
    resultStr.push(String.fromCharCode(parseInt(rawStr.substr(i, 2), 16)));
  }

  return resultStr.join('');
}
