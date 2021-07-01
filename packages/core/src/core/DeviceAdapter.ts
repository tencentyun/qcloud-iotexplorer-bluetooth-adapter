import { arrayBufferToHexStringArray, delay, hexToArrayBuffer, hexToStr, } from '../libs/utillib';
import { BlueToothBase } from './BlueToothBase';
import { BlueToothActions, BlueToothAdapter, H5Websocket } from "./BlueToothAdapter";

export interface BlueToothDeviceInfo extends WechatMiniprogram.BlueToothDevice {
  deviceName: string; // 设备唯一标识，同时也会作为 explorer 的 deviceName
  serviceId: string;
  productId?: string; // 对于自定义蓝牙协议的设备，filter的时候是没有这个productId的，需要后面动态查询的
}

export interface BLEMessageResponse {
  shouldIgnore?: boolean;
  reportData?: any; // 需要上报的数据，会原样调用 controlDeviceData
  [propName: string]: any; // 其他会透传给 message 事件
}

export type DeviceAdapterActions = Omit<BlueToothActions, 'initProductIds'>;

export interface DeviceFilterExtendInfo {
  serviceIds?: string[];
  deviceName?: string;
  productId?: string;
  ignoreDeviceIds?: string[];
  ignoreServiceIds?: string[];
  extendInfo?: any;
}

export type DeviceFilterFunction = (deviceInfo: WechatMiniprogram.BlueToothDevice, extendInfo: DeviceFilterExtendInfo) => BlueToothDeviceInfo | void | false | null;

/**
 * 设备适配器
 */
export class DeviceAdapter extends BlueToothBase {
  constructor({
    deviceId,
    productId,
    deviceName,
    name, // 设备原始名称
    actions,
    bluetoothApi,
    h5Websocket,
    extendInfo = {},
    bluetoothAdapter,
  }: {
    deviceId: string; // 微信蓝牙的deviceid，非explorer的deviceid
    productId: string;
    deviceName: string;
    name: string; // 设备原始名称
    actions: DeviceAdapterActions;
    bluetoothApi: any;
    h5Websocket?: H5Websocket;
    extendInfo?: any;
    bluetoothAdapter: BlueToothAdapter;
  }) {
    super();

    if (!deviceId) {
      throw '无deviceId';
    }

    if (!productId) {
      throw 'productId为空';
    }

    this._h5Websocket = h5Websocket;
    this._bluetoothApi = bluetoothApi;
    this._actions = actions;
    this._name = name;
    this._deviceName = deviceName;
    this._deviceId = deviceId;
    this._productId = productId;
    this.extendInfo = extendInfo || {};
    this.bluetoothAdapter = bluetoothAdapter;
  }

  bluetoothAdapter: BlueToothAdapter;

  extendInfo: any = {};

  _h5Websocket;

  _name = '';

  _deviceId = '';

  _deviceName = '';

  _deviceConnected = false;

  _productId = '';

  _deviceRegistered = false;

  _services = [];

  // serviceId => {writeId: [], notifyId: [], readId: [], indicateId: []}
  characteristicsMap = {};

  // @ts-ignore
  _actions: DeviceAdapterActions = {};

  _bluetoothApi: any = {};

  _getNotifyId({ serviceId = '' } = {}) {
    serviceId = serviceId || this.serviceId;

    const characteristicsMap = this.characteristicsMap[serviceId] || {
      writeIds: [], notifyIds: [], readIds: [], indicateIds: []
    };

    return characteristicsMap.notifyIds[0] || characteristicsMap.indicateIds[0];
  }

  // 下面4个为向前兼容
  get _writeId() {
    return ((this.characteristicsMap[this.serviceId] || {}).writeIds || [])[0];
  }

  get _notifyId() {
    return ((this.characteristicsMap[this.serviceId] || {}).notifyIds || [])[0];
  }

  get _readId() {
    return ((this.characteristicsMap[this.serviceId] || {}).readIds || [])[0];
  }

  get _indicateId() {
    return ((this.characteristicsMap[this.serviceId] || {}).indicateIds || [])[0];
  }

  get deviceId() {
    return this._deviceId;
  }

  get productId() {
    return this._productId;
  }

  get deviceName() {
    return this._deviceName;
  }

  set deviceName(deviceName) {
    this._deviceName = deviceName;
  }

  get isConnected() {
    return this._deviceConnected;
  }

  get originName() {
    return this._name;
  }

  get explorerDeviceId() {
    // 有可能没有 productId
    return [this._productId || '', this._deviceName || ''].join('/');
  }

  get serviceId() {
    // @ts-ignore
    return this.constructor.serviceId;
  }

  get deviceInfo() {
    return {
      productId: this.productId,
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      explorerDeviceId: this.explorerDeviceId,
      name: this.originName, // 设备原始名称
    }
  }

