import { BlueToothAdapter, BlueToothAdapterProps } from "../core";
import { MpBlueToothBridge } from "./MpBlueToothBridge";
import { AppBlueToothBridge } from "./AppBlueToothBridge";

export class BlueToothAdapter4H5 extends BlueToothAdapter {
  _blueToothBridge;

  constructor({
    h5Websocket,
    appBridge,
    devMode,
    actions,
    ...props
  }: BlueToothAdapterProps) {
    const blueToothBridge = appBridge ? 
      new AppBlueToothBridge({ appBridge }) :
      new MpBlueToothBridge({ h5Websocket });

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
