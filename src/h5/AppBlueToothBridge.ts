import EventEmitter from 'event-emitter-for-miniprogram';
import { H5AppBridge } from '../core';
import { tryCallHandler } from '../libs/utillib';

export class AppBlueToothBridge extends EventEmitter {
  _appBridge: H5AppBridge;
  _onBluetoothAdapterStateChangeHandler;
  _onBLEConnectionStateChangeHandler;
  _onBLECharacteristicValueChangeHandler;
  _onBluetoothDeviceFoundHandler;

  constructor({
    appBridge,
  }: {
    appBridge: H5AppBridge;
  }) {
    super();

    appBridge.on('bluetoothAdapterStateChange', (payload) => {
      tryCallHandler(this, 'onBluetoothAdapterStateChange', payload);
    });

    appBridge.on('bleConnectionStateChange', (payload) => {
      tryCallHandler(this, 'onBLEConnectionStateChange', payload);
    });

    appBridge.on('bleCharacteristicValueChange', (payload) => {
      tryCallHandler(this, 'onBLECharacteristicValueChange', payload);
    });

    appBridge.on('bluetoothDeviceFound', (payload) => {
      tryCallHandler(this, 'onBluetoothDeviceFound', payload);
    });

    this._appBridge = appBridge;
  }

  _blueToothBridgeEnable = false;

  async init() {
    this._blueToothBridgeEnable = true;
    return this._appBridge.callApp('openBluetoothAdapter');
  }

  openBluetoothAdapter() {
    return this.init();
  }

  control(action, payload) {
    switch (action) {
      case 'registryDevice':
        return Promise.reject({ msg: '腾讯连连 APP 不支持调用 registerDevice' });
      case 'bindDevice':
        return Promise.reject({ msg: '腾讯连连 APP 不支持调用 bindDevice' });
      default:
        return Promise.reject({ msg: `未定义的 Action: ${action}` });
    }
  }

  // 停止搜寻附近的蓝牙外围设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.stopBluetoothDevicesDiscovery.html
  stopBluetoothDevicesDiscovery(params) {
    return this._appBridge.callApp('stopBluetoothDevicesDiscovery', params);
  }

  // 开始搜寻附近的蓝牙外围设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.html
  startBluetoothDevicesDiscovery(params) {
    return this._appBridge.callApp('startBluetoothDevicesDiscovery', params);
  }

  // 根据 uuid 获取处于已连接状态的设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getConnectedBluetoothDevices.html
  getConnectedBluetoothDevices(params) {
    return this._appBridge.callApp('getConnectedBluetoothDevices', params);
  }

  // 获取在蓝牙模块生效期间所有已发现的蓝牙设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothDevices.html
  getBluetoothDevices(params) {
    return this._appBridge.callApp('getBluetoothDevices', params);
  }

  // 获取本机蓝牙适配器状态
  getBluetoothAdapterState(params) {
    return this._appBridge.callApp('getBluetoothAdapterState', params);
  }

  // 向低功耗蓝牙设备特征值中写入二进制数据
  writeBLECharacteristicValue(params) {
    return this._appBridge.callApp('writeBLECharacteristicValue', params);
  }

  // 设置蓝牙最大传输单元
  setBLEMTU(params) {
    return this._appBridge.callApp('setBLEMTU', params);
  }

  // 读取低功耗蓝牙设备的特征值的二进制数据值
  readBLECharacteristicValue(params) {
    return this._appBridge.callApp('readBLECharacteristicValue', params);
  }

  // 启用低功耗蓝牙设备特征值变化时的 notify 功能，订阅特征值
  notifyBLECharacteristicValueChange(params) {
    return this._appBridge.callApp('notifyBLECharacteristicValueChange', params);
  }

  // 获取蓝牙设备所有服务(service)
  getBLEDeviceServices(params) {
    return this._appBridge.callApp('getBLEDeviceServices', params);
  }

  // 获取蓝牙设备的信号强度
  getBLEDeviceRSSI(params) {
    return this._appBridge.callApp('getBLEDeviceRSSI', params);
  }

  // 获取蓝牙设备某个服务中所有特征值(characteristic)
  getBLEDeviceCharacteristics(params) {
    return this._appBridge.callApp('getBLEDeviceCharacteristics', params);
  }

  // 连接低功耗蓝牙设备
  async createBLEConnection(params, isRetry = false) {
    try {
      await this._appBridge.callApp('createBLEConnection', params);
    } catch (err) {
      if (!isRetry && err && err.errMsg && err.errMsg.indexOf('already connect') > -1) {
        console.log('already connect, try disconnect');

        try {
          await this.closeBLEConnection(params);
          console.log('disconnect success', params);
        } catch (err) {
          console.warn('disconnect fail', err);
        }

        console.log('try connect again', params);

        // 重试的时候再报错就不要处理了避免死循环
        return this.createBLEConnection(params, true);
      } else {
        return Promise.reject(err);
      }
    }
  }

  // 断开与低功耗蓝牙设备的连接
  closeBLEConnection(params) {
    return this._appBridge.callApp('closeBLEConnection', params);
  }

  registerDevice(params) {
    return this._appBridge.callApp('registerBluetoothDevice', params);
  }

  bindDevice(params) {
    return this._appBridge.callApp('bindBluetoothDevice', params);
  }

  // 监听蓝牙适配器状态变化事件
  onBluetoothAdapterStateChange(callback) {
    this._onBluetoothAdapterStateChangeHandler = callback;
  }

  offBluetoothAdapterStateChange() {
    this._onBluetoothAdapterStateChangeHandler = null;
  }

  // 监听低功耗蓝牙连接状态的改变事件
  onBLEConnectionStateChange(callback) {
    this._onBLEConnectionStateChangeHandler = callback;
  }

  offBLEConnectionStateChange() {
    this._onBLEConnectionStateChangeHandler = null;
  }

  // 监听低功耗蓝牙设备的特征值变化事件
  onBLECharacteristicValueChange(callback) {
    this._onBLECharacteristicValueChangeHandler = callback;
  }

  offBLECharacteristicValueChange() {
    this._onBLECharacteristicValueChangeHandler = null;
  }

  // 监听寻找到新设备的事件
  onBluetoothDeviceFound(callback) {
    this._onBluetoothDeviceFoundHandler = callback;
  }

  offBluetoothDeviceFound() {
    this._onBluetoothDeviceFoundHandler = null;
  }

  closeBluetoothAdapter() {
    // 蓝牙适配器由 App 在关闭 H5 页面时强制关闭，H5 不会主动进行关闭操作
  }
}
