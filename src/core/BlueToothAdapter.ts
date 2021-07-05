import EventEmitter from "event-emitter-for-miniprogram";
import { arrayBufferToHexStringArray, isEmpty, noop } from '../libs/utillib';
import { BlueToothBase } from './BlueToothBase';
import { DeviceAdapter, BlueToothDeviceInfo } from './DeviceAdapter';
import nativeBluetoothApi from './nativeBluetoothApi';
import { throttle } from '../libs/throttle';
import { BluetoothDeviceCacheManager } from "./BluetoothDeviceCacheManager";
import { SimpleStore } from "../libs/SimpleStore";

type DeviceAdapterFactory = typeof DeviceAdapter;

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
  DeviceAdapter?: DeviceAdapterFactory;
}

export interface StartSearchParams extends SearchDeviceBaseParams {
  onSearch?: (devices: BlueToothDeviceInfo[]) => any;
  onError?: (error: Error | object | string) => any;
}

export interface SearchDeviceParams extends SearchDeviceBaseParams {
  deviceName?: string;
  productId?: string;
  ignoreWarning?: boolean;
  ignoreCache?: boolean; // alias for disableCache
  disableCache?: boolean;
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

    if (isEmpty(this._deviceAdapterFactoryMap)) {
      console.warn('无合法的deviceAdapter');
    }

