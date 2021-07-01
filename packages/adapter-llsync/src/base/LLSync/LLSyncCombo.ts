import * as utils from './utils';
import { AppDevSdk } from 'qcloud-iotexplorer-appdev-sdk';
import { DeviceFilterFunction } from 'qcloud-iotexplorer-bluetooth-adapter';
import { arrayBufferToHexStringArray, hex2str } from '@utillib';
import { StandardBleComboDeviceAdapter } from '@lib/blueTooth/adapters';
import { insightReportor } from '@lib/insight';
import { reportEventTypes } from '@constants/common';
import * as constants from './constants';
import { LLSync, Reporter } from './LLSync';
import { LLSyncProtocol } from './LLSyncProtocol';

const REPORT_EVENT_TYPE = reportEventTypes.STANDARD_BLE_COMBO;
const {
  byteUtil,
} = AppDevSdk.utils;

export const LLSyncComboConfig = {
  waitGetDeviceInfoTime: 10000,
  waitSetWiFiModeTime: 10000,
  waitSetWiFiInfoTime: 10000,
  waitSetWiFiConnectTime: 20000,
  waitSetWiFiTokenTime: 10000,
  waitDevLogInfoTime: 10000,
};

export class LLSyncCombo extends AppDevSdk.utils.EventEmitter {
  static serviceId16 = '0000FFF0-0000-1000-8000-00805F9B34FB'; // 搜索时匹配的serviceId
  static serviceId = '0000FFF0-65D0-4E20-B56A-E493541BA4E2'; // 服务的serviceId

