import * as utils from './utils';
import { AppDevSdk } from 'qcloud-iotexplorer-appdev-sdk';
import * as constants from './constants';
import { arrayBufferToHexStringArray, delay, downloadFile, genPromise, noop, str2hexStr } from '@utillib';
import { StandardDeviceAdapter } from '@lib/blueTooth/adapters';
import { LLSync, LLSyncConfig } from './LLSync';
import { getDeviceOTAInfo, reportOTAVersion } from '@models';

const {
  CryptoJS,
  byteUtil,
} = AppDevSdk.utils;

export interface OtaUpdateInfo {
  needUpdate: boolean;
  targetVersion?: string;
  otaUrl?: string;
}

export interface ProgressCallBackFun {
  (params: {
    code: string;
    msg?: string;
    detail: any;
  }): void;
}

export interface OtaUpdateFileInfo {
  fileCrc: number;
  fileSize: number;
  fileBuffer: ArrayBuffer;
}

export interface OtaUpdateProgressInfo {
  maxPackageNumPerCircle: number;
  maxLengthPerPackage: number;
  alreadyReceiveSize: number;
  retryTimeGap: number;
  retryTimes: number;
  rebootMaxTime: number;
  // 发送间隔
  sendWaitGap: number;
}

export const generateFileChunks = (fileOjb: OtaUpdateFileInfo, moduleInfo: OtaUpdateProgressInfo): ArrayBuffer[] => {
  // 从断点的地方开始分包
  let start = moduleInfo.alreadyReceiveSize;
  const dataTrunks: ArrayBuffer[] = [];
  const perPackage = moduleInfo.maxLengthPerPackage - 3;
  // 计算剩余还有没有那么多包
  const sendPackageNum = Math.min(Math.ceil((fileOjb.fileSize - start) / perPackage), moduleInfo.maxPackageNumPerCircle);

  for (let i = 0; i < sendPackageNum; i++) {
    const end = Math.min(start + perPackage, fileOjb.fileSize);
    const data: ArrayBuffer = fileOjb.fileBuffer.slice(start, end);
    // 升级数据包拼接
    dataTrunks.push(data);
    start = end;
  }

  return dataTrunks;
};


export const getPackageDataToSend = (srcData: ArrayBuffer[], seq): string[] => {
  const packageData: string[] = [];
  const type = parseInt(constants.LL_OTA_WRITE_PREFIX[constants.OTA_UPDATE_DATA], 16);

  for (let i = seq; i < srcData.length; i++) {
    // 对于i进行随机数，观察客户端丢包
    // const errorOccur = (Math.floor((Math.random() * 100)) % 100 === 1) ? 1 : 0;
    const length = srcData[i].byteLength + 1;
    packageData.push([
      utils.U8ToHexString(type),
      utils.U8ToHexString(length),
      utils.U8ToHexString(i),
      ...arrayBufferToHexStringArray(srcData[i]),
    ].join(''));
  }

  // console.log(packageData);
  return packageData;
};

export class LLSyncOtaProcessor {
  llSyncCore: LLSync;
  deviceAdapter: StandardDeviceAdapter;
  otaInProgress = false;
  _onProgressCb: ProgressCallBackFun;
  processPromise;

  get reporter() {
    return this.llSyncCore.reporter;
  }

  get otaVersion() {
    return this.llSyncCore.otaVersion;
  }

  constructor(llSyncCore) {
    this.llSyncCore = llSyncCore;
    this.deviceAdapter = llSyncCore.deviceAdapter;
  }

  onProgress(code, detail = {}) {
    // 打印日志
    const message = constants.OTA_UPDATE_STEPS_MESSAGE[code];
    this.reporter.info(code, {
      message,
      ...detail,
    });

    if (typeof this._onProgressCb === 'function') {
      this._onProgressCb({
        code,
        msg: message,
        detail,
      });
    }
  }


  cancelOta() {
    if (this.otaInProgress) {
      this.processPromise.reject({
        code: 'USER_CANCEL_OTA_UPDATE',
      });
    }
  }

