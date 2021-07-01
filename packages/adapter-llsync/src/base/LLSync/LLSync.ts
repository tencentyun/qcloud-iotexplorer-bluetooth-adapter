import { AppDevSdk } from 'qcloud-iotexplorer-appdev-sdk';
import { StandardDeviceAdapter } from '@lib/blueTooth/adapters';
import { DeviceFilterFunction } from 'qcloud-iotexplorer-bluetooth-adapter';
import { arrayBufferToHexStringArray, delay, genPromise, hex2str } from '@utillib';
import * as wxlib from '@wxlib';
import * as constants from './constants';
import { LLSyncProtocol } from './LLSyncProtocol';
import { LLSyncOtaProcessor, ProgressCallBackFun } from './LLSyncOtaProcessor';
import * as models from '@models';
import * as utils from './utils';
import { insightReportor } from '@lib/insight';
import { reportEventTypes } from '@constants/common';

const REPORT_EVENT_TYPE = reportEventTypes.STANDARD_BLE;

export interface Reporter {
  info(actionName: string, reportInfo?: any);

  error(eventName: string, reportInfo?: any);
}

interface Wait4EventResponseOptions {
  timeout?: number;
  timeoutCode?: string;
  timeoutHandler?: () => any;
  wrapSplitDataMode?: utils.TlvDataType;
  shouldWrapSplitDataFn?: boolean;
  afterBindEvent?: () => any; // 绑定事件回调后，等待超时前执行的函数
}

interface WriteAndWait4ResponseOptions extends Wait4EventResponseOptions {
  writeId?: string;
}

export const LLSyncConfig = {
  BLE_PSK_DEVICE_KEY: 'ble_psk_device_ket',
  waitConnectReplyTime: 10000,
  waitBindReplyTime: 10000,
  waitGetCheckTimeoutReplyTime: 10000,
  waitGetCheckTimeoutDefaultReplyTime: 60000,
  waitControlReplyTime: 10000,
  waitGetDeviceInfoTime: 10000,
  waitUpdateReplyInt: 10000,
  mtuDefaultMap: {
    // version为0的时候不限时mtu
    0: undefined,
    1: 20,
    2: 20,
  },
};

export class LLSync extends AppDevSdk.utils.EventEmitter {
  static serviceId16 = '0000FFE0-0000-1000-8000-00805F9B34FB'; // 搜索时匹配的serviceId
  static serviceId = '0000FFE0-65D0-4E20-B56A-E493541BA4E2'; // 服务的serviceId

