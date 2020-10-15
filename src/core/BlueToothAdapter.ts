import EventEmitter from "event-emitter-for-miniprogram";
import { arrayBufferToHexStringArray, isEmpty, noop } from '../libs/utillib';
import { BlueToothBase } from './BlueToothBase';
import { DeviceAdapter, BlueToothDeviceInfo } from './DeviceAdapter';
import nativeBluetoothApi from './nativeBluetoothApi';
import { throttle } from '../libs/throttle';

// 交由外部实现如下action，核心代码不关注其各端差异
export interface BlueToothActions {
  initProductIds?: () => Promise<{ [propKey: string]: string; }>;
  registerDevice: ({
    deviceId,
    deviceName,
    productId,
  }: {
    deviceId?: string;
    deviceName?: string;
    productId?: string;
  }) => Promise<any>;
  // familyId 和 roomId 不一定会传，外面需要处理默认取当前家庭及房间
  bindDevice: (params: {
    deviceId?: string;
    deviceName?: string;
    productId?: string;
    familyId?: string;
    roomId?: string;
  }) => Promise<any>;
  reportDeviceData: (params: {
    deviceId?: string;
    deviceName?: string;
    productId?: string;
    data: any;
    timestamp: number;
  }) => Promise<any>;
}

export interface H5Websocket extends EventEmitter {
  requestHandlerMap: Map<string, (any) => any>;
  options: {
    url: string;
  };
  _manuallyClose: boolean;
  _connected: boolean;
  isConnected: () => boolean;
  doConnectWs: () => Promise<any>;
  connect: () => Promise<any>;
  disconnect: (manually: boolean) => any;
  send: (action: string, data: any, options?: { reqId?: string }) => Promise<any>;
  activeConnect: () => Promise<any>;
}

export interface BlueToothAdapterProps {
  deviceAdapters?: (typeof DeviceAdapter)[];
  actions?: BlueToothActions;
  bluetoothApi?: any;
  h5Websocket?: H5Websocket;
  devMode?: (() => boolean) | boolean;
}

export interface SearchDeviceBaseParams {
  serviceId?: string;
  serviceIds?: string[];
  ignoreDeviceIds?: string[];
  ignoreServiceIds?: string[];
  timeout?: number;
  extendInfo?: any;
}

export interface StartSearchParams extends SearchDeviceBaseParams {
  onSearch?: (devices: BlueToothDeviceInfo[]) => any;
  onError?: (error: Error | object | string) => any;
}

export interface SearchDeviceParams extends SearchDeviceBaseParams {
  deviceName?: string;
  productId?: string;
}

/**
 * 1. 负责初始化蓝牙模块
 * 2. 负责搜索设备
 */
export class BlueToothAdapter extends BlueToothBase {
  constructor({
    deviceAdapters = [],
    actions,
    bluetoothApi,
    h5Websocket,
    devMode,
  }: BlueToothAdapterProps) {
    super();

    this._devMode = devMode;

    this.addAdapter(deviceAdapters);

    if (isEmpty(this._deviceAdapterMap)) {
      console.warn('无合法的deviceAdapter');
    }

    this._h5Websocket = h5Websocket;
    this._bluetoothApi = bluetoothApi || nativeBluetoothApi;
    this._actions = actions;
  }

  _devMode: (() => boolean) | boolean = false;

  get devMode() {
    if (typeof this._devMode === 'function') return this._devMode();

    return this._devMode
  }

  _h5Websocket;
  _bluetoothApi: any = {};

  // @ts-ignore
  _actions: BlueToothActions = {};

  // serviceId => DeviceAdapter
  _deviceAdapterMap = {};

  // serviceId => productId
  _productIdMap: { [serviceId: string]: string } = {};

  // deviceId => deviceAdapter
  _deviceMap = {};

  _inited = false;

  _available = false;

  _discovering = false;

  _onBluetoothDeviceFoundHandler = null;

  _initPromise = null;

  _searchDevicePromise = null;

  addAdapter(deviceAdapter) {
    const doAdd = (adapter) => {
      if (!Object.prototype.isPrototypeOf.call(DeviceAdapter, adapter)) {
        console.error('非法的设备适配器', adapter);
      } else if (!adapter.serviceId) {
        console.error('非法的设备适配器，未配置serviceId', adapter);
      } else {
        this._deviceAdapterMap[adapter.serviceId] = adapter;
      }
    };

    if (deviceAdapter && deviceAdapter.splice) {
      deviceAdapter.forEach(doAdd);
    } else {
      doAdd(deviceAdapter);
    }
  }

