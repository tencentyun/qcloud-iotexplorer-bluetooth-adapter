import { BlueToothAdapter, BlueToothAdapterProps, SearchDeviceParams, StartSearchParams } from "../core";
import EventEmitter from "../libs/event-emmiter";
import { arrayBufferToHexStringArray, hexToArrayBuffer, isEmpty } from "../libs/utillib";

export interface BlueToothAdapter4MpProps extends BlueToothAdapterProps {
  h5Websocket?: EventEmitter;
  devMode?: boolean;
}

const parseAdvertisData = (device) => {
  const result = { ...device };

  if (result.advertisData) {
    try {
      result.advertisData = arrayBufferToHexStringArray(result.advertisData);
    } catch (err) {
      console.error('Parse bluetoothe device advertisData fail', err);
    }
  }

  return result;
};

/**
 * 小程序版本在核心上拓展了：
 * 1. h5 channel 的注册和处理
 * 2. 某些api需要将响应上报h5 channel
 * 3. 需要 cleanup
 */
export class BlueToothAdapter4Mp extends BlueToothAdapter {
  _h5ChanelOpened = false;

  // 当前本地是否正在使用搜索
  _localDiscoveringInUse = false;

  // 当前h5是否正在使用搜索
  _h5DiscoveringInUse = false;

  _h5Websocket = null;

  _cleanupTimer = null;

  _currentProductId = '';

  constructor({
    h5Websocket,
    devMode,
    ...props
  }: BlueToothAdapter4MpProps) {
    super(props);

    if (h5Websocket && typeof h5Websocket.on === 'function') {
      this._h5Websocket = h5Websocket;

      this.on('adapterStateChange', ({ available, discovering }) => {
        this.response2BlueToothChanel('onBluetoothAdapterStateChange', { available, discovering });
      })

      h5Websocket
        .on('message', async ({ data, reqId }) => {
          console.log('bluetooth ws on message', data);

          const { action, payload } = data;

          switch (action) {
            case 'bindDevice': {
              try {
                // 为了适配调试模式，支持传productId
                const { deviceName, productId } = payload;

                await this._actions.bindDevice({
                  deviceId: `${devMode && productId ? productId : this._currentProductId}/${deviceName}`,
                });

                this.response2BlueToothChanel('response', { code: 0 }, reqId);
              } catch (err) {
                this.response2BlueToothChanel('response', err, reqId);
              }
              break;
            }
            case 'registryDevice': {
              try {
                // 为了适配调试模式，支持传productId
                const { deviceName, productId } = payload;

                await this._actions.registerDevice({
                  // 只有调试模式下，传了productId使用指定productId，否则都用当前打开的产品id
                  deviceId: `${devMode && productId ? productId : this._currentProductId}/${deviceName}`,
                });
                this.response2BlueToothChanel('response', { code: 0 }, reqId);
              } catch (err) {
                this.response2BlueToothChanel('response', err, reqId);
              }
              break;
            }
            case 'connect': // 启用h5通道
              console.log('h5chanel opened');
              this._h5ChanelOpened = true;
              break;
            case 'disconnect': // 断开h5通道
              console.log('h5chanel closed');
              this._h5ChanelOpened = false;

              // 如果h5断开且h5正在搜索，则主动停止搜索
              if (this._h5DiscoveringInUse) {
                this.stopBluetoothDevicesDiscovery(true);
              }

              break;
            case 'init': {
              try {
                await this.init();
                this.response2BlueToothChanel('response', { code: 0 }, reqId);
              } catch (err) {
                this.response2BlueToothChanel('response', err, reqId);
              }
              break;
            }
            case 'callApi': {
              const { api, params } = payload;

              try {
                console.log('call api', api, params);

                // 先处理需要特殊处理的api
                switch (api) {
                  case 'getBluetoothDevices': {
                    const devices = await this.getBluetoothDevices();

                    this.response2BlueToothChanel('response', {
                      devices: devices.map(parseAdvertisData),
                    }, reqId);

                    return;
                  }
                  case 'writeBLECharacteristicValue': {
                    const { value } = params;

                    console.log('calling writeBLECharacteristicValue', {
                      ...params,
                      value: hexToArrayBuffer(value),
                    });

                    const resp = await this._bluetoothApi.writeBLECharacteristicValue({
                      ...params,
                      value: hexToArrayBuffer(value),
                    });

                    this.response2BlueToothChanel('response', resp, reqId);

                    return;
                  }
                  case 'startBluetoothDevicesDiscovery': {
                    const resp = await this.startBluetoothDevicesDiscovery(true);

                    this.response2BlueToothChanel('response', resp, reqId);

                    return;
                  }
                  // h5离线时，判断是否在搜索，如果是的话停止搜索
                  case 'stopBluetoothDevicesDiscovery': {
                    const resp = await this.stopBluetoothDevicesDiscovery(true);

                    this.response2BlueToothChanel('response', resp, reqId);

                    return;
                  }
                }
              } catch (err) {
                console.log('call api fail', err);
                this.response2BlueToothChanel('response', this._normalizeError(err), reqId);
              }

              if (wx[api]) {
                wx[api]({
                  ...params,
                  success: (resp) => {
                    console.log('call api success', resp);
                    this.response2BlueToothChanel('response', resp, reqId);
                  },
                  fail: (error) => {
                    console.log('call api fail', error);
                    this.response2BlueToothChanel('response', this._normalizeError(error), reqId);
                  },
                });
              }
              break;
            }
          }
        });
    }
  }