  static deviceFilter: DeviceFilterFunction = (device, extendInfo) => {
    if (!device.advertisServiceUUIDs
      || !device.advertisServiceUUIDs.find(id => id === StandardDeviceAdapter.serviceId16)
      || !device.advertisData) {
      return null;
    }

    try {
      // 计算是否要上报，这里取样1/10
      const needReport = Math.floor(Math.random() * 10) % 10 === 1 || true;

      const hexArr: string[] = arrayBufferToHexStringArray(device.advertisData);

      if (needReport) {
        insightReportor.info(REPORT_EVENT_TYPE, {
          message: '收到广播',
          serviceId: StandardDeviceAdapter.serviceId,
          hexArr: hexArr.join(','),
        });
      }

      const bindStateId = parseInt(hexArr[2], 16) - ((parseInt(hexArr[2], 16) >> 2) << 2);
      const moduleVersion = parseInt(hexArr[2], 16) >> 4;

      // 目标deviceId
      const targetDeviceId = extendInfo.productId && extendInfo.deviceName
        ? `${extendInfo.productId}/${extendInfo.deviceName}`
        : '';
      // 目标设备标识
      const targetDeviceIdentify = targetDeviceId
        ? utils.get8ByteFromStr(`${targetDeviceId.replace('/', '')}`)
        : '';
      const currentUserIdentify = utils.getUserIdentify(); // 当前登陆用户标识

      const isSearchSpecificDeviceMode = !!targetDeviceId;

      let deviceProductId = '';
      let deviceUserIdentify = '';
      let deviceIdentify = '';

      const bindState = constants.DEVICE_STATE_MAP[bindStateId];
      const deviceHasBeenBind = [constants.DEVICE_HAS_BINDED, constants.DEVICE_HAS_CONNECTED].indexOf(bindState) > -1;

      if (!deviceHasBeenBind) {
        const macArr = hexArr.slice(3, 3 + 6);
        // 防止name重名
        if (device.name && device.name.indexOf('_') === -1) {
          device.name = `${device.name}_${macArr.slice(0, 2).join('')}`;
        }
        deviceProductId = hex2str(hexArr.slice(9));
      } else {
        deviceIdentify = hexArr.slice(3, 3 + 8).join('')
          .toLocaleLowerCase();
        deviceUserIdentify = hexArr.slice(11).join('')
          .toLocaleLowerCase();
        deviceProductId = extendInfo.productId as string;
      }

      if (needReport) {
        insightReportor.info(REPORT_EVENT_TYPE, {
          message: '解析广播',
          serviceId: StandardDeviceAdapter.serviceId,
          data: {
            bindState: bindState || 'x',
            targetDeviceId,
            targetDeviceIdentify,
            currentUserIdentify,
            deviceUserIdentify: deviceUserIdentify || 'x',
            deviceProductId: deviceProductId || 'x',
            deviceIdentify: deviceIdentify || 'x',
          },
        });
      }

      const doResponse = () => {
        const deviceInfo = {
          ...device,
          // 标准蓝牙的标示
          standard: true,
          bindState: constants.DEVICE_STATE_MAP[bindState],
          serviceId: StandardDeviceAdapter.serviceId,
          deviceName: extendInfo.deviceName || '',
          productId: deviceProductId,
          extendInfo: { moduleVersion },
        };

        console.log('---设备匹配成功---', deviceInfo);

        return deviceInfo;
      };

      // 如果设备已经被绑定了，且当前为指定搜索某个设备的模式，且当前设备与目标设备、当前用户与设备归属用户都匹配，才返回，否则都不展示
      if (deviceHasBeenBind) {
        // 指定搜索模式，且设备匹配、并且设备是本人绑定的才返回，否则其他都不返回
        if (isSearchSpecificDeviceMode) {
          if (deviceIdentify === targetDeviceIdentify && deviceUserIdentify === currentUserIdentify) {
            return doResponse();
          }
        }

        return null;
      } else {
        return doResponse();
      }
    } catch (error) {
      insightReportor.error(REPORT_EVENT_TYPE, {
        message: '协议广播出错',
        error,
      });
    }
  }

  deviceAdapter: StandardDeviceAdapter;
  protocol: LLSyncProtocol;
  otaProcessor: LLSyncOtaProcessor;

  authorized = false;
  bleVersion;
  localPsk: string;
  userIdentify: string; // 当前登陆用户身份标识
  otaVersion: string;
  mtu: number;

  reporter: Reporter = {
    info: (actionName = '', {
      message = '',
      ...params
    } = {} as any) => {
      const { explorerDeviceId, deviceId, isConnected } = this.deviceAdapter;

      insightReportor.info(REPORT_EVENT_TYPE, {
        serviceId: StandardDeviceAdapter.serviceId,
        message: message || (actionName && constants.ACTION_DESC[actionName] ? `${actionName}(${constants.ACTION_DESC[actionName]})` : actionName),
        timeCost: params.timeCost || 0,
        action: actionName,
        data: {
          deviceId: explorerDeviceId,
          bleDeviceId: deviceId,
          isConnected,
          ...params,
        },
      });
    },
    // @ts-ignore
    error: (eventName = '', { error, ...params } = {}) => {
      const { explorerDeviceId, deviceId, isConnected } = this.deviceAdapter;

      // 补充errorMsg
      if (error.code && constants.ERROR_MESSAGES[error.code]) {
        // 注意，这里会引入副作用造成外层传入的error对象被修改，不过副作用危害不大，外层也加上了 normalizeError做兜底，所以可以保留
        error.msg = constants.ERROR_MESSAGES[error.code];
      }

      insightReportor.error(REPORT_EVENT_TYPE, {
        // 优化message的显示
        message: (eventName && constants.ERROR_MESSAGES[eventName] && `${eventName}(${constants.ERROR_MESSAGES[eventName]}：${error && (error.message || error.errMsg || error.msg || error.code)})`),
        timeCost: params.timeCost || 0,
        action: eventName,
        error,
        data: {
          deviceId: explorerDeviceId,
          bleDeviceId: deviceId,
          isConnected,
          ...params,
          ...error,
        },
      });
    },
  };

