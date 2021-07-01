import { DeviceAdapter } from '../../DeviceAdapter';
import { LLSync, LLSyncCombo } from './LLSync';

export class StandardBleComboDeviceAdapter extends DeviceAdapter {
  static serviceId16 = LLSyncCombo.serviceId16; // 搜索时匹配的serviceId
  static serviceId = LLSyncCombo.serviceId; // 服务的serviceId
  static deviceFilter = LLSyncCombo.deviceFilter; // 设备过滤

  handleBLEMessage: LLSync['handleBLEMessage'];
  bindDevice: LLSync['bindDevice'];
  reporter: any;
  llSyncCombo: any;

  get ready() {
    return this.isConnected;
  }

  constructor(props) {
    super(props);

    const llSync = new LLSync(this);
    // 初始化blecombo的个性化逻辑
    const llSyncCombo = new LLSyncCombo(llSync);
    this.llSyncCombo = llSyncCombo;

    this.on('message', llSyncCombo.notifyMessage.bind(llSync));

    Object.assign(this, {
      // 处理消息
      handleBLEMessage: llSync.handleBLEMessage.bind(llSync),
      // 设置配网格式
      setWiFiMode: llSyncCombo.setWiFiMode.bind(llSyncCombo),
      // 发送WiFi信息
      setWiFiInfo: llSyncCombo.setWiFiInfo.bind(llSyncCombo),
      // 下发WiFi连接请求，并获取连接状态
      sendConnectWiFiAndGetWiFiConnectState: llSyncCombo.sendConnectWiFiAndGetWiFiConnectState.bind(llSyncCombo),
      // 发送token
      sendToken: llSyncCombo.sendToken.bind(llSyncCombo),
      // 获取模组日志
      getModuleLog: llSyncCombo.getModuleLog.bind(llSyncCombo),
    });


    this.reporter = llSync.reporter;
  }

  // 重写连接
  async connectDevice(params) {
    await super.connectDevice(params);
    await this.llSyncCombo.afterConnectDevice.call(this.llSyncCombo, params);
  }
}
