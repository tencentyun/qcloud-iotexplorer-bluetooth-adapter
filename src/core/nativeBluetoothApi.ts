import { pify } from '../libs/utillib';

const pifyApiArr = [
  'closeBluetoothAdapter',
  'stopBluetoothDevicesDiscovery',
  'openBluetoothAdapter',
  'getBluetoothAdapterState',
  'getBluetoothDevices',
  'startBluetoothDevicesDiscovery',
  'closeBLEConnection',
  'createBLEConnection',
  'getBLEDeviceServices',
  'getBLEDeviceCharacteristics',
  'notifyBLECharacteristicValueChange',
  'offBluetoothAdapterStateChange',
  'offBLEConnectionStateChange',
  'offBLECharacteristicValueChange',
  'offBluetoothDeviceFound',
  'writeBLECharacteristicValue',
  'setBLEMTU',
];

const callbackApiArr = [
  'onBluetoothAdapterStateChange',
  'onBLEConnectionStateChange',
  'onBLECharacteristicValueChange',
  'onBluetoothDeviceFound',
];

const apis: any = {};

pifyApiArr.forEach((apiKey) => {
  apis[apiKey] = params => pify(wx[apiKey])(params);
});

callbackApiArr.forEach((apiKey) => {
  apis[apiKey] = params => wx[apiKey](params);
});

export default apis;