  get _normalizeError() {
    return this.deviceAdapter._normalizeError;
  }

  get dataTemplate() {
    if (!this.deviceAdapter.dataTemplate) {
      this.deviceAdapter.init(true);
    }

    return this.deviceAdapter.dataTemplate;
  }

  get productInfo() {
    if (!this.deviceAdapter.productInfo) {
      this.deviceAdapter.init(true);
    }
    return this.deviceAdapter.productInfo;
  }

  get productConfig() {
    if (!this.deviceAdapter.productConfig) {
      this.deviceAdapter.init(true);
    }
    return this.deviceAdapter.productConfig;
  }

  constructor(deviceAdapter) {
    super();

    this.deviceAdapter = deviceAdapter;
    this.userIdentify = utils.getUserIdentify();
    this.protocol = new LLSyncProtocol(this);
    this.otaProcessor = new LLSyncOtaProcessor(this);

    this.deviceAdapter.on('disconnect', () => {
      this.authorized = false;
    });
  }

  notifyMessage({ type, data }: any = {}) {
    if (type !== 'unknown') {
      console.log('check this in notifyMessage', this, { type, data });
      return this.emit(type, { type, data });
    }
  }

  async getDevicePsk(deviceName) {
    const psk = await models.getUserDeviceConfig({
      DeviceId: `${this.deviceAdapter.productId}/${deviceName || this.deviceAdapter.deviceName}`,
      DeviceKey: LLSyncConfig.BLE_PSK_DEVICE_KEY,
    });

    if (!psk) {
      throw {
        code: constants.PSK_GET_ERROR,
      };
    }

    return psk;
  }

  startOta({
    // 进度函数
    onProgress,
  }: {
    onProgress: ProgressCallBackFun;
  }) {
    return this.otaProcessor.startOta({ onProgress });
  }

  // 取消固件升级
  cancelOta() {
    return this.otaProcessor.cancelOta();
  }

  startListenLLEvents() {
    this.on(constants.PROPERTY_REPORT, utils.wrapEventHandler(this.onPropertyReport.bind(this), constants.PROPERTY_REPORT));
    this.on(constants.GET_STATUS, this.onGetStatus.bind(this));
    this.on(constants.EVENT_REPORT, utils.wrapEventHandler(this.onEventReport.bind(this), constants.EVENT_REPORT));
  }

  stopListenLLEvents() {
    // @ts-ignore
    this.off(constants.PROPERTY_REPORT);
    // @ts-ignore
    this.off(constants.GET_STATUS);
    // @ts-ignore
    this.off(constants.EVENT_REPORT);
  }

  async onPropertyReport(data) {
    try {
      console.log('onPropertyReport check this', this);

      const jsObj = utils.convertPropertiesTlvToJsObject(data.slice(2), this.dataTemplate);

      this.reporter.info(constants.REPORT_RESULT, {
        data: utils.formatArrayToReportString(data),
        jsObj,
      });

      const { Data } = await models.reportBlueToothDeviceData({
        ProductId: this.deviceAdapter.productId,
        DeviceName: this.deviceAdapter.deviceName,
        Data: jsObj,
        DataTimeStamp: Date.now(),
      });

      if (Data) {
        const status = JSON.parse(Data);
        this.protocol.reportPropertyReportResult(status.code);
      }
    } catch (error) {
      this.reporter.error(constants.REPORT_RESULT_ERROR, {
        error,
      });
      this.protocol.reportPropertyReportResult(-1);
    }
  }

  async onGetStatus() {
    try {
      console.log('onGetStatus check this', this);

      const newData = await models.getDeviceData({
        ProductId: this.deviceAdapter.productId,
        DeviceName: this.deviceAdapter.deviceName,
      });

      const properties = {};
      Object.keys(newData).forEach((key) => {
        properties[key] = newData[key].Value;
      });
      const { tlvData, tmpData } = utils.convertPropertiesChangeToTlv(properties, this.dataTemplate);

      this.reporter.info(constants.GET_STATUS, {
        properties,
        tlvData: utils.formatArrayToReportString(tlvData),
        tmpData,
      });
      this.protocol.reportGetStatusResult(0, tlvData, tmpData);
    } catch (error) {
      this.reporter.error(constants.GET_STATUS_ERROR, {
        error,
      });
      // 统一写入错误
      this.protocol.reportGetStatusResult(-1);
      return Promise.reject(this._normalizeError(error));
    }
  }

