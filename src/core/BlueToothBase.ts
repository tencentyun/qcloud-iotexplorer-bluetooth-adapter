import EventEmitter from '../libs/event-emmiter';

const errorMap = {
  10000: '未初始化蓝牙适配器',
  10001: '当前蓝牙适配器不可用',
  10002: '没有找到指定设备',
  10003: '无法连接，请将手机尽量靠近设备',
  10004: '没有找到指定服务',
  10005: '没有找到指定特征值',
  10006: '当前连接已断开',
  10007: '当前特征值不支持此操作',
  10008: '其余所有系统上报的异常',
  10009: '安卓版本过低，不支持低功耗蓝牙',
  10012: '连接超时，请将手机尽量靠近设备',
  10013: '连接 deviceId 为空或者是格式不正确',
};

export class BlueToothBase extends EventEmitter {
  _cleanupMap = {};

  _normalizeError(error) {
    if (error && error.errCode) {
      Object.assign(error, {
        code: error.errCode,
        msg: errorMap[error.errCode],
      });
    }

    return error;
  }

  cleanup(action?: string) {
    if (action) {
      if (this._cleanupMap[action] && typeof this._cleanupMap[action] === 'function') {
        console.log('clean up for action: ', action);
        this._cleanupMap[action]();
      } else {
        console.warn('clean up invalid action', action, this._cleanupMap);
      }
    } else {
      for (const key in this._cleanupMap) {
        if (typeof this._cleanupMap[key] === 'function') {
          this._cleanupMap[key]();
        }
      }
    }
  }

  addCleanupTask(action, cleanupFn) {
    this._cleanupMap[action] = cleanupFn;
  }
}