    this._h5Websocket = h5Websocket;
    this._bluetoothApi = bluetoothApi || nativeBluetoothApi;
    this._actions = actions;
    this.deviceCacheManager = new BluetoothDeviceCacheManager();
  }

  deviceCacheManager: BluetoothDeviceCacheManager;
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
  _deviceAdapterFactoryMap = {};

  // serviceId => productId
  _productIdMap: { [serviceId: string]: string } = {};

  _inited = false;

  _available = false;

  _discovering = false;

  _onBluetoothDeviceFoundHandler = null;

  _initPromise = null;

  _searchDevicePromise = null;

  _deviceAdapterStore = new SimpleStore<DeviceAdapter>({
    filter: params =>
      item => {
        return item.deviceId === params.deviceId || item.explorerDeviceId === params.explorerDeviceId;
      },
  })

  // 这里除了要维护本地内存 deviceAdapter 上的状态，还要维护 h5 过来的状态，所以单独维护
  _deviceConnectStatusStore = new SimpleStore<{
    connected: boolean;
    explorerDeviceId: string;
    deviceId: string;
  }>({
    filter: params => item => item.deviceId === params.deviceId || item.explorerDeviceId === params.explorerDeviceId,
  });

  addAdapter(deviceAdapter) {
    const doAdd = (adapter) => {
      if (!Object.prototype.isPrototypeOf.call(DeviceAdapter, adapter)) {
        console.error('非法的设备适配器', adapter);
      } else if (!adapter.serviceId) {
        console.error('非法的设备适配器，未配置serviceId', adapter);
      } else {
        this._deviceAdapterFactoryMap[adapter.serviceId] = adapter;
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
    deviceName = '',
    productId,
    ignoreDeviceIds = [],
    ignoreServiceIds = [],
    extendInfo = {},
    DeviceAdapter,
  }: {
    devices: WechatMiniprogram.BlueToothDevice[];
    serviceIds?: string[];
    deviceName?: string;
    productId?: string;
    ignoreDeviceIds?: string[];
    ignoreServiceIds?: string[];
    extendInfo?: any;
    DeviceAdapter?: DeviceAdapterFactory;
  }): BlueToothDeviceInfo[] {
    let deviceFilters;

    if (DeviceAdapter) {
      serviceIds = [DeviceAdapter.serviceId];
      deviceFilters = [DeviceAdapter.deviceFilter];

      console.log('specific serviceId: ', serviceIds);
    } else {
      if (!serviceIds || !serviceIds.length) {
        serviceIds = this._getSupportServiceIds();
      }

      const ignoreAdapterMap = {};

      if (ignoreServiceIds && ignoreServiceIds.length) {
        ignoreServiceIds.forEach(serviceId => ignoreAdapterMap[serviceId] = true);

        serviceIds = serviceIds.filter(serviceId => !ignoreAdapterMap[serviceId]);
      }

      deviceFilters = serviceIds.map(id => this._deviceAdapterFactoryMap[id].deviceFilter);

      console.log('support serviceIds', serviceIds);
    }

    const results = [];

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
    return Object.keys(this._deviceAdapterFactoryMap);
  }

  // 所有设备连接状态变更统一在这里处理
  // 包括h5同步过来的状态，以及 adapter 接收到的设备状态变化
  onDeviceConnectStatusChange({
    connected,
    explorerDeviceId,
    deviceId,
  }) {
    console.log('onDeviceConnectStatusChange', {
      connected,
      explorerDeviceId,
      deviceId,
    });
    const target = this._deviceConnectStatusStore.get({
      connected,
      explorerDeviceId,
    });

    if (target) {
      if (target.connected !== connected) {
        console.log('device connect status did change', {
          connected,
          explorerDeviceId,
          deviceId,
        });
        target.connected = connected;
        this.emit('onDeviceConnectStatusChange', {
          connected,
          explorerDeviceId,
          deviceId,
        });
      }
    } else {
      this._deviceConnectStatusStore.set({ connected, explorerDeviceId, deviceId });
      console.log('new device connected', this._deviceConnectStatusStore.getAll());
      this.emit('onDeviceConnectStatusChange', {
        connected,
        explorerDeviceId,
        deviceId,
      });
    }
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

      console.log('manually disconnect all device', this._deviceAdapterStore.getAll());

      this._deviceAdapterStore.getAll().forEach((deviceAdapter) => {
        if (deviceAdapter.isConnected) {
          deviceAdapter.disconnectDevice();
        }
      });

      // Object.keys(this._deviceMap).forEach((deviceId) => {
      //   if (this._deviceMap[deviceId]) {
      //     this._deviceMap[deviceId].disconnectDevice();
      //   }
      // });

      // cleanup后清理所有 deviceAdapter
      // this._deviceAdapterList = [];
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

        await Promise.all([
          this.deviceCacheManager.init(),
          this.initProductIds(),
        ]);

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

    const deviceAdapter = this.getDeviceAdapter({ deviceId });

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

    return devices;
  }

  async onBluetoothDeviceFound() {
    const devices = await this.getBluetoothDevices();

    try {
      console.log('onBluetoothDeviceFound', devices);

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
    DeviceAdapter,
  }: StartSearchParams): Promise<any> {
    await this.init();

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
            DeviceAdapter,
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
  async searchDevice({
    serviceId,
    serviceIds,
    deviceName,
    productId,
    ignoreDeviceIds = [],
    timeout = 5 * 1000,
    extendInfo = {},
    ignoreWarning = false,
    ignoreCache,
    disableCache,
    DeviceAdapter, // 指定adapter，会自动忽略已经注入的adapter
  }: SearchDeviceParams): Promise<BlueToothDeviceInfo> {
    if (!ignoreWarning) {
      console.warn('[DEPRECATED] searchDevice + connectDevice 的方式连接设备已废弃，请直接使用 searchAndConnectDevice 方法，会自动处理连接缓存已经失效重搜等逻辑。');
    }

    if (typeof disableCache === 'undefined' && typeof ignoreCache !== 'undefined') {
      disableCache = ignoreCache;
    }

    await this.init();

    if (serviceId && !serviceIds) {
      serviceIds = [serviceId];
    }

    console.log('searching for explorerDeviceId => ', deviceName);

    if (!disableCache) {
      const deviceCache = this.deviceCacheManager.getDeviceCache(deviceName);

      if (deviceCache) {
        console.log(`find ble deviceInfo for ${deviceName}`, {
          deviceName,
          productId,
          ...deviceCache,
        });

        return Promise.resolve({
          deviceName,
          productId,
          ...deviceCache,
        } as any);
      }
    }

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
            DeviceAdapter,
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

  getDeviceAdapter(params: string | { deviceId?: string; explorerDeviceId?: string }) {
    let deviceId: string;
    let explorerDeviceId: string;

    if (!params) throw '非法的参数，请传入 { deviceId?: string; explorerDeviceId?: string }';

    if (typeof params === 'string') {
      deviceId = params;
    } else {
      deviceId = params.deviceId;
      explorerDeviceId = params.explorerDeviceId;
    }

    return this._deviceAdapterStore.get({ deviceId, explorerDeviceId });
  }

  async connectDevice({
    deviceId,
    serviceId,
    mac,
    deviceName,
    name,
    productId,
    extendInfo,
  }: {
    deviceId: string;
    serviceId: string;
    mac?: string;
    deviceName: string;
    name: string;
    productId?: string;
    extendInfo?: any;
  }, {
    DeviceAdapter: SpecificDeviceAdapter,
    autoNotify,
    enableDeviceCache = true,
    destroyAdapterAfterDisconnect,
    disableCache,
  }: {
    DeviceAdapter?: DeviceAdapterFactory;
    autoNotify?: boolean;
    enableDeviceCache?: boolean;
    disableCache?: boolean;
    destroyAdapterAfterDisconnect?: boolean;
  } = {}) {
    if (typeof disableCache === 'undefined' && typeof enableDeviceCache !== 'undefined') {
      disableCache = !enableDeviceCache;
    }

    await this.init();

    if (mac) {
      console.warn('[DEPRECATED] mac is deprecated, please use deviceName instead.');
    }

    if (typeof destroyAdapterAfterDisconnect !== 'undefined') {
      console.warn('[DEPRECATED] destroyAdapterAfterDisconnect 参数已废弃，默认 deviceAdapter 创建后不会被销毁，如需手动销毁请调用 deviceAdapter.destroy()');
    }

    deviceName = deviceName || mac;
    productId = productId || this._productIdMap[serviceId];

    try {
      let DeviceAdapter: DeviceAdapterFactory;

      if (SpecificDeviceAdapter) {
        if (SpecificDeviceAdapter.serviceId !== serviceId) {
          throw `指定的DeviceAdapter serviceId 不匹配，${SpecificDeviceAdapter.serviceId} !== ${serviceId}`;
        }

        DeviceAdapter = SpecificDeviceAdapter;
      } else {
        DeviceAdapter = this._deviceAdapterFactoryMap[serviceId];

        if (!DeviceAdapter) {
          throw `无匹配serviceId为${serviceId}的 deviceAdapter`;
        }
      }

      let deviceAdapter;

      if (!disableCache) {
        if (deviceId || (productId && deviceName)) {
          deviceAdapter = this.getDeviceAdapter({
            deviceId,
            explorerDeviceId: `${productId}/${deviceName}`,
          });
        }

        if (deviceAdapter && deviceAdapter.isConnected) {
          console.log('device already connected, returning adapter', deviceAdapter);
          return deviceAdapter;
        }
      }

      if (!deviceAdapter) {
        // 必须在这里挂载实例，因为连接设备时触发的一些回调是从 this._deviceMap 上去找 deviceAdapter 触发的
        deviceAdapter = new DeviceAdapter({
          deviceId,
          deviceName,
          // 标准蓝牙协议在设备里面是有productId写入的
          productId,
          name,
          actions: this._actions,
          bluetoothApi: this._bluetoothApi,
          h5Websocket: this._h5Websocket,
          extendInfo,
          bluetoothAdapter: this,
        });

        this._deviceAdapterStore.set(deviceAdapter);

        deviceAdapter
          .on('connect', () => {
            deviceAdapter._deviceConnected = true;
            this.onDeviceConnectStatusChange({
              explorerDeviceId: deviceAdapter.explorerDeviceId,
              connected: true,
              deviceId,
            });
          })
          .on('disconnect', () => {
            deviceAdapter._deviceConnected = false;
            this.onDeviceConnectStatusChange({
              explorerDeviceId: deviceAdapter.explorerDeviceId,
              connected: false,
              deviceId,
            });
          })
          .on('destroy', () => {
            console.log('destroy adapter', deviceAdapter);

            this._deviceAdapterStore.remove({ deviceId });
          });
      }

      await deviceAdapter.connectDevice({ autoNotify });

      // 标准蓝牙可能不会返回 deviceName
      if (!disableCache && deviceName) {
        // 风险点：deviceName冲突？
        this.deviceCacheManager.setDeviceCache(deviceName, {
          deviceId,
          serviceId,
          name,
          productId,
        });
      }

      // 走到这里说明连接成功了
      console.log('deviceConnected');

      return deviceAdapter;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async searchAndConnectDevice({
    serviceId,
    serviceIds,
    deviceName,
    productId,
    ignoreDeviceIds = [],
    timeout = 5 * 1000,
    extendInfo = {},
  }: SearchDeviceParams, {
    autoNotify,
    disableCache = false,
    DeviceAdapter,
  }: {
    disableCache?: boolean;
    autoNotify?: boolean;
    DeviceAdapter?: DeviceAdapterFactory;
  } = {}) {
    try {
      let deviceAdapter;

      if (!disableCache && productId && deviceName) {
        deviceAdapter = this._deviceAdapterStore.get({
          explorerDeviceId: `${productId}/${deviceName}`,
        });
      }

      if (deviceAdapter) {
        console.log('find deviceAdapter in cache, explorerDeviceId: ', `${productId}/${deviceName}`, deviceAdapter);

        if (!deviceAdapter.isConnected) {
          await deviceAdapter.connectDevice({ autoNotify });
        }

        return deviceAdapter;
      } else {
        let deviceInfo = await this.searchDevice({
          serviceId,
          serviceIds,
          deviceName,
          productId,
          ignoreDeviceIds,
          timeout,
          extendInfo,
          ignoreWarning: true,
          disableCache,
          DeviceAdapter,
        });

        if (!deviceInfo) {
          return Promise.reject({ code: 'DeviceNotFound' });
        }

        if (!deviceInfo.productId && productId) {
          deviceInfo.productId = productId;
        }

        console.log('deviceInfo', deviceInfo, productId);
        deviceAdapter = await this.connectDevice(deviceInfo, {
          autoNotify,
          disableCache,
          DeviceAdapter,
        });

        return deviceAdapter;
      }
    } catch (err) {
      console.error('searchAndConnectDevice error', err);
      return Promise.reject(err);
    }
  }
}