  async onEventReport(data) {
    try {
      console.log('onEventReport check this', this);

      const length = utils.getStrLength(data);
      const { eventId, params, eventIndex } = utils.convertEventTlvToJsObject(data.slice(2, 2 + length), this.dataTemplate);

      const reportData = {
        DeviceId: this.deviceAdapter.explorerDeviceId,
        EventId: eventId,
        Params: JSON.stringify(params),
      };
      this.reporter.info(constants.EVENT_REPLY, {
        ...reportData,
        eventIndex,
      });
      try {
        await models.reportDeviceEvent(reportData);

        // 可能有多个event
        if (data.length - 2 > length) {
          await this.onEventReport({
            // type 那个要slice掉
            data: data.slice(length + 2 + 1),
          });
        } else {
          this.protocol.reportEventReportResult(0, eventIndex);
        }
      } catch (error) {
        this.protocol.reportEventReportResult(-1, eventIndex);
        throw error;
      }
    } catch (error) {
      this.reporter.error(constants.EVENT_REPLY_ERROR, {
        error,
      });
      return Promise.reject(this._normalizeError(error));
    }
  }

  // 设备绑定到家庭,标准蓝牙协议有自有的绑定逻辑，所以这部分重写
  async bindDevice({
    familyId,
    roomId,
  }) {
    try {
      this.reporter.info(constants.BIND_AUTH);
      const start = Date.now();

      const { sign, timestamp, nonce, deviceName } = await this.protocol.requestBindDevice(this.deviceAdapter.needUserCheck);
      // 设置真实的deviceName
      this.deviceAdapter.deviceName = deviceName;

      try {
        const params: any = {
          Signature: sign,
          DeviceTimestamp: timestamp,
          DeviceId: this.deviceAdapter.explorerDeviceId,
          ConnId: `${nonce}`,
          FamilyId: familyId,
          RoomId: roomId,
          BindType: 'bluetooth_sign',
        };
        this.reporter.info(constants.BIND_AUTH_DETAIL, params);
        await models.addDeviceBySigInFamily(params);
      } catch (error) {
        this.protocol.reportBindError(error.code);
        return Promise.reject(this._normalizeError(error));
      }

      // 写入绑定结果
      await this.protocol.reportBindSuccess(start);

      // TODO： 验证是否不需要再验证
      this.authorized = true;

      return this.deviceAdapter.explorerDeviceId;
    } catch (err) {
      console.log(err);
      console.log('error in bindDevice', err);
      this.reporter.error(constants.BIND_AUTH_FAIL, { error: err });
      return Promise.reject(this._normalizeError(err));
    }
  }

  async unbindDevice({
    familyId,
    deviceName,
  }) {
    try {
      if (!deviceName) {
        throw {
          code: constants.DEVICE_NAME_IS_EMPTY,
        };
      }

      const start = Date.now();

      const localPsk = await this.getDevicePsk(deviceName);

      this.reporter.info(constants.UNBIND_AUTH, {
        localPsk,
      });

      const { sign } = await this.protocol.getUnbindAuthSign();
      // 校验sign
      const signToCheck = utils.encrypt(constants.UNBIND_RESPONSE, localPsk);

      if (sign !== signToCheck) {
        throw {
          code: constants.UNBIND_REPLY_ERROR,
        };
      }

      this.localPsk = localPsk;
      this.deviceAdapter.deviceName = deviceName;

      await models.deleteDeviceFromFamily({
        FamilyId: familyId,
        DeviceId: this.deviceAdapter.explorerDeviceId,
      });

      this.reporter.info(constants.UNBIND_RESULT_AUTH_SUCCESS, {
        timeCost: Date.now() - start,
      });
      await this.protocol.reportUnbindResult('success');
      // 取消监听
      this.stopListenLLEvents();
      this.authorized = false;
      this.deviceAdapter.disconnectDevice();
    } catch (err) {
      this.protocol.reportUnbindResult('fail');
      this.reporter.error(constants.UNBIND_RESULT_AUTH_FAIL, {
        error: err,
      });
      return Promise.reject(this._normalizeError(err));
    }
  }

