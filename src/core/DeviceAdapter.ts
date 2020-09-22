import { arrayBufferToHexStringArray, hexToArrayBuffer, noop } from '../libs/utillib';
import { BlueToothBase } from './BlueToothBase';
import { BlueToothActions } from "./BlueToothAdapter";

export interface DeviceInfo extends WechatMiniprogram.BlueToothDevice {
  deviceName: string; // 设备唯一标识，同时也会作为 explorer 的 deviceName
  serviceId: string;
}

type DeviceAdapterActions = Omit<BlueToothActions, 'initProductIds'>;

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
  }: {
    deviceId: string; // 微信蓝牙的deviceid，非explorer的deviceid
    productId: string;
    deviceName: string;
    name: string; // 设备原始名称
    actions: DeviceAdapterActions;
    bluetoothApi: any;
  }) {
    super();

    if (!deviceId) {
      throw '无deviceId';
    }

    if (!productId) {
      throw 'productId为空';
    }

    this._bluetoothApi = bluetoothApi;
    this._actions = actions;
    this._name = name;
    this._deviceName = deviceName;
    this._deviceId = deviceId;
    this._productId = productId;
  }

  _name = '';

  _deviceId = '';

  _deviceName = '';

  _deviceConnected = false;

  // write支持多个
  _writeIds = [];

  _notifyIds = [];

  // read支持多个
  _readIds = [];

  _indicateIds = [];

  _productId = '';

  _deviceRegistered = false;

  _services = [];

  _characteristics = [];

  // @ts-ignore
  _actions: DeviceAdapterActions = {};

  _bluetoothApi: any = {};

  _getNotifyId() {
    return this._notifyIds[0] || this._indicateIds[0];
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

  get isConnected() {
    return this._deviceConnected;
  }

  get originName() {
    return this._name;
  }

  get explorerDeviceId() {
    return `${this._productId}/${this._deviceName}`;
  }

  get serviceId() {
    // @ts-ignore
    return this.constructor.serviceId;
  }

  // 各自适配器根据业务需要覆盖，
  // 如需上报，返回包里加入 data.reportData = { ...data }
  handleBLEMessage(data) {
    return data;
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
  static deviceFilter(deviceInfo: WechatMiniprogram.BlueToothDevice, extendInfo?: any): DeviceInfo {
    throw new Error('具体产品需要自行实现该方法');
  }

  static serviceId = ''; // 子类实现时必须设置主服务id

  // 无论是否需要都可以调吧，大不了重复报错而已，看需要优化否？
  async registerDevice() {
    if (!this._deviceRegistered) {
      await this._actions.registerDevice({
        deviceId: this.explorerDeviceId,
      });

      this._deviceRegistered = true;
    }
  }

  // 设备绑定到家庭
  async bindDevice({
    familyId,
    roomId,
  }) {
    try {
      await this.registerDevice();

      await this._actions.bindDevice({
        deviceId: this.explorerDeviceId,
        familyId,
        roomId,
      });

      return this.explorerDeviceId;
    } catch (err) {
      return Promise.reject(this._normalizeError(err));
    }
  }

  onBleConnectionStateChange({ connected }) {
    this._deviceConnected = connected;
    this.emit('bLEConnectionStateChange', { connected });

    if (connected) {
      this.emit('connect');
    } else {
      this.disconnectDevice();
    }
  }

  async onBLECharacteristicValueChange({
    serviceId,
    characteristicId,
    value,
  }) {
    try {
      if (serviceId === this.serviceId && characteristicId === this._getNotifyId()) {
        const hexValue = arrayBufferToHexStringArray(value);
        const { shouldIgnore, reportData, ...message } = this.handleBLEMessage(hexValue);

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

          await this._actions.reportDeviceData({
            deviceId: this.explorerDeviceId,
            data: reportData,
            timestamp,
          });
        }

        this.emit('message', { ...message, timestamp, dataReported });
      }
    } catch (err) {
      console.error('onBLECharacteristicValueChange onError,', err);
    }
  }

  disconnectDevice() {
    this._bluetoothApi.closeBLEConnection({
      deviceId: this._deviceId,
    });

    // disconnect 后 blueToothAdapter 会直接销毁这个实例，所以其他都不用清理了
    this.emit('disconnect');
  }

  /**
   *  1. 连接设备
   *  2. 获取服务列表、特征列表
   *  3. 监听notify，注册回调
   */
  async connectDevice() {
    try {
      let isConnected = false;

      // 当前已经连接的话，无需再执行：
      // createBLEConnection、getBLEDeviceServices、getBLEDeviceCharacteristics、notifyBLECharacteristicValueChange 等步骤
      // 直接调用监听 onBLEConnectionStateChange、onBLECharacteristicValueChange 回调即可
      if (this._deviceConnected) {
        console.log('Device已经连接', this._deviceId);
        isConnected = true;
      }

      if (!isConnected) {
        await this.registerDevice();

        await this._bluetoothApi.createBLEConnection({
          deviceId: this._deviceId,
        });

        console.log('createBLEConnection succ');

        const { services } = await this._bluetoothApi.getBLEDeviceServices({
          deviceId: this._deviceId,
        });

        this._services = services;

        console.log('getBLEDeviceServices succ', services);

        // TODO：有必要判断主服务id吗？
        if (!services.find(item => item.uuid === this.serviceId)) {
          console.log('BLEDeviceService do not contain main serviceId', this.serviceId);
          this.disconnectDevice();
          throw '暂不支持该品类设备，请确认设备型号后重新连接';
        }

        this.emit('onGetBLEDeviceServices', services);

        const { characteristics } = await this._bluetoothApi.getBLEDeviceCharacteristics({
          deviceId: this._deviceId,
          serviceId: this.serviceId,
        });

        this._characteristics = characteristics;

        console.log('getBLEDeviceCharacteristics succ', characteristics);

        this.emit('onGetBLEDeviceCharacteristics', characteristics);

        const setCharacteristicsId = (idSet, uuid) => {
          if (idSet.indexOf(uuid) === -1) {
            idSet.push(uuid);
          }
        };

        // 这里可以指定需要监听的id，指定后就不会再次赋值
        // TODO: 指定后，是否需要校验是否存在？
        characteristics.forEach(({
          uuid,
          properties: {
            notify, write, indicate, read,
          },
        }) => {
          if (notify) {
            setCharacteristicsId(this._notifyIds, uuid);
          } else if (write) {
            setCharacteristicsId(this._writeIds, uuid);
          } else if (indicate) {
            setCharacteristicsId(this._indicateIds, uuid);
          } else if (read) {
            setCharacteristicsId(this._readIds, uuid);
          }
        });

        const notifyId = this._getNotifyId();

        if (!notifyId) {
          console.warn('该设备不支持 notify');
        } else {
          await this._bluetoothApi.notifyBLECharacteristicValueChange({
            deviceId: this._deviceId,
            characteristicId: notifyId,
            serviceId: this.serviceId,
            state: true,
          });
          console.log('notifyBLECharacteristicValueChange succ');
        }
      }
    } catch (err) {
      console.error('connectDevice error', err);
      throw this._normalizeError(err);
    }
  }

  async write(data, writeId = '') {
    if (typeof data === 'string') {
      console.log('writeBLECharacteristicValue', data);
      data = hexToArrayBuffer(data);
    } else if (data instanceof ArrayBuffer) {
      try {
        console.log('writeBLECharacteristicValue', arrayBufferToHexStringArray(data).join(''));
      } catch (err) {
      }
    }

    return this._write(data, writeId);
  }

  async _write(value, writeId = '') {
    try {
      await this._bluetoothApi.writeBLECharacteristicValue({
        deviceId: this._deviceId,
        characteristicId: writeId || this._writeIds[0],
        serviceId: this.serviceId,
        value: value,
      });
    } catch (err) {
      return Promise.reject(this._normalizeError(err));
    }
  }
}