  _filterDevices({
    devices = [],
    serviceIds,
    deviceName,
    productId,
    ignoreDeviceIds = [],
    ignoreServiceIds = [],
    extendInfo = {},
  }: {
    devices: WechatMiniprogram.BlueToothDevice[];
    serviceIds?: string[];
    deviceName?: string;
    productId?: string;
    ignoreDeviceIds?: string[];
    ignoreServiceIds?: string[];
    extendInfo?: any;
  }): BlueToothDeviceInfo[] {
    if (!serviceIds || !serviceIds.length) {
      serviceIds = this._getSupportServiceIds();
    }

    const ignoreAdapterMap = {};

    if (ignoreServiceIds && ignoreServiceIds.length) {
      ignoreServiceIds.forEach(serviceId => ignoreAdapterMap[serviceId] = true);

      serviceIds = serviceIds.filter(serviceId => !ignoreAdapterMap[serviceId]);
    }

    console.log('support serviceIds', serviceIds);

    const results = [];

    const deviceFilters = serviceIds.map(id => this._deviceAdapterMap[id].deviceFilter);

    for (let i = 0, l = devices.length; i < l; i++) {
      if (ignoreDeviceIds.find(deviceId => devices[i].deviceId === deviceId)) {
        return;
      }

      let matchedDevice;

      for (let j = 0, lenJ = deviceFilters.length; j < lenJ; j++) {
        matchedDevice = deviceFilters[j](devices[i], {
          serviceIds,
          deviceName,
          productId,
          ignoreDeviceIds,
          ignoreServiceIds,
          extendInfo,
        });

        if (deviceName) {
          if (matchedDevice && matchedDevice.deviceName === deviceName) {
            return [matchedDevice];
          }
        } else {
          if (matchedDevice) {
            results.push(matchedDevice);
            break;
          }
        }
      }
    }

    return results;
  }

  _getSupportServiceIds() {
    return Object.keys(this._deviceAdapterMap);
  }

  startBluetoothDevicesDiscovery() {
    return this._bluetoothApi.startBluetoothDevicesDiscovery();
  }

  /**
   * 1. 本地决定stop，看h5是否在搜，如果在搜则忽略
   * 2. h5决定stop，看本地是否在搜，如果在搜则忽略
   */
  stopBluetoothDevicesDiscovery(isFromH5 = false) {
    return this._bluetoothApi.stopBluetoothDevicesDiscovery();
  }

  cleanup(action?: string) {
    super.cleanup(action);

    if (!action) {
      console.log('cleanup bluetooth adapter');
      if (this._discovering) {
        this.stopBluetoothDevicesDiscovery();
      }

      this._bluetoothApi.closeBluetoothAdapter();

      console.log('manually disconnect all device', this._deviceMap);

      Object.keys(this._deviceMap).forEach((deviceId) => {
        if (this._deviceMap[deviceId]) {
          this._deviceMap[deviceId].disconnectDevice();
        }
      });
    }
  }

