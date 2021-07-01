# iotexplorer-appdev-jssdk

## 开始开发

1. yarn install (由于使用了 yarn workspaces 特性（整个工程复用根目录的 node_modules），所以请勿使用 npm install)
2. npm run init 初始化工程下所有包的依赖，并将相互间的依赖用npm link 关联（方便本地开发）
3. 开始各包开发

## 发布beta版

1. npm run build
2. git commit 变更
3. npm run publish:beta，会自动判断出需要发布的包，依次选择版本号

## 发布正式包

1. npm run build
2. git commit 变更
3. npm run publish

## 发布私有包（gree-softap）

1. 移除 package.json 的 private: true（加上 private 的话 lerna 不会发布这个包）
2. tnpm publish
3. 加回 private: true