  async init() {
    if (this.bluetoothAdapter) {
      await this.bluetoothAdapter.init();
    } else {
      console.warn('DeviceAdapter未注入bluetoothAdapter实例，可能使用的不是最新版本的qcloud-iotexplorer-bluetooth-adapter模块');
    }
  }

  // 各自适配器根据业务需要覆盖，
  // 如需上报，返回包里加入 data.reportData = { ...data }
  handleBLEMessage(hexStrArr: string[], { serviceId, characteristicId }: {
    serviceId: string;
    characteristicId: string;
  }): BLEMessageResponse {
    return {};
  }

  /**
   * 匹配各自设备，并返回包含唯一标识的deviceInfo
   *
   * 需包含:
   * {
   *    ...deviceInfo,
   *    deviceName: mac,
   *    serviceId: matchedServiceId,
   * }
   * @param deviceInfo
   * @param extendInfo
   */
  static deviceFilter: DeviceFilterFunction = (deviceInfo, extendInfo) => {
    // 具体设备需要自行实现该方法
  }

  static serviceId = ''; // 子类实现时必须设置主服务id

  // 无论是否需要都可以调吧，大不了重复报错而已，看需要优化否？
  async registerDevice() {
    if (!this._deviceRegistered) {
      await this._actions.registerDevice({
        deviceId: this.explorerDeviceId,
        deviceName: this._deviceName,
        productId: this._productId,
      });

      this._deviceRegistered = true;
    }
  }

  // 设备绑定到家庭
  async bindDevice({
    familyId = '',
    roomId = '',
  } = {}) {
    try {
      await this.registerDevice();

      const params = {
        deviceId: this.explorerDeviceId,
        deviceName: this._deviceName,
        productId: this._productId,
        familyId,
        roomId,
      };

      await this._actions.bindDevice(params);

      this.emit('bind', params);

      return this.explorerDeviceId;
    } catch (err) {
      return Promise.reject(this._normalizeError(err));
    }
  }

  onBleConnectionStateChange({ connected }) {
    console.log('onBleConnectionStateChange => ', connected);
    const statusChanged = this._deviceConnected !== connected;
    this._deviceConnected = connected;

    if (statusChanged) {
      if (connected) {
        this.emit('connect', { ...this.deviceInfo });
      } else {
        // 当前状态是连接中，且新状态是断开时，才会去调 disconnect
        this.disconnectDevice();
      }

      this.emit('bLEConnectionStateChange', { connected });
    }
  }

  async onBLECharacteristicValueChange({
    serviceId,
    characteristicId,
    value,
  }) {
    try {
      let hexValue = value;
      if (value instanceof ArrayBuffer) {
        hexValue = arrayBufferToHexStringArray(value);
      }
      const { shouldIgnore, reportData, ...message } = this.handleBLEMessage(hexValue, {
        serviceId,
        characteristicId,
      }) || {};

      console.log('shouldIgnore?', shouldIgnore);

      if (shouldIgnore) {
        return;
      }

      console.log('receive data', hexValue, message);
      console.log('should report?', !!reportData, reportData);

      const timestamp = Date.now();
      let dataReported = false;

      if (this._deviceName && reportData) {
        dataReported = true;

        if (typeof this._actions.reportDeviceData === 'function') {
          await this._actions.reportDeviceData({
            deviceId: this.explorerDeviceId,
            deviceName: this._deviceName,
            productId: this._productId,
            data: reportData,
            timestamp,
          });
        } else {
          console.warn('handleBLEMessage return should report but actions.reportDeviceData is not implement.');
        }
      }

      this.emit('message', { ...message, timestamp, dataReported });
    } catch (err) {
      console.error('onBLECharacteristicValueChange onError,', err);
    }
  }

  disconnectDevice() {
    this._bluetoothApi.closeBLEConnection({
      deviceId: this._deviceId,
    });

    // disconnect 后 blueToothAdapter 会直接销毁这个实例，所以其他都不用清理了
    this.emit('disconnect', { ...this.deviceInfo });
  }