  /**
   * 1. wx.openBluetoothAdapter
   * 2.
   * @returns {Promise<void>}
   */
  async init() {
    return (this._initPromise || (this._initPromise = (new Promise(async (resolve, reject) => {
      try {
        if (this._inited) {
          if (this._available) {
            this._initPromise = null;
            return resolve();
          } else {
            // 当前不可用
            throw { errCode: 10001 };
          }
        }

        await this.initProductIds();

        const handleBlueToothAdapterState = ({ available, discovering }) => {
          console.log('onBluetoothAdapterStateChange', { available, discovering });

          this._available = available;
          this._discovering = discovering;
          this.emit('adapterStateChange', { available, discovering });
          if (available) {
            this._inited = true;
            resolve();
            this._initPromise = null;
          } else {
            this.cleanup();
          }
        };

        const handleBleConnectionStateChange = params => this.onBleConnectionStateChange(params);
        const handleBLECharacteristicValueChange = params => this.onBLECharacteristicValueChange(params);
        // @ts-ignore
        const handleBlueToothDeviceFound = throttle(1000, params => this.onBluetoothDeviceFound(params));

        this._bluetoothApi.onBluetoothAdapterStateChange(handleBlueToothAdapterState);
        this._bluetoothApi.onBLEConnectionStateChange(handleBleConnectionStateChange);
        this._bluetoothApi.onBLECharacteristicValueChange(handleBLECharacteristicValueChange);
        this._bluetoothApi.onBluetoothDeviceFound(handleBlueToothDeviceFound);

        this.addCleanupTask('init', () => {
          this._available = this._discovering = this._inited = false;
          this._initPromise = null;
          this._bluetoothApi.offBluetoothAdapterStateChange(handleBlueToothAdapterState);
          this._bluetoothApi.offBLEConnectionStateChange(handleBleConnectionStateChange);
          this._bluetoothApi.offBLECharacteristicValueChange(handleBLECharacteristicValueChange);
          this._bluetoothApi.offBluetoothDeviceFound(handleBlueToothDeviceFound);
          this._bluetoothApi.closeBluetoothAdapter();
        });

        await this._bluetoothApi.openBluetoothAdapter();

        handleBlueToothAdapterState(await this._bluetoothApi.getBluetoothAdapterState());
      } catch (err) {
        this._available = false;
        this._inited = false;
        this._initPromise = null;
        reject(this._normalizeError(err));
      }
    }))));
  }

  async initProductIds() {
    // 不是所有端都需要初始化 productId，比如h5和插件侧
    if (typeof this._actions.initProductIds === 'function') {
      this._productIdMap = await this._actions.initProductIds();
    }
  }

  onBleConnectionStateChange({ deviceId, connected }) {
    console.log('onBLEConnectionStateChange', deviceId, connected);

    const deviceAdapter = this.getDeviceAdapter(deviceId);

    if (!deviceAdapter) {
      console.warn('on bLEConnectionStateChange, but no adapter');
      return;
    }

    deviceAdapter.onBleConnectionStateChange({ connected });
  }

  onBLECharacteristicValueChange({
    deviceId, serviceId, characteristicId, value,
  }) {
    console.log('onBLECharacteristicValueChange', deviceId, serviceId, characteristicId, value);

    const deviceAdapter = this._deviceMap[deviceId];

    if (!deviceAdapter) {
      console.warn('on onBLECharacteristicValueChange, but no adapter');
      return;
    }

    return deviceAdapter.onBLECharacteristicValueChange({
      serviceId, characteristicId, value,
    });
  }

  async getBluetoothDevices() {
    const { devices } = await this._bluetoothApi.getBluetoothDevices();

    return devices.filter(item => item.name !== '未知设备');
  }

  async onBluetoothDeviceFound() {
    const devices = await this.getBluetoothDevices();

    try {
      if (typeof this._onBluetoothDeviceFoundHandler === 'function') {
        this._onBluetoothDeviceFoundHandler(devices);
      }
    } catch (err) {
      console.error('_onBluetoothDeviceFoundHandler error', err);
    }

    return devices;
  }

  /**
   * 记得必须要调 stopSearch
   */
  async startSearch({
    serviceId,
    serviceIds,
    ignoreDeviceIds = [],
    ignoreServiceIds = [],
    onSearch = noop,
    onError = noop,
    timeout = 20 * 1000,
    extendInfo = {},
  }: StartSearchParams): Promise<any> {
    if (serviceId && !serviceIds) {
      serviceIds = [serviceId];
    }

    let _deviceFindedLength = 0;

    const _onError = (error) => {
      this.stopSearch();
      onError(error);
    };

    try {
      await this.startBluetoothDevicesDiscovery();

      this._onBluetoothDeviceFoundHandler = (devices) => {
        try {
          const matchedDevices = this._filterDevices({
            devices,
            serviceIds,
            ignoreDeviceIds,
            ignoreServiceIds,
            extendInfo,
          });

          _deviceFindedLength = matchedDevices.length;

          onSearch(matchedDevices);
        } catch (err) {
          console.log('onSearch error', err);
          _onError(this._normalizeError(err));
        }
      };

      this.onBluetoothDeviceFound();

      const onAdapterStateChange = ({ available }) => {
        if (!available) {
          _onError(this._normalizeError({ errCode: 10001 }));
        }
      };

      this.on('adapterStateChange', onAdapterStateChange);

      this.addCleanupTask('startSearch', () => {
        this._onBluetoothDeviceFoundHandler = null;
        this.off('adapterStateChange', onAdapterStateChange);
      });

      setTimeout(() => {
        if (!_deviceFindedLength) {
          _onError('未发现设备，请确认设备已开启');
        }
      }, timeout);
    } catch (err) {
      this.cleanup('startSearch');
      throw this._normalizeError(err);
    }
  }

