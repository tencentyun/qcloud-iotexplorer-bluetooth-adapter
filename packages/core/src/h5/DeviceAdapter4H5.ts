import { DeviceAdapter } from "../base";
import { arrayBufferToHexStringArray, hexToArrayBuffer } from "../libs/utillib";

export class DeviceAdapter4H5 extends DeviceAdapter {
  constructor(props) {
    super(props);

    const h5WebsocketReady = this._h5Websocket && typeof this._h5Websocket.send === 'function';

    this.on('connect', () => {
      if (h5WebsocketReady) {
        this._h5Websocket.send('Control', {
          action: 'reportDeviceConnectStatus',
          payload: {
            connected: true,
            explorerDeviceId: this.explorerDeviceId,
            deviceId: this.deviceId,
          },
        });
      }
    }).on('disconnect', () => {
      if (h5WebsocketReady) {
        this._h5Websocket.send('Control', {
          action: 'reportDeviceConnectStatus',
          payload: {
            connected: false,
            explorerDeviceId: this.explorerDeviceId,
            deviceId: this.deviceId,
          },
        });
      }
    });
  }

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
