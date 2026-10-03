/**
 * Stand-in for `rvfc-polyfill` (GPL-3.0), which JASSUB imports for its side
 * effect only: it patches `HTMLVideoElement.prototype.requestVideoFrameCallback`
 * on browsers without it. Every browser JASSUB 2.x supports has the native
 * method (Chrome 83, Safari 15.4, Firefox 132), so aliasing the polyfill to
 * this empty module in vite.config.ts keeps GPL-3.0 code out of the MIT
 * bundle without changing behaviour on supported browsers.
 */
export {};
