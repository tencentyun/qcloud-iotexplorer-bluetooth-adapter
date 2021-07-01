/**
 * @description 物模型tlv数据到json的转换
 */
import { hex2str } from '@src/lib/utillib';
import { AppDevSdk } from 'qcloud-iotexplorer-appdev-sdk';
import * as constants from '../constants';
import { U16ToHexString, getStrLength } from './util';

type stringArray = string[];

const { byteUtil } = AppDevSdk.utils;
export const getTypeFromHead = head => parseInt(head, 16) >> 5;

export const getTypeIndexFromHead = head => parseInt(head, 16) & 0x1F;

export const getTypeHead = (head, suffix) => {
  if (typeof head === 'string') {
    head = parseInt(head, 2);
  }
  if (typeof suffix === 'string') {
    suffix = parseInt(suffix, 2);
  }
  return byteUtil.byteToHex((head << 5) | (suffix & 0x1f));
};

export const genHead = (type, id) => {
  const typeIndex = constants.TLV_TYPE_INDEX[type];
  return byteUtil.byteToHex((typeIndex << 5) | (id & 0x1f));
};

export const stringToTlv = (value) => {
  const converted = `${U16ToHexString(value.length)}${byteUtil.byteArrayToHex(byteUtil.stringToByteArray(value))}`;
  return byteUtil.hexString2hexArray(converted) || [''];
};

const parseTlv = (type: string, tlvHex: string[], hexIndex: number): {
  hexIndex: number;
  value: string;
} => {
  const {
    TLV_TYPE_LENGTH,
    BLE_IOT_DATA_TYPE_BOOL,
    BLE_IOT_DATA_TYPE_INT,
    BLE_IOT_DATA_TYPE_ENUM,
    BLE_IOT_DATA_TYPE_FLOAT,
    BLE_IOT_DATA_TYPE_TIME,
    BLE_IOT_DATA_TYPE_STRUCT,
  } = constants;
  let value;
  switch (type) {
    case BLE_IOT_DATA_TYPE_BOOL:
      value = parseInt(tlvHex[++hexIndex], 16);
      hexIndex++;
      break;
    case BLE_IOT_DATA_TYPE_TIME:
    case BLE_IOT_DATA_TYPE_ENUM:
      value = parseInt(tlvHex.slice(++hexIndex, hexIndex = hexIndex + TLV_TYPE_LENGTH[type]).join(''), 16);
      break;
    case BLE_IOT_DATA_TYPE_FLOAT:
      value = parseFloat(`${byteUtil.hexArray2Float32(tlvHex.slice(++hexIndex, hexIndex = hexIndex + TLV_TYPE_LENGTH[type]), 3)}`);
      break;
    case BLE_IOT_DATA_TYPE_INT:
      value = byteUtil.hex2Int32(tlvHex.slice(++hexIndex, hexIndex = hexIndex + TLV_TYPE_LENGTH[type]));
      break;
    case constants.BLE_IOT_DATA_TYPE_STRING: {
      let str = tlvHex.slice(++hexIndex);
      const length = getStrLength(str);
      hexIndex = hexIndex + 2;
      str = tlvHex.slice(hexIndex, hexIndex = hexIndex + length);
      value = hex2str(str);
      break;
    }
    case BLE_IOT_DATA_TYPE_STRUCT: {
      let str = tlvHex.slice(++hexIndex);
      const length = getStrLength(str);
      hexIndex = hexIndex + 2;
      str = tlvHex.slice(hexIndex, hexIndex = hexIndex + length);
      value = str;
      break;
    }
  }

  return {
    hexIndex,
    value,
  };
};


const loopParseTlv = (params, tlvHex, start = 0, inStruct = false) => {
  const retData = {};
  for (let hexIndex = start; hexIndex < tlvHex.length;) {
    const typeFromHex = getTypeFromHead(tlvHex[hexIndex]);
    const indexFromHex = getTypeIndexFromHead(tlvHex[hexIndex]);

    const param = params[indexFromHex];
    if (!param) {
      throw {
        code: 'ID_TEMPLATE_IS_NOT_EXIT',
      };
    }
    const typeFromTemp = inStruct ? param.dataType.type : param.define.type;

    console.log('---type---', typeFromHex, constants.TLV_TYPE_INDEX[typeFromTemp]);
    if (typeFromHex !== constants.TLV_TYPE_INDEX[typeFromTemp]) {
      throw {
        code: 'TYPE_IN_MODULE_IS_WRONG',
      };
    }
    const parsed = parseTlv(typeFromTemp, tlvHex, hexIndex);

    hexIndex = parsed.hexIndex;
    // 如果type是结构体的话，还需要深层次解析
    if (typeFromTemp === constants.BLE_IOT_DATA_TYPE_STRUCT) {
      console.log('STRUCT', param.define.specs, parsed.value);
      retData[param.id] = loopParseTlv(param.define.specs, parsed.value, 0, true);
    } else {
      retData[param.id] = parsed.value;
    }
  }

  return retData;
};


