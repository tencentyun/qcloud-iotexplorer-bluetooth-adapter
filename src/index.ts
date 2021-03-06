/// <reference types="miniprogram-api-typings" />

import { arrayBufferToHexStringArray, hexToArrayBuffer, hexToStr } from "./libs/utillib";

export * from './core';
export * from './h5';
export * from './miniprogram';
export const blueToothHelper = {
  hexToArrayBuffer,
  arrayBufferToHexStringArray,
  hexToStr,
}