  // TODO：验证未授权调用会如何
  async controlDevice({ deviceData }) {
    try {
      console.log('controlDevice check this', this);

      this.reporter.info(constants.CONTROL_DEVICE, {
        deviceData,
      });
      await this.protocol.controlDeviceProperty(deviceData);
      // 上报给后台
      await models.reportBlueToothDeviceData({
        ProductId: this.deviceAdapter.productId,
        DeviceName: this.deviceAdapter.deviceName,
        Data: deviceData,
        DataTimeStamp: Date.now(),
      });
    } catch (error) {
      this.reporter.error(constants.CONTROL_DEVICE_REPLY_ERROR, {
        error,
      });
      return Promise.reject(this._normalizeError(error));
    }
  }

  async controlAction({ actionData }) {
    try {
      console.log('controlAction check this', this);
      const { output } = await this.protocol.controlDeviceAction(actionData);

      const { outputParams, actionIndex, actionId } = await utils.convertActionOutputTlvToJsObject(output, this.dataTemplate);

      await models.publishDeviceActionMessage({
        deviceName: this.deviceAdapter.deviceName,
        productId: this.deviceAdapter.productId,
        actionId,
        clientToken: actionData.clientToken,
        output: outputParams,
      });

      this.reporter.info(constants.CONTROL_ACTION_SUCCESS, {
        outputParams, actionIndex, actionId,
      });
    } catch (error) {
      this.reporter.error(constants.CONTROL_ACTION_ERROR, {
        error,
      });

      return Promise.reject(this._normalizeError(error));
    }
  }

  // 这里没办法，只有授权后才能拿到真实 deviceName,所以只能从外面传，然后再跟设备响应回来的做比较，确认后写入 adapter
  async authenticateConnection({
    deviceName,
  }: {
    deviceName?: string;
  } = {}) {
    try {
      console.log('start authenticate connection', deviceName);

      if (!deviceName) {
        throw {
          code: constants.DEVICE_NAME_IS_EMPTY,
        };
      }

      const start = Date.now();
      const localPsk = this.localPsk = await this.getDevicePsk(deviceName);

      this.reporter.info(constants.CONNECT_AUTH, {
        localPsk,
      });

      const { sign, timestamp } = await this.protocol.getDeviceAuthInfo();

      // 校验sign
      const signToCheck = utils.encrypt(`${timestamp + 60}${this.deviceAdapter.productId}${deviceName}`, localPsk);

      if (sign !== signToCheck) {
        throw {
          code: constants.CONNECT_SIGN_AUTH_ERROR,
        };
      }

      const { version, mtu, needSetMtu, otaVersion } = await this.protocol.getDeviceInfo();

      // 通过校验确认 deviceName 合法才写入
      this.deviceAdapter.deviceName = deviceName;
      this.bleVersion = version;
      // 设置mtu的值
      this.mtu = mtu;
      // 主动设置下mtu
      if (needSetMtu) {
        try {
          await this.setMtu(this.mtu);

          this.protocol.writeMtuResult('success');
        } catch (e) {
          this.protocol.writeMtuResult('fail');
        }
      }

      this.otaVersion = otaVersion;

      if (otaVersion) {
        models.reportOTAVersion({
          Version: otaVersion,
          DeviceId: this.deviceAdapter.explorerDeviceId,
        });
      }

      // 写入上线结果
      this.reporter.info(constants.CONNECT_RESULT_WRITE_SUCCESS, {
        timeCost: Date.now() - start,
        version,
        mtu,
        otaVersion,
      });

      this.authorized = true;

      // TODO: reconnected 换为 authorized，检查副作用
      this.deviceAdapter.emit('authorized', {
        version,
        mtu,
        otaVersion,
      });

      // await this.setMtu(25);
      // 设置监听,先取消监听
      this.stopListenLLEvents();
      // 设置监听
      this.startListenLLEvents();
    } catch (err) {
      this.protocol.reportConnectError();
      this.reporter.error(constants.CONNECT_RESULT_WRITE_FAIL, {
        error: err,
      });

      return Promise.reject(this._normalizeError(err));
    }
  }