  static deviceFilter: DeviceFilterFunction = (device) => {
    console.log('-----', device);
    if (!device.advertisServiceUUIDs
      || !device.advertisServiceUUIDs.find(id => id === StandardBleComboDeviceAdapter.serviceId16)
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
          serviceId: StandardBleComboDeviceAdapter.serviceId,
          hexArr: hexArr.join(','),
        });
      }

      const moduleVersion = parseInt(hexArr[2], 16) >> 4;


      let deviceProductId = '';
      const macArr = hexArr.slice(3, 3 + 6);
      // 防止name重名
      if (device.name && device.name.indexOf('_') === -1) {
        device.name = `${device.name}_${macArr.slice(0, 2).join('')}`;
      }
      deviceProductId = hex2str(hexArr.slice(9));

      if (needReport) {
        insightReportor.info(REPORT_EVENT_TYPE, {
          message: '解析广播',
          serviceId: StandardBleComboDeviceAdapter.serviceId,
          data: {
            deviceProductId: deviceProductId || 'x',
          },
        });
      }

      return {
        ...device,
        // 标准蓝牙的blecombo的标示
        standardBleCombo: true,
        serviceId: StandardBleComboDeviceAdapter.serviceId,
        deviceName: '',
        productId: deviceProductId,
        extendInfo: { moduleVersion },
      };
    } catch (error) {
      insightReportor.error(REPORT_EVENT_TYPE, {
        message: '协议广播出错',
        error,
      });
    }
  }


  llSyncCore: LLSync;
  protocol: LLSyncProtocol;
  deviceAdapter: StandardBleComboDeviceAdapter;
  bleVersion;

  reporter: Reporter = {
    info: (actionName = '', {
      message = '',
      ...params
    } = {} as any) => {
      const { explorerDeviceId, deviceId, isConnected } = this.deviceAdapter;

      insightReportor.info(REPORT_EVENT_TYPE, {
        serviceId: StandardBleComboDeviceAdapter.serviceId,
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
        error.msg = constants.ERROR_MESSAGES[error.code];
      }

      insightReportor.error(REPORT_EVENT_TYPE, {
        // 优化message的显示
        message: (eventName && constants.ERROR_MESSAGES[eventName] && `${eventName}(${constants.ERROR_MESSAGES[eventName]}：${error && (error.message || error.errMsg || error.msg || error.code)})`),
        // @ts-ignore
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

  constructor(llSyncCore) {
    super();
    this.llSyncCore = llSyncCore;
    this.protocol = llSyncCore.protocol;
    this.deviceAdapter = llSyncCore.deviceAdapter;
  }

  notifyMessage({ type, data }: any = {}) {
    if (type !== 'unknown') {
      console.log('check this in notifyMessage', this, { type, data });
      return this.emit(type, { type, data });
    }
  }


  async afterConnectDevice() {
    // 获取设备信息
    const { version, mtu, needSetMtu, deviceName } = await this.getDeviceInfo();
    this.deviceAdapter.deviceName = deviceName;
    this.llSyncCore.bleVersion = version;

    // 设置mtu的值
    this.llSyncCore.mtu = mtu;

    this.reporter.info('CONNECT_DEVICE', {
      data: {
        version,
        mtu,
        needSetMtu,
        deviceName,
      },
    });
    if (needSetMtu) {
      try {
        await this.llSyncCore.setMtu(this.llSyncCore.mtu);

        this.protocol.writeMtuResult('success');
      } catch (e) {
        this.protocol.writeMtuResult('fail');
      }
    }

    // 返回设备name，后座绑定用
    return deviceName;
  }


  getDeviceInfo(): Promise<{ version: number; mtu: number; needSetMtu: boolean; deviceName: string }> {
    return this.llSyncCore.writeAndWait4Response(
      constants.DEVICE_INFO_WRITE_PREFIX[constants.GET_DEVICE_INFO],
      constants.DEVICE_INFO,
      (data) => {
        // console.log('----', data);
        if (!data.length) {
          throw {
            code: constants.DEVICE_INFO_INVALID,
          };
        }
        // 解析data消息
        const version = parseInt(data.slice(2, 3).join(''), 16);
        const mtuFiled = parseInt(data.slice(3, 5).join(''), 16);
        const needSetMtu = !!(mtuFiled >> 15);
        const mtu = mtuFiled & 0x1fff;

        const deviceNameLength = parseInt(data[5], 16);
        const deviceName = hex2str(data.slice(6).join(''));

        if (deviceNameLength !== deviceName.length) {
          throw {
            code: constants.DEVICE_INFO_INVALID,
          };
        }

        return {
          version,
          mtu,
          needSetMtu,
          deviceName,
        };
      },
      {
        timeout: LLSyncComboConfig.waitGetDeviceInfoTime,
        timeoutCode: constants.WAIT_GET_DEVICE_INFO_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  /**
   * @description WiFi模式设置
   * @returns boolean 表示设置WiFi模式成功或者失败
   */
  setWiFiMode(mode: string = constants.STA_WIFI_MODE): Promise<boolean> {
    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.SET_WIFI_MODE]}${utils.U8ToHexString(constants.WIFI_MODE_MAP[mode])}`;
    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.SET_WIFI_MODE_RESULT,
      (data) => {
        // console.log('----', data);
        if (!data.length) {
          throw {
            code: constants.SET_WIFI_MODE_RESULT_INVALID,
          };
        }
        // 解析data消息
        const result = parseInt(data.slice(2, 3).join(''), 16);
        return !result;
      },
      {
        timeout: LLSyncComboConfig.waitSetWiFiModeTime,
        timeoutCode: constants.SET_WIFI_MODE_RESULT_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  /**
   *
   * @param params0 {Object} 配网的WiFi信息
   * @param parmas0.ssid {String} WiFi的ssid
   * @param params0.password {String} WiFi的密码
   * @returns {boolean} 传输WiFi结果
   */
  setWiFiInfo({
    ssid,
    password,
  }: {
    ssid: string;
    password: string;
  }): Promise<boolean> {
    const ssidHexArray = byteUtil.hexString2hexArray(byteUtil.byteArrayToHex(byteUtil.getBytesByString(ssid))) || [];
    // password可能为空
    const passwordHexArray = byteUtil.hexString2hexArray(byteUtil.byteArrayToHex(byteUtil.getBytesByString(password))) || [];
    console.log('----data----', {
      ssid,
      password,
      ssidHexArray,
      passwordHexArray,
    });
    const data =  this.llSyncCore.sliceData(
      [
        constants.DEVICE_INFO_WRITE_PREFIX[constants.SET_WIFI_INFO],
        utils.U16ToHexString(ssidHexArray.length + passwordHexArray.length),
        utils.U8ToHexString(ssidHexArray.length),
        ...ssidHexArray,
        utils.U8ToHexString(passwordHexArray.length),
        ...passwordHexArray,
      ],
      [[utils.U8ToHexString(ssidHexArray.length), ...ssidHexArray], [utils.U8ToHexString(passwordHexArray.length), ...passwordHexArray]],
      constants.SET_WIFI_INFO,
    ) ;

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.SET_WIFI_INFO_RESULT,
      (data) => {
        // console.log('----', data);
        if (!data.length) {
          throw {
            code: constants.SET_WIFI_INFO_RESULT_INVALID,
          };
        }
        // 解析data消息
        const result = parseInt(data.slice(2, 3).join(''), 16);
        return !result;
      },
      {
        timeout: LLSyncComboConfig.waitSetWiFiInfoTime,
        timeoutCode: constants.SET_WIFI_INFO_RESULT_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  /**
   * @description 下发WiFi连接请求，并获取连接状态
   * @returns {boolean} WiFi连接状态
   */
  sendConnectWiFiAndGetWiFiConnectState(): Promise<{
    connected: boolean;
    ssid: string;
  }> {
    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.SET_WIFI_CONNECT]}`;

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.SET_WIFI_CONNECT_RESULT,
      (data) => {
        // console.log('----', data);
        if (!data.length) {
          throw {
            code: constants.SET_WIFI_CONNECT_RESULT_INVALID,
          };
        }
        // 解析data消息,	Stattion状态表示BLE设备作为WiFi Station模式的工作状态，0x0表示连接，其他表示非连接。
        const stationState = parseInt(data.slice(3, 4).join(''), 16);
        const ssidLength = parseInt(data.slice(5, 6).join(''), 16);
        let ssid = '';
        if (ssidLength) {
          ssid = hex2str(data.slice(6, 6 + ssidLength));
        }
        return {
          connected: !stationState,
          ssid,
        };
      },
      {
        timeout: LLSyncComboConfig.waitSetWiFiConnectTime,
        timeoutCode: constants.SET_WIFI_CONNECT_RESULT_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }


  sendToken({
    token,
  }: {
    token: string;
  }): Promise<boolean> {
    const tokenHexArray = byteUtil.hexString2hexArray(byteUtil.byteArrayToHex(byteUtil.getBytesByString(token)));

    console.log('----data----', {
      token,
      tokenHexArray,
    });
    const data =  this.llSyncCore.sliceData(
      [
        constants.DEVICE_INFO_WRITE_PREFIX[constants.SET_WIFI_TOKEN],
        utils.U16ToHexString(tokenHexArray.length),
        ...tokenHexArray,
      ],
      [tokenHexArray],
      constants.SET_WIFI_TOKEN,
    ) ;

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.SET_WIFI_TOKEN_RESULT,
      (data) => {
        // console.log('----', data);
        if (!data.length) {
          throw {
            code: constants.SET_WIFI_TOKEN_RESULT_INVALID,
          };
        }
        // 解析data消息
        const result = parseInt(data.slice(2, 3).join(''), 16);
        return !result;
      },
      {
        timeout: LLSyncComboConfig.waitSetWiFiTokenTime,
        timeoutCode: constants.SET_WIFI_TOKEN_RESULT_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }


  getModuleLog(): Promise<{
    logStr: string;
  }> {
    // 获取错误日志吧
    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.GET_DEV_LOG]}`;
    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.GET_DEV_LOG_INFO,
      (data) => {
        if (!data.length) {
          throw {
            code: constants.GET_DEV_LOG_INFO_INVALID,
          };
        }
        // 解析data消息
        const length = parseInt(data.slice(1, 3).join(''), 16);
        const logStr = hex2str(data.slice(4, 4 + length));
        return {
          logStr,
        };
      },
      {
        timeout: LLSyncComboConfig.waitDevLogInfoTime,
        timeoutCode: constants.GET_DEV_LOG_INFO_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }
}
