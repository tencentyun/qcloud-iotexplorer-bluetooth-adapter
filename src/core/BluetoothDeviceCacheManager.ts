import { storage } from "../libs/storage";

export interface BluetoothDeviceCacheInfo {
	deviceId: string;
	serviceId: string;
	name: string;
	productId?: string;
}

export class BluetoothDeviceCacheManager {
	_storageKey = '__explorer-bluetooth-deviceCacheMap';

	// deviceName -> deviceId
	deviceCacheMap: { [explorerDeviceId: string]: BluetoothDeviceCacheInfo } = {};

	async init() {
		this.deviceCacheMap = await storage.getItem(this._storageKey) || {};
	}

	setDeviceCache(deviceName, deviceInfo: BluetoothDeviceCacheInfo) {
		console.log('cache ble deviceInfo: ', deviceName, deviceInfo);

		this.deviceCacheMap[deviceName] = deviceInfo;

		storage.setItem(this._storageKey, this.deviceCacheMap);
	}

	getDeviceCache(deviceName) {
		return this.deviceCacheMap[deviceName];
	}

	removeDeviceCache(deviceName) {
		if (this.deviceCacheMap[deviceName]) {
			this.deviceCacheMap[deviceName] = null;

			storage.setItem(this._storageKey, this.deviceCacheMap);
		}
	}
}
