import { BlueToothAdapter, BlueToothAdapterProps } from "../core";
import { BlueToothBridge } from "./BlueToothBridge";

export class BlueToothAdapter4H5 extends BlueToothAdapter {
  constructor({
    bluetoothApi,
    h5Websocket,
    ...props
  }: BlueToothAdapterProps) {
    super({
      ...props,
      h5Websocket,
      bluetoothApi: new BlueToothBridge({ h5Websocket }),
    });
  }
}
