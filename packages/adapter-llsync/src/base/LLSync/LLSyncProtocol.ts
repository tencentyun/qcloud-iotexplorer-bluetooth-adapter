import * as utils from './utils';
import * as constants from './constants';
import { AppDevSdk } from 'qcloud-iotexplorer-appdev-sdk';
import { delay, genPromise, hex2str, noop, str2hexStr } from '@utillib';
import {
  setUserDeviceConfig,
} from '@models';
import { StandardDeviceAdapter } from '@lib/blueTooth/adapters';
import { LLSync, LLSyncConfig } from './LLSync';
import { U8ToHexString } from './utils/util';

const {
  CryptoJS,
  byteUtil,
} = AppDevSdk.utils;

export interface WriteStampResult {
  sign: string;
  // 设备端会加60
  timestamp: number;
  nonce: number;
  deviceName: string;
  userCheckResult?: boolean;
}

export interface WriteConInfoResult {
  sign: string;
  timestamp: number;
}

export class LLSyncProtocol {
  llSyncCore: LLSync;
  deviceAdapter: StandardDeviceAdapter;

  get reporter() {
    return this.llSyncCore.reporter;
  }

  constructor(llSyncCore) {
    this.llSyncCore = llSyncCore;
    this.deviceAdapter = llSyncCore.deviceAdapter;
  }

  /**
   * 请求绑定，写入时间戳，换取获取设备签名
   */
  requestBindDevice(needUserCheck = false): Promise<WriteStampResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = parseInt(utils.gen4BytesIntHex(), 16);
    const bindDeviceData = this._parseDataBeforeConnect(
      `${constants.DEVICE_INFO_WRITE_PREFIX[constants.TIME_SYNC]}${nonce.toString(16)}${timestamp.toString(16)}`,
      constants.TIME_SYNC,
    );

    const bindDeviceParams = {
      timestamp,
      nonce,
      bindDeviceData,
    };
    this.reporter.info(constants.TIME_SYNC, bindDeviceParams);