  async startOta({
    onProgress,
  }: {
    onProgress: ProgressCallBackFun;
  }): Promise<{
    code: string;
    msg: string;
  }> {
    if (this.otaInProgress) {
      throw {
        code: 'OTA_UPDATE_IN_PROGRESS',
        msg: 'OTA升级进行中，请勿重复操作',
      };
    }

    this.otaInProgress = true;
    this.processPromise = genPromise();
    this._onProgressCb = onProgress;

    try {
      this.onProgress(constants.OTA_UPDATE_STEPS.GET_OTA_UPDATE_INFO);
      // 获取OTA升级信息
      const otaUpdateInfo = await this.getOtaUpdateInfo();

      // 先触发进度更新吧
      this.onProgress(constants.OTA_UPDATE_STEPS.GET_OTA_UPDATE_INFO_SUCCESS, {
        otaUpdateInfo,
      });
      if (!otaUpdateInfo.needUpdate) {
        throw {
          code: this.otaVersion ? 'MODULE_VERSION_IS_UPDATED' : 'MODULE_DONNOT_SUPPORT',
        };
      }

      this.onProgress(constants.OTA_UPDATE_STEPS.DOWNLOADING_OTA_FILE);
      // 超时返回设备端不支持，设备端返回不允许就返回MODULE_DONNOT_ALLOW
      const fileInfo = await this.downloadOtaFile(otaUpdateInfo);
      this.onProgress(constants.OTA_UPDATE_STEPS.DOWNLOAD_OTA_FILE_SUCCESS, {
        fileInfo,
      });

      this.onProgress(constants.OTA_UPDATE_STEPS.REQUEST_MODULE_UPDATE_START);
      const { supportUploadFromBreak, otaUpdateProgressInfo } = await this.sendOTARequest({
        fileInfo,
        otaUpdateInfo,
      });
      this.onProgress(constants.OTA_UPDATE_STEPS.REQUEST_MODULE_UPDATE_SUCCESS, {
        supportUploadFromBreak,
        otaUpdateProgressInfo,
      });

      this.onProgress(constants.OTA_UPDATE_STEPS.SEND_UPDATE_DATA_START);
      const start = Date.now();
      // 下发升级数据包
      // @ts-ignore
      // 开始发送数据
      await this.sendOtaFile({
        fileInfo,
        otaUpdateProgressInfo,
      });

      // await this.reportSendOtaDataSuccess();

      // 告知设备已经完成发送并检查更新状态
      const response = await this.reportAndConfirmUpdateStatus({ otaUpdateProgressInfo });

      this.onProgress(constants.OTA_UPDATE_STEPS.SEND_UPDATE_DATA_SUCCESS, {
        timeCost: Date.now() - start,
        response,
      });

      // 开始监控设备升级重启版本更新状态
      this.onProgress(constants.OTA_UPDATE_STEPS.WAITING_MODULE_UPDATE);

      const startCheckReboot = Date.now();

      await this.checkRebootStatus({ otaUpdateInfo, rebootMaxTime: otaUpdateProgressInfo.rebootMaxTime });

      this.onProgress(constants.OTA_UPDATE_STEPS.MODULE_UPDATE_SUCCESS, {
        timeCost: Date.now() - startCheckReboot,
      });

      // 清空process
      this.processPromise = null;
      return {
        code: constants.OTA_UPDATE_STEPS.MODULE_UPDATE_SUCCESS,
        msg: constants.OTA_UPDATE_STEPS_MESSAGE[constants.OTA_UPDATE_STEPS.MODULE_UPDATE_SUCCESS],
      };
    } catch (e) {
      console.log('---ota fail---', e);
      if (!e) {
        e = {};
      }

      if (e.code && constants.OTA_UPDATE_ERRORS[e.code]) {
        e.msg = `${constants.OTA_UPDATE_ERRORS[e.code]}:${e.code}`;
      } else {
        // 其余的错误，都当作固件不支持吧
        const code = 'MODULE_DONNOT_SUPPORT';
        e.msg = `${code}:${constants.OTA_UPDATE_ERRORS[code]}:${e.code}:${e.msg || e.errMsg || ''}`;
        e.code = code;
      }
      this.reporter.error('MODULE_UPDATE_FAIL', {
        error: e,
      });

      throw e;
    } finally {
      this.otaInProgress = false;
    }
  }