const getIndexMap = (templateData) => {
  const indexMap = {};
  templateData.map((temp, index) => {
    indexMap[temp.id] = index;
  });

  return indexMap;
};

const convertToTlv = (type, typeIndex, value, templateConfig = {}) => {
  const {
    BLE_IOT_DATA_TYPE_BOOL,
    BLE_IOT_DATA_TYPE_INT,
    BLE_IOT_DATA_TYPE_ENUM,
    BLE_IOT_DATA_TYPE_FLOAT,
    BLE_IOT_DATA_TYPE_TIME,
  } = constants;

  const {
    hexString2hexArray,
    int32ToHex,
    byteToHex,
    convertNumberToByte,
  } = byteUtil;
  const head = genHead(type, typeIndex);

  let valueHex: string[] = [];
  switch (type) {
    case BLE_IOT_DATA_TYPE_BOOL:
      valueHex = [byteToHex(convertNumberToByte(value))];
      break;
    case BLE_IOT_DATA_TYPE_TIME:
    case BLE_IOT_DATA_TYPE_INT:
      valueHex = hexString2hexArray(int32ToHex(value)) || [''];
      break;
    case BLE_IOT_DATA_TYPE_ENUM:
      valueHex = hexString2hexArray(U16ToHexString(value)) || [''];
      break;
    case BLE_IOT_DATA_TYPE_FLOAT:
      valueHex = byteUtil.float32ToHexArray(parseFloat(value)) || [''];
      break;
    case constants.BLE_IOT_DATA_TYPE_STRING:
      valueHex = stringToTlv(value);
      break;
    case constants.BLE_IOT_DATA_TYPE_STRUCT: {
      // 先计算tlv的数据
      const indexMap = getIndexMap(templateConfig);
      const { tlvData } = loopConvertToTlv(value, indexMap, templateConfig, true);
      const length = tlvData.length;
      valueHex = [...byteUtil.hexString2hexArray(U16ToHexString(length)), ...tlvData];
      break;
    }
  }

  return [head, ...valueHex];
};


const loopConvertToTlv = (jsObj, indexMap, templateConfig, inStruct = false) => {
  type typeData = string[];
  const tmpData: typeData[] = [];
  Object.keys(jsObj).forEach((id) => {
    const index = indexMap[id];
    if (templateConfig[index] && templateConfig[index].define) {
      console.log('to tlv', jsObj[id], templateConfig);
      const type = inStruct ? templateConfig[index].dataType.type : templateConfig[index].define.type;
      // 结构体把底层的嵌套放进去
      tmpData[index] = convertToTlv(type, index, jsObj[id], type === constants.BLE_IOT_DATA_TYPE_STRUCT ? templateConfig[index].define.specs : {});
    } else {
      throw {
        code: 'TEMPLATE_NOT_MATCH',
        detail: {
          jsObj,
          templateConfig,
        },
      };
    }
  });

  const tlvData: typeData = [];
  tmpData.map((data) => {
    if (data && data.length) {
      tlvData.push(...data);
    }
  });

  console.log('---tlvData---', tlvData);
  return { tlvData, tmpData };
};


/**
 *
 * @param {String} tlvHex tlv的十六进制字符串
 * @param {Object} templateData 物模型数据，给解析tlv数据的时候提供参考
 * @param {String} mode properties|events|actions
 */
export const tlvHex = [
  '00', '00',
  '81', '00', '00',
  '22', '00', '00', '00', '00',
  '43', '00', '0C', '64', '65', '66', '61', '75', '6C', '74', '20', '6E', '61', '6D', '65'];
export const convertPropertiesTlvToJsObject = (tlvHex, templateData) => {
  const {
    TLV_TYPE_INDEX,
    TEMPLATE_PROPERTY,
  } = constants;
  console.log('---tlvHex--', tlvHex);
  const templateForMode = templateData[TEMPLATE_PROPERTY];
  if (!templateForMode) {
    throw {
      code: 'NO_SUCH_MODE_FOR_THIS_PRODUCT',
    };
  }

  // 有些物模型万一模组没有烧录进去的话，所以也得判断设备端上报的长度
  return loopParseTlv(templateForMode, tlvHex);
};


export const convertActionControlToTlv = (action: {
  actionId: string;
  clientToken: string;
  method: 'action';
  params: any;
  timestamp: number;
}, templateData) => {
  console.log('---convertActionControlToTlv--', action);
  const templateForMode = templateData[constants.TEMPLATE_ACTIONS];
  const actionsIndexMap = getIndexMap(templateForMode);

  const index = actionsIndexMap[action.actionId];
  const actionConfig = templateForMode[index];

  const jsObj = action.params;
  const inputIndexMap = getIndexMap(actionConfig.input);

  console.log('---jsObj--', jsObj, inputIndexMap);
  const { tlvData, tmpData } = loopConvertToTlv(jsObj, inputIndexMap, actionConfig.input);
  return {
    actionIndex: index,
    tlvData,
    tmpData,
  };
};