    return needUserCheck ? this.waitUserCheckAndBindDevice(bindDeviceParams) : this.bindDeviceDirectly(bindDeviceParams);
  }

  bindDeviceDirectly({
    timestamp,
    nonce,
    bindDeviceData,
  }): Promise<WriteStampResult> {
    return this.llSyncCore.writeAndWait4Response<WriteStampResult>(
      bindDeviceData,
      constants.BIND_AUTH,
      (data) => {
        if (!data.length) {
          throw { code: constants.CONNECT_REPLY_INVALID };
        }
        // 解析data消息
        const sign = data.slice(2, 22).join('');
        const deviceName = hex2str(data.slice(22));

        const resolveParam = {
          sign: sign.toLocaleLowerCase(),
          // 设备端会加60
          timestamp: timestamp + 60,
          nonce,
          deviceName,
        };
        this.reporter.info(constants.TIME_SYNC, resolveParam);
        return resolveParam;
      },
      {
        timeout: LLSyncConfig.waitBindReplyTime,
        timeoutCode: constants.WAIT_CONNECT_REPLY_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  // 如果用户主动取消用户确认，则执行该函数
  _cleanupUserCheckHandleAfterCancel = noop;

  /**
   * 需要用户确认的绑定流程：
   * 1. 请求绑定
   * 2. 等待设备响应用户确认超时时间（老固件不会响应），若响应则设置用户超时定时器，超时未响应则设置默认超时时间
   * 3. 等待用户确认
   *
   * Checklist：
   * 1. 老版本固件，不返回超时时间（用错误的事件来模拟），能够设置默认的用户确认超时
   * 2. 正常固件，及时返回超时时间，设置正确的用户确认超时
   * 3. 用户UI上主动拒绝绑定，能够正确取消
   * 4. 用户设备上主动拒绝绑定，能够正确取消
   * 5. 不做任何响应，能够正确超时
   * 6. 用户正常确认，能够正常绑定
   */
  async waitUserCheckAndBindDevice({
    timestamp,
    nonce,
    bindDeviceData,
  }): Promise<WriteStampResult> {
    const userCheckPromise = genPromise();

    let userCheckTimer;
    // 注册等待用户确认超时定时器
    const registerUserCheckTimer = (userCheckTimeout) => {
      clearTimeout(userCheckTimer);

      console.log('registerUserCheckTimer', userCheckTimeout);

      userCheckTimer = setTimeout(() => {
        console.log('user check timeout', userCheckTimeout);
        this.cancelUserCheck('timeout');
        userCheckPromise.reject({
          code: constants.WAIT_USER_CHECK_TIMEOUT,
        });
      }, userCheckTimeout);
    };

    // 等待设备响应用户等待超时时间（老版本固件可能不会响应这个超时时间），若超时则设置默认的超时时间
    this.llSyncCore.wait4EventResponse(
      constants.USER_CHECK_TIMEOUT_CALLBACK,
      (data) => {
        if (!data.length) {
          console.log('get user check timeout duration fail, trigger default timeout timer');
          this.reporter.info(constants.GET_USER_CHECK_TIMEOUT_ERROR);
          return registerUserCheckTimer(LLSyncConfig.waitGetCheckTimeoutDefaultReplyTime);
        }
        const timeoutDuration = parseInt(data.slice(2).join(''), 16) * 1000;
        this.reporter.info(constants.GET_USER_CHECK_TIMEOUT_SUCCESS, {
          timeoutDuration,
        });

        // 注册超时
        registerUserCheckTimer(timeoutDuration);
      },
      {
        timeout: LLSyncConfig.waitGetCheckTimeoutReplyTime,
        timeoutHandler: () => {
          this.reporter.info(constants.GET_USER_CHECK_TIMEOUT_TIMEOUT);
          registerUserCheckTimer(LLSyncConfig.waitGetCheckTimeoutDefaultReplyTime - LLSyncConfig.waitGetCheckTimeoutReplyTime);
        },
      },
    );

    // 注册 cleanup handler
    this._cleanupUserCheckHandleAfterCancel = () => {
      console.log('process cleanup user check handler');
      userCheckPromise.reject(null);
      // 解绑掉事件，避免再意外触发
      // @ts-ignore
      this.llSyncCore.off(constants.BIND_AUTH);

      // 执行结束后复原
      this._cleanupUserCheckHandleAfterCancel = noop;
    };

    // 2. 拿到超时时长后，等待用户确认，监听绑定事件，用户确认后会拿到用户确认结果以及签名
    return await Promise.race([
      userCheckPromise.promise,
      this.llSyncCore.writeAndWait4Response(
        bindDeviceData,
        constants.BIND_AUTH,
        (data) => {
          if (!data.length) {
            throw { code: constants.CONNECT_REPLY_INVALID };
          }

          // 解析data消息
          const userCheckResult = !(utils.getStrLength(data) >> 15);
          const sign = data.slice(2, 22).join('');
          const deviceName = hex2str(data.slice(22));

          console.log('bind auth response', userCheckResult);

          if (!userCheckResult) {
            throw { code: constants.GET_USER_CHECK_REJECT };
          } else {
            const resolveParam = {
              sign: sign.toLocaleLowerCase(),
              // 设备端会加60
              timestamp: timestamp + 60,
              nonce,
              deviceName,
              userCheckResult,
            };
            this.reporter.info(constants.TIME_SYNC, resolveParam);
            return resolveParam;
          }
        },
      ),
    ]);
  }

  // 取消用户确认，通知设备，两种原因：超时、用户主动取消
  cancelUserCheck(reason: 'timeout' | 'cancel' = 'timeout') {
    console.log('cancel user check, reason: ', reason);
    if (reason === 'cancel') {
      this._cleanupUserCheckHandleAfterCancel();
    }

    // 把超时状态写给设备
    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.USER_CHECK_TIMEOUT]}${U8ToHexString(reason === 'timeout' ? constants.WRITE_USER_CHECK_TIMEOUT : constants.WRITE_USER_CHECK_CANCEL)}`;
    this.deviceAdapter.write(data, {
      writeId: constants.DEVICE_INFO_WRITE_ID,
    });
  }

  getDeviceAuthInfo(): Promise<WriteConInfoResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const data = this._parseDataBeforeConnect(
      `${constants.DEVICE_INFO_WRITE_PREFIX[constants.CONNECT_AUTH]}${timestamp.toString(16)}${utils.encrypt(timestamp, this.llSyncCore.localPsk)}`,
      constants.CONNECT_AUTH,
    );

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.CONNECT_AUTH,
      (data) => {
        if (!data.length) {
          throw {
            code: constants.CONNECT_REPLY_INVALID,
          };
        }
        // 解析data消息
        const sign = data.slice(2, 22).join('');

        return {
          sign: sign.toLocaleLowerCase(),
          timestamp,
        };
      },
      {
        timeout: LLSyncConfig.waitConnectReplyTime,
        timeoutCode: constants.WAIT_CONNECT_REPLY_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  async getDeviceInfo(): Promise<{ version: number; mtu: number; needSetMtu: boolean; otaVersion: string }> {
    return this.llSyncCore.writeAndWait4Response(
      constants.DEVICE_INFO_WRITE_PREFIX[constants.CONNECT_RESULT_WRITE_SUCCESS],
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
        // 后面要判断length
        const otaVersion = data.slice(6).join('');

        return {
          version,
          mtu,
          needSetMtu,
          otaVersion: otaVersion ? hex2str(otaVersion) : otaVersion,
        };
      },
      {
        timeout: LLSyncConfig.waitGetDeviceInfoTime,
        timeoutCode: constants.WAIT_GET_DEVICE_INFO_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  /**
   *
   * @param type {string} success|fail
   * @param mtu {number} mtu的值
   */
  writeMtuResult(type) {
    const body = type === 'success' ? 0 : 0xffff;
    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.WRITE_MTU_RESULT]}${utils.U16ToHexString(body)}`;
    this.deviceAdapter.write(data, {
      writeId: constants.DEVICE_INFO_WRITE_ID,
    });
  }


  getUnbindAuthSign(): Promise<{ sign: string }> {
    const data = this._parseDataBeforeConnect(
      `${constants.DEVICE_INFO_WRITE_PREFIX[constants.UNBIND_AUTH]}${utils.encrypt(constants.UNBIND_REQUEST, this.llSyncCore.localPsk)}`,
      constants.UNBIND_AUTH,
    );

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.UNBIND_AUTH,
      (data) => {
        if (!data.length) {
          throw {
            code: constants.UNBIND_REPLY_INVALID,
          };
        }
        // 解析data消息
        const sign = data.slice(2, 22).join('');

        return {
          sign: sign.toLocaleLowerCase(),
        };
      },
      {
        timeout: LLSyncConfig.waitConnectReplyTime,
        timeoutCode: constants.WAIT_UNBIND_REPLY_TIMEOUT,
        writeId: constants.DEVICE_INFO_WRITE_ID,
      },
    );
  }

  controlDeviceAction(action): Promise<{ success: boolean; output: string[] }> {
    const { actionIndex, tlvData, tmpData } = utils.convertActionControlToTlv(action, this.llSyncCore.dataTemplate);

    const data = this.llSyncCore.sliceData(
      [
        utils.getTypeHead(constants.DEVICE_DATA_WRITE_HEAD[constants.CONTROL_ACTION], actionIndex),
        utils.U16ToHexString(tlvData.length),
        ...tlvData,
      ],
      tmpData,
      constants.CONTROL_ACTION,
    );

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.ACTION_REPLY,
      (data) => {
        if (!data.length) {
          throw {
            code: constants.CONTROL_REPLY_INVALID,
          };
        }

        const code = parseInt(data.slice(2, 3).join(''), 16);
        const output = data.slice(3);
        if (code === 0) {
          return {
            success: true,
            output,
          };
        } else {
          throw {
            code: constants.CONTROL_REPLY_CODE_INVALID,
            errCode: code,
          };
        }
      },
      {
        timeout: LLSyncConfig.waitControlReplyTime,
        timeoutCode: constants.WAIT_CONTROL_ACTION_REPLY_TIMEOUT,
        writeId: constants.DEVICE_DATA_WRITE_ID,
        wrapSplitDataMode: constants.ACTION_REPLY,
      },
    );
  }

  controlDeviceProperty(properties) {
    const { tlvData, tmpData } = utils.convertPropertiesChangeToTlv(properties, this.llSyncCore.dataTemplate);

    const data = this.llSyncCore.sliceData(
      [
        utils.getTypeHead(
          constants.DEVICE_DATA_WRITE_HEAD[constants.CONTROL_DEVICE],
          constants.DEVICE_DATA_WRITE_SUFFIX[constants.CONTROL_DEVICE],
        ),
        utils.U16ToHexString(tlvData.length),
        ...tlvData,
      ],
      tmpData,
      constants.CONTROL_DEVICE,
    );

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.CONTROL_REPLY,
      (data) => {
        if (!data.length) {
          throw {
            code: constants.CONTROL_REPLY_INVALID,
          };
        }
        const code = parseInt(data.slice(2).join(''), 16);
        if (code === 0) {
          return { code: 0 };
        } else {
          throw {
            code: constants.CONTROL_REPLY_CODE_INVALID,
            errCode: code,
          };
        }
      },
      {
        timeout: LLSyncConfig.waitControlReplyTime,
        timeoutCode: constants.WAIT_CONTROL_DEVICE_REPLY_TIMEOUT,
        writeId: constants.DEVICE_DATA_WRITE_ID,
      },
    );
  }

  /**
   * 各类响应
   */
  async reportBindSuccess(bindStartTime) {
    const localPsk = utils.gen4BytesIntHex();

    this.reporter.info(constants.BIND_AUTH_SUCCESS, {
      identify: this.llSyncCore.userIdentify,
      localPsk,
      timeCost: Date.now() - bindStartTime,
    });

    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.BIND_AUTH_SUCCESS]}${constants.DEVICE_INFO_WRITE_PREFIX[constants.BIND_AUTH_SUCCESS]}${localPsk}${this.llSyncCore.userIdentify}`;

    // TODO: 不需要保证写成功？
    this.llSyncCore.writeData(this._parseDataBeforeConnect(data, constants.BIND_AUTH_SUCCESS), {
      writeId: constants.DEVICE_INFO_WRITE_ID,
    });

    await setUserDeviceConfig({
      DeviceId: this.deviceAdapter.explorerDeviceId,
      DeviceKey: LLSyncConfig.BLE_PSK_DEVICE_KEY,
      DeviceValue: localPsk,
    });

    this.llSyncCore.localPsk = localPsk;
  }

  reportBindError(code) {
    const data = `${constants.DEVICE_INFO_WRITE_PREFIX[constants.BIND_AUTH_FAIL]}${str2hexStr(code)}`;
    this.deviceAdapter.write(data, {
      writeId: constants.DEVICE_INFO_WRITE_ID,
    });
  }

  reportConnectError() {
    const data = constants.DEVICE_INFO_WRITE_PREFIX[constants.CONNECT_RESULT_WRITE_FAIL];
    this.deviceAdapter.write(data, {
      writeId: constants.DEVICE_INFO_WRITE_ID,
    });
  }

  reportPropertyReportResult(code = 0) {
    const {
      DEVICE_DATA_WRITE_HEAD,
      DEVICE_DATA_WRITE_SUFFIX,
      REPORT_RESULT,
      DEVICE_DATA_WRITE_ID,
    } = constants;
    const data = `${utils.getTypeHead(DEVICE_DATA_WRITE_HEAD[REPORT_RESULT], DEVICE_DATA_WRITE_SUFFIX[REPORT_RESULT])}${byteUtil.byteToHex(byteUtil.convertNumberToByte(code))}`;
    this.deviceAdapter.write(data, {
      writeId: DEVICE_DATA_WRITE_ID,
    });
  }

  reportEventReportResult(code = 0, eventIndex) {
    const {
      DEVICE_DATA_WRITE_HEAD,
      EVENT_REPLY,
      DEVICE_DATA_WRITE_ID,
    } = constants;
    const data = `${utils.getTypeHead(DEVICE_DATA_WRITE_HEAD[EVENT_REPLY], eventIndex)}${byteUtil.byteToHex(byteUtil.convertNumberToByte(code))}`;

    this.deviceAdapter.write(data, {
      writeId: DEVICE_DATA_WRITE_ID,
    });
  }

  reportGetStatusResult(code = 0, tlvData?, tmpData?) {
    const {
      DEVICE_DATA_WRITE_HEAD,
      DEVICE_DATA_WRITE_SUFFIX,
      GET_STATUS,
      DEVICE_DATA_WRITE_ID,
    } = constants;
    // 因为要处理分片，都做为数组来处理吧
    let data = [`${utils.getTypeHead(DEVICE_DATA_WRITE_HEAD[GET_STATUS], DEVICE_DATA_WRITE_SUFFIX[GET_STATUS])}`, byteUtil.byteToHex(byteUtil.convertNumberToByte(code))];
    if (tlvData) {
      data = this.llSyncCore.sliceData(
        data.concat([utils.U16ToHexString(tlvData.length), ...tlvData]),
        tmpData,
        constants.GET_STATUS,
      );
    }

    this.llSyncCore.writeData(data, {
      writeId: DEVICE_DATA_WRITE_ID,
    });
  }

  reportUnbindResult(mode) {
    let data = constants.DEVICE_INFO_WRITE_PREFIX[constants.UNBIND_RESULT_AUTH_SUCCESS];
    if (mode === 'fail') {
      data = constants.DEVICE_INFO_WRITE_PREFIX[constants.UNBIND_RESULT_AUTH_FAIL];
    }
    return this.deviceAdapter.write(data, {
      writeId: constants.DEVICE_INFO_WRITE_ID,
    });
  }

  /**
   * Helpers
   */
  _parseDataBeforeConnect(data, mode) {
    // setMtuBeforeConnect 的逻辑
    const version = this.deviceAdapter.extendInfo.moduleVersion;

    let mtuLength;

    if (version) {
      mtuLength = LLSyncConfig.mtuDefaultMap[version];
      if (version >= 2) {
        // version为1以上都支持mtulength为20
        mtuLength = LLSyncConfig.mtuDefaultMap[2];
      }
    }

    this.reporter.info(constants.SET_MTU_BEFORE_CONNECT, {
      version,
      mtuLength,
    });
    this.llSyncCore.bleVersion = version;
    // 重新设置一下mtu，在连接之后还会重新设置，所以连接之后的操作不会被这里影响
    this.llSyncCore.mtu = mtuLength;

    const tlvData = byteUtil.hexString2hexArray(data.slice(2));
    // tmpdata是每次发送数据包的最小单位的组成的数组，比如发送属性的话，只能一个属性一个属性的发
    const tmpData = [tlvData];
    let originData = [data.slice(0, 2)];
    // version 为 1+之后都要加上数据的长度
    if (version as number > 0) {
      originData.push(utils.U16ToHexString(tlvData.length));
    }
    originData = originData.concat(tlvData);

    return this.llSyncCore.sliceData(originData, tmpData, mode);
  }
}