  // 每次打开蓝牙h5需要记录当前productId（这样会导致同时只能打开一个蓝牙h5）
  setCurrentProduct(productId) {
    this._currentProductId = productId;
  }

  startBluetoothDevicesDiscovery(isFromH5 = false) {
    if (isFromH5) {
      this._h5DiscoveringInUse = true;
    } else {
      this._localDiscoveringInUse = true;
    }

    return super.startBluetoothDevicesDiscovery();
  }

  /**
   * 1. 本地决定stop，看h5是否在搜，如果在搜则忽略
   * 2. h5决定stop，看本地是否在搜，如果在搜则忽略
   */
  stopBluetoothDevicesDiscovery(isFromH5 = false) {
    console.log(`try call stopBluetoothDevicesDiscovery, isFromH5: ${isFromH5}, _h5DiscoveringInUse: ${this._h5DiscoveringInUse}, _localDiscoveringInUse: ${this._localDiscoveringInUse}`);

    if (isFromH5) {
      this._h5DiscoveringInUse = false;
    } else {
      this._localDiscoveringInUse = false;
    }

    if (!this._h5DiscoveringInUse && this._localDiscoveringInUse) return;

    return super.stopBluetoothDevicesDiscovery();
  }

  async response2BlueToothChanel(action, payload = {}, reqId = '') {
    try {
      if (!this._h5ChanelOpened) {
        console.log('h5 chanel not opened');
        return;
      }

      console.log('response2BlueToothChanel', action, payload);

      await this._h5Websocket.send('Response', {
        action, payload,
      }, { reqId });
    } catch (err) {
      console.warn('try send bluetooth message fail', err);
    }
  }

  /**
   * 启用清理器
   * 每一段时间检查一次，若不在搜索状态、且当前连接设备数为0，则cleanup
   *
   * 每次 init, startSearch, searchDevice, connectDevice 都会重置清理器
   *
   * 测试用例：
   * timeout设10秒
   * 1. 搜索中，清理器不会触发，一直重置
   * 2. 退出搜索，无设备连接，10秒后清理器触发，移开设备，再次进入搜索页面，无法搜到该设备
   * 3. 单连设备，进入搜索，退出搜索，10秒后不会触发清理器，断开设备，再过10秒，清理器触发
   */
  startCleanupTimer() {
    clearTimeout(this._cleanupTimer);

    console.log('start cleanup timer');

    this._cleanupTimer = setTimeout(() => {
      console.log('bluetooth searching or deviceMap not empty, reset cleanup timer', this._discovering, this._deviceMap);
      if (this._h5ChanelOpened || this._discovering || !isEmpty(this._deviceMap)) {
        this.startCleanupTimer();
        return;
      }

      this.cleanup();
    }, 30 * 1000); // TODO: 这个时间需要观察如何最佳
  }

  async init() {
    return super.init().then(() => this.startCleanupTimer());
  }

  onBleConnectionStateChange({ deviceId, connected }) {
    this.response2BlueToothChanel('onBLEConnectionStateChange', { deviceId, connected });

    return super.onBleConnectionStateChange({ deviceId, connected });
  }

  onBLECharacteristicValueChange({
    deviceId, serviceId, characteristicId, value,
  }) {
    this.response2BlueToothChanel('onBLECharacteristicValueChange', {
      deviceId,
      serviceId,
      characteristicId,
      value: arrayBufferToHexStringArray(value),
    });

    return super.onBLECharacteristicValueChange({
      deviceId, serviceId, characteristicId, value,
    });
  }

  async onBluetoothDeviceFound() {
    const devices = await super.onBluetoothDeviceFound();

    this.response2BlueToothChanel('onBluetoothDeviceFound', {
      devices: devices.map(parseAdvertisData),
    });
  }

  async startSearch(params: StartSearchParams) {
    await super.startSearch(params);
    this.startCleanupTimer();
  }

  async searchDevice(params: SearchDeviceParams) {
    await super.searchDevice(params);
    this.startCleanupTimer();
  }
}