  async reportAndConfirmUpdateStatus({
    otaUpdateProgressInfo,
  }: {
    otaUpdateProgressInfo: OtaUpdateProgressInfo;
  }) {
    const data = `${constants.LL_OTA_WRITE_PREFIX[constants.OTA_UPDATE_DATA_END]}`;

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.UPDATE_DATA_CHECK_REPLY,
      ({ data }) => {
        console.log('---checkUpdateState---', data);
        if (!data.length) {
          throw {
            code: constants.UPDATE_REPLY_INVALID,
          };
        }

        const result = parseInt(data.slice(2).join(''), 16);
        let code = constants.MODULE_UPDATE_DATA_REPLAY_CODE_MAP[result >> 7];
        code = code === undefined ? 'MODULE_UPDATE_CHECK_FILE_FAIL' : code;
        const message = ((result << 1) & 0xff) >> 1;

        console.log('------UPDATE_DATA_CHECK_REPLY——code----', code, message);
        if (code === constants.OTA_UPDATE_STEPS.MODULE_UPDATE_CHECK_FILE_SUCCESS) {
          return { code };
        } else {
          throw {
            code,
            msg: constants.MODULE_UPDATE_REPLAY_DATA_CODE_MAP[message],
          };
        }
      },
      {
        timeout: otaUpdateProgressInfo.retryTimeGap * otaUpdateProgressInfo.retryTimes,
        timeoutCode: 'UPDATE_DATA_REPLAY_TIMEOUT',
        writeId: constants.LL_OTA_WRITE_ID,
        shouldWrapSplitDataFn: false,
      },
    );
  }

  /**
   * @description 检查是否有固件升级
   * @returns {OtaUpdateInfo} 升级信息
   */
  async getOtaUpdateInfo(): Promise<OtaUpdateInfo> {
    try {
      const {
        FirmwareURL,
        TargetVersion,
      } = await getDeviceOTAInfo({
        DeviceId: this.deviceAdapter.explorerDeviceId,
      });

      console.log('----', TargetVersion, FirmwareURL, this.otaVersion);

      const respInfo: OtaUpdateInfo = {
        needUpdate: false,
        targetVersion: TargetVersion,
        otaUrl: FirmwareURL,
      };
      // 版本不等于当前版本就需要升级
      if (this.otaVersion && TargetVersion !== this.otaVersion) {
        respInfo.needUpdate = true;
      }

      return respInfo;
    } catch (e) {
      return Promise.reject({
        code: 'GET_OTA_INFO_FAIL',
      });
    }
  }

  // 发起ota请求
  sendOTARequest({
    fileInfo,
    otaUpdateInfo,
  }: {
    fileInfo: OtaUpdateFileInfo;
    otaUpdateInfo: OtaUpdateInfo;
  }): Promise<{
    supportUploadFromBreak: boolean;
    otaUpdateProgressInfo: OtaUpdateProgressInfo;
  }> {
    const versionHexArray = byteUtil.hexString2hexArray(str2hexStr(otaUpdateInfo.targetVersion));
    const tlvData = byteUtil.hexString2hexArray(`${utils.U32ToHexString(fileInfo.fileSize)}`
      + `${utils.U32ToHexString(fileInfo.fileCrc)}`
      + `${utils.U8ToHexString(versionHexArray.length)}`
      + `${versionHexArray.join('')}`);

    const data = this.llSyncCore.sliceData([
      `${constants.LL_OTA_WRITE_PREFIX[constants.OTA_UPDATE_REQUEST]}`,
      utils.U16ToHexString(tlvData.length),
      ...tlvData,
    ], [tlvData], constants.UPDATE_REPLY);

    return this.llSyncCore.writeAndWait4Response(
      data,
      constants.UPDATE_REPLY,
      (data) => {
        console.log('receive send OTA request', data);
        if (!data.length) {
          throw {
            code: constants.UPDATE_REPLY_INVALID,
          };
        }

        const indicate = parseInt(data.slice(2, 3).join(''), 16);
        const canUpdate = !!(indicate & 0x01);
        const supportUploadFromBreak = !!((indicate >> 1) & 0x01);
        const payloadSrc = data.slice(3);

        if (!canUpdate) {
          const code = parseInt(payloadSrc.slice(0, 1), 16);

          throw {
            code: 'MODULE_DONNOT_ALLOW',
            detail: {
              code,
              msg: constants.MODULE_UPDATE_REPLAY_CODE_MAP[code],
            },
          };
        }

        const otaUpdateProgressInfo = {
          maxPackageNumPerCircle: parseInt(payloadSrc.slice(0, 1).join(''), 16),
          maxLengthPerPackage: parseInt(payloadSrc.slice(1, 2).join(''), 16),
          retryTimeGap: parseInt(payloadSrc.slice(2, 3).join(''), 16) * 1000,
          // 最多传5次
          retryTimes: 5,
          rebootMaxTime: parseInt(payloadSrc.slice(3, 4).join(''), 16) * 1000,
          alreadyReceiveSize: parseInt(payloadSrc.slice(4, 8).join(''), 16),
          sendWaitGap: parseInt(payloadSrc.slice(8, 9).join('') || 0, 16),
        };
        // 对maxLengthPerPackage针对mtu进行调整
        otaUpdateProgressInfo.maxLengthPerPackage = Math.min(otaUpdateProgressInfo.maxLengthPerPackage, this.llSyncCore.mtu);

        return {
          supportUploadFromBreak,
          otaUpdateProgressInfo,
        };
      },
      {
        timeout: LLSyncConfig.waitUpdateReplyInt,
        timeoutCode: constants.WAIT_GET_UPDATE_INFO_TIMEOUT,
        writeId: constants.LL_OTA_WRITE_ID,
      },
    );
  }

  reportSendOtaDataSuccess(): Promise<any> {
    const data = `${constants.LL_OTA_WRITE_PREFIX[constants.OTA_UPDATE_DATA_END]}`;
    return this.deviceAdapter.write(data, {
      writeId: constants.LL_OTA_WRITE_ID,
    });
  }

  async sendOtaFile({
    fileInfo,
    otaUpdateProgressInfo,
  }: {
    fileInfo: OtaUpdateFileInfo;
    otaUpdateProgressInfo: OtaUpdateProgressInfo;
  }) {
    // 发送请求
    this.onProgress(constants.OTA_UPDATE_STEPS.SEND_UPDATE_DATA_DETAIL, {
      progress: Math.ceil((otaUpdateProgressInfo.alreadyReceiveSize / fileInfo.fileSize) * 100),
    });
    const fileChunks = generateFileChunks(fileInfo, otaUpdateProgressInfo);

    const onDisconnectPromise = genPromise();
    const disconnectListener = () => {
      console.log('disconnect while send data');
      onDisconnectPromise.reject({
        code: 'BLE_CONNECTION_BREAK',
      });
    };
    this.deviceAdapter.once('disconnect', disconnectListener);

    const { fileSize } = await Promise.race([
      this.processPromise.promise,
      onDisconnectPromise.promise,
      this.sendFileChunks({
        fileChunks,
        otaUpdateProgressInfo,
      }),
    ]);

    console.log('----on--update---data-reply---then', fileSize);
    // 删除监听
    // 更新收到的文件大小
    otaUpdateProgressInfo.alreadyReceiveSize = fileSize;

    if (otaUpdateProgressInfo.alreadyReceiveSize !== fileInfo.fileSize) {
      // 整体结束
      return this.sendOtaFile({
        fileInfo,
        otaUpdateProgressInfo,
      });
    }
  }

  /**
   * 确保把一个循环的数据发送出去，否则重试5次之后失败
   */
  async sendFileChunks({
    fileChunks,
    otaUpdateProgressInfo,
    seq = 0,
    retryTime = 0,
  }: {
    fileChunks: ArrayBuffer[];
    otaUpdateProgressInfo: OtaUpdateProgressInfo;
    seq?: number;
    retryTime?: number;
  }): Promise<{ fileSize: number }> {
    console.log('----send file chunks', fileChunks, otaUpdateProgressInfo, seq, retryTime);

    if (retryTime > otaUpdateProgressInfo.retryTimes) {
      console.log('----UPDATE_DATA_REPLAY_TIMEOUT---reject---', retryTime);
      throw {
        code: 'UPDATE_DATA_REPLAY_TIMEOUT',
      };
    }

    try {
      const dataToSend = getPackageDataToSend(fileChunks, seq);
      let retryLeft = constants.UPDATE_WRITE_ERROR_TIMES_PER_CIRCLE;

      // 如果 writeData 失败，最多可以重试5次
      while (retryLeft > 0) {
        try {
          await this.llSyncCore.writeData(dataToSend, {
            writeId: constants.LL_OTA_WRITE_ID,
            // 发包间隔
            waitGap: otaUpdateProgressInfo.sendWaitGap || 10,
          });
          break;
        } catch (err) {
          console.log('---write error, retry time:---', constants.UPDATE_WRITE_ERROR_TIMES_PER_CIRCLE - retryLeft, err);
          retryLeft--;

          if (!retryLeft) {
            throw err;
          }
        }
      }

      try {
        const { seq: seqReceived, fileSize } = await this.confirmFileChunkReceived({
          otaUpdateProgressInfo,
        });

        console.log('---receive update reply', seqReceived, fileSize, fileChunks.length);

        // 收到的seq与刚发送的不同，则重发一次
        if (seqReceived !== fileChunks.length) {
          console.log(
            '---confirmFileChunkSendStatus fail---',
            'seqReceived and fileSended not match, resend file',
            seqReceived, fileChunks.length,
          );

          return this.sendFileChunks({
            fileChunks,
            otaUpdateProgressInfo,
            seq: seqReceived || seq,
            retryTime: retryTime + 1,
          });
        }

        return { fileSize };
      } catch (err) {
        console.log('---confirmFileChunkSendStatus fail---', err);

        return Promise.reject(err);
      }
    } catch (err) {
      return Promise.reject({
        code: 'BLE_WRITE_ERROR',
        ...err,
      });
    }
  }

  /**
   * 等待设备回复，确认文件包发送情况
   * @param fullLength 本次循环发送的完成数据包的总个数
   */
  confirmFileChunkReceived({
    otaUpdateProgressInfo,
  }: {
    otaUpdateProgressInfo: OtaUpdateProgressInfo;
  }): Promise<{
    seq: number;
    fileSize: number;
  }> {
    let timeoutInt: any;
    const checkDataPromise = genPromise();
    const checkDataCallback = ({ data }) => {
      // 移除掉，省的有副作用
      clearTimeout(timeoutInt);
      if (!data.length) {
        return checkDataPromise.reject({
          code: constants.UPDATE_REPLY_INVALID,
        });
      }

      const seq = parseInt(data.slice(2, 3).join(''), 16);
      const fileSize = parseInt(data.slice(3, 7).join(''), 16);

      return checkDataPromise.resolve({
        seq,
        fileSize,
      });
    };

    // 当全部发完的时候
    console.log('---confirmFileChunkReceived---:listen data');
    this.llSyncCore.once(constants.UPDATE_DATA_REPLY, checkDataCallback);

    return Promise.race<any>([
      checkDataPromise.promise,
      new Promise((r, reject) => {
        timeoutInt = setTimeout(() => {
          // @ts-ignore
          this.llSyncCore.off(constants.UPDATE_DATA_REPLY, checkDataCallback);
          reject({
            code: 'UPDATE_DATA_REPLAY_TIMEOUT',
          });
        }, otaUpdateProgressInfo.retryTimeGap * otaUpdateProgressInfo.retryTimes);
      }),
    ]);
  }

  async checkRebootStatus({
    otaUpdateInfo,
    rebootMaxTime,
  }: {
    otaUpdateInfo: OtaUpdateInfo;
    rebootMaxTime: number;
  }): Promise<any> {
    // 监听设备断开的事件，并超时最大重启事件，取消监听
    const connectBlePromise = genPromise();
    let cancelTryConnect = false;
    let connectTimes = 0;

    const connectAndCheckVersion = async () => {
      while (connectTimes <= constants.WAIT_MODULE_UPDATE_CONNECT_TIMES) {
        const { deviceName } = this.deviceAdapter;

        console.log('--try connect--', cancelTryConnect, connectTimes, deviceName);
        try {
          await this.deviceAdapter.connectDevice();
          await this.llSyncCore.authenticateConnection({
            deviceName,
          });

          // 看升级的版本号是否正确
          if (this.otaVersion !== otaUpdateInfo.targetVersion) {
            return connectBlePromise.reject({
              code: 'MODULE_UPDATE_FAIL',
            });
          }

          return connectBlePromise.resolve({
            code: constants.OTA_UPDATE_STEPS.MODULE_UPDATE_SUCCESS,
          });
        } catch (e) {
          connectTimes += 1;
          await delay(constants.WAIT_MODULE_UPDATE_CONNECT_TIME_GAP);
        }
      }

      // 超过限制，直接reject
      return connectBlePromise.reject({
        code: 'MODULE_UPDATE_CONNECT_TIMEOUT',
      });
    };

    const onDisconnect = async () => {
      console.log('--on/disconnect--');
      // 开始尝试重新连接，直到超时
      connectAndCheckVersion();
    };

    this.deviceAdapter.once('disconnect', onDisconnect);

    return await Promise.race([
      connectBlePromise.promise,
      new Promise((resolve, reject) => {
        setTimeout(() => {
          cancelTryConnect = true;
          // 解除监听
          this.deviceAdapter.off('disconnect', onDisconnect);
          reject({
            code: constants.WAIT_MODULE_UPDATE_TIMEOUT,
          });
        }, rebootMaxTime * 10);
      }),
    ]);
  }

  async downloadOtaFile(updateData: OtaUpdateInfo): Promise<OtaUpdateFileInfo> {
    // 获取文件的二进制流
    const {
      fileSize,
      fileBuffer,
    } = await downloadFile(updateData.otaUrl, {
      onProgress: (res) => {
        this.onProgress(constants.OTA_UPDATE_STEPS.DOWNLOADING_OTA_FILE_DETAIL, res);
      },
    });
    console.log(fileSize, fileBuffer);
    // 计算fileCrc
    // const fileBuffer = new Int8Array(byteUtil.stringToUtf8ByteArray('1234'));
    const crc32 = new utils.CRC32();
    crc32.update(new Int8Array(fileBuffer));
    const fileCrc = crc32.getValue();

    return {
      fileSize,
      fileCrc,
      fileBuffer,
    };
  }
}