  /**
   *  1. 连接设备
   *  2. 获取服务列表、特征列表
   *  3. 监听notify，注册回调
   */
  async connectDevice({
    autoNotify = true,
  } = {}) {
    const startTime = Date.now();

    try {
      await this.init();

      // 当前已经连接的话，无需再执行：
      // createBLEConnection、getBLEDeviceServices、getBLEDeviceCharacteristics、notifyBLECharacteristicValueChange 等步骤
      // 直接调用监听 onBLEConnectionStateChange、onBLECharacteristicValueChange 回调即可
      console.log('start connect device', this.deviceInfo);

      if (this.isConnected) {
        console.log('device is already connected', this.deviceInfo);
        return;
      }

      let stepStart = Date.now();

      await this._bluetoothApi.createBLEConnection({
        deviceId: this._deviceId,
      });

      console.log('createBLEConnection succ', Date.now() - stepStart);

      if (autoNotify) {
        stepStart = Date.now();
        const services = await this.getBLEDeviceServices();

        console.log('getBLEDeviceServices succ', services, Date.now() - stepStart);

        this.emit('onGetBLEDeviceServices', services);

        stepStart = Date.now();
        const characteristics = await this.getBLEDeviceCharacteristics();

        console.log('getBLEDeviceCharacteristics succ', characteristics, Date.now() - stepStart);

        this.emit('onGetBLEDeviceCharacteristics', characteristics);

        stepStart = Date.now();
        await this.notifyBLECharacteristicValueChange();

        console.log('notifyBLECharacteristicValueChange succ', Date.now() - stepStart);
      }

      console.log('connectDevice succeed, time cost: ', Date.now() - startTime);
    } catch (err) {
      err = this._normalizeError(err);

      // 尝试断开然后重连
      if (err.errMsg && err.errMsg.indexOf('already connect') > -1) {
        // TODO: 这里观察下不断开是否有问题
        console.log('device is already connected, resolve directly, time cost: ', Date.now() - startTime);
        return Promise.resolve();
      }

      console.error('connectDevice error', err);

      return Promise.reject(err);
    }
  }

  async write(data, {
    writeId = '',
    serviceId = '',
  } = {}): Promise<void> {
    if (typeof data === 'string') {
      console.log('writeBLECharacteristicValue', data);
      data = hexToArrayBuffer(data);
    } else if (data instanceof ArrayBuffer) {
      try {
        console.log('writeBLECharacteristicValue', arrayBufferToHexStringArray(data).join(''));
      } catch (err) {
      }
    }

    return this._write(data, { writeId, serviceId });
  }

  async _write(value, {
    writeId = '',
    serviceId = '',
  } = {}): Promise<void> {
    try {
      await this._bluetoothApi.writeBLECharacteristicValue({
        deviceId: this._deviceId,
        characteristicId: writeId || this._writeId,
        serviceId: serviceId || this.serviceId,
        value,
      });
    } catch (err) {
      return Promise.reject(this._normalizeError(err));
    }
  }

  async getBLEDeviceServices() {
    const { services } = await this._bluetoothApi.getBLEDeviceServices({
      deviceId: this._deviceId,
    });

    this._services = services;

    return services;
  }

  setCharacteristicsIds(serviceId, characteristics) {
    const map = {
      notifyIds: [],
      writeIds: [],
      indicateIds: [],
      readIds: [],
    };

    const setCharacteristicsId = (idSet, uuid) => {
      if (idSet.indexOf(uuid) === -1) {
        idSet.push(uuid);
      }
    };

    characteristics.forEach(({
      uuid,
      properties: {
        notify, write, indicate, read,
      },
    }) => {
      if (notify) {
        setCharacteristicsId(map.notifyIds, uuid);
      } else if (write) {
        setCharacteristicsId(map.writeIds, uuid);
      } else if (indicate) {
        setCharacteristicsId(map.indicateIds, uuid);
      } else if (read) {
        setCharacteristicsId(map.readIds, uuid);
      }
    });

    this.characteristicsMap[serviceId] = map;
  }

  async getBLEDeviceCharacteristics({
    serviceId = '',
  } = {}) {
    serviceId = serviceId || this.serviceId;

    const { characteristics } = await this._bluetoothApi.getBLEDeviceCharacteristics({
      deviceId: this._deviceId,
      serviceId,
    });

    this.setCharacteristicsIds(serviceId, characteristics);

    return characteristics;
  }

  async notifyBLECharacteristicValueChange({
    characteristicId = '',
    serviceId = '',
    state = true,
  } = {}) {
    characteristicId = characteristicId || this._getNotifyId();
    serviceId = serviceId || this.serviceId;

    if (!characteristicId) {
      console.warn('未找到指定service下的notifyId，该设备可能不支持notify');
    } else {
      await this._bluetoothApi.notifyBLECharacteristicValueChange({
        deviceId: this._deviceId,
        characteristicId,
        serviceId,
        state,
      });
    }
  }

  async readBLECharacteristicValue({
    serviceId = '',
    characteristicId = '',
  } = {}) {
    serviceId = serviceId || this.serviceId;

    if (!characteristicId) {
      characteristicId = ((this.characteristicsMap[this.serviceId] || {}).readIds || [])[0];
    }

    if (!characteristicId) {
      console.warn('未找到指定service下的readId，该设备可能不支持read');
    } else {
      await this._bluetoothApi.readBLECharacteristicValue({
        deviceId: this._deviceId,
        characteristicId,
        serviceId,
      });
    }
  }

  setBLEMTU(params) {
    return this._bluetoothApi.setBLEMTU(params);
  }

  getBLEDeviceRSSI() {
    return this._bluetoothApi.getBLEDeviceRSSI({
      deviceId: this._deviceId,
    });
  }

  destroy() {
    this.emit('destroy');
  }
}
