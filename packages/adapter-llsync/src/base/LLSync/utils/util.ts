import { md5 } from '@utillib';
import { AppDevSdk } from 'qcloud-iotexplorer-appdev-sdk';
import { store } from '@redux/store';
import { USER_NEED_LOGIN } from '../constants';
import { getTlvDataParser, TlvDataType } from './tlvJson';

const {
  CryptoJS,
  byteUtil,
} = AppDevSdk.utils;

export const getStrLength = hex => parseInt(hex.slice(0, 2).join(''), 16);

export const U16ToHexString = (length) => {
  const hex = length.toString(16).toUpperCase();
  return `${'0000'.slice(0, 4 - hex.length)}${hex}`;
};

export const U32ToHexString = (length) => {
  const hex = length.toString(16).toUpperCase();
  return `${'00000000'.slice(0, 8 - hex.length)}${hex}`;
};


export const U8ToHexString = (length) => {
  const hex = length.toString(16).toUpperCase();
  if (hex.length > 2) {
    throw 'length error，must less then 255';
  }
  return `${'00'.slice(0, 2 - hex.length)}${hex}`;
};

export const get8ByteFromStr = (str) => {
  const md5edStr = md5(str);
  const lowArray: number[] = byteUtil.hexStringToByteArray(md5edStr.substring(0, md5edStr.length / 2));
  const highArray: number[] = byteUtil.hexStringToByteArray(md5edStr.substring(md5edStr.length / 2));
  const intCombine: number[] = [];
  for (let i = 0; i < lowArray.length; i++) {
    intCombine[i] = lowArray[i] ^ highArray[i];
  }

  return byteUtil.byteArrayToHex(intCombine);
};

// 获取当前登陆用户的标识
export const getUserIdentify = (): string => {
  const { login } = store.getState();
  if (!login.isLogin || !login.userInfo.UserID) {
    throw {
      code: USER_NEED_LOGIN,
    };
  }
  const userId = login.userInfo.UserID;

  return get8ByteFromStr(md5(userId));
};

export const getProductDateTemplate = (productInfo) => {
  try {
    if (!productInfo) {
      throw { code: 'GET_PRODUCT_INFO_FAIL', msg: '获取产品信息失败' };
    }

    let { DataTemplate } = productInfo;

    if (typeof DataTemplate === 'string') {
      DataTemplate = JSON.parse(DataTemplate);
    }

    return DataTemplate;
  } catch (err) {
    throw {
      code: 'TEMPLATE_ERROR',
      ...err,
    };
  }
};

export const gen4BytesIntHex = () => {
  const random = Math.floor(Math.random() * Math.pow(10, 9)).toString(16);
  return `${random}${'feaa12dd'.slice(0, 8 - random.length)}`;
};

export const wrapEventHandler = (cb, dataType: TlvDataType = 'default') => {
  const dataParser = getTlvDataParser(dataType);

  return ({ data }) => {
    console.log('event triggered', data);

    const result = dataParser(data);

    console.log('----result', result, this);
    if (result !== null) {
      // TODO： 验证this指向
      cb(result);
    }
  };
};

export const encrypt = (str, psk) => {
  const secret = CryptoJS.enc.Hex.parse(String(psk));
  // @ts-ignore
  const ret = CryptoJS.HmacSHA1(String(str), secret);
  console.log('encrypt', secret, str, ret.toString(CryptoJS.enc.Hex));
  return ret.toString(CryptoJS.enc.Hex);
};

export const formatArrayToReportString = data => data.join(',');
