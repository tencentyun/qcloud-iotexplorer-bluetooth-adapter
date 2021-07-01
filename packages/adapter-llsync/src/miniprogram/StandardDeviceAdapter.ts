import { DeviceAdapter4Mp } from 'qcloud-iotexplorer-bluetooth-adapter';
import { LLSync } from '../base/LLSync';
// import * as utils from './LLSync/utils';
// import { ProductUIDevConfig } from '@tencent/iotexplorer-ui-dev-config';
// import * as constants from './LLSync/constants';

export class StandardDeviceAdapter extends DeviceAdapter4Mp {
  static serviceId16 = LLSync.serviceId16; // 搜索时匹配的serviceId
  static serviceId = LLSync.serviceId; // 服务的serviceId
  static deviceFilter = LLSync.deviceFilter;

  handleBLEMessage: LLSync['handleBLEMessage'];
  bindDevice: LLSync['bindDevice'];
  unbindDevice: LLSync['unbindDevice'];
  controlDevice: LLSync['controlDevice'];
  controlAction: LLSync['controlAction'];
  authenticateConnection: LLSync['authenticateConnection'];
  startOta: LLSync['startOta'];
  cancelOta: LLSync['cancelOta'];
  authorized: boolean;
  reporter: any;

  get ready() {
    return this.isConnected && this.authorized;
  }

  get needUserCheck() {
    try {
      console.log('check needUserCheck', this.productConfig, !!parseInt(this?.productConfig?.BleConfig?.bindingBootConfig?.confirmRequired || '0'));

      return !!parseInt(this?.productConfig?.BleConfig?.bindingBootConfig?.confirmRequired || '0');
    } catch (err) {
      console.warn('LLSync check confirmRequired fail', err);
      return false;
    }
  }

  _normalizeError(error) {
    error = super._normalizeError(error);

    if (!error.msg && error.code && constants.ERROR_MESSAGES[error.code]) {
      error.msg = constants.ERROR_MESSAGES[error.code];
    }

    return error;
  }

  constructor(props) {
    super(props);

    const llSync = new LLSync(this);

    this.on('message', llSync.notifyMessage.bind(llSync));

    this.init();

    const wrapWaitInit = fn => async (...args) => {
      await this.init();
      return fn(...args);
    };

    Object.assign(this, {
      // 处理消息
      handleBLEMessage: llSync.handleBLEMessage.bind(llSync),
      bindDevice: wrapWaitInit(llSync.bindDevice.bind(llSync)),
      unbindDevice: wrapWaitInit(llSync.unbindDevice.bind(llSync)),
      controlDevice: wrapWaitInit(llSync.controlDevice.bind(llSync)),
      controlAction: wrapWaitInit(llSync.controlAction.bind(llSync)),
      authenticateConnection: wrapWaitInit(llSync.authenticateConnection.bind(llSync)),
      startOta: wrapWaitInit(llSync.startOta.bind(llSync)),
      cancelOta: wrapWaitInit(llSync.cancelOta.bind(llSync)),
      userCancelBindDevice: wrapWaitInit(llSync.protocol.cancelUserCheck.bind(llSync.protocol, 'cancel')),
    });

    Object.defineProperties(this, {
      authorized: {
        get() {
          return llSync.authorized;
        },
      },
    });

    const onControl = ({ deviceId, deviceData }) => {
      if (this.ready && deviceId === this.explorerDeviceId) {
        const nowDeviceData = {};
        Object.keys(deviceData).forEach((key) => {
          nowDeviceData[key] = deviceData[key].Value;
        });

        llSync.controlDevice({ deviceData: nowDeviceData });
      }
    };

    const onWsActionPush = ({ deviceId, Payload }) => {
      // 不是这个设备就过滤掉
      if (this.ready && deviceId !== this.explorerDeviceId) return;

      llSync.controlAction({ actionData: Payload });
    };

    this.reporter = llSync.reporter;
    this
      .on('authorized', () => {
        // 每次授权后，强制刷新一次缓存
        this.init(true);
        system.sdk.on(AppDevSdk.constants.EventTypes.WsControl, onControl);
        system.sdk.on(AppDevSdk.constants.EventTypes.WsActionPush, onWsActionPush);
      })
      .on('disconnect', () => {
        system.sdk.off(AppDevSdk.constants.EventTypes.WsControl, onControl);
        system.sdk.off(AppDevSdk.constants.EventTypes.WsActionPush, onWsActionPush);
      });
  }

  _initPromise;
  productConfig: ProductUIDevConfig;
  productInfo;
  dataTemplate;

  // @ts-ignore
  async init(reload?: boolean) {
    await super.init();

    if (reload) {
      // @ts-ignore
      this.productInfo = this.productConfig = this._initPromise = null;
    }

    return this._initPromise || (this._initPromise = new Promise(async (resolve, reject) => {
      try {
        const { productConfig, productInfo } = this;

        const [_productInfo, _productConfig] = await Promise.all([
          productConfig ? Promise.resolve(productConfig) : pullProductInfo({ productId: this.productId }),
          productInfo ? Promise.resolve(productInfo) : getProductConfig({ ProductId: this.productId }),
        ]);

        this.dataTemplate = utils.getProductDateTemplate(_productInfo);
        this.productInfo = _productInfo;
        this.productConfig = _productConfig;

        console.log('init llsync done', {
          productInfo: this.productInfo,
          productConfig: this.productConfig,
          dataTemplate: this.dataTemplate,
        });

        resolve();
      } catch (err) {
        console.error('init standard device adapter fail', err);
        reject(err);
        this._initPromise = null;
      }
    }));
  }
}