export const convertPropertiesChangeToTlv = (jsObj, templateData) => {
  const {
    TEMPLATE_PROPERTY,
  } = constants;
  console.log('---jsObj--', jsObj, templateData);
  const templateForMode = templateData[TEMPLATE_PROPERTY];
  const propertiesIndexMap = getIndexMap(templateForMode);
  const { tlvData, tmpData } = loopConvertToTlv(jsObj, propertiesIndexMap, templateForMode);
  return { tlvData, tmpData };
};


export const eventTlvData = [
  '01',
  '60', '00', '00', '80', '3F',
];

export const convertEventTlvToJsObject = (tlvHex, templateData) => {
  const {
    TEMPLATE_EVENTS,
    TLV_TYPE_INDEX,
  } = constants;
  const eventIndex = parseInt(tlvHex[0], 16);
  const eventTemplate = templateData[TEMPLATE_EVENTS];

  const eventConfig = eventTemplate[eventIndex];
  if (!eventConfig) {
    throw {
      code: 'NO_SUCH_MODE_FOR_THIS_PRODUCT',
    };
  }
  const retData = loopParseTlv(eventConfig.params, tlvHex, 1);

  return {
    eventId: eventConfig.id,
    eventIndex,
    params: retData,
  };
};

export const convertActionOutputTlvToJsObject = (tlvHex, templateData) => {
  const actionIndex = parseInt(tlvHex[0], 16);
  const actionTemplate = templateData[constants.TEMPLATE_ACTIONS];

  const actionConfig = actionTemplate[actionIndex];
  if (!actionConfig) {
    throw {
      code: 'NO_SUCH_MODE_FOR_THIS_PRODUCT',
    };
  }
  const retData = loopParseTlv(actionConfig.output, tlvHex, 1);

  return {
    actionId: actionConfig.id,
    actionIndex,
    outputParams: retData,
  };
};

export const TlvDataTypeIndexMap = {
  [constants.PROPERTY_REPORT]: 2,
  [constants.EVENT_REPORT]: 3,
  [constants.ACTION_REPLY]: 4,
  default: 2,
};

export type TlvDataType = keyof typeof TlvDataTypeIndexMap;

/**
 * @description 处理分片的数据，把它拼起来
 * @returns {null/Array} null表示尚未完成
 */
export const getTlvDataParser = (type: TlvDataType = 'default'): Function => {
  let completeData: stringArray = [];

  return (data): stringArray | null | undefined => {
    console.log('----data----', data);
    const length = getStrLength(data);
    const splitMark = length >> 14;
    const reserveBit = (length >> 13) & 1;
    const splitType = constants.SPLIT_MAP[splitMark];
    console.log(splitMark, splitType, type);
    switch (splitType) {
      case constants.SPLIT_FIRST:
        // 蓝牙是有序的，所以在新的序列的就清空
        completeData = [...data.slice(2)];
        return null;
      case constants.SPLIT_MIDDLE:
        completeData = completeData.concat(data.slice(TlvDataTypeIndexMap[type] !== undefined ? TlvDataTypeIndexMap[type] : 2));
        return null;
      case constants.SPLIT_LAST:
        completeData = completeData.concat(data.slice(TlvDataTypeIndexMap[type] !== undefined ? TlvDataTypeIndexMap[type] : 2));
        // 插入长度字段
        completeData.splice(0, 0, ...(byteUtil.hexString2hexArray(U16ToHexString((reserveBit << 15) | completeData.length)) || []));
        console.log('----completeData---', completeData);
        return completeData;
      case constants.NOT_SPLIT:
        return data;
    }
  };
};


/**
 * @description 对数据进行分片处理
 * @returns {Array} 分片后的数据
 */
export const sliceData = (data: stringArray[], {
  head,
  mtu,
  mode,
}: {
  head: string[];
  mtu: number;
  mode: string;
}): string[] => {
  const slicedData: string[] = [];
  // 如果data里面的某一项有超过mtu的也需要分片
  const preprocessedData: stringArray[] = [];
  // head一个字节，长度2个字节
  const eachMostLength = mtu - 1 - 2;
  data.map((eachData: string[]) => {
    if (eachData.length < eachMostLength) {
      preprocessedData.push(eachData);
    } else {
      const addID = mode === constants.CONTROL_ACTION;
      for (let i = addID ? 1 : 0; i < eachData.length; i += eachMostLength) {
        if (addID) {
          preprocessedData.push([eachData[1], ...eachData.slice(i, i + eachMostLength)]);
        } else {
          preprocessedData.push(eachData.slice(i, i + eachMostLength));
        }
      }
    }
  });
  preprocessedData.map((eachData: string[], i) => {
    let joinStr = head.join('');
    let position;

    if (i === 0) {
      position = constants.SPLIT_INDEX_MAP[constants.SPLIT_FIRST];
    } else if (i === preprocessedData.length - 1) {
      position = constants.SPLIT_INDEX_MAP[constants.SPLIT_LAST];
    } else {
      position = constants.SPLIT_INDEX_MAP[constants.SPLIT_MIDDLE];
    }

    joinStr += U16ToHexString((position << 14) | eachData.length);
    joinStr += eachData.join('');
    slicedData.push(joinStr);
  });

  return slicedData;
};
