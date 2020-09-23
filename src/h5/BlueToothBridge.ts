import EventEmitter from '../libs/event-emmiter';
import { tryCallHandler } from '../libs/utillib';

/**
 * @doc https://developers.weixin.qq.com/miniprogram/dev/api/
 */
export class BlueToothBridge extends EventEmitter {
  _h5Websocket = null;
  _onBluetoothAdapterStateChangeHandler;
  _onBLEConnectionStateChangeHandler;
  _onBLECharacteristicValueChangeHandler;
  _onBluetoothDeviceFoundHandler;

  constructor({
    h5Websocket
  }) {
    super();

    this._h5Websocket = h5Websocket;
    this._h5Websocket.h5Websocket
      .on('message', async ({ action, payload }) => {
        switch (action) {
          case 'connect':
            if (this._blueToothBridgeEnable) {
              // 这里主要是两端通道已连接后，若小程序退到后台，过一阵再进来，会重新触发一次connect，这是判断如果蓝牙已激活，则再次调用init
              await this._h5Websocket.connect();
              await this.init();
            }
            break;
          case 'onBluetoothAdapterStateChange':
            tryCallHandler(this, 'onBluetoothAdapterStateChange', payload);
            break;
          case 'onBLEConnectionStateChange':
            tryCallHandler(this, 'onBLEConnectionStateChange', payload);
            break;
          case 'onBLECharacteristicValueChange':
            tryCallHandler(this, 'onBLECharacteristicValueChange', payload);
            break;
          case 'onBluetoothDeviceFound':
            tryCallHandler(this, 'onBluetoothDeviceFound', payload);
            break;
        }
      });
  }

  _blueToothBridgeEnable = false;

  async init() {
    this._blueToothBridgeEnable = true;
    await this._h5Websocket.send('Control', {
      action: 'init'
    });
  }

  control(action, payload) {
    return this._h5Websocket.send('Control', {
      action,
      payload,
    });
  }

  async callWxApi(api, params) {
    const start = Date.now();

    const resp = await this.control('callApi', {
      api,
      params,
    });

    console.log(`call api: ${api} success, time cast: ${Date.now() - start}ms`);

    return resp;
  }

  // 停止搜寻附近的蓝牙外围设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.stopBluetoothDevicesDiscovery.html
  stopBluetoothDevicesDiscovery(params) {
    return this.callWxApi('stopBluetoothDevicesDiscovery', params);
  }

  // 开始搜寻附近的蓝牙外围设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.html
  startBluetoothDevicesDiscovery(params) {
    return this.callWxApi('startBluetoothDevicesDiscovery', params);
  }

  // 根据 uuid 获取处于已连接状态的设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getConnectedBluetoothDevices.html
  getConnectedBluetoothDevices(params) {
    return this.callWxApi('getConnectedBluetoothDevices', params);
  }

  // 获取在蓝牙模块生效期间所有已发现的蓝牙设备
  // https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothDevices.html
  getBluetoothDevices(params) {
    return this.callWxApi('getBluetoothDevices', params);
  }

  // 获取本机蓝牙适配器状态
  getBluetoothAdapterState(params) {
    return this.callWxApi('getBluetoothAdapterState', params);
  }

  // 向低功耗蓝牙设备特征值中写入二进制数据
  writeBLECharacteristicValue(params) {
    return this.callWxApi('writeBLECharacteristicValue', params);
  }

  // 设置蓝牙最大传输单元
  setBLEMTU(params) {
    return this.callWxApi('setBLEMTU', params);
  }

  // 读取低功耗蓝牙设备的特征值的二进制数据值
  readBLECharacteristicValue(params) {
    return this.callWxApi('readBLECharacteristicValue', params);
  }

  // 启用低功耗蓝牙设备特征值变化时的 notify 功能，订阅特征值
  notifyBLECharacteristicValueChange(params) {
    return this.callWxApi('notifyBLECharacteristicValueChange', params);
  }

  // 获取蓝牙设备所有服务(service)
  getBLEDeviceServices(params) {
    return this.callWxApi('getBLEDeviceServices', params);
  }

  // 获取蓝牙设备的信号强度
  getBLEDeviceRSSI(params) {
    return this.callWxApi('getBLEDeviceRSSI', params);
  }

  // 获取蓝牙设备某个服务中所有特征值(characteristic)
  getBLEDeviceCharacteristics(params) {
    return this.callWxApi('getBLEDeviceCharacteristics', params);
  }

  // 连接低功耗蓝牙设备
  async createBLEConnection(params) {
    return this.callWxApi('createBLEConnection', params);
  }

  // 断开与低功耗蓝牙设备的连接
  closeBLEConnection(params) {
    return this.callWxApi('closeBLEConnection', params);
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
}