  stopSearch() {
    this.cleanup('startSearch');
    this.stopBluetoothDevicesDiscovery();
  }

  /**
   * 目前的交互只支持展示一台待连接设备，所以搜到第一台设备后就停止
   */
  searchDevice({
    serviceId,
    serviceIds,
    deviceName,
    productId,
    ignoreDeviceIds = [],
    timeout = 5 * 1000,
    extendInfo = {},
  }: SearchDeviceParams): Promise<BlueToothDeviceInfo> {
    if (serviceId && !serviceIds) {
      serviceIds = [serviceId];
    }

    console.log('searching for explorerDeviceId => ', deviceName);

    return (this._searchDevicePromise || (this._searchDevicePromise = new Promise(async (resolve, reject) => {
      const onReject = (err) => {
        this.stopBluetoothDevicesDiscovery();
        reject(this._normalizeError(err));
        this._searchDevicePromise = null;
      };

      const onResolve = (device) => {
        this.stopBluetoothDevicesDiscovery();
        resolve(device);
        this._searchDevicePromise = null;
      };

      this._onBluetoothDeviceFoundHandler = (devices) => {
        try {
          const matchedDevices = this._filterDevices({
            devices,
            serviceIds,
            deviceName,
            productId,
            ignoreDeviceIds,
            extendInfo,
          });

          console.log('matchedDevices: ', matchedDevices);

          if (matchedDevices.length > 0) {
            console.log('doFindDevice', matchedDevices[0]);
            onResolve(matchedDevices[0]);
          }
        } catch (err) {
          onReject(err);
        }
      };

      try {
        await this.startBluetoothDevicesDiscovery();

        console.log('startBluetoothDevicesDiscovery succ');

        this.onBluetoothDeviceFound();

        setTimeout(() => {
          onResolve(null);
        }, timeout);
      } catch (err) {
        onReject(err);
      }
    })));
  }

  getDeviceAdapter(deviceId) {
    return this._deviceMap[deviceId];
  }

  async connectDevice({
    deviceId,
    serviceId,
    mac,
    deviceName,
    name,
    productId,
  }: {
    deviceId: string;
    serviceId: string;
    mac?: string;
    deviceName: string;
    name: string;
    productId?: string;
  }, {
    autoNotify
  }: {
    autoNotify?: boolean;
  } = {}) {
    if (mac) {
      console.warn('[DEPRECATED] mac is deprecated, please use deviceName instead.');
    }

    deviceName = deviceName || mac;

    try {
      const DeviceAdapter = this._deviceAdapterMap[serviceId];

      if (!DeviceAdapter) {
        throw `无匹配serviceId为${serviceId}的 deviceAdapter`;
      }

      if (this._deviceMap[deviceId] && this._deviceMap[deviceId].isConnected) {
        console.log('find device adapter', this._deviceMap[deviceId]);
        return this._deviceMap[deviceId];
      }

      // 必须在这里挂载实例，因为连接设备时触发的一些回调是从 this._deviceMap 上去找 deviceAdapter 触发的
      const deviceAdapter = this._deviceMap[deviceId] = new DeviceAdapter({
        deviceId,
        deviceName,
        // 标准蓝牙协议在设备里面是有productId写入的
        productId: productId || this._productIdMap[serviceId],
        name,
        actions: this._actions,
        bluetoothApi: this._bluetoothApi,
      });

      await deviceAdapter.connectDevice({ autoNotify });

      console.log('deviceConnected');

      // 走到这里说明连接成功了

      // TODO: 是否可以优化，不销毁实例？就不需要重新读deviceName了
      deviceAdapter
        .on('disconnect', () => {
          console.log('ondisconnect, cleanup adapter', deviceAdapter);
          delete this._deviceMap[deviceId];
        });

      console.log('return adapter');

      return deviceAdapter;
    } catch (err) {
      delete this._deviceMap[deviceId];
      return Promise.reject(err);
    }
  }
}
