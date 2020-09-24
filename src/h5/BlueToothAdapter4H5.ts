import { BlueToothAdapter, BlueToothAdapterProps } from "../core";
import { BlueToothBridge } from "./BlueToothBridge";

export class BlueToothAdapter4H5 extends BlueToothAdapter {
  _blueToothBridge;

  constructor({
    h5Websocket,
    devMode,
    actions,
    ...props
  }: BlueToothAdapterProps) {
    const blueToothBridge = new BlueToothBridge({ h5Websocket });

    super({
      actions: {
        registerDevice: async ({
          deviceName,
          productId,
        }) => {
          await blueToothBridge.control('registryDevice', {
            deviceName,
            productId: this.devMode ? productId : '',
          });
        },
        bindDevice: async ({
          deviceName,
          productId,
        }) => {
          await blueToothBridge.control('bindDevice', {
            deviceName,
            productId: this.devMode ? productId : '',
          });
        },
        ...actions,
      },
      devMode,
      h5Websocket,
      bluetoothApi: blueToothBridge,
      ...props,
    });

    this._blueToothBridge = blueToothBridge;
  }
}