  // 等待某个事件响应
  async wait4EventResponse<T>(
    eventName: string,
    handler: (data: any) => T,
    {
      timeout,
      timeoutCode,
      timeoutHandler,
      wrapSplitDataMode,
      shouldWrapSplitDataFn = true,
      afterBindEvent,
    }: Wait4EventResponseOptions = {},
  ): Promise<T> {
    const respPromise = genPromise<T>();

    console.log('wait4EventResponse', { eventName });

    // race 中的两个Promise之一，是否已经被触发过了，如果已经触发过，另外一个就别动了
    let promiseResolved = false;

    const eventHandlerFn = async (data) => {
      try {
        if (!promiseResolved) {
          respPromise.resolve(handler(data));
          promiseResolved = true;
        } else {
          console.log(`Target event: ${eventName} triggered, but is already timeout`);
        }
      } catch (err) {
        respPromise.reject(err);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        this.off(eventName, eventHandler);
      }
    };

    const eventHandler = shouldWrapSplitDataFn ? utils.wrapEventHandler(eventHandlerFn, wrapSplitDataMode) : eventHandlerFn;

    this.on(eventName, eventHandler);

    try {
      if (typeof afterBindEvent === 'function') {
        await afterBindEvent();
      }

      return await Promise.race([
        respPromise.promise,
        new Promise<any>((resolve, reject) => {
          // 若没设置timeout，则不设超时定时器
          if (timeout && timeout > 0) {
            setTimeout(() => {
              if (!promiseResolved) {
                console.log(`Wait for target event: ${eventName} timeout`);

                promiseResolved = true;
                this.off(eventName, eventHandler);

                // 如果传了，就按 timeoutHandler 去 resolve，否则报 timeoutCode 错误
                if (typeof timeoutHandler === 'function') {
                  console.log('trigger timeout handler');
                  resolve(timeoutHandler());
                } else {
                  reject({
                    code: timeoutCode,
                  });
                }
              }
            }, timeout);
          }
        }),
      ]);
    } catch (err) {
      this.off(eventName, eventHandler);
      return Promise.reject(err);
    }
  }

  // write something and wait for response
  async writeAndWait4Response<T>(
    data2Write: any,
    eventName: string,
    handler: (data: any) => T,
    {
      timeout,
      timeoutCode,
      timeoutHandler,
      writeId,
      wrapSplitDataMode,
      shouldWrapSplitDataFn = true,
    }: WriteAndWait4ResponseOptions = {},
  ): Promise<T> {
    return this.wait4EventResponse(
      eventName,
      handler,
      {
        timeout,
        timeoutCode,
        timeoutHandler,
        wrapSplitDataMode,
        shouldWrapSplitDataFn,
        afterBindEvent: () => this.writeData(data2Write, { writeId })
          .catch(error => Promise.reject({
            code: constants.BLE_WRITE_ERROR,
            ...error,
          })),
      },
    );
  }

  sliceData(data, tmpData, mode): string[] {
    if (!this.mtu || data.join('').length <= this.mtu * 2) return [data.join('')];

    // 处理分片
    // 获取头部
    const head = data.slice(0, mode === constants.GET_STATUS ? 2 : 1);
    console.log('---head----', head);

    return utils.sliceData(tmpData, {
      mtu: this.mtu,
      head,
      mode,
    });
  }

  handleBLEMessage(hex) {
    const indicateType = parseInt(hex.slice(0, 1), 16);

    const result = {
      type: constants.INDICATE_TYPE_MAP[indicateType] || 'unknown',
      data: hex.splice(1),
    };

    console.log('Message(hex)', result);

    return result;
  }

  // 业务相关
  async writeData(data, opts: {
    writeId?: string;
    waitGap?: number;
  } = {}): Promise<any> {
    if (!Array.isArray(data)) {
      data = [data];
    }
    for (let i = 0; i < data.length; i++) {
      if (i !== 0) {
        // const errorOccur = (Math.floor((Math.random() * 10)) % 10 === 1) ? 1 : 0;
        // opts.waitGap = opts.waitGap * errorOccur * 120000;
        await delay(opts.waitGap || 100);
      }

      await this.deviceAdapter.write(data[i], opts);
    }
  }

  // 业务相关
  async setMtu(mtu) {
    // ios不支持设置
    if (wxlib.system.isIOS()) return;
    const ret = await this.deviceAdapter.setBLEMTU({
      deviceId: this.deviceAdapter.deviceId,
      mtu,
    });
    this.reporter.info(constants.ANDROID_SET_MTU, {
      mtu,
      ret,
    });
    return ret;
  }
}
