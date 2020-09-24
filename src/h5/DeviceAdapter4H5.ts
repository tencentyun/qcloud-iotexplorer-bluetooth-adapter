import { DeviceAdapter } from "../core";
import { arrayBufferToHexStringArray, hexToArrayBuffer } from "../libs/utillib";

export class DeviceAdapter4H5 extends DeviceAdapter {
  static helper = DeviceAdapter.helper;

  // h5 传不了 arrayBuffer过去，只能传 hexString，这里整个复写
  async write(data, writeId) {
    if (typeof data === 'string') {
      console.log('writeBLECharacteristicValue', data);
    } else if (data instanceof ArrayBuffer) {
      data = arrayBufferToHexStringArray(data).join('');
    }

    return this._write(data, writeId);
  }
}
