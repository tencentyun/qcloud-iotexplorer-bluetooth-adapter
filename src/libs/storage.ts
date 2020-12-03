import { pify, isBrowser, isMiniProgram } from './utillib';

export interface StorageApi {
	setItem: (key: string, value: any) => any;
	getItem: (key: string) => any;
	removeItem: (key: string) => any;
}

export const storage: StorageApi = {
	async getItem(key) {
		try {
			if (isMiniProgram) {
				// @ts-ignore
				const { data } = await pify(wx.getStorage)({ key });
				return data;
			} else if (isBrowser) {
				let data = window.localStorage.getItem(key);

				if (data) {
					try {
						data = JSON.parse(data);
					} catch (err) {}
				}

				return data;
			}
		} catch (err) {
			return null;
		}
	},
	async setItem(key, data) {
		try {
			if (isMiniProgram) {
				await pify(wx.setStorage)({
					key,
					data
				});
			} else if (isBrowser) {
				if (data) {
					try {
						data = JSON.stringify(data);
					} catch (err) {}
				}

				window.localStorage.setItem(key, data);
			}
		} catch (err) {
			console.error('setStorage error', err);
		}
	},
	async removeItem(key) {
		try {
			if (isMiniProgram) {
				await pify(wx.removeStorage)({ key });
			} else if (isBrowser) {
				window.localStorage.removeItem(key);
			}
		} catch (err) {
			console.error('removeStorage error', err);
		}
	},
};
