import { delay, pify } from '../libs/utillib';

const pifyApiArr = [
  'closeBluetoothAdapter',
  'stopBluetoothDevicesDiscovery',
  'readBLECharacteristicValue',
  'openBluetoothAdapter',
  'getBluetoothAdapterState',
  'getBluetoothDevices',
  'startBluetoothDevicesDiscovery',
  'closeBLEConnection',
  'getBLEDeviceServices',
  'getBLEDeviceCharacteristics',
  'notifyBLECharacteristicValueChange',
  'offBluetoothAdapterStateChange',
  'offBLEConnectionStateChange',
  'offBLECharacteristicValueChange',
  'offBluetoothDeviceFound',
  'writeBLECharacteristicValue',
  'setBLEMTU',
];

const callbackApiArr = [
  'onBluetoothAdapterStateChange',
  'onBLEConnectionStateChange',
  'onBLECharacteristicValueChange',
  'onBluetoothDeviceFound',
];

// TODO: createBLEConnection 需要捕获 errMsg 中含 already connect 的错误，捕获后尝试 closeBLEConnection 然后再重新 createBLEConnection
const apis: any = {};

pifyApiArr.forEach((apiKey) => {
  apis[apiKey] = params => pify(wx[apiKey])(params);
});

callbackApiArr.forEach((apiKey) => {
  apis[apiKey] = params => wx[apiKey](params);
});

apis.createBLEConnection = async (params, isRetry = false) => {
  try {
    await pify(wx.createBLEConnection)(params);
  } catch (err) {
    if (!isRetry && err && err.errMsg && err.errMsg.indexOf('already connect') > -1) {
      // 碰到 already connect，需要先尝试断开，再重连
      // zefengwang 7-10 下午 4:18
      // 其实是客户端检查的…这个事情应该是最早的版本这里会直接重连，但是后面发现有问题，改成检查是否已经连接了
      // vinsonxiao 7-10 下午 4:26
      // 那我碰到这个错直接认为连接成功是不是可以？
      // 还是需要先手动断开
      // zefengwang 7-10 下午 4:28
      // 先断开
      console.log('already connect, try disconnect');

      try {
        await apis.closeBLEConnection(params);
        // 等一下再重连，否则可能出现重新连上后始终无法获取services报100004问题
        await delay(1000);
        console.log('disconnect success', params);
      } catch (err) {
        console.warn('disconnect fail', err);
      }

      console.log('try connect again', params);

      // 重试的时候再报错就不要处理了避免死循环
      return apis.createBLEConnection(params, true);
    } else {
      return Promise.reject(err);
    }
  }
};

export default apis;
