import 'array-flat-polyfill';
import fs, { readFile, outputJson, readJSONSync } from 'fs-extra';
import flatten from 'lodash.flatten';
import path, { relative, join, basename } from 'path';
import cheerio from 'cheerio';
import prettier from 'prettier';
import { cosmiconfigSync } from 'cosmiconfig';
import { JSONPath } from 'jsonpath-plus';
import memoize from 'mem';
import slash from 'slash';
import glob from 'glob';
import get from 'lodash.get';
import diff from 'lodash.difference';
import Ajv from 'ajv';
import { rollup } from 'rollup';

const not = (fn) => (x) => !fn(x);

function isChunk(
  x,
) {
  return x && x.type === 'chunk'
}

function isAsset(
  x,
) {
  return x.type === 'asset'
}

function isString(x) {
  return typeof x === 'string'
}

function isJsonFilePath(x) {
  return isString(x) && x.endsWith('json')
}

const normalizeFilename = (p) =>
  p.replace(/\.[tj]sx?$/, '.js');

/**
 * Update the manifest source in the output bundle
 */
const updateManifest = (
  updater

,
  bundle,
  handleError,
) => {
  try {
    const manifestKey = 'manifest.json';
    const manifestAsset = bundle[manifestKey]; 

    if (!manifestAsset) {
      throw new Error(
        'No manifest.json in the rollup output bundle.',
      )
    }

    const manifest = JSON.parse(
      manifestAsset.source ,
    ); 

    const result = updater(manifest);

    manifestAsset.source = JSON.stringify(result, undefined, 2);
  } catch (error) {
    if (handleError) {
      handleError(error.message);
    } else {
      throw error
    }
  }

  return bundle
};

function reduceToRecord(srcDir) {
  if (srcDir === null || typeof srcDir === 'undefined') {
    // This would be a config error, so should throw
    throw new TypeError('srcDir is null or undefined')
  }

  return (
    inputRecord,
    filename,
  ) => {
    const name = relative(srcDir, filename)
      .split('.')
      .slice(0, -1)
      .join('.');

    if (name in inputRecord) {
      throw new Error(
        `Script files with different extensions should not share names:\n\n"${filename}"\nwill overwrite\n"${inputRecord[name]}"`,
      )
    }

    return { ...inputRecord, [name]: filename }
  }
}

const formatHtml = ($) =>
  prettier.format($.html(), { parser: 'html' });

const loadHtml = (rootPath) => (
  filePath,
) => {
  const htmlCode = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio.load(htmlCode);

  return Object.assign($, { filePath, rootPath })
};

const getRelativePath = ({
  filePath,
  rootPath,
}) => (p) => {
  const htmlFileDir = path.dirname(filePath);

  let relDir;
  if (p.startsWith('/')) {
    relDir = path.relative(process.cwd(), rootPath);
  } else {
    relDir = path.relative(process.cwd(), htmlFileDir);
  }

  return path.join(relDir, p)
};

/* -------------------- SCRIPTS -------------------- */

const getScriptElems = ($) =>
  $('script')
    .not('[data-rollup-asset]')
    .not('[src^="http:"]')
    .not('[src^="https:"]')
    .not('[src^="data:"]')
    .not('[src^="/"]');

// Mutative action
const mutateScriptElems = ({
  browserPolyfill,
}) => (
  $,
) => {
  getScriptElems($)
    .attr('type', 'module')
    .attr('src', (i, value) => {
      // FIXME: @types/cheerio is wrong for AttrFunction: index.d.ts, line 16
      // declare type AttrFunction = (i: number, currentValue: string) => any;
      // eslint-disable-next-line
      // @ts-ignore
      const replaced = value.replace(/\.[jt]sx?/g, '.js');

      return replaced
    });

  if (browserPolyfill) {
    const head = $('head');
    if (
      browserPolyfill === true ||
      (typeof browserPolyfill === 'object' &&
        browserPolyfill.executeScript)
    ) {
      head.prepend(
        '<script src="/assets/browser-polyfill-executeScript.js"></script>',
      );
    }

    head.prepend(
      '<script src="/assets/browser-polyfill.js"></script>',
    );
  }

  return $
};

const getScripts = ($) =>
  getScriptElems($).toArray();

const getScriptSrc = ($) =>
  getScripts($)
    .map((elem) => $(elem).attr('src'))
    .filter(isString)
    .map(getRelativePath($));

/* ----------------- ASSET SCRIPTS ----------------- */

const getAssets = ($) =>
  $('script')
    .filter('[data-rollup-asset="true"]')
    .not('[src^="http:"]')
    .not('[src^="https:"]')
    .not('[src^="data:"]')
    .not('[src^="/"]')
    .toArray();

const getJsAssets = ($) =>
  getAssets($)
    .map((elem) => $(elem).attr('src'))
    .filter(isString)
    .map(getRelativePath($));

/* -------------------- css ------------------- */

const getCss = ($) =>
  $('link')
    .filter('[rel="stylesheet"]')
    .not('[href^="http:"]')
    .not('[href^="https:"]')
    .not('[href^="data:"]')
    .not('[href^="/"]')
    .toArray();

const getCssHrefs = ($) =>
  getCss($)
    .map((elem) => $(elem).attr('href'))
    .filter(isString)
    .map(getRelativePath($));

/* -------------------- img ------------------- */

const getImgs = ($) =>
  $('img')
    .not('[src^="http://"]')
    .not('[src^="https://"]')
    .not('[src^="data:"]')
    .toArray();

const getFavicons = ($) =>
  $('link[rel="icon"]')
    .not('[href^="http:"]')
    .not('[href^="https:"]')
    .not('[href^="data:"]')
    .toArray();

const getImgSrcs = ($) => {
  return [
    ...getImgs($).map((elem) => $(elem).attr('src')),
    ...getFavicons($).map((elem) => $(elem).attr('href')),
  ]
    .filter(isString)
    .map(getRelativePath($))
};

const isHtml = (path) => /\.html?$/.test(path);

const name = 'html-inputs';

/* ============================================ */
/*                  HTML-INPUTS                 */
/* ============================================ */

function htmlInputs(
  htmlInputsOptions,
  /** Used for testing */
  cache = {
    scripts: [],
    html: [],
    html$: [],
    js: [],
    css: [],
    img: [],
    input: [],
  } ,
) {
  return {
    name,
    cache,

    /* ============================================ */
    /*                 OPTIONS HOOK                 */
    /* ============================================ */

    options(options) {
      // srcDir may be initialized by another plugin
      const { srcDir } = htmlInputsOptions;

      if (srcDir) {
        cache.srcDir = srcDir;
      } else {
        throw new TypeError('options.srcDir not initialized')
      }

      // Skip if cache.input exists
      // cache is dumped in watchChange hook

      // Parse options.input to array
      let input;
      if (typeof options.input === 'string') {
        input = [options.input];
      } else if (Array.isArray(options.input)) {
        input = [...options.input];
      } else if (typeof options.input === 'object') {
        input = Object.values(options.input);
      } else {
        throw new TypeError(
          `options.input cannot be ${typeof options.input}`,
        )
      }

      /* ------------------------------------------------- */
      /*                 HANDLE HTML FILES                 */
      /* ------------------------------------------------- */

      // Filter htm and html files
      cache.html = input.filter(isHtml);

      // If no html files, do nothing
      if (cache.html.length === 0) return options

      // If the cache has been dumped, reload from files
      if (cache.html$.length === 0) {
        // This is all done once
        cache.html$ = cache.html.map(loadHtml(srcDir));

        cache.js = flatten(cache.html$.map(getScriptSrc));
        cache.css = flatten(cache.html$.map(getCssHrefs));
        cache.img = flatten(cache.html$.map(getImgSrcs));
        cache.scripts = flatten(cache.html$.map(getJsAssets));

        // Cache jsEntries with existing options.input
        cache.input = input.filter(not(isHtml)).concat(cache.js);

        // Prepare cache.html$ for asset emission
        cache.html$.forEach(mutateScriptElems(htmlInputsOptions));

        if (cache.input.length === 0) {
          throw new Error(
            'At least one HTML file must have at least one script.',
          )
        }
      }

      // TODO: simply remove HTML files from options.input
      // - Parse HTML and emit chunks and assets in buildStart
      return {
        ...options,
        input: cache.input.reduce(
          reduceToRecord(htmlInputsOptions.srcDir),
          {},
        ),
      }
    },

    /* ============================================ */
    /*              HANDLE FILE CHANGES             */
    /* ============================================ */

    async buildStart() {
      const { srcDir } = htmlInputsOptions;

      if (srcDir) {
        cache.srcDir = srcDir;
      } else {
        throw new TypeError('options.srcDir not initialized')
      }

      const assets = [
        ...cache.css,
        ...cache.img,
        ...cache.scripts,
      ];

      assets.concat(cache.html).forEach((asset) => {
        this.addWatchFile(asset);
      });

      const emitting = assets.map(async (asset) => {
        // Read these files as Buffers
        const source = await readFile(asset);
        const fileName = relative(srcDir, asset);

        this.emitFile({
          type: 'asset',
          source, // Buffer
          fileName,
        });
      });

      cache.html$.map(($) => {
        const source = formatHtml($);
        const fileName = relative(srcDir, $.filePath);

        this.emitFile({
          type: 'asset',
          source, // String
          fileName,
        });
      });

      await Promise.all(emitting);
    },

    watchChange(id) {
      if (id.endsWith('.html') || id.endsWith('manifest.json')) {
        // Dump cache if html file or manifest changes
        cache.html$ = [];
      }
    },
  }
}

const code = "(function () {\n\t'use strict';\n\n\tconst importPath = /*@__PURE__*/JSON.parse('%PATH%');\n\n\timport(importPath);\n\n}());\n";

const cloneObject = (obj) => JSON.parse(JSON.stringify(obj));

const code$1 = "(function () {\n  'use strict';\n\n  function delay(ms) {\n    return new Promise((resolve) => {\n      setTimeout(resolve, ms);\n    })\n  }\n\n  function captureEvents(events) {\n    const captured = events.map(captureEvent);\n\n    return () => captured.forEach((t) => t())\n\n    function captureEvent(event) {\n      let isCapturePhase = true;\n\n      const callbacks = new Map();\n      const eventArgs = new Set();\n\n      // This is the only listener for the native event\n      event.addListener(handleEvent);\n\n      function handleEvent(...args) {\n        if (isCapturePhase) {\n          // This is before dynamic import completes\n          eventArgs.add(args);\n\n          if (typeof args[2] === 'function') {\n            // During capture phase all messages are async\n            return true\n          } else {\n            // Sync messages or some other event\n            return false\n          }\n        } else {\n          // The callbacks determine the listener return value\n          return callListeners(...args)\n        }\n      }\n\n      // Called when dynamic import is complete\n      //  and when subsequent events fire\n      function callListeners(...args) {\n        let isAsyncCallback = false;\n        callbacks.forEach((options, cb) => {\n          // A callback error should not affect the other callbacks\n          try {\n            isAsyncCallback = cb(...args) || isAsyncCallback;\n          } catch (error) {\n            console.error(error);\n          }\n        });\n\n        if (!isAsyncCallback && typeof args[2] === 'function') {\n          // We made this an async message callback during capture phase\n          //   when the function handleEvent returned true\n          //   so we are responsible to call sendResponse\n          // If the callbacks are sync message callbacks\n          //   the sendMessage callback on the other side\n          //   resolves with no arguments (this is the same behavior)\n          args[2]();\n        }\n\n        // Support events after import is complete\n        return isAsyncCallback\n      }\n\n      // This function will trigger this Event with our stored args\n      function triggerEvents() {\n        // Fire each event for this Event\n        eventArgs.forEach((args) => {\n          callListeners(...args);\n        });\n\n        // Dynamic import is complete\n        isCapturePhase = false;\n        // Don't need these anymore\n        eventArgs.clear();\n      }\n\n      // All future listeners are handled by our code\n      event.addListener = function addListener(cb, ...options) {\n        callbacks.set(cb, options);\n      };\n\n      event.hasListeners = function hasListeners() {\n        return callbacks.size > 0\n      };\n\n      event.hasListener = function hasListener(cb) {\n        return callbacks.has(cb)\n      };\n\n      event.removeListener = function removeListener(cb) {\n        callbacks.delete(cb);\n      };\n\n      event.__isCapturedEvent = true;\n\n      return triggerEvents\n    }\n  }\n\n  function resolvePath(object, path, defaultValue) {\n    return path.split('.').reduce((o, p) => (o ? o[p] : defaultValue), object) ;\n  }\n\n  const eventPaths = /*@__PURE__*/JSON.parse('%EVENTS%'); \n  const importPath = /*@__PURE__*/JSON.parse('%PATH%'); \n  const delayLength = /*@__PURE__*/JSON.parse('%DELAY%');\n\n  const events = eventPaths.map((eventPath) => resolvePath(chrome, eventPath));\n  const triggerEvents = captureEvents(events);\n\n  import(importPath).then(async () => {\n    if (delayLength) await delay(delayLength);\n\n    triggerEvents();\n  });\n\n}());\n";

const code$2 = "(function () {\n  'use strict';\n\n  function captureEvents(events) {\n    const captured = events.map(captureEvent);\n\n    return () => captured.forEach((t) => t())\n\n    function captureEvent(event) {\n      let isCapturePhase = true;\n\n      const callbacks = new Map();\n      const eventArgs = new Set();\n\n      // This is the only listener for the native event\n      event.addListener(handleEvent);\n\n      function handleEvent(...args) {\n        if (isCapturePhase) {\n          // This is before dynamic import completes\n          eventArgs.add(args);\n\n          if (typeof args[2] === 'function') {\n            // During capture phase all messages are async\n            return true\n          } else {\n            // Sync messages or some other event\n            return false\n          }\n        } else {\n          // The callbacks determine the listener return value\n          return callListeners(...args)\n        }\n      }\n\n      // Called when dynamic import is complete\n      //  and when subsequent events fire\n      function callListeners(...args) {\n        let isAsyncCallback = false;\n        callbacks.forEach((options, cb) => {\n          // A callback error should not affect the other callbacks\n          try {\n            isAsyncCallback = cb(...args) || isAsyncCallback;\n          } catch (error) {\n            console.error(error);\n          }\n        });\n\n        if (!isAsyncCallback && typeof args[2] === 'function') {\n          // We made this an async message callback during capture phase\n          //   when the function handleEvent returned true\n          //   so we are responsible to call sendResponse\n          // If the callbacks are sync message callbacks\n          //   the sendMessage callback on the other side\n          //   resolves with no arguments (this is the same behavior)\n          args[2]();\n        }\n\n        // Support events after import is complete\n        return isAsyncCallback\n      }\n\n      // This function will trigger this Event with our stored args\n      function triggerEvents() {\n        // Fire each event for this Event\n        eventArgs.forEach((args) => {\n          callListeners(...args);\n        });\n\n        // Dynamic import is complete\n        isCapturePhase = false;\n        // Don't need these anymore\n        eventArgs.clear();\n      }\n\n      // All future listeners are handled by our code\n      event.addListener = function addListener(cb, ...options) {\n        callbacks.set(cb, options);\n      };\n\n      event.hasListeners = function hasListeners() {\n        return callbacks.size > 0\n      };\n\n      event.hasListener = function hasListener(cb) {\n        return callbacks.has(cb)\n      };\n\n      event.removeListener = function removeListener(cb) {\n        callbacks.delete(cb);\n      };\n\n      event.__isCapturedEvent = true;\n\n      return triggerEvents\n    }\n  }\n\n  function delay(ms) {\n    return new Promise((resolve) => {\n      setTimeout(resolve, ms);\n    })\n  }\n\n  /**\n   * Get matches from an object of nested objects\n   *\n   * @export\n   * @template T Type of matches\n   * @param {*} object Parent object to search\n   * @param {(x: any) => boolean} pred A predicate function that will receive each property value of an object\n   * @param {string[]} excludeKeys Exclude a property if the key exactly matches\n   * @returns {T[]} The matched values from the parent object\n   */\n  function getDeepMatches(object, pred, excludeKeys) {\n    const keys = typeof object === 'object' ? Object.keys(object) : [];\n\n    return keys.length\n      ? keys\n          .filter((key) => !excludeKeys.includes(key))\n          .reduce((r, key) => {\n            const target = object[key];\n\n            if (target && pred(target)) {\n              return [...r, target]\n            } else {\n              return [...r, ...getDeepMatches(target, pred, excludeKeys)]\n            }\n          }, [] )\n      : []\n  }\n\n  const importPath = /*@__PURE__*/JSON.parse('%PATH%'); \n  const delayLength = /*@__PURE__*/JSON.parse('%DELAY%'); \n  const excludedPaths = /*@__PURE__*/JSON.parse('%EXCLUDE%');\n\n  const events = getDeepMatches(\n    chrome,\n    (x) => typeof x === 'object' && 'addListener' in x,\n    // The webRequest API is not compatible with event pages\n    //  TODO: this can be removed\n    //   if we stop using this wrapper with \"webRequest\" permission\n    excludedPaths.concat(['webRequest']),\n  );\n  const triggerEvents = captureEvents(events);\n\n  import(importPath).then(async () => {\n    if (delayLength) await delay(delayLength);\n\n    triggerEvents();\n  });\n\n}());\n";

/**
 * This options object allows fine-tuning of the dynamic import wrapper.
 *
 * @export
 * @interface DynamicImportWrapper
 */









// FEATURE: add static code analysis for wake events
//  - This will be slower...
function prepImportWrapperScript({
  eventDelay = 0,
  wakeEvents = [],
  excludeNames = ['extension'],
}) {
  const delay = JSON.stringify(eventDelay);
  const events = wakeEvents.length
    ? JSON.stringify(
        wakeEvents.map((ev) => ev.replace(/^chrome\./, '')),
      )
    : false;
  const exclude = JSON.stringify(excludeNames);

  const script = (events
    ? code$1.replace('%EVENTS%', events)
    : code$2.replace('%EXCLUDE%', exclude)
  ).replace('%DELAY%', delay);

  return script
}

const combinePerms = (
  ...permissions
) => {
  const { perms, xperms } = (permissions.flat(
    Infinity,
  ) )
    .filter((perm) => typeof perm !== 'undefined')
    .reduce(
      ({ perms, xperms }, perm) => {
        if (perm.startsWith('!')) {
          xperms.add(perm.slice(1));
        } else {
          perms.add(perm);
        }

        return { perms, xperms }
      },
      { perms: new Set(), xperms: new Set() },
    );

  return [...perms].filter((p) => !xperms.has(p))
};

/* ============================================ */
/*               CHECK PERMISSIONS              */
/* ============================================ */

// export const debugger = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*debugger/.test(s)
// export const enterprise.deviceAttributes = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*enterprise\.deviceAttributes/.test(s)
// export const enterprise.hardwarePlatform = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*enterprise\.hardwarePlatform/.test(s)
// export const enterprise.platformKeys = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*enterprise\.platformKeys/.test(s)
// export const networking.config = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*networking\.config/.test(s)
// export const system.cpu = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.cpu/.test(s)
// export const system.display = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.display/.test(s)
// export const system.memory = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.memory/.test(s)
// export const system.storage = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.storage/.test(s)

const alarms = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*alarms/.test(s);

const bookmarks = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*bookmarks/.test(s);

const contentSettings = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*contentSettings/.test(s);

const contextMenus = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*contextMenus/.test(s);

const cookies = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*cookies/.test(s);

const declarativeContent = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*declarativeContent/.test(s);
const declarativeNetRequest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*declarativeNetRequest/.test(s);
const declarativeWebRequest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*declarativeWebRequest/.test(s);
const desktopCapture = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*desktopCapture/.test(s);
const displaySource = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*displaySource/.test(s);
const dns = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*dns/.test(s);
const documentScan = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*documentScan/.test(s);
const downloads = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*downloads/.test(s);
const experimental = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*experimental/.test(s);
const fileBrowserHandler = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*fileBrowserHandler/.test(s);
const fileSystemProvider = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*fileSystemProvider/.test(s);
const fontSettings = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*fontSettings/.test(s);
const gcm = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*gcm/.test(s);
const geolocation = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*geolocation/.test(s);
const history = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*history/.test(s);
const identity = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*identity/.test(s);
const idle = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*idle/.test(s);
const idltest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*idltest/.test(s);
const management = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*management/.test(s);
const nativeMessaging = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*nativeMessaging/.test(s);
const notifications = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*notifications/.test(s);
const pageCapture = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*pageCapture/.test(s);
const platformKeys = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*platformKeys/.test(s);
const power = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*power/.test(s);
const printerProvider = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*printerProvider/.test(s);
const privacy = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*privacy/.test(s);
const processes = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*processes/.test(s);
const proxy = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*proxy/.test(s);
const sessions = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*sessions/.test(s);
const signedInDevices = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*signedInDevices/.test(s);
const storage = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*storage/.test(s);
const tabCapture = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*tabCapture/.test(s);
// export const tabs = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*tabs/.test(s)
const topSites = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*topSites/.test(s);
const tts = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*tts/.test(s);
const ttsEngine = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*ttsEngine/.test(s);
const unlimitedStorage = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*unlimitedStorage/.test(s);
const vpnProvider = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*vpnProvider/.test(s);
const wallpaper = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*wallpaper/.test(s);
const webNavigation = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*webNavigation/.test(s);
const webRequest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*webRequest/.test(s);
const webRequestBlocking = (s) =>
  webRequest(s) && s.includes('\'blocking\'');

// TODO: add readClipboard
// TODO: add writeClipboard

var permissions = /*#__PURE__*/Object.freeze({
  __proto__: null,
  alarms: alarms,
  bookmarks: bookmarks,
  contentSettings: contentSettings,
  contextMenus: contextMenus,
  cookies: cookies,
  declarativeContent: declarativeContent,
  declarativeNetRequest: declarativeNetRequest,
  declarativeWebRequest: declarativeWebRequest,
  desktopCapture: desktopCapture,
  displaySource: displaySource,
  dns: dns,
  documentScan: documentScan,
  downloads: downloads,
  experimental: experimental,
  fileBrowserHandler: fileBrowserHandler,
  fileSystemProvider: fileSystemProvider,
  fontSettings: fontSettings,
  gcm: gcm,
  geolocation: geolocation,
  history: history,
  identity: identity,
  idle: idle,
  idltest: idltest,
  management: management,
  nativeMessaging: nativeMessaging,
  notifications: notifications,
  pageCapture: pageCapture,
  platformKeys: platformKeys,
  power: power,
  printerProvider: printerProvider,
  privacy: privacy,
  processes: processes,
  proxy: proxy,
  sessions: sessions,
  signedInDevices: signedInDevices,
  storage: storage,
  tabCapture: tabCapture,
  topSites: topSites,
  tts: tts,
  ttsEngine: ttsEngine,
  unlimitedStorage: unlimitedStorage,
  vpnProvider: vpnProvider,
  wallpaper: wallpaper,
  webNavigation: webNavigation,
  webRequest: webRequest,
  webRequestBlocking: webRequestBlocking
});

/* ============================================ */
/*              DERIVE PERMISSIONS              */
/* ============================================ */

const derivePermissions = (
  set,
  { code },
) =>
  Object.entries(permissions)
    .filter(([, fn]) => fn(code))
    .map(([key]) => key)
    .reduce((s, p) => s.add(p), set);

// /* ============================================ */
// /*                DERIVE MANIFEST               */
// /* ============================================ */

// export function deriveManifest(
//   manifest: ChromeExtensionManifest, // manifest.json
//   ...permissions: string[] | string[][] // will be combined with manifest.permissions
// ): ChromeExtensionManifest {
//   return validateManifest({
//     // SMELL: Is this necessary?
//     manifest_version: 2,
//     ...manifest,
//     permissions: combinePerms(permissions, manifest.permissions),
//   })
// }

/* -------------------------------------------- */
/*                 DERIVE FILES                 */
/* -------------------------------------------- */

function deriveFiles(
  manifest,
  srcDir,
) {
  const files = get(
    manifest,
    'web_accessible_resources',
    [] ,
  ).reduce((r, x) => {
    if (glob.hasMagic(x)) {
      const files = glob.sync(x, { cwd: srcDir });
      return [...r, ...files.map((f) => f.replace(srcDir, ''))]
    } else {
      return [...r, x]
    }
  }, [] );

  const js = [
    ...files.filter((f) => /\.[jt]sx?$/.test(f)),
    ...get(manifest, 'background.scripts', [] ),
    ...get(
      manifest,
      'content_scripts',
      [] ,
    ).reduce((r, { js = [] }) => [...r, ...js], [] ),
  ];

  const html = [
    ...files.filter((f) => /\.html?$/.test(f)),
    get(manifest, 'background.page'),
    get(manifest, 'options_page'),
    get(manifest, 'options_ui.page'),
    get(manifest, 'devtools_page'),
    get(manifest, 'browser_action.default_popup'),
    get(manifest, 'page_action.default_popup'),
    ...Object.values(get(manifest, 'chrome_url_overrides', {})),
  ];

  const css = [
    ...files.filter((f) => f.endsWith('.css')),
    ...get(
      manifest,
      'content_scripts',
      [] ,
    ).reduce(
      (r, { css = [] }) => [...r, ...css],
      [] ,
    ),
  ];

  // TODO: this can be a string or object
  const actionIconSet = [
    'browser_action.default_icon',
    'page_action.default_icon',
  ].reduce((set, query) => {
    const result = get(
      manifest,
      query,
      {},
    );

    if (typeof result === 'string') {
      set.add(result);
    } else {
      Object.values(result).forEach((x) => set.add(x));
    }

    return set
  }, new Set());

  const img = [
    ...actionIconSet,
    ...files.filter((f) =>
      /\.(jpe?g|png|svg|tiff?|gif|webp|bmp|ico)$/i.test(f),
    ),
    ...Object.values(get(manifest, 'icons', {})),
  ];

  // Files like fonts, things that are not expected
  const others = diff(files, css, js, html, img);

  return {
    css: validate(css),
    js: validate(js),
    html: validate(html),
    img: validate(img),
    others: validate(others),
  }

  function validate(ary) {
    return [...new Set(ary.filter(isString))].map((x) =>
      join(srcDir, x),
    )
  }

  function isString(x) {
    return typeof x === 'string'
  }
}

var id = "http://json-schema.org/draft-04/schema#";
var $schema = "http://json-schema.org/draft-04/schema#";
var description = "Core schema meta-schema";
var definitions = {
	schemaArray: {
		type: "array",
		minItems: 1,
		items: {
			$ref: "#"
		}
	},
	positiveInteger: {
		type: "integer",
		minimum: 0
	},
	positiveIntegerDefault0: {
		allOf: [
			{
				$ref: "#/definitions/positiveInteger"
			},
			{
				"default": 0
			}
		]
	},
	simpleTypes: {
		"enum": [
			"array",
			"boolean",
			"integer",
			"null",
			"number",
			"object",
			"string"
		]
	},
	stringArray: {
		type: "array",
		items: {
			type: "string"
		},
		minItems: 1,
		uniqueItems: true
	}
};
var type = "object";
var properties = {
	id: {
		type: "string"
	},
	$schema: {
		type: "string"
	},
	title: {
		type: "string"
	},
	description: {
		type: "string"
	},
	"default": {
	},
	multipleOf: {
		type: "number",
		minimum: 0,
		exclusiveMinimum: true
	},
	maximum: {
		type: "number"
	},
	exclusiveMaximum: {
		type: "boolean",
		"default": false
	},
	minimum: {
		type: "number"
	},
	exclusiveMinimum: {
		type: "boolean",
		"default": false
	},
	maxLength: {
		$ref: "#/definitions/positiveInteger"
	},
	minLength: {
		$ref: "#/definitions/positiveIntegerDefault0"
	},
	pattern: {
		type: "string",
		format: "regex"
	},
	additionalItems: {
		anyOf: [
			{
				type: "boolean"
			},
			{
				$ref: "#"
			}
		],
		"default": {
		}
	},
	items: {
		anyOf: [
			{
				$ref: "#"
			},
			{
				$ref: "#/definitions/schemaArray"
			}
		],
		"default": {
		}
	},
	maxItems: {
		$ref: "#/definitions/positiveInteger"
	},
	minItems: {
		$ref: "#/definitions/positiveIntegerDefault0"
	},
	uniqueItems: {
		type: "boolean",
		"default": false
	},
	maxProperties: {
		$ref: "#/definitions/positiveInteger"
	},
	minProperties: {
		$ref: "#/definitions/positiveIntegerDefault0"
	},
	required: {
		$ref: "#/definitions/stringArray"
	},
	additionalProperties: {
		anyOf: [
			{
				type: "boolean"
			},
			{
				$ref: "#"
			}
		],
		"default": {
		}
	},
	definitions: {
		type: "object",
		additionalProperties: {
			$ref: "#"
		},
		"default": {
		}
	},
	properties: {
		type: "object",
		additionalProperties: {
			$ref: "#"
		},
		"default": {
		}
	},
	patternProperties: {
		type: "object",
		additionalProperties: {
			$ref: "#"
		},
		"default": {
		}
	},
	dependencies: {
		type: "object",
		additionalProperties: {
			anyOf: [
				{
					$ref: "#"
				},
				{
					$ref: "#/definitions/stringArray"
				}
			]
		}
	},
	"enum": {
		type: "array",
		minItems: 1,
		uniqueItems: true
	},
	type: {
		anyOf: [
			{
				$ref: "#/definitions/simpleTypes"
			},
			{
				type: "array",
				items: {
					$ref: "#/definitions/simpleTypes"
				},
				minItems: 1,
				uniqueItems: true
			}
		]
	},
	format: {
		type: "string"
	},
	allOf: {
		$ref: "#/definitions/schemaArray"
	},
	anyOf: {
		$ref: "#/definitions/schemaArray"
	},
	oneOf: {
		$ref: "#/definitions/schemaArray"
	},
	not: {
		$ref: "#"
	}
};
var dependencies = {
	exclusiveMaximum: [
		"maximum"
	],
	exclusiveMinimum: [
		"minimum"
	]
};
var jsonSchema = {
	id: id,
	$schema: $schema,
	description: description,
	definitions: definitions,
	type: type,
	properties: properties,
	dependencies: dependencies,
	"default": {
}
};

var title = "JSON schema for Google Chrome extension manifest files";
var $schema$1 = "http://json-schema.org/draft-04/schema#";
var type$1 = "object";
var additionalProperties = true;
var required = [
	"manifest_version",
	"name",
	"version"
];
var properties$1 = {
	manifest_version: {
		type: "number",
		description: "One integer specifying the version of the manifest file format your package requires.",
		"enum": [
			2
		],
		minimum: 2,
		maximum: 2
	},
	name: {
		type: "string",
		description: "The name of the extension",
		maxLength: 45
	},
	version: {
		description: "One to four dot-separated integers identifying the version of this extension.",
		$ref: "#/definitions/version_string"
	},
	default_locale: {
		type: "string",
		description: "Specifies the subdirectory of _locales that contains the default strings for this extension.",
		"default": "en"
	},
	description: {
		type: "string",
		description: "A plain text description of the extension",
		maxLength: 132
	},
	icons: {
		type: "object",
		description: "One or more icons that represent the extension, app, or theme. Recommended format: PNG; also BMP, GIF, ICO, JPEG.",
		minProperties: 1,
		properties: {
			"16": {
				$ref: "#/definitions/icon",
				description: "Used as the favicon for an extension's pages and infobar."
			},
			"48": {
				$ref: "#/definitions/icon",
				description: "Used on the extension management page (chrome://extensions)."
			},
			"128": {
				$ref: "#/definitions/icon",
				description: "Used during installation and in the Chrome Web Store."
			},
			"256": {
				$ref: "#/definitions/icon",
				description: "Used during installation and in the Chrome Web Store."
			}
		}
	},
	browser_action: {
		$ref: "#/definitions/action",
		description: "Use browser actions to put icons in the main Google Chrome toolbar, to the right of the address bar. In addition to its icon, a browser action can also have a tooltip, a badge, and a popup."
	},
	page_action: {
		$ref: "#/definitions/action",
		description: "Use the chrome.pageAction API to put icons inside the address bar. Page actions represent actions that can be taken on the current page, but that aren't applicable to all pages."
	},
	background: {
		type: "object",
		description: "The background page is an HTML page that runs in the extension process. It exists for the lifetime of your extension, and only one instance of it at a time is active.",
		properties: {
			persistent: {
				type: "boolean",
				description: "When false, makes the background page an event page (loaded only when needed).",
				"default": true
			},
			page: {
				$ref: "#/definitions/page",
				description: "Specify the HTML of the background page.",
				"default": "background.html"
			},
			scripts: {
				$ref: "#/definitions/scripts",
				description: "A background page will be generated by the extension system that includes each of the files listed in the scripts property.",
				"default": [
					"background.js"
				]
			}
		},
		dependencies: {
			page: {
				not: {
					required: [
						"scripts"
					]
				}
			},
			scripts: {
				not: {
					required: [
						"page"
					]
				}
			}
		}
	},
	chrome_url_overrides: {
		type: "object",
		description: "Override pages are a way to substitute an HTML file from your extension for a page that Google Chrome normally provides.",
		additionalProperties: false,
		maxProperties: 1,
		properties: {
			bookmarks: {
				$ref: "#/definitions/page",
				description: "The page that appears when the user chooses the Bookmark Manager menu item from the Chrome menu or, on Mac, the Bookmark Manager item from the Bookmarks menu. You can also get to this page by entering the URL chrome://bookmarks.",
				"default": "bookmarks.html"
			},
			history: {
				$ref: "#/definitions/page",
				description: "The page that appears when the user chooses the History menu item from the Chrome menu or, on Mac, the Show Full History item from the History menu. You can also get to this page by entering the URL chrome://history.",
				"default": "history.html"
			},
			newtab: {
				$ref: "#/definitions/page",
				description: "The page that appears when the user creates a new tab or window. You can also get to this page by entering the URL chrome://newtab.",
				"default": "newtab.html"
			}
		}
	},
	commands: {
		type: "object",
		description: "Use the commands API to add keyboard shortcuts that trigger actions in your extension, for example, an action to open the browser action or send a command to the extension.",
		patternProperties: {
			".*": {
				$ref: "#/definitions/command"
			},
			"^_execute_browser_action$": {
				$ref: "#/definitions/command"
			},
			"^_execute_page_action$": {
				$ref: "#/definitions/command"
			}
		}
	},
	content_scripts: {
		type: "array",
		description: "Content scripts are JavaScript files that run in the context of web pages.",
		minItems: 1,
		uniqueItems: true,
		items: {
			type: "object",
			required: [
				"matches"
			],
			additionalProperties: false,
			properties: {
				matches: {
					type: "array",
					description: "Specifies which pages this content script will be injected into.",
					minItems: 1,
					uniqueItems: true,
					items: {
						$ref: "#/definitions/match_pattern"
					}
				},
				exclude_matches: {
					type: "array",
					description: "Excludes pages that this content script would otherwise be injected into.",
					uniqueItems: true,
					items: {
						$ref: "#/definitions/match_pattern"
					}
				},
				css: {
					type: "array",
					description: "The list of CSS files to be injected into matching pages. These are injected in the order they appear in this array, before any DOM is constructed or displayed for the page.",
					uniqueItems: true,
					items: {
						$ref: "#/definitions/uri"
					}
				},
				js: {
					$ref: "#/definitions/scripts",
					description: "The list of JavaScript files to be injected into matching pages. These are injected in the order they appear in this array."
				},
				run_at: {
					type: "string",
					description: "Controls when the files in js are injected.",
					"enum": [
						"document_start",
						"document_end",
						"document_idle"
					],
					"default": "document_idle"
				},
				all_frames: {
					type: "boolean",
					description: "Controls whether the content script runs in all frames of the matching page, or only the top frame.",
					"default": false
				},
				match_origin_as_fallback: {
					type: "boolean",
					description: "Controls whether the content script runs in all frames of the matching page, or only the top frame.",
					"default": false
				},
				include_globs: {
					type: "array",
					description: "Applied after matches to include only those URLs that also match this glob. Intended to emulate the @include Greasemonkey keyword.",
					uniqueItems: true,
					items: {
						$ref: "#/definitions/glob_pattern"
					}
				},
				exclude_globs: {
					type: "array",
					description: "Applied after matches to exclude URLs that match this glob. Intended to emulate the @exclude Greasemonkey keyword.",
					uniqueItems: true,
					items: {
						$ref: "#/definitions/glob_pattern"
					}
				},
				match_about_blank: {
					type: "boolean",
					description: "Whether to insert the content script on about:blank and about:srcdoc.",
					"default": false
				}
			}
		}
	},
	content_security_policy: {
		$ref: "#/definitions/content_security_policy"
	},
	devtools_page: {
		$ref: "#/definitions/page",
		description: "A DevTools extension adds functionality to the Chrome DevTools. It can add new UI panels and sidebars, interact with the inspected page, get information about network requests, and more."
	},
	externally_connectable: {
		type: "object",
		description: "Declares which extensions, apps, and web pages can connect to your extension via runtime.connect and runtime.sendMessage.",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				ids: {
					type: "array",
					items: {
						type: "string",
						description: "The IDs of extensions or apps that are allowed to connect. If left empty or unspecified, no extensions or apps can connect."
					}
				},
				matches: {
					type: "array",
					items: {
						type: "string",
						description: "The URL patterns for web pages that are allowed to connect. This does not affect content scripts. If left empty or unspecified, no web pages can connect."
					}
				},
				accepts_tls_channel_id: {
					type: "boolean",
					"default": false,
					description: "Indicates that the extension would like to make use of the TLS channel ID of the web page connecting to it. The web page must also opt to send the TLS channel ID to the extension via setting includeTlsChannelId to true in runtime.connect's connectInfo or runtime.sendMessage's options."
				}
			}
		}
	},
	file_browser_handlers: {
		type: "array",
		description: "You can use this API to enable users to upload files to your website.",
		minItems: 1,
		items: {
			type: "object",
			required: [
				"id",
				"default_title",
				"file_filters"
			],
			additionalProperties: false,
			properties: {
				id: {
					type: "string",
					description: "Used by event handling code to differentiate between multiple file handlers"
				},
				default_title: {
					type: "string",
					description: "What the button will display."
				},
				file_filters: {
					type: "array",
					description: "Filetypes to match.",
					minItems: 1,
					items: {
						type: "string"
					}
				}
			}
		}
	},
	homepage_url: {
		$ref: "#/definitions/uri",
		description: "The URL of the homepage for this extension."
	},
	incognito: {
		type: "string",
		description: "Specify how this extension will behave if allowed to run in incognito mode.",
		"enum": [
			"spanning",
			"split"
		],
		"default": "spanning"
	},
	input_components: {
		type: "array",
		description: "Allows your extension to handle keystrokes, set the composition, and manage the candidate window.",
		items: {
			type: "object",
			required: [
				"name",
				"type",
				"id",
				"description",
				"language",
				"layouts"
			],
			additionalProperties: false,
			properties: {
				name: {
					type: "string"
				},
				type: {
					type: "string"
				},
				id: {
					type: "string"
				},
				description: {
					type: "string"
				},
				language: {
					type: "string"
				},
				layouts: {
					type: "array"
				}
			}
		}
	},
	key: {
		type: "string",
		description: "This value can be used to control the unique ID of an extension, app, or theme when it is loaded during development."
	},
	minimum_chrome_version: {
		$ref: "#/definitions/version_string",
		description: "The version of Chrome that your extension, app, or theme requires, if any."
	},
	nacl_modules: {
		type: "array",
		description: "One or more mappings from MIME types to the Native Client module that handles each type.",
		minItems: 1,
		uniqueItems: true,
		items: {
			type: "object",
			required: [
				"path",
				"mime_type"
			],
			additionalProperties: false,
			properties: {
				path: {
					$ref: "#/definitions/uri",
					description: "The location of a Native Client manifest (a .nmf file) within the extension directory."
				},
				mime_type: {
					$ref: "#/definitions/mime_type",
					description: "The MIME type for which the Native Client module will be registered as content handler."
				}
			}
		}
	},
	oauth2: {
		type: "object",
		description: "Use the Chrome Identity API to authenticate users: the getAuthToken for users logged into their Google Account and the launchWebAuthFlow for users logged into a non-Google account.",
		required: [
			"client_id",
			"scopes"
		],
		additionalProperties: false,
		properties: {
			client_id: {
				type: "string",
				description: "You need to register your app in the Google APIs Console to get the client ID."
			},
			scopes: {
				type: "array",
				minItems: 1,
				items: {
					type: "string"
				}
			}
		}
	},
	offline_enabled: {
		type: "boolean",
		description: "Whether the app or extension is expected to work offline. When Chrome detects that it is offline, apps with this field set to true will be highlighted on the New Tab page."
	},
	omnibox: {
		type: "object",
		description: "The omnibox API allows you to register a keyword with Google Chrome's address bar, which is also known as the omnibox.",
		required: [
			"keyword"
		],
		additionalProperties: false,
		properties: {
			keyword: {
				type: "string",
				description: "The keyward that will trigger your extension."
			}
		}
	},
	optional_permissions: {
		$ref: "#/definitions/permissions",
		description: "Use the chrome.permissions API to request declared optional permissions at run time rather than install time, so users understand why the permissions are needed and grant only those that are necessary."
	},
	options_page: {
		$ref: "#/definitions/page",
		description: "To allow users to customize the behavior of your extension, you may wish to provide an options page. If you do, a link to it will be provided from the extensions management page at chrome://extensions. Clicking the Options link opens a new tab pointing at your options page.",
		"default": "options.html"
	},
	options_ui: {
		type: "object",
		description: "To allow users to customize the behavior of your extension, you may wish to provide an options page. If you do, an Options link will be shown on the extensions management page at chrome://extensions which opens a dialogue containing your options page.",
		required: [
			"page"
		],
		properties: {
			page: {
				type: "string",
				description: "The path to your options page, relative to your extension's root."
			},
			chrome_style: {
				type: "boolean",
				"default": true,
				description: "If true, a Chrome user agent stylesheet will be applied to your options page. The default value is false, but we recommend you enable it for a consistent UI with Chrome."
			},
			open_in_tab: {
				type: "boolean",
				"default": false,
				description: "If true, your extension's options page will be opened in a new tab rather than embedded in chrome://extensions. The default is false, and we recommend that you don't change it. This is only useful to delay the inevitable deprecation of the old options UI! It will be removed soon, so try not to use it. It will break."
			}
		}
	},
	permissions: {
		$ref: "#/definitions/permissions",
		description: "Permissions help to limit damage if your extension or app is compromised by malware. Some permissions are also displayed to users before installation, as detailed in Permission Warnings."
	},
	requirements: {
		type: "object",
		description: "Technologies required by the app or extension. Hosting sites such as the Chrome Web Store may use this list to dissuade users from installing apps or extensions that will not work on their computer.",
		additionalProperties: false,
		properties: {
			"3D": {
				type: "object",
				description: "The '3D' requirement denotes GPU hardware acceleration.",
				required: [
					"features"
				],
				additionalProperties: false,
				properties: {
					features: {
						type: "array",
						description: "List of the 3D-related features your app requires.",
						minItems: 1,
						uniqueItems: true,
						items: {
							type: "string",
							"enum": [
								"webgl"
							]
						}
					}
				}
			},
			plugins: {
				type: "object",
				description: "Indicates if an app or extension requires NPAPI to run. This requirement is enabled by default when the manifest includes the 'plugins' field.",
				required: [
					"npapi"
				],
				additionalProperties: false,
				properties: {
					npapi: {
						type: "boolean",
						"default": true
					}
				}
			}
		}
	},
	sandbox: {
		type: "object",
		description: "Defines an collection of app or extension pages that are to be served in a sandboxed unique origin, and optionally a Content Security Policy to use with them.",
		required: [
			"pages"
		],
		additionalProperties: false,
		properties: {
			pages: {
				type: "array",
				minItems: 1,
				uniqueItems: true,
				items: {
					$ref: "#/definitions/page"
				}
			},
			content_security_policy: {
				$ref: "#/definitions/content_security_policy",
				"default": "sandbox allow-scripts allow-forms"
			}
		}
	},
	short_name: {
		type: "string",
		description: "The short name is typically used where there is insufficient space to display the full name.",
		maxLength: 12
	},
	update_url: {
		$ref: "#/definitions/uri",
		description: "If you publish using the Chrome Developer Dashboard, ignore this field. If you bridge your own extension or app: URL to an update manifest XML file."
	},
	tts_engine: {
		type: "object",
		description: "Register itself as a speech engine.",
		required: [
			"voices"
		],
		additionalProperties: false,
		properties: {
			voices: {
				type: "array",
				description: "Voices the extension can synthesize.",
				minItems: 1,
				uniqueItems: true,
				items: {
					type: "object",
					required: [
						"voice_name",
						"event_types"
					],
					additionalProperties: false,
					properties: {
						voice_name: {
							type: "string",
							description: "Identifies the name of the voice and the engine used."
						},
						lang: {
							type: "string",
							description: "Almost always, a voice can synthesize speech in just a single language. When an engine supports more than one language, it can easily register a separate voice for each language."
						},
						gender: {
							type: "string",
							description: "If your voice corresponds to a male or female voice, you can use this parameter to help clients choose the most appropriate voice for their application."
						},
						event_types: {
							type: "array",
							description: "Events sent to update the client on the progress of speech synthesis.",
							minItems: 1,
							uniqueItems: true,
							items: {
								type: "string",
								description: "",
								"enum": [
									"start",
									"word",
									"sentence",
									"marker",
									"end",
									"error"
								]
							}
						}
					}
				}
			}
		}
	},
	version_name: {
		type: "string",
		description: "In addition to the version field, which is used for update purposes, version_name can be set to a descriptive version string and will be used for display purposes if present."
	},
	web_accessible_resources: {
		type: "array",
		description: "An array of strings specifying the paths (relative to the package root) of packaged resources that are expected to be usable in the context of a web page.",
		minItems: 1,
		uniqueItems: true,
		items: {
			$ref: "#/definitions/uri"
		}
	},
	chrome_settings_overrides: {
	},
	content_pack: {
	},
	current_locale: {
	},
	"import": {
	},
	platforms: {
	},
	signature: {
	},
	spellcheck: {
	},
	storage: {
	},
	system_indicator: {
	}
};
var dependencies$1 = {
	page_action: {
		not: {
			required: [
				"browser_action"
			]
		}
	},
	browser_action: {
		not: {
			required: [
				"page_action"
			]
		}
	},
	content_scripts: {
		not: {
			required: [
				"script_badge"
			]
		}
	},
	script_badge: {
		not: {
			required: [
				"content_scripts"
			]
		}
	}
};
var definitions$1 = {
	action: {
		type: "object",
		properties: {
			default_title: {
				type: "string",
				description: "Tooltip for the main toolbar icon."
			},
			default_popup: {
				$ref: "#/definitions/uri",
				description: "The popup appears when the user clicks the icon."
			},
			default_icon: {
				anyOf: [
					{
						type: "string",
						description: "FIXME: String form is deprecated."
					},
					{
						type: "object",
						description: "Icon for the main toolbar.",
						properties: {
							"19": {
								$ref: "#/definitions/icon"
							},
							"38": {
								$ref: "#/definitions/icon"
							}
						}
					}
				]
			}
		},
		dependencies: {
			name: {
				not: {
					required: [
						"name"
					]
				}
			},
			icons: {
				not: {
					required: [
						"icons"
					]
				}
			},
			popup: {
				not: {
					required: [
						"popup"
					]
				}
			}
		}
	},
	command: {
		type: "object",
		additionalProperties: false,
		properties: {
			description: {
				type: "string"
			},
			suggested_key: {
				type: "object",
				additionalProperties: false,
				patternProperties: {
					"^(default|mac|windows|linux|chromeos)$": {
						type: "string",
						pattern: "^(Ctrl|Command|MacCtrl|Alt|Option)\\+(Shift\\+)?[A-Z]"
					}
				}
			}
		}
	},
	content_security_policy: {
		type: "string",
		description: "This introduces some fairly strict policies that will make extensions more secure by default, and provides you with the ability to create and enforce rules governing the types of content that can be loaded and executed by your extensions and applications.",
		"default": "script-src 'self'; object-src 'self'"
	},
	glob_pattern: {
		type: "string"
	},
	icon: {
		$ref: "#/definitions/uri"
	},
	match_pattern: {
		type: "string",
		pattern: "^((\\*|http|https|file|ftp|chrome-extension):\\/\\/(\\*|\\*\\.[^\\/\\*]+|[^\\/\\*]+)?(\\/.*))|<all_urls>$"
	},
	mime_type: {
		type: "string",
		pattern: "^(?:application|audio|image|message|model|multipart|text|video)\\/[-+.\\w]+$"
	},
	page: {
		$ref: "#/definitions/uri"
	},
	permissions: {
		type: "array",
		uniqueItems: true,
		items: {
			type: "string"
		}
	},
	scripts: {
		type: "array",
		minItems: 1,
		uniqueItems: true,
		items: {
			$ref: "#/definitions/uri"
		}
	},
	uri: {
		type: "string"
	},
	version_string: {
		type: "string",
		pattern: "^(?:\\d{1,5}\\.){0,3}\\d{1,5}$"
	}
};
var manifestSchema = {
	title: title,
	$schema: $schema$1,
	type: type$1,
	additionalProperties: additionalProperties,
	required: required,
	properties: properties$1,
	dependencies: dependencies$1,
	definitions: definitions$1
};

class ValidationError extends Error {
  constructor(msg, errors) {
    super(msg);
    this.name = 'ValidationError';
    this.errors = errors;
  }
  
}

// const jsonSchema = readJSONSync(
//   resolve(__dirname, 'json-schema-draft-04.json'),
// )

// const manifestSchema = readJSONSync(
//   resolve(__dirname, 'schema-web-ext-manifest-v2.json'),
// )

const ajv = new Ajv({
  verbose: true,
  schemaId: 'auto',
  schemas: {
    'http://json-schema.org/draft-04/schema#': jsonSchema,
  },
  strictDefaults: true,
});

// ajv.addMetaSchema(jsonSchema)

const validator = ajv.compile(manifestSchema);

const validateManifest = (
  manifest,
) => {
  if (validator(manifest)) {
    return manifest
  }

  const { errors } = validator;
  const msg = 'There were problems with the extension manifest.';

  throw new ValidationError(msg, errors)
};

function dedupe(x) {
  return [...new Set(x)]
}

const explorer = cosmiconfigSync('manifest', {
  cache: false,
});

const name$1 = 'manifest-input';

const stubChunkName =
  'stub__empty-chrome-extension-manifest';

const npmPkgDetails =
  process.env.npm_package_name &&
  process.env.npm_package_version &&
  process.env.npm_package_description
    ? {
        name: process.env.npm_package_name,
        version: process.env.npm_package_version,
        description: process.env.npm_package_description,
      }
    : {
        name: '',
        version: '',
        description: '',
      };

/* ============================================ */
/*                MANIFEST-INPUT                */
/* ============================================ */

function manifestInput(
  {
    browserPolyfill = false,
    contentScriptWrapper = true,
    crossBrowser = false,
    dynamicImportWrapper = {},
    extendManifest = {},
    firstClassManifest = true,
    iifeJsonPaths = [],
    pkg = npmPkgDetails,
    publicKey,
    verbose = true,
    cache = {
      assetChanged: false,
      assets: [],
      iife: [],
      input: [],
      inputAry: [],
      inputObj: {},
      permsHash: '',
      readFile: new Map(),
      srcDir: null,
    } ,
  } = {} ,
) {
  const readAssetAsBuffer = memoize(
    (filepath) => {
      return fs.readFile(filepath)
    },
    {
      cache: cache.readFile,
    },
  );

  /* ----------- HOOKS CLOSURES START ----------- */

  let manifestPath;

  const manifestName = 'manifest.json';

  /* ------------ HOOKS CLOSURES END ------------ */

  /* - SETUP DYNAMIC IMPORT LOADER SCRIPT START - */

  let wrapperScript = '';
  if (dynamicImportWrapper !== false) {
    wrapperScript = prepImportWrapperScript(dynamicImportWrapper);
  }

  /* -- SETUP DYNAMIC IMPORT LOADER SCRIPT END -- */

  /* --------------- plugin object -------------- */
  return {
    name: name$1,

    browserPolyfill,
    crossBrowser,

    get srcDir() {
      return cache.srcDir
    },

    get formatMap() {
      return { iife: cache.iife }
    },

    /* ============================================ */
    /*                 OPTIONS HOOK                 */
    /* ============================================ */

    options(options) {
      // Do not reload manifest without changes
      if (!cache.manifest) {
        /* ----------- LOAD AND PROCESS MANIFEST ----------- */

        let inputManifestPath;
        if (Array.isArray(options.input)) {
          const manifestIndex = options.input.findIndex(
            isJsonFilePath,
          );
          inputManifestPath = options.input[manifestIndex];
          cache.inputAry = [
            ...options.input.slice(0, manifestIndex),
            ...options.input.slice(manifestIndex + 1),
          ];
        } else if (typeof options.input === 'object') {
          inputManifestPath = options.input.manifest;
          cache.inputObj = cloneObject(options.input);
          delete cache.inputObj['manifest'];
        } else {
          inputManifestPath = options.input;
        }

        if (!isJsonFilePath(inputManifestPath)) {
          throw new TypeError(
            'RollupOptions.input must be a single Chrome extension manifest.',
          )
        }

        const configResult = explorer.load(
          inputManifestPath,
        ); 





        if (configResult.isEmpty) {
          throw new Error(`${options.input} is an empty file.`)
        }

        const { options_page, options_ui } = configResult.config;
        if (
          options_page !== undefined &&
          options_ui !== undefined
        ) {
          throw new Error(
            'options_ui and options_page cannot both be defined in manifest.json.',
          )
        }

        manifestPath = configResult.filepath;

        if (typeof extendManifest === 'function') {
          cache.manifest = extendManifest(configResult.config);
        } else if (typeof extendManifest === 'object') {
          cache.manifest = {
            ...configResult.config,
            ...extendManifest,
          };
        } else {
          cache.manifest = configResult.config;
        }

        cache.srcDir = path.dirname(manifestPath);

        if (firstClassManifest) {
          cache.iife = iifeJsonPaths
            .map((jsonPath) => {
              const result = JSONPath({
                path: jsonPath,
                json: cache.manifest,
              });

              return result
            })
            .flat(Infinity);

          // Derive entry paths from manifest
          const { js, html, css, img, others } = deriveFiles(
            cache.manifest,
            cache.srcDir,
          );

          // Cache derived inputs
          cache.input = [...cache.inputAry, ...js, ...html];

          cache.assets = [
            // Dedupe assets
            ...new Set([...css, ...img, ...others]),
          ];
        }

        /* --------------- END LOAD MANIFEST --------------- */
      }

      const finalInput = cache.input.reduce(
        reduceToRecord(cache.srcDir),
        cache.inputObj,
      );

      if (Object.keys(finalInput).length === 0) {
        finalInput[stubChunkName] = stubChunkName;
      }

      return { ...options, input: finalInput }
    },

    /* ============================================ */
    /*              HANDLE WATCH FILES              */
    /* ============================================ */

    async buildStart() {
      this.addWatchFile(manifestPath);

      cache.assets.forEach((srcPath) => {
        this.addWatchFile(srcPath);
      });

      const assets = await Promise.all(
        cache.assets.map(async (srcPath) => {
          const source = await readAssetAsBuffer(srcPath);

          return {
            type: 'asset' ,
            source,
            fileName: path.relative(cache.srcDir, srcPath),
          }
        }),
      );

      assets.forEach((asset) => {
        this.emitFile(asset);
      });
    },

    resolveId(source) {
      if (source === stubChunkName) {
        return source
      }

      return null
    },

    load(id) {
      if (id === stubChunkName) {
        return { code: `console.log(${stubChunkName})` }
      }

      return null
    },

    watchChange(id) {
      if (id.endsWith(manifestName)) {
        // Dump cache.manifest if manifest changes
        delete cache.manifest;
        cache.assetChanged = false;
      } else {
        // Force new read of changed asset
        cache.assetChanged = cache.readFile.delete(id);
      }
    },

    /* ============================================ */
    /*                GENERATEBUNDLE                */
    /* ============================================ */

    generateBundle(options, bundle) {
      /* ----------------- CLEAN UP STUB ----------------- */

      delete bundle[stubChunkName + '.js'];

      /* ---------- DERIVE PERMISSIONS START --------- */

      // Get module ids for all chunks
      let permissions;
      if (cache.assetChanged && cache.permsHash) {
        // Permissions did not change
        permissions = JSON.parse(cache.permsHash); 

        cache.assetChanged = false;
      } else {
        const chunks = Object.values(bundle).filter(isChunk);

        // Permissions may have changed
        permissions = Array.from(
          chunks.reduce(derivePermissions, new Set()),
        );

        const permsHash = JSON.stringify(permissions);

        if (verbose && permissions.length) {
          if (!cache.permsHash) {
            this.warn(
              `Detected permissions: ${permissions.toString()}`,
            );
          } else if (permsHash !== cache.permsHash) {
            this.warn(
              `Detected new permissions: ${permissions.toString()}`,
            );
          }
        }

        cache.permsHash = permsHash;
      }

      if (Object.keys(bundle).length === 0) {
        throw new Error(
          'The manifest must have at least one asset (html or css) or script file.',
        )
      }

      try {
        // Clone cache.manifest
        if (!cache.manifest)
          // This is a programming error, so it should throw
          throw new TypeError(
            `cache.manifest is ${typeof cache.manifest}`,
          )

        const clonedManifest = cloneObject(cache.manifest);

        const manifestBody = validateManifest({
          manifest_version: 2,
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          ...clonedManifest,
          permissions: combinePerms(
            permissions,
            clonedManifest.permissions || [],
          ),
        });

        const {
          content_scripts: cts = [],
          web_accessible_resources: war = [],
          background: { scripts: bgs = [] } = {},
        } = manifestBody;

        /* ------------- SETUP CONTENT SCRIPTS ------------- */

        const contentScripts = cts.reduce(
          (r, { js = [] }) => [...r, ...js],
          [] ,
        );

        if (contentScriptWrapper && contentScripts.length) {
          const memoizedEmitter = memoize(
            (scriptPath) => {
              const source = code.replace(
                '%PATH%',
                // Fix path slashes to support Windows
                JSON.stringify(
                  slash(relative('assets', scriptPath)),
                ),
              );

              const assetId = this.emitFile({
                type: 'asset',
                source,
                name: basename(scriptPath),
              });

              return this.getFileName(assetId)
            },
          );

          // Setup content script import wrapper
          manifestBody.content_scripts = cts.map(
            ({ js, ...rest }) => {
              return typeof js === 'undefined'
                ? rest
                : {
                    js: js
                      .map(normalizeFilename)
                      .map(memoizedEmitter),
                    ...rest,
                  }
            },
          );

          // make all imports & dynamic imports web_acc_res
          const imports = Object.values(bundle)
            .filter((x) => x.type === 'chunk')
            .reduce(
              (r, { isEntry, fileName }) =>
                // Get imported filenames
                !isEntry ? [...r, fileName] : r,
              [] ,
            );

          // SMELL: web accessible resources can be used for fingerprinting extensions
          manifestBody.web_accessible_resources = dedupe([
            ...war,
            // FEATURE: filter out imports for background?
            ...imports,
            // Need to be web accessible b/c of import
            ...contentScripts,
          ]);
        }

        /* ----------- END SETUP CONTENT SCRIPTS ----------- */

        /* ------------ SETUP BACKGROUND SCRIPTS ----------- */

        // Emit background script wrappers
        if (bgs.length && wrapperScript.length) {
          // background exists because bgs has scripts
          manifestBody.background.scripts = bgs
            .map(normalizeFilename)
            .map((scriptPath) => {
              // Loader script exists because of type guard above
              const source =
                // Path to module being loaded
                wrapperScript.replace(
                  '%PATH%',
                  // Fix path slashes to support Windows
                  JSON.stringify(
                    slash(relative('assets', scriptPath)),
                  ),
                );

              const assetId = this.emitFile({
                type: 'asset',
                source,
                name: basename(scriptPath),
              });

              return this.getFileName(assetId)
            });
        }

        /* ---------- END SETUP BACKGROUND SCRIPTS --------- */

        /* --------- STABLE EXTENSION ID BEGIN -------- */

        if (publicKey) {
          manifestBody.key = publicKey;
        }

        /* ---------- STABLE EXTENSION ID END --------- */

        /* ----------- OUTPUT MANIFEST.JSON BEGIN ---------- */

        const manifestJson = JSON.stringify(
          manifestBody,
          null,
          2,
        )
          // SMELL: is this necessary?
          .replace(/\.[jt]sx?"/g, '.js"');

        // Emit manifest.json
        this.emitFile({
          type: 'asset',
          fileName: manifestName,
          source: manifestJson,
        });
      } catch (error) {
        // Catch here because we need the validated result in scope

        if (error.name !== 'ValidationError') throw error
        const errors = error.errors; 
        if (errors) {
          errors.forEach((err) => {
            // FIXME: make a better validation error message
            // https://github.com/atlassian/better-ajv-errors
            this.warn(JSON.stringify(err, undefined, 2));
          });
        }
        this.error(error.message);
      }

      /* ------------ OUTPUT MANIFEST.JSON END ----------- */
    },
  }
}

const code$3 = "(function () {\n  'use strict';\n\n  const checkPolyfilled = 'typeof browser !== \"undefined\"';\n\n  const _executeScript = chrome.tabs.executeScript;\n  const withP = (...args) =>\n    new Promise((resolve, reject) => {\n      // @ts-ignore\n      _executeScript(...args, (results) => {\n        if (chrome.runtime.lastError) {\n          reject(chrome.runtime.lastError.message);\n        } else {\n          resolve(results);\n        }\n      });\n    });\n\n  chrome.tabs.executeScript = (...args) => {\n  (async () => {\n      const baseArgs = (typeof args[0] === 'number' ? [args[0]] : []); \n\n      const [done] = await withP(...(baseArgs.concat({ code: checkPolyfilled }) ));\n\n      if (!done) {\n        await withP(...(baseArgs.concat([{ file: JSON.parse('%BROWSER_POLYFILL_PATH%') }]) ));\n      }\n\n      _executeScript(...(args ));\n    })();\n  };\n\n}());\n";

function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }





const defaultOptions = { executeScript: true };
function browserPolyfill({
  browserPolyfill: options = defaultOptions,
})


 {
  if (options === false)
    return {
      name: 'no-op',
      generateBundle() {},
    }
  else if (options === true) options = defaultOptions;
  const { executeScript = true } = options;

  const convert = require('convert-source-map');
  const polyfillPath = require.resolve('webextension-polyfill');
  const src = fs.readFileSync(polyfillPath, 'utf-8');
  const map = fs.readJsonSync(polyfillPath + '.map');

  const browserPolyfillSrc = [
    convert.removeMapFileComments(src),
    convert.fromObject(map).toComment(),
  ].join('\n');

  return {
    name: 'browser-polyfill',
    generateBundle({ plugins = [] }, bundle) {
      const firefoxPlugin = plugins.find(
        ({ name }) => name === 'firefox-addon',
      );
      const chromeExtensionPlugin = plugins.find(
        ({ name }) => name === 'chrome-extension',
      ); 

      if (
        firefoxPlugin &&
        !chromeExtensionPlugin._plugins.manifest.crossBrowser
      ) {
        return // Don't need to add it
      }

      const manifestAsset = bundle['manifest.json'];
      if (!isAsset(manifestAsset)) {
        throw new TypeError(
          `manifest.json must be an OutputAsset, received "${typeof manifestAsset}"`,
        )
      }
      const manifest = JSON.parse(
        manifestAsset.source ,
      ); 

      /* ------------- EMIT BROWSER POLYFILL ------------- */

      const bpId = this.emitFile({
        type: 'asset',
        source: browserPolyfillSrc,
        fileName: 'assets/browser-polyfill.js',
      });

      const browserPolyfillPath = this.getFileName(bpId);

      if (executeScript) {
        const exId = this.emitFile({
          type: 'asset',
          source: code$3.replace(
            '%BROWSER_POLYFILL_PATH%',
            JSON.stringify(browserPolyfillPath),
          ),
          fileName: 'assets/browser-polyfill-executeScript.js',
        });

        const executeScriptPolyfillPath = this.getFileName(exId);

        _optionalChain([manifest, 'access', _ => _.background, 'optionalAccess', _2 => _2.scripts, 'optionalAccess', _3 => _3.unshift, 'call', _4 => _4(
          executeScriptPolyfillPath,
        )]);
      }

      _optionalChain([manifest, 'access', _5 => _5.background, 'optionalAccess', _6 => _6.scripts, 'optionalAccess', _7 => _7.unshift, 'call', _8 => _8(browserPolyfillPath)]);
      _optionalChain([manifest, 'access', _9 => _9.content_scripts, 'optionalAccess', _10 => _10.forEach, 'call', _11 => _11((script) => {
        _optionalChain([script, 'access', _12 => _12.js, 'optionalAccess', _13 => _13.unshift, 'call', _14 => _14(browserPolyfillPath)]);
      })]);

      /* ---------------- UPDATE MANIFEST ---------------- */
      manifestAsset.source = JSON.stringify(manifest);
    },
  }
}

const validateNames = () => ({
  name: 'validate-names',

  generateBundle(options, bundle) {
    const chunks = Object.values(bundle).filter(
      (x) => x.type === 'chunk',
    );

    // Files cannot start with "_" in Chrome Extensions
    // Loop through each file and check for "_" in filename
    Object.keys(bundle)
      .filter((fileName) => fileName.startsWith('_'))
      .forEach((fileName) => {
        // Only replace first instance
        const regex = new RegExp(fileName);
        const fixed = fileName.slice(1);

        // Fix manifest
        const manifest = bundle['manifest.json']; 
        manifest.source = manifest.source.replace(regex, fixed);

        // Change bundle key
        const chunk = bundle[fileName];
        delete bundle[fileName];
        bundle[fixed] = chunk;

        // Fix chunk
        chunk.fileName = fixed;

        // Find imports and fix
        chunks
          .filter(({ imports }) => imports.includes(fileName))
          .forEach((chunk) => {
            // Fix imports list
            chunk.imports = chunk.imports.map((i) =>
              i === fileName ? fixed : i,
            );
            // Fix imports in code
            chunk.code = chunk.code.replace(regex, fixed);
          });
      });
  },
});

const resolveFromBundle = (
  bundle,
) => ({
  name: 'resolve-from-bundle',
  resolveId(source, importer) {
    if (typeof importer === 'undefined') {
      return source
    } else {
      const dirname = path.dirname(importer);
      const resolved = path.join(dirname, source);

      // if it's not in the bundle,
      //   tell Rollup not to try to resolve it
      return resolved in bundle ? resolved : false
    }
  },
  load(id) {
    const chunk = bundle[id];

    if (isChunk(chunk)) {
      return {
        code: chunk.code,
        map: chunk.map,
      }
    } else {
      // anything not in the bundle is external
      //  this doesn't make sense for a chrome extension,
      //    but we should let Rollup handle it
      return null
    }
  },
});

async function regenerateBundle(
  
  { input, output },
  bundle,
) {
  if (!output || Array.isArray(output)) {
    throw new TypeError(
      'options.output must be an OutputOptions object',
    )
  }

  if (typeof input === 'undefined') {
    throw new TypeError(
      'options.input should be an object, string array or string',
    )
  }

  // Don't do anything if input is an empty array
  if (Array.isArray(input) && input.length === 0) {
    return {}
  }

  const { format, chunkFileNames: cfn = '' } = output;
  
  const chunkFileNames = path.join(path.dirname(cfn), '[name].js');

  // Transform input array to input object
  const inputValue = Array.isArray(input)
    ? input.reduce((r, x) => {
        const { dir, name } = path.parse(x);
        return { ...r, [path.join(dir, name)]: x }
      }, {} )
    : input;

  const build = await rollup({
    input: inputValue,
    plugins: [resolveFromBundle(bundle)],
  });

  let _b;
  await build.generate({
    format,
    chunkFileNames,
    plugins: [
      {
        name: 'get-bundle',
        generateBundle(o, b) {
          _b = b;
        },
      } ,
    ],
  });
  const newBundle = _b;

  if (typeof inputValue === 'string') {
    delete bundle[inputValue];

    const bundleKey = path.basename(inputValue);

    return {
      [inputValue]: {
        ...(newBundle[bundleKey] ),
        fileName: inputValue,
      },
    }
  } else {
    // Remove regenerated entries from bundle
    Object.values(inputValue).forEach((key) => {
      delete bundle[key];
    });

    return newBundle
  }
}

function mixedFormat(
  options,
) {
  return {
    name: 'mixed-format',
    async generateBundle(
      
      { format, chunkFileNames },
      bundle,
    ) {
      const { formatMap } = options; // this might not be defined upon init

      if (typeof formatMap === 'undefined') return

      const formats = Object.entries(formatMap).filter(
        (
          x,
        


) => typeof x[1] !== 'undefined',
      );

      {
        const allInput = formats.flatMap(([, inputs]) =>
          Array.isArray(inputs)
            ? inputs
            : Object.values(inputs || {}),
        );
        const allInputSet = new Set(allInput);
        if (allInput.length !== allInputSet.size) {
          throw new Error(
            'formats should not have duplicate inputs',
          )
        }
      }

      // TODO: handle different kinds of formats differently?
      const bundles = await Promise.all(
        // Configured formats
        formats.flatMap(([f, inputs]) =>
          (Array.isArray(inputs)
            ? inputs
            : Object.values(inputs)
          ).map((input) =>
            regenerateBundle.call(
              this,
              {
                input,
                output: {
                  format: f,
                  chunkFileNames,
                },
              },
              bundle,
            ),
          ),
        ),
      );

      // Base format (ESM)
      const base = await regenerateBundle.call(
        this,
        {
          input: Object.entries(bundle)
            .filter(([, file]) => isChunk(file) && file.isEntry)
            .map(([key]) => key),
          output: { format, chunkFileNames },
        },
        bundle,
      );

      // Empty bundle
      Object.entries(bundle)
        .filter(([, v]) => isChunk(v))
        .forEach(([key]) => {
          delete bundle[key];
        });

      // Refill bundle
      Object.assign(bundle, base, ...bundles);
    },
  }
}

const code$4 = "(function () {\n  'use strict';\n\n  /* ------------------- FILENAMES ------------------- */\n\n  /* ------------------ PLACEHOLDERS ----------------- */\n\n  const timestampPathPlaceholder = '%TIMESTAMP_PATH%';\n  const loadMessagePlaceholder = '%LOAD_MESSAGE%';\n  const ctScriptPathPlaceholder = '%CONTENT_SCRIPT_PATH%';\n  const unregisterServiceWorkersPlaceholder = '%UNREGISTER_SERVICE_WORKERS%';\n  const executeScriptPlaceholder = '%EXECUTE_SCRIPT%';\n\n  /* eslint-env browser */\n\n  // Log load message to browser dev console\n  console.log(loadMessagePlaceholder.slice(1, -1));\n\n  const options = {\n    executeScript: JSON.parse(executeScriptPlaceholder),\n    unregisterServiceWorkers: JSON.parse(\n      unregisterServiceWorkersPlaceholder,\n    ),\n  };\n\n  /* ---------- POLYFILL TABS.EXECUTESCRIPT ---------- */\n\n  if (options.executeScript) {\n    const markerId =\n      'rollup-plugin-chrome-extension-simple-reloader';\n\n    const addMarker = `{\n    const tag = document.createElement('meta');\n    tag.id = '${markerId}';\n    document.head.append(tag);\n  }`;\n\n    const checkMarker = `\n  !!document.head.querySelector('#${markerId}')\n  `;\n\n    // Modify chrome.tabs.executeScript to inject reloader\n    const _executeScript = chrome.tabs.executeScript;\n    const withP = (...args) =>\n      new Promise((resolve, reject) => {\n        // eslint-disable-next-line\n        // @ts-ignore\n        _executeScript(...args, (results) => {\n          if (chrome.runtime.lastError) {\n            reject(chrome.runtime.lastError.message);\n          } else {\n            resolve(results);\n          }\n        });\n      });\n\n    chrome.tabs.executeScript = (...args) => {\n  (async () => {\n        const tabId = typeof args[0] === 'number' ? args[0] : null;\n        const argsBase = (tabId === null ? [] : [tabId]); \n\n        const [done] = await withP(\n          ...(argsBase.concat({ code: checkMarker }) \n\n\n  ),\n        );\n\n        // Don't add reloader if it's already there\n        if (!done) {\n          await withP(\n            ...(argsBase.concat({ code: addMarker }) \n\n\n  ),\n          );\n\n          // execute reloader\n          const reloaderArgs = argsBase.concat([\n            // TODO: convert to file to get replacements right\n            { file: JSON.parse(ctScriptPathPlaceholder) },\n          ]); \n\n          await withP(...reloaderArgs);\n        }\n\n        _executeScript(...(args ));\n      })();\n    };\n  }\n\n  /* ----------- UNREGISTER SERVICE WORKERS ---------- */\n\n  if (options.unregisterServiceWorkers) {\n    // Modify chrome.runtime.reload to unregister sw's\n    const _runtimeReload = chrome.runtime.reload;\n    chrome.runtime.reload = () => {\n  (async () => {\n        await unregisterServiceWorkers();\n        _runtimeReload();\n      })();\n    };\n  }\n\n  async function unregisterServiceWorkers() {\n    try {\n      const registrations = await navigator.serviceWorker.getRegistrations();\n      await Promise.all(registrations.map((r) => r.unregister()));\n    } catch (error) {\n      console.error(error);\n    }\n  }\n\n  /* -------------- CHECK TIMESTAMP.JSON ------------- */\n\n  let timestamp;\n\n  const id = setInterval(async () => {\n    const t = await fetch(timestampPathPlaceholder)\n      .then((res) => {\n        localStorage.removeItem('chromeExtensionReloaderErrors');\n        return res.json()\n      })\n      .catch(handleFetchError);\n\n    if (typeof timestamp === 'undefined') {\n      timestamp = t;\n    } else if (timestamp !== t) {\n      chrome.runtime.reload();\n    }\n\n    function handleFetchError(error) {\n      clearInterval(id);\n\n      const errors =\n        localStorage.chromeExtensionReloaderErrors || 0;\n\n      if (errors < 5) {\n        localStorage.chromeExtensionReloaderErrors = errors + 1;\n\n        // Should reload at least once if fetch fails.\n        // The fetch will fail if the timestamp file is absent,\n        // thus the new build does not include the reloader\n        return 0\n      } else {\n        console.log(\n          'rollup-plugin-chrome-extension simple reloader error:',\n        );\n        console.error(error);\n\n        return timestamp\n      }\n    }\n  }, 1000);\n\n}());\n";

const code$5 = "(function () {\n  'use strict';\n\n  /* ------------------- FILENAMES ------------------- */\n  const loadMessagePlaceholder = '%LOAD_MESSAGE%';\n\n  /* eslint-env browser */\n\n  // Log load message to browser dev console\n  console.log(loadMessagePlaceholder.slice(1, -1));\n\n  const { name } = chrome.runtime.getManifest();\n\n  const reload = () => {\n    console.log(`${name} has reloaded...`);\n\n    setTimeout(() => {\n      location.reload();\n    }, 500);\n  };\n\n  setInterval(() => {\n    try {\n      chrome.runtime.getManifest();\n    } catch (error) {\n      if (error.message === 'Extension context invalidated.') {\n        reload();\n      }\n    }\n  }, 1000);\n\n}());\n";

/* ------------------- FILENAMES ------------------- */

const backgroundPageReloader =
  'background-page-reloader.js';
const contentScriptReloader = 'content-script-reloader.js';
const timestampFilename = 'timestamp.json';

/* ------------------ PLACEHOLDERS ----------------- */

const timestampPathPlaceholder = '%TIMESTAMP_PATH%';
const loadMessagePlaceholder = '%LOAD_MESSAGE%';
const ctScriptPathPlaceholder = '%CONTENT_SCRIPT_PATH%';
const unregisterServiceWorkersPlaceholder = '%UNREGISTER_SERVICE_WORKERS%';
const executeScriptPlaceholder = '%EXECUTE_SCRIPT%';

function _optionalChain$1(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }


















// Used for testing
const _internalCache = {};

const simpleReloader = (
  {
    executeScript = true,
    unregisterServiceWorkers = true,
  } = {} ,
  cache = {} ,
) => {
  if (!process.env.ROLLUP_WATCH) {
    return undefined
  }

  return {
    name: 'chrome-extension-simple-reloader',

    generateBundle({ dir }, bundle) {
      const date = new Date();
      const time = `${date
        .getFullYear()
        .toString()
        .padStart(2, '0')}-${(date.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${date
        .getDate()
        .toString()
        .padStart(2, '0')} ${date
        .getHours()
        .toString()
        .padStart(2, '0')}:${date
        .getMinutes()
        .toString()
        .padStart(2, '0')}:${date
        .getSeconds()
        .toString()
        .padStart(2, '0')}`;

      cache.outputDir = dir;
      cache.loadMessage = [
        'DEVELOPMENT build with simple auto-reloader',
        `[${time}] waiting for changes...`,
      ].join('\n');

      /* --------------- EMIT CLIENT FILES --------------- */

      const emit = (
        name,
        source,
        isFileName,
      ) => {
        const id = this.emitFile({
          type: 'asset',
          [isFileName ? 'fileName' : 'name']: name,
          source,
        });

        return this.getFileName(id)
      };

      cache.timestampPath = emit(
        timestampFilename,
        JSON.stringify(Date.now()),
        true,
      );

      cache.ctScriptPath = emit(
        contentScriptReloader,
        code$5.replace(
          loadMessagePlaceholder,
          JSON.stringify(cache.loadMessage),
        ),
      );

      cache.bgScriptPath = emit(
        backgroundPageReloader,
        code$4
          .replace(timestampPathPlaceholder, cache.timestampPath)
          .replace(
            loadMessagePlaceholder,
            JSON.stringify(cache.loadMessage),
          )
          .replace(
            ctScriptPathPlaceholder,
            JSON.stringify(cache.ctScriptPath),
          )
          .replace(
            executeScriptPlaceholder,
            JSON.stringify(executeScript),
          )
          .replace(
            unregisterServiceWorkersPlaceholder,
            JSON.stringify(unregisterServiceWorkers),
          ),
      );

      // Update the exported cache
      Object.assign(_internalCache, cache);

      /* ---------------- UPDATE MANIFEST ---------------- */

      updateManifest(
        (manifest) => {
          /* ------------------ DESCRIPTION ------------------ */

          manifest.description = cache.loadMessage;

          /* ---------------- BACKGROUND PAGE ---------------- */

          if (!manifest.background) {
            manifest.background = {};
          }

          manifest.background.persistent = true;

          const { scripts: bgScripts = [] } = manifest.background;

          if (cache.bgScriptPath) {
            manifest.background.scripts = [
              cache.bgScriptPath,
              ...bgScripts,
            ];
          } else {
            this.error(
              `cache.bgScriptPath is ${typeof cache.bgScriptPath}`,
            );
          }

          /* ---------------- CONTENT SCRIPTS ---------------- */

          const { content_scripts: ctScripts } = manifest;

          if (cache.ctScriptPath) {
            manifest.content_scripts = _optionalChain$1([ctScripts, 'optionalAccess', _ => _.map, 'call', _2 => _2(
              ({ js = [], ...rest }) => ({
                js: [cache.ctScriptPath, ...js],
                ...rest,
              }),
            )]);
          } else {
            this.error(
              `cache.ctScriptPath is ${typeof cache.ctScriptPath}`,
            );
          }

          return manifest
        },
        bundle,
        this.error,
      );

      // We'll write this file ourselves, we just need a safe path to write the timestamp
      delete bundle[cache.timestampPath];
    },

    /* -------------- WRITE TIMESTAMP FILE ------------- */
    async writeBundle() {
      try {
        await outputJson(
          join(cache.outputDir, cache.timestampPath),
          Date.now(),
        );
      } catch (err) {
        if (typeof err.message === 'string') {
          this.error(
            `Unable to update timestamp file:\n\t${err.message}`,
          );
        } else {
          this.error('Unable to update timestamp file');
        }
      }
    },
  }
};

const chromeExtension = (
  options = {} ,
) => {
  /* --------------- LOAD PACKAGE.JSON --------------- */

  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    options.pkg = options.pkg || readJSONSync(packageJsonPath);
  } catch (error) {}

  /* ----------------- SETUP PLUGINS ----------------- */

  const manifest = manifestInput(options);
  const html = htmlInputs(manifest);
  const validate = validateNames();
  const browser = browserPolyfill(manifest);
  const mixedFormat$1 = mixedFormat(manifest);

  /* ----------------- RETURN PLUGIN ----------------- */

  return {
    name: 'chrome-extension',

    // For testing
    _plugins: { manifest, html, validate },

    options(options) {
      try {
        return [manifest, html].reduce((opts, plugin) => {
          const result = plugin.options.call(this, opts);

          return result || options
        }, options)
      } catch (error) {
        const manifestError =
          'The manifest must have at least one script or HTML file.';
        const htmlError =
          'At least one HTML file must have at least one script.';

        if (
          error.message === manifestError ||
          error.message === htmlError
        ) {
          throw new Error(
            'A Chrome extension must have at least one script or HTML file.',
          )
        } else {
          throw error
        }
      }
    },

    async buildStart(options) {
      await Promise.all([
        manifest.buildStart.call(this, options),
        html.buildStart.call(this, options),
      ]);
    },

    async resolveId(source, importer) {
      return manifest.resolveId.call(this, source, importer)
    },

    async load(id) {
      return manifest.load.call(this, id)
    },

    watchChange(id) {
      manifest.watchChange.call(this, id);
      html.watchChange.call(this, id);
    },

    async generateBundle(...args) {
      await manifest.generateBundle.call(this, ...args);
      await validate.generateBundle.call(this, ...args);
      await browser.generateBundle.call(this, ...args);
      // TODO: should skip this if not needed
      await mixedFormat$1.generateBundle.call(this, ...args);
    },
  }
};

export { chromeExtension, simpleReloader };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXgtZXNtLmpzIiwic291cmNlcyI6WyIuLi9zcmMvaGVscGVycy50cyIsIi4uL3NyYy9tYW5pZmVzdC1pbnB1dC9yZWR1Y2VUb1JlY29yZC50cyIsIi4uL3NyYy9odG1sLWlucHV0cy9jaGVlcmlvLnRzIiwiLi4vc3JjL2h0bWwtaW5wdXRzL2luZGV4LnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L2R5bmFtaWNJbXBvcnRXcmFwcGVyLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L21hbmlmZXN0LXBhcnNlci9jb21iaW5lLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L21hbmlmZXN0LXBhcnNlci9wZXJtaXNzaW9ucy50cyIsIi4uL3NyYy9tYW5pZmVzdC1pbnB1dC9tYW5pZmVzdC1wYXJzZXIvaW5kZXgudHMiLCIuLi9zcmMvbWFuaWZlc3QtaW5wdXQvbWFuaWZlc3QtcGFyc2VyL3ZhbGlkYXRlLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L2luZGV4LnRzIiwiLi4vc3JjL2Jyb3dzZXItcG9seWZpbGwvaW5kZXgudHMiLCIuLi9zcmMvdmFsaWRhdGUtbmFtZXMvaW5kZXgudHMiLCIuLi9zcmMvbWl4ZWQtZm9ybWF0L3Jlc29sdmVGcm9tQnVuZGxlLnRzIiwiLi4vc3JjL21peGVkLWZvcm1hdC9yZWdlbmVyYXRlQnVuZGxlLnRzIiwiLi4vc3JjL21peGVkLWZvcm1hdC9pbmRleC50cyIsIi4uL3NyYy9wbHVnaW4tcmVsb2FkZXItc2ltcGxlL0NPTlNUQU5UUy50cyIsIi4uL3NyYy9wbHVnaW4tcmVsb2FkZXItc2ltcGxlL2luZGV4LnRzIiwiLi4vc3JjL2luZGV4LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IE91dHB1dE9wdGlvbnMgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyBPdXRwdXRBc3NldCwgT3V0cHV0Q2h1bmssIE91dHB1dEJ1bmRsZSB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IENocm9tZUV4dGVuc2lvbk1hbmlmZXN0IH0gZnJvbSAnLi9tYW5pZmVzdCdcblxuZXhwb3J0IGNvbnN0IG5vdCA9IDxUPihmbjogKHg6IFQpID0+IGJvb2xlYW4pID0+ICh4OiBUKSA9PiAhZm4oeClcblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ2h1bmsoXG4gIHg6IE91dHB1dENodW5rIHwgT3V0cHV0QXNzZXQsXG4pOiB4IGlzIE91dHB1dENodW5rIHtcbiAgcmV0dXJuIHggJiYgeC50eXBlID09PSAnY2h1bmsnXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc091dHB1dE9wdGlvbnMoeDogYW55KTogeCBpcyBPdXRwdXRPcHRpb25zIHtcbiAgcmV0dXJuIChcbiAgICB0eXBlb2YgeCA9PT0gJ29iamVjdCcgJiZcbiAgICAhQXJyYXkuaXNBcnJheSh4KSAmJlxuICAgIHR5cGVvZiB4LmZvcm1hdCA9PT0gJ3N0cmluZycgJiZcbiAgICBbJ2lpZmUnLCAnZXMnXS5pbmNsdWRlcyh4LmZvcm1hdClcbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNBc3NldChcbiAgeDogT3V0cHV0Q2h1bmsgfCBPdXRwdXRBc3NldCxcbik6IHggaXMgT3V0cHV0QXNzZXQge1xuICByZXR1cm4geC50eXBlID09PSAnYXNzZXQnXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1N0cmluZyh4OiBhbnkpOiB4IGlzIHN0cmluZyB7XG4gIHJldHVybiB0eXBlb2YgeCA9PT0gJ3N0cmluZydcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzSnNvbkZpbGVQYXRoKHg6IGFueSk6IHggaXMgc3RyaW5nIHtcbiAgcmV0dXJuIGlzU3RyaW5nKHgpICYmIHguZW5kc1dpdGgoJ2pzb24nKVxufVxuXG5leHBvcnQgY29uc3Qgbm9ybWFsaXplRmlsZW5hbWUgPSAocDogc3RyaW5nKSA9PlxuICBwLnJlcGxhY2UoL1xcLlt0al1zeD8kLywgJy5qcycpXG5cbi8qKlxuICogVXBkYXRlIHRoZSBtYW5pZmVzdCBzb3VyY2UgaW4gdGhlIG91dHB1dCBidW5kbGVcbiAqL1xuZXhwb3J0IGNvbnN0IHVwZGF0ZU1hbmlmZXN0ID0gKFxuICB1cGRhdGVyOiAoXG4gICAgbWFuaWZlc3Q6IENocm9tZUV4dGVuc2lvbk1hbmlmZXN0LFxuICApID0+IENocm9tZUV4dGVuc2lvbk1hbmlmZXN0LFxuICBidW5kbGU6IE91dHB1dEJ1bmRsZSxcbiAgaGFuZGxlRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogT3V0cHV0QnVuZGxlID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9ICdtYW5pZmVzdC5qc29uJ1xuICAgIGNvbnN0IG1hbmlmZXN0QXNzZXQgPSBidW5kbGVbbWFuaWZlc3RLZXldIGFzIE91dHB1dEFzc2V0XG5cbiAgICBpZiAoIW1hbmlmZXN0QXNzZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgJ05vIG1hbmlmZXN0Lmpzb24gaW4gdGhlIHJvbGx1cCBvdXRwdXQgYnVuZGxlLicsXG4gICAgICApXG4gICAgfVxuXG4gICAgY29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKFxuICAgICAgbWFuaWZlc3RBc3NldC5zb3VyY2UgYXMgc3RyaW5nLFxuICAgICkgYXMgQ2hyb21lRXh0ZW5zaW9uTWFuaWZlc3RcblxuICAgIGNvbnN0IHJlc3VsdCA9IHVwZGF0ZXIobWFuaWZlc3QpXG5cbiAgICBtYW5pZmVzdEFzc2V0LnNvdXJjZSA9IEpTT04uc3RyaW5naWZ5KHJlc3VsdCwgdW5kZWZpbmVkLCAyKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChoYW5kbGVFcnJvcikge1xuICAgICAgaGFuZGxlRXJyb3IoZXJyb3IubWVzc2FnZSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZXJyb3JcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYnVuZGxlXG59XG4iLCJpbXBvcnQgeyByZWxhdGl2ZSB9IGZyb20gJ3BhdGgnXG5cbnR5cGUgSW5wdXRSZWNvcmQgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG5cbmV4cG9ydCBmdW5jdGlvbiByZWR1Y2VUb1JlY29yZChzcmNEaXI6IHN0cmluZyB8IG51bGwpIHtcbiAgaWYgKHNyY0RpciA9PT0gbnVsbCB8fCB0eXBlb2Ygc3JjRGlyID09PSAndW5kZWZpbmVkJykge1xuICAgIC8vIFRoaXMgd291bGQgYmUgYSBjb25maWcgZXJyb3IsIHNvIHNob3VsZCB0aHJvd1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NyY0RpciBpcyBudWxsIG9yIHVuZGVmaW5lZCcpXG4gIH1cblxuICByZXR1cm4gKFxuICAgIGlucHV0UmVjb3JkOiBJbnB1dFJlY29yZCxcbiAgICBmaWxlbmFtZTogc3RyaW5nLFxuICApOiBJbnB1dFJlY29yZCA9PiB7XG4gICAgY29uc3QgbmFtZSA9IHJlbGF0aXZlKHNyY0RpciwgZmlsZW5hbWUpXG4gICAgICAuc3BsaXQoJy4nKVxuICAgICAgLnNsaWNlKDAsIC0xKVxuICAgICAgLmpvaW4oJy4nKVxuXG4gICAgaWYgKG5hbWUgaW4gaW5wdXRSZWNvcmQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFNjcmlwdCBmaWxlcyB3aXRoIGRpZmZlcmVudCBleHRlbnNpb25zIHNob3VsZCBub3Qgc2hhcmUgbmFtZXM6XFxuXFxuXCIke2ZpbGVuYW1lfVwiXFxud2lsbCBvdmVyd3JpdGVcXG5cIiR7aW5wdXRSZWNvcmRbbmFtZV19XCJgLFxuICAgICAgKVxuICAgIH1cblxuICAgIHJldHVybiB7IC4uLmlucHV0UmVjb3JkLCBbbmFtZV06IGZpbGVuYW1lIH1cbiAgfVxufVxuIiwiaW1wb3J0IGNoZWVyaW8gZnJvbSAnY2hlZXJpbydcbmltcG9ydCBmcyBmcm9tICdmcy1leHRyYSdcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnXG5pbXBvcnQgcHJldHRpZXIgZnJvbSAncHJldHRpZXInXG5cbmltcG9ydCB7IGlzU3RyaW5nIH0gZnJvbSAnLi4vaGVscGVycydcbmltcG9ydCB7IEh0bWxJbnB1dHNPcHRpb25zIH0gZnJvbSAnLi4vcGx1Z2luLW9wdGlvbnMnXG5cbmV4cG9ydCB0eXBlIEh0bWxGaWxlUGF0aERhdGEgPSB7XG4gIGZpbGVQYXRoOiBzdHJpbmdcbiAgcm9vdFBhdGg6IHN0cmluZ1xufVxuXG4vKiogY2hlZXJpby5Sb290IG9iamVjdHMgd2l0aCBhIGZpbGUgcGF0aCAqL1xuZXhwb3J0IHR5cGUgQ2hlZXJpb0ZpbGUgPSBjaGVlcmlvLlJvb3QgJiBIdG1sRmlsZVBhdGhEYXRhXG5cbmV4cG9ydCBjb25zdCBmb3JtYXRIdG1sID0gKCQ6IENoZWVyaW9GaWxlKSA9PlxuICBwcmV0dGllci5mb3JtYXQoJC5odG1sKCksIHsgcGFyc2VyOiAnaHRtbCcgfSlcblxuZXhwb3J0IGNvbnN0IGxvYWRIdG1sID0gKHJvb3RQYXRoOiBzdHJpbmcpID0+IChcbiAgZmlsZVBhdGg6IHN0cmluZyxcbik6IENoZWVyaW9GaWxlID0+IHtcbiAgY29uc3QgaHRtbENvZGUgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGY4JylcbiAgY29uc3QgJCA9IGNoZWVyaW8ubG9hZChodG1sQ29kZSlcblxuICByZXR1cm4gT2JqZWN0LmFzc2lnbigkLCB7IGZpbGVQYXRoLCByb290UGF0aCB9KVxufVxuXG5leHBvcnQgY29uc3QgZ2V0UmVsYXRpdmVQYXRoID0gKHtcbiAgZmlsZVBhdGgsXG4gIHJvb3RQYXRoLFxufTogSHRtbEZpbGVQYXRoRGF0YSkgPT4gKHA6IHN0cmluZykgPT4ge1xuICBjb25zdCBodG1sRmlsZURpciA9IHBhdGguZGlybmFtZShmaWxlUGF0aClcblxuICBsZXQgcmVsRGlyOiBzdHJpbmdcbiAgaWYgKHAuc3RhcnRzV2l0aCgnLycpKSB7XG4gICAgcmVsRGlyID0gcGF0aC5yZWxhdGl2ZShwcm9jZXNzLmN3ZCgpLCByb290UGF0aClcbiAgfSBlbHNlIHtcbiAgICByZWxEaXIgPSBwYXRoLnJlbGF0aXZlKHByb2Nlc3MuY3dkKCksIGh0bWxGaWxlRGlyKVxuICB9XG5cbiAgcmV0dXJuIHBhdGguam9pbihyZWxEaXIsIHApXG59XG5cbi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tIFNDUklQVFMgLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuZXhwb3J0IGNvbnN0IGdldFNjcmlwdEVsZW1zID0gKCQ6IGNoZWVyaW8uUm9vdCkgPT5cbiAgJCgnc2NyaXB0JylcbiAgICAubm90KCdbZGF0YS1yb2xsdXAtYXNzZXRdJylcbiAgICAubm90KCdbc3JjXj1cImh0dHA6XCJdJylcbiAgICAubm90KCdbc3JjXj1cImh0dHBzOlwiXScpXG4gICAgLm5vdCgnW3NyY149XCJkYXRhOlwiXScpXG4gICAgLm5vdCgnW3NyY149XCIvXCJdJylcblxuLy8gTXV0YXRpdmUgYWN0aW9uXG5leHBvcnQgY29uc3QgbXV0YXRlU2NyaXB0RWxlbXMgPSAoe1xuICBicm93c2VyUG9seWZpbGwsXG59OiBQaWNrPEh0bWxJbnB1dHNPcHRpb25zLCAnYnJvd3NlclBvbHlmaWxsJz4pID0+IChcbiAgJDogQ2hlZXJpb0ZpbGUsXG4pID0+IHtcbiAgZ2V0U2NyaXB0RWxlbXMoJClcbiAgICAuYXR0cigndHlwZScsICdtb2R1bGUnKVxuICAgIC5hdHRyKCdzcmMnLCAoaSwgdmFsdWUpID0+IHtcbiAgICAgIC8vIEZJWE1FOiBAdHlwZXMvY2hlZXJpbyBpcyB3cm9uZyBmb3IgQXR0ckZ1bmN0aW9uOiBpbmRleC5kLnRzLCBsaW5lIDE2XG4gICAgICAvLyBkZWNsYXJlIHR5cGUgQXR0ckZ1bmN0aW9uID0gKGk6IG51bWJlciwgY3VycmVudFZhbHVlOiBzdHJpbmcpID0+IGFueTtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZVxuICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgY29uc3QgcmVwbGFjZWQgPSB2YWx1ZS5yZXBsYWNlKC9cXC5banRdc3g/L2csICcuanMnKVxuXG4gICAgICByZXR1cm4gcmVwbGFjZWRcbiAgICB9KVxuXG4gIGlmIChicm93c2VyUG9seWZpbGwpIHtcbiAgICBjb25zdCBoZWFkID0gJCgnaGVhZCcpXG4gICAgaWYgKFxuICAgICAgYnJvd3NlclBvbHlmaWxsID09PSB0cnVlIHx8XG4gICAgICAodHlwZW9mIGJyb3dzZXJQb2x5ZmlsbCA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgYnJvd3NlclBvbHlmaWxsLmV4ZWN1dGVTY3JpcHQpXG4gICAgKSB7XG4gICAgICBoZWFkLnByZXBlbmQoXG4gICAgICAgICc8c2NyaXB0IHNyYz1cIi9hc3NldHMvYnJvd3Nlci1wb2x5ZmlsbC1leGVjdXRlU2NyaXB0LmpzXCI+PC9zY3JpcHQ+JyxcbiAgICAgIClcbiAgICB9XG5cbiAgICBoZWFkLnByZXBlbmQoXG4gICAgICAnPHNjcmlwdCBzcmM9XCIvYXNzZXRzL2Jyb3dzZXItcG9seWZpbGwuanNcIj48L3NjcmlwdD4nLFxuICAgIClcbiAgfVxuXG4gIHJldHVybiAkXG59XG5cbmV4cG9ydCBjb25zdCBnZXRTY3JpcHRzID0gKCQ6IGNoZWVyaW8uUm9vdCkgPT5cbiAgZ2V0U2NyaXB0RWxlbXMoJCkudG9BcnJheSgpXG5cbmV4cG9ydCBjb25zdCBnZXRTY3JpcHRTcmMgPSAoJDogQ2hlZXJpb0ZpbGUpID0+XG4gIGdldFNjcmlwdHMoJClcbiAgICAubWFwKChlbGVtKSA9PiAkKGVsZW0pLmF0dHIoJ3NyYycpKVxuICAgIC5maWx0ZXIoaXNTdHJpbmcpXG4gICAgLm1hcChnZXRSZWxhdGl2ZVBhdGgoJCkpXG5cbi8qIC0tLS0tLS0tLS0tLS0tLS0tIEFTU0VUIFNDUklQVFMgLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuY29uc3QgZ2V0QXNzZXRzID0gKCQ6IGNoZWVyaW8uUm9vdCkgPT5cbiAgJCgnc2NyaXB0JylcbiAgICAuZmlsdGVyKCdbZGF0YS1yb2xsdXAtYXNzZXQ9XCJ0cnVlXCJdJylcbiAgICAubm90KCdbc3JjXj1cImh0dHA6XCJdJylcbiAgICAubm90KCdbc3JjXj1cImh0dHBzOlwiXScpXG4gICAgLm5vdCgnW3NyY149XCJkYXRhOlwiXScpXG4gICAgLm5vdCgnW3NyY149XCIvXCJdJylcbiAgICAudG9BcnJheSgpXG5cbmV4cG9ydCBjb25zdCBnZXRKc0Fzc2V0cyA9ICgkOiBDaGVlcmlvRmlsZSkgPT5cbiAgZ2V0QXNzZXRzKCQpXG4gICAgLm1hcCgoZWxlbSkgPT4gJChlbGVtKS5hdHRyKCdzcmMnKSlcbiAgICAuZmlsdGVyKGlzU3RyaW5nKVxuICAgIC5tYXAoZ2V0UmVsYXRpdmVQYXRoKCQpKVxuXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLSBjc3MgLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5jb25zdCBnZXRDc3MgPSAoJDogY2hlZXJpby5Sb290KSA9PlxuICAkKCdsaW5rJylcbiAgICAuZmlsdGVyKCdbcmVsPVwic3R5bGVzaGVldFwiXScpXG4gICAgLm5vdCgnW2hyZWZePVwiaHR0cDpcIl0nKVxuICAgIC5ub3QoJ1tocmVmXj1cImh0dHBzOlwiXScpXG4gICAgLm5vdCgnW2hyZWZePVwiZGF0YTpcIl0nKVxuICAgIC5ub3QoJ1tocmVmXj1cIi9cIl0nKVxuICAgIC50b0FycmF5KClcblxuZXhwb3J0IGNvbnN0IGdldENzc0hyZWZzID0gKCQ6IENoZWVyaW9GaWxlKSA9PlxuICBnZXRDc3MoJClcbiAgICAubWFwKChlbGVtKSA9PiAkKGVsZW0pLmF0dHIoJ2hyZWYnKSlcbiAgICAuZmlsdGVyKGlzU3RyaW5nKVxuICAgIC5tYXAoZ2V0UmVsYXRpdmVQYXRoKCQpKVxuXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLSBpbWcgLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5jb25zdCBnZXRJbWdzID0gKCQ6IGNoZWVyaW8uUm9vdCkgPT5cbiAgJCgnaW1nJylcbiAgICAubm90KCdbc3JjXj1cImh0dHA6Ly9cIl0nKVxuICAgIC5ub3QoJ1tzcmNePVwiaHR0cHM6Ly9cIl0nKVxuICAgIC5ub3QoJ1tzcmNePVwiZGF0YTpcIl0nKVxuICAgIC50b0FycmF5KClcblxuY29uc3QgZ2V0RmF2aWNvbnMgPSAoJDogY2hlZXJpby5Sb290KSA9PlxuICAkKCdsaW5rW3JlbD1cImljb25cIl0nKVxuICAgIC5ub3QoJ1tocmVmXj1cImh0dHA6XCJdJylcbiAgICAubm90KCdbaHJlZl49XCJodHRwczpcIl0nKVxuICAgIC5ub3QoJ1tocmVmXj1cImRhdGE6XCJdJylcbiAgICAudG9BcnJheSgpXG5cbmV4cG9ydCBjb25zdCBnZXRJbWdTcmNzID0gKCQ6IENoZWVyaW9GaWxlKSA9PiB7XG4gIHJldHVybiBbXG4gICAgLi4uZ2V0SW1ncygkKS5tYXAoKGVsZW0pID0+ICQoZWxlbSkuYXR0cignc3JjJykpLFxuICAgIC4uLmdldEZhdmljb25zKCQpLm1hcCgoZWxlbSkgPT4gJChlbGVtKS5hdHRyKCdocmVmJykpLFxuICBdXG4gICAgLmZpbHRlcihpc1N0cmluZylcbiAgICAubWFwKGdldFJlbGF0aXZlUGF0aCgkKSlcbn1cbiIsImltcG9ydCAnYXJyYXktZmxhdC1wb2x5ZmlsbCdcblxuaW1wb3J0IHsgcmVhZEZpbGUgfSBmcm9tICdmcy1leHRyYSdcbmltcG9ydCBmbGF0dGVuIGZyb20gJ2xvZGFzaC5mbGF0dGVuJ1xuaW1wb3J0IHsgcmVsYXRpdmUgfSBmcm9tICdwYXRoJ1xuXG5pbXBvcnQgeyBub3QgfSBmcm9tICcuLi9oZWxwZXJzJ1xuaW1wb3J0IHsgcmVkdWNlVG9SZWNvcmQgfSBmcm9tICcuLi9tYW5pZmVzdC1pbnB1dC9yZWR1Y2VUb1JlY29yZCdcbmltcG9ydCB7XG4gIEh0bWxJbnB1dHNPcHRpb25zLFxuICBIdG1sSW5wdXRzUGx1Z2luQ2FjaGUsXG4gIEh0bWxJbnB1dHNQbHVnaW4sXG59IGZyb20gJy4uL3BsdWdpbi1vcHRpb25zJ1xuaW1wb3J0IHtcbiAgZm9ybWF0SHRtbCxcbiAgZ2V0Q3NzSHJlZnMsXG4gIGdldEltZ1NyY3MsXG4gIGdldEpzQXNzZXRzLFxuICBnZXRTY3JpcHRTcmMsXG4gIGxvYWRIdG1sLFxuICBtdXRhdGVTY3JpcHRFbGVtcyxcbn0gZnJvbSAnLi9jaGVlcmlvJ1xuXG5jb25zdCBpc0h0bWwgPSAocGF0aDogc3RyaW5nKSA9PiAvXFwuaHRtbD8kLy50ZXN0KHBhdGgpXG5cbmNvbnN0IG5hbWUgPSAnaHRtbC1pbnB1dHMnXG5cbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4vKiAgICAgICAgICAgICAgICAgIEhUTUwtSU5QVVRTICAgICAgICAgICAgICAgICAqL1xuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gaHRtbElucHV0cyhcbiAgaHRtbElucHV0c09wdGlvbnM6IEh0bWxJbnB1dHNPcHRpb25zLFxuICAvKiogVXNlZCBmb3IgdGVzdGluZyAqL1xuICBjYWNoZSA9IHtcbiAgICBzY3JpcHRzOiBbXSxcbiAgICBodG1sOiBbXSxcbiAgICBodG1sJDogW10sXG4gICAganM6IFtdLFxuICAgIGNzczogW10sXG4gICAgaW1nOiBbXSxcbiAgICBpbnB1dDogW10sXG4gIH0gYXMgSHRtbElucHV0c1BsdWdpbkNhY2hlLFxuKTogSHRtbElucHV0c1BsdWdpbiB7XG4gIHJldHVybiB7XG4gICAgbmFtZSxcbiAgICBjYWNoZSxcblxuICAgIC8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4gICAgLyogICAgICAgICAgICAgICAgIE9QVElPTlMgSE9PSyAgICAgICAgICAgICAgICAgKi9cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuXG4gICAgb3B0aW9ucyhvcHRpb25zKSB7XG4gICAgICAvLyBzcmNEaXIgbWF5IGJlIGluaXRpYWxpemVkIGJ5IGFub3RoZXIgcGx1Z2luXG4gICAgICBjb25zdCB7IHNyY0RpciB9ID0gaHRtbElucHV0c09wdGlvbnNcblxuICAgICAgaWYgKHNyY0Rpcikge1xuICAgICAgICBjYWNoZS5zcmNEaXIgPSBzcmNEaXJcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29wdGlvbnMuc3JjRGlyIG5vdCBpbml0aWFsaXplZCcpXG4gICAgICB9XG5cbiAgICAgIC8vIFNraXAgaWYgY2FjaGUuaW5wdXQgZXhpc3RzXG4gICAgICAvLyBjYWNoZSBpcyBkdW1wZWQgaW4gd2F0Y2hDaGFuZ2UgaG9va1xuXG4gICAgICAvLyBQYXJzZSBvcHRpb25zLmlucHV0IHRvIGFycmF5XG4gICAgICBsZXQgaW5wdXQ6IHN0cmluZ1tdXG4gICAgICBpZiAodHlwZW9mIG9wdGlvbnMuaW5wdXQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlucHV0ID0gW29wdGlvbnMuaW5wdXRdXG4gICAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkob3B0aW9ucy5pbnB1dCkpIHtcbiAgICAgICAgaW5wdXQgPSBbLi4ub3B0aW9ucy5pbnB1dF1cbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG9wdGlvbnMuaW5wdXQgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGlucHV0ID0gT2JqZWN0LnZhbHVlcyhvcHRpb25zLmlucHV0KVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcbiAgICAgICAgICBgb3B0aW9ucy5pbnB1dCBjYW5ub3QgYmUgJHt0eXBlb2Ygb3B0aW9ucy5pbnB1dH1gLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cbiAgICAgIC8qICAgICAgICAgICAgICAgICBIQU5ETEUgSFRNTCBGSUxFUyAgICAgICAgICAgICAgICAgKi9cbiAgICAgIC8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuICAgICAgLy8gRmlsdGVyIGh0bSBhbmQgaHRtbCBmaWxlc1xuICAgICAgY2FjaGUuaHRtbCA9IGlucHV0LmZpbHRlcihpc0h0bWwpXG5cbiAgICAgIC8vIElmIG5vIGh0bWwgZmlsZXMsIGRvIG5vdGhpbmdcbiAgICAgIGlmIChjYWNoZS5odG1sLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG9wdGlvbnNcblxuICAgICAgLy8gSWYgdGhlIGNhY2hlIGhhcyBiZWVuIGR1bXBlZCwgcmVsb2FkIGZyb20gZmlsZXNcbiAgICAgIGlmIChjYWNoZS5odG1sJC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgLy8gVGhpcyBpcyBhbGwgZG9uZSBvbmNlXG4gICAgICAgIGNhY2hlLmh0bWwkID0gY2FjaGUuaHRtbC5tYXAobG9hZEh0bWwoc3JjRGlyKSlcblxuICAgICAgICBjYWNoZS5qcyA9IGZsYXR0ZW4oY2FjaGUuaHRtbCQubWFwKGdldFNjcmlwdFNyYykpXG4gICAgICAgIGNhY2hlLmNzcyA9IGZsYXR0ZW4oY2FjaGUuaHRtbCQubWFwKGdldENzc0hyZWZzKSlcbiAgICAgICAgY2FjaGUuaW1nID0gZmxhdHRlbihjYWNoZS5odG1sJC5tYXAoZ2V0SW1nU3JjcykpXG4gICAgICAgIGNhY2hlLnNjcmlwdHMgPSBmbGF0dGVuKGNhY2hlLmh0bWwkLm1hcChnZXRKc0Fzc2V0cykpXG5cbiAgICAgICAgLy8gQ2FjaGUganNFbnRyaWVzIHdpdGggZXhpc3Rpbmcgb3B0aW9ucy5pbnB1dFxuICAgICAgICBjYWNoZS5pbnB1dCA9IGlucHV0LmZpbHRlcihub3QoaXNIdG1sKSkuY29uY2F0KGNhY2hlLmpzKVxuXG4gICAgICAgIC8vIFByZXBhcmUgY2FjaGUuaHRtbCQgZm9yIGFzc2V0IGVtaXNzaW9uXG4gICAgICAgIGNhY2hlLmh0bWwkLmZvckVhY2gobXV0YXRlU2NyaXB0RWxlbXMoaHRtbElucHV0c09wdGlvbnMpKVxuXG4gICAgICAgIGlmIChjYWNoZS5pbnB1dC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnQXQgbGVhc3Qgb25lIEhUTUwgZmlsZSBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIHNjcmlwdC4nLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUT0RPOiBzaW1wbHkgcmVtb3ZlIEhUTUwgZmlsZXMgZnJvbSBvcHRpb25zLmlucHV0XG4gICAgICAvLyAtIFBhcnNlIEhUTUwgYW5kIGVtaXQgY2h1bmtzIGFuZCBhc3NldHMgaW4gYnVpbGRTdGFydFxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgaW5wdXQ6IGNhY2hlLmlucHV0LnJlZHVjZShcbiAgICAgICAgICByZWR1Y2VUb1JlY29yZChodG1sSW5wdXRzT3B0aW9ucy5zcmNEaXIpLFxuICAgICAgICAgIHt9LFxuICAgICAgICApLFxuICAgICAgfVxuICAgIH0sXG5cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuICAgIC8qICAgICAgICAgICAgICBIQU5ETEUgRklMRSBDSEFOR0VTICAgICAgICAgICAgICovXG4gICAgLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuICAgIGFzeW5jIGJ1aWxkU3RhcnQoKSB7XG4gICAgICBjb25zdCB7IHNyY0RpciB9ID0gaHRtbElucHV0c09wdGlvbnNcblxuICAgICAgaWYgKHNyY0Rpcikge1xuICAgICAgICBjYWNoZS5zcmNEaXIgPSBzcmNEaXJcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29wdGlvbnMuc3JjRGlyIG5vdCBpbml0aWFsaXplZCcpXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGFzc2V0cyA9IFtcbiAgICAgICAgLi4uY2FjaGUuY3NzLFxuICAgICAgICAuLi5jYWNoZS5pbWcsXG4gICAgICAgIC4uLmNhY2hlLnNjcmlwdHMsXG4gICAgICBdXG5cbiAgICAgIGFzc2V0cy5jb25jYXQoY2FjaGUuaHRtbCkuZm9yRWFjaCgoYXNzZXQpID0+IHtcbiAgICAgICAgdGhpcy5hZGRXYXRjaEZpbGUoYXNzZXQpXG4gICAgICB9KVxuXG4gICAgICBjb25zdCBlbWl0dGluZyA9IGFzc2V0cy5tYXAoYXN5bmMgKGFzc2V0KSA9PiB7XG4gICAgICAgIC8vIFJlYWQgdGhlc2UgZmlsZXMgYXMgQnVmZmVyc1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBhd2FpdCByZWFkRmlsZShhc3NldClcbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSByZWxhdGl2ZShzcmNEaXIsIGFzc2V0KVxuXG4gICAgICAgIHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgICAgc291cmNlLCAvLyBCdWZmZXJcbiAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIGNhY2hlLmh0bWwkLm1hcCgoJCkgPT4ge1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBmb3JtYXRIdG1sKCQpXG4gICAgICAgIGNvbnN0IGZpbGVOYW1lID0gcmVsYXRpdmUoc3JjRGlyLCAkLmZpbGVQYXRoKVxuXG4gICAgICAgIHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgICAgc291cmNlLCAvLyBTdHJpbmdcbiAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKGVtaXR0aW5nKVxuICAgIH0sXG5cbiAgICB3YXRjaENoYW5nZShpZCkge1xuICAgICAgaWYgKGlkLmVuZHNXaXRoKCcuaHRtbCcpIHx8IGlkLmVuZHNXaXRoKCdtYW5pZmVzdC5qc29uJykpIHtcbiAgICAgICAgLy8gRHVtcCBjYWNoZSBpZiBodG1sIGZpbGUgb3IgbWFuaWZlc3QgY2hhbmdlc1xuICAgICAgICBjYWNoZS5odG1sJCA9IFtdXG4gICAgICB9XG4gICAgfSxcbiAgfVxufVxuIiwiaW1wb3J0IHsgY29kZSBhcyBleHBsaWNpdFNjcmlwdCB9IGZyb20gJ2NvZGUgLi9icm93c2VyL2ltcG9ydFdyYXBwZXItLWV4cGxpY2l0LnRzJ1xuaW1wb3J0IHsgY29kZSBhcyBpbXBsaWNpdFNjcmlwdCB9IGZyb20gJ2NvZGUgLi9icm93c2VyL2ltcG9ydFdyYXBwZXItLWltcGxpY2l0LnRzJ1xuXG4vKipcbiAqIFRoaXMgb3B0aW9ucyBvYmplY3QgYWxsb3dzIGZpbmUtdHVuaW5nIG9mIHRoZSBkeW5hbWljIGltcG9ydCB3cmFwcGVyLlxuICpcbiAqIEBleHBvcnRcbiAqIEBpbnRlcmZhY2UgRHluYW1pY0ltcG9ydFdyYXBwZXJcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBEeW5hbWljSW1wb3J0V3JhcHBlck9wdGlvbnMge1xuICAvKiogSG93IGxvbmcgdG8gZGVsYXkgd2FrZSBldmVudHMgYWZ0ZXIgZHluYW1pYyBpbXBvcnQgaGFzIGNvbXBsZXRlZCAqL1xuICBldmVudERlbGF5PzogbnVtYmVyXG4gIC8qKiBMaW1pdCB3aGljaCB3YWtlIGV2ZW50cyB0byBjYXB0dXJlLiBVc2UgaWYgdGhlIGRlZmF1bHQgZXZlbnQgZGlzY292ZXJ5IGlzIHRvbyBzbG93LiAqL1xuICB3YWtlRXZlbnRzPzogc3RyaW5nW11cbiAgLyoqIEFQSSBuYW1lc3BhY2VzIHRvIGV4Y2x1ZGUgZnJvbSBhdXRvbWF0aWMgZGV0ZWN0aW9uICovXG4gIGV4Y2x1ZGVOYW1lcz86IHN0cmluZ1tdXG59XG5cbi8vIEZFQVRVUkU6IGFkZCBzdGF0aWMgY29kZSBhbmFseXNpcyBmb3Igd2FrZSBldmVudHNcbi8vICAtIFRoaXMgd2lsbCBiZSBzbG93ZXIuLi5cbmV4cG9ydCBmdW5jdGlvbiBwcmVwSW1wb3J0V3JhcHBlclNjcmlwdCh7XG4gIGV2ZW50RGVsYXkgPSAwLFxuICB3YWtlRXZlbnRzID0gW10sXG4gIGV4Y2x1ZGVOYW1lcyA9IFsnZXh0ZW5zaW9uJ10sXG59OiBEeW5hbWljSW1wb3J0V3JhcHBlck9wdGlvbnMpIHtcbiAgY29uc3QgZGVsYXkgPSBKU09OLnN0cmluZ2lmeShldmVudERlbGF5KVxuICBjb25zdCBldmVudHMgPSB3YWtlRXZlbnRzLmxlbmd0aFxuICAgID8gSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIHdha2VFdmVudHMubWFwKChldikgPT4gZXYucmVwbGFjZSgvXmNocm9tZVxcLi8sICcnKSksXG4gICAgICApXG4gICAgOiBmYWxzZVxuICBjb25zdCBleGNsdWRlID0gSlNPTi5zdHJpbmdpZnkoZXhjbHVkZU5hbWVzKVxuXG4gIGNvbnN0IHNjcmlwdCA9IChldmVudHNcbiAgICA/IGV4cGxpY2l0U2NyaXB0LnJlcGxhY2UoJyVFVkVOVFMlJywgZXZlbnRzKVxuICAgIDogaW1wbGljaXRTY3JpcHQucmVwbGFjZSgnJUVYQ0xVREUlJywgZXhjbHVkZSlcbiAgKS5yZXBsYWNlKCclREVMQVklJywgZGVsYXkpXG5cbiAgcmV0dXJuIHNjcmlwdFxufVxuIiwiaW1wb3J0ICdhcnJheS1mbGF0LXBvbHlmaWxsJ1xuXG5leHBvcnQgY29uc3QgY29tYmluZVBlcm1zID0gKFxuICAuLi5wZXJtaXNzaW9uczogc3RyaW5nW10gfCBzdHJpbmdbXVtdXG4pOiBzdHJpbmdbXSA9PiB7XG4gIGNvbnN0IHsgcGVybXMsIHhwZXJtcyB9ID0gKHBlcm1pc3Npb25zLmZsYXQoXG4gICAgSW5maW5pdHksXG4gICkgYXMgc3RyaW5nW10pXG4gICAgLmZpbHRlcigocGVybSkgPT4gdHlwZW9mIHBlcm0gIT09ICd1bmRlZmluZWQnKVxuICAgIC5yZWR1Y2UoXG4gICAgICAoeyBwZXJtcywgeHBlcm1zIH0sIHBlcm0pID0+IHtcbiAgICAgICAgaWYgKHBlcm0uc3RhcnRzV2l0aCgnIScpKSB7XG4gICAgICAgICAgeHBlcm1zLmFkZChwZXJtLnNsaWNlKDEpKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHBlcm1zLmFkZChwZXJtKVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgcGVybXMsIHhwZXJtcyB9XG4gICAgICB9LFxuICAgICAgeyBwZXJtczogbmV3IFNldDxzdHJpbmc+KCksIHhwZXJtczogbmV3IFNldDxzdHJpbmc+KCkgfSxcbiAgICApXG5cbiAgcmV0dXJuIFsuLi5wZXJtc10uZmlsdGVyKChwKSA9PiAheHBlcm1zLmhhcyhwKSlcbn1cbiIsIi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4vKiAgICAgICAgICAgICAgIENIRUNLIFBFUk1JU1NJT05TICAgICAgICAgICAgICAqL1xuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuLy8gZXhwb3J0IGNvbnN0IGRlYnVnZ2VyID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmRlYnVnZ2VyLy50ZXN0KHMpXG4vLyBleHBvcnQgY29uc3QgZW50ZXJwcmlzZS5kZXZpY2VBdHRyaWJ1dGVzID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmVudGVycHJpc2VcXC5kZXZpY2VBdHRyaWJ1dGVzLy50ZXN0KHMpXG4vLyBleHBvcnQgY29uc3QgZW50ZXJwcmlzZS5oYXJkd2FyZVBsYXRmb3JtID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmVudGVycHJpc2VcXC5oYXJkd2FyZVBsYXRmb3JtLy50ZXN0KHMpXG4vLyBleHBvcnQgY29uc3QgZW50ZXJwcmlzZS5wbGF0Zm9ybUtleXMgPSBzID0+IC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZW50ZXJwcmlzZVxcLnBsYXRmb3JtS2V5cy8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IG5ldHdvcmtpbmcuY29uZmlnID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKm5ldHdvcmtpbmdcXC5jb25maWcvLnRlc3Qocylcbi8vIGV4cG9ydCBjb25zdCBzeXN0ZW0uY3B1ID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnN5c3RlbVxcLmNwdS8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IHN5c3RlbS5kaXNwbGF5ID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnN5c3RlbVxcLmRpc3BsYXkvLnRlc3Qocylcbi8vIGV4cG9ydCBjb25zdCBzeXN0ZW0ubWVtb3J5ID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnN5c3RlbVxcLm1lbW9yeS8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IHN5c3RlbS5zdG9yYWdlID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnN5c3RlbVxcLnN0b3JhZ2UvLnRlc3QocylcblxuZXhwb3J0IGNvbnN0IGFsYXJtcyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qYWxhcm1zLy50ZXN0KHMpXG5cbmV4cG9ydCBjb25zdCBib29rbWFya3MgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmJvb2ttYXJrcy8udGVzdChzKVxuXG5leHBvcnQgY29uc3QgY29udGVudFNldHRpbmdzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpjb250ZW50U2V0dGluZ3MvLnRlc3QocylcblxuZXhwb3J0IGNvbnN0IGNvbnRleHRNZW51cyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qY29udGV4dE1lbnVzLy50ZXN0KHMpXG5cbmV4cG9ydCBjb25zdCBjb29raWVzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpjb29raWVzLy50ZXN0KHMpXG5cbmV4cG9ydCBjb25zdCBkZWNsYXJhdGl2ZUNvbnRlbnQgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmRlY2xhcmF0aXZlQ29udGVudC8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGRlY2xhcmF0aXZlTmV0UmVxdWVzdCA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZGVjbGFyYXRpdmVOZXRSZXF1ZXN0Ly50ZXN0KHMpXG5leHBvcnQgY29uc3QgZGVjbGFyYXRpdmVXZWJSZXF1ZXN0ID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpkZWNsYXJhdGl2ZVdlYlJlcXVlc3QvLnRlc3QocylcbmV4cG9ydCBjb25zdCBkZXNrdG9wQ2FwdHVyZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZGVza3RvcENhcHR1cmUvLnRlc3QocylcbmV4cG9ydCBjb25zdCBkaXNwbGF5U291cmNlID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpkaXNwbGF5U291cmNlLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZG5zID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpkbnMvLnRlc3QocylcbmV4cG9ydCBjb25zdCBkb2N1bWVudFNjYW4gPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmRvY3VtZW50U2Nhbi8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGRvd25sb2FkcyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZG93bmxvYWRzLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZXhwZXJpbWVudGFsID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpleHBlcmltZW50YWwvLnRlc3QocylcbmV4cG9ydCBjb25zdCBmaWxlQnJvd3NlckhhbmRsZXIgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmZpbGVCcm93c2VySGFuZGxlci8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGZpbGVTeXN0ZW1Qcm92aWRlciA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZmlsZVN5c3RlbVByb3ZpZGVyLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZm9udFNldHRpbmdzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpmb250U2V0dGluZ3MvLnRlc3QocylcbmV4cG9ydCBjb25zdCBnY20gPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmdjbS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGdlb2xvY2F0aW9uID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpnZW9sb2NhdGlvbi8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGhpc3RvcnkgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmhpc3RvcnkvLnRlc3QocylcbmV4cG9ydCBjb25zdCBpZGVudGl0eSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qaWRlbnRpdHkvLnRlc3QocylcbmV4cG9ydCBjb25zdCBpZGxlID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSppZGxlLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgaWRsdGVzdCA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qaWRsdGVzdC8udGVzdChzKVxuZXhwb3J0IGNvbnN0IG1hbmFnZW1lbnQgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKm1hbmFnZW1lbnQvLnRlc3QocylcbmV4cG9ydCBjb25zdCBuYXRpdmVNZXNzYWdpbmcgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKm5hdGl2ZU1lc3NhZ2luZy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IG5vdGlmaWNhdGlvbnMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKm5vdGlmaWNhdGlvbnMvLnRlc3QocylcbmV4cG9ydCBjb25zdCBwYWdlQ2FwdHVyZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qcGFnZUNhcHR1cmUvLnRlc3QocylcbmV4cG9ydCBjb25zdCBwbGF0Zm9ybUtleXMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnBsYXRmb3JtS2V5cy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHBvd2VyID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpwb3dlci8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHByaW50ZXJQcm92aWRlciA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qcHJpbnRlclByb3ZpZGVyLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgcHJpdmFjeSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qcHJpdmFjeS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHByb2Nlc3NlcyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qcHJvY2Vzc2VzLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgcHJveHkgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnByb3h5Ly50ZXN0KHMpXG5leHBvcnQgY29uc3Qgc2Vzc2lvbnMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnNlc3Npb25zLy50ZXN0KHMpXG5leHBvcnQgY29uc3Qgc2lnbmVkSW5EZXZpY2VzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzaWduZWRJbkRldmljZXMvLnRlc3QocylcbmV4cG9ydCBjb25zdCBzdG9yYWdlID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzdG9yYWdlLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgdGFiQ2FwdHVyZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qdGFiQ2FwdHVyZS8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IHRhYnMgPSBzID0+IC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qdGFicy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHRvcFNpdGVzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSp0b3BTaXRlcy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHR0cyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qdHRzLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgdHRzRW5naW5lID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSp0dHNFbmdpbmUvLnRlc3QocylcbmV4cG9ydCBjb25zdCB1bmxpbWl0ZWRTdG9yYWdlID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSp1bmxpbWl0ZWRTdG9yYWdlLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgdnBuUHJvdmlkZXIgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnZwblByb3ZpZGVyLy50ZXN0KHMpXG5leHBvcnQgY29uc3Qgd2FsbHBhcGVyID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSp3YWxscGFwZXIvLnRlc3QocylcbmV4cG9ydCBjb25zdCB3ZWJOYXZpZ2F0aW9uID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSp3ZWJOYXZpZ2F0aW9uLy50ZXN0KHMpXG5leHBvcnQgY29uc3Qgd2ViUmVxdWVzdCA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qd2ViUmVxdWVzdC8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHdlYlJlcXVlc3RCbG9ja2luZyA9IChzOiBzdHJpbmcpID0+XG4gIHdlYlJlcXVlc3QocykgJiYgcy5pbmNsdWRlcygnXFwnYmxvY2tpbmdcXCcnKVxuXG4vLyBUT0RPOiBhZGQgcmVhZENsaXBib2FyZFxuLy8gVE9ETzogYWRkIHdyaXRlQ2xpcGJvYXJkXG4iLCJpbXBvcnQgZ2xvYiBmcm9tICdnbG9iJ1xuaW1wb3J0IGdldCBmcm9tICdsb2Rhc2guZ2V0J1xuaW1wb3J0IGRpZmYgZnJvbSAnbG9kYXNoLmRpZmZlcmVuY2UnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCdcbmltcG9ydCB7IE91dHB1dENodW5rIH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0ICogYXMgcGVybWlzc2lvbnMgZnJvbSAnLi9wZXJtaXNzaW9ucydcbmltcG9ydCB7XG4gIENocm9tZUV4dGVuc2lvbk1hbmlmZXN0LFxuICBDb250ZW50U2NyaXB0LFxufSBmcm9tICcuLi8uLi9tYW5pZmVzdCdcblxuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cbi8qICAgICAgICAgICAgICBERVJJVkUgUEVSTUlTU0lPTlMgICAgICAgICAgICAgICovXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuXG5leHBvcnQgY29uc3QgZGVyaXZlUGVybWlzc2lvbnMgPSAoXG4gIHNldDogU2V0PHN0cmluZz4sXG4gIHsgY29kZSB9OiBPdXRwdXRDaHVuayxcbikgPT5cbiAgT2JqZWN0LmVudHJpZXMocGVybWlzc2lvbnMpXG4gICAgLmZpbHRlcigoWywgZm5dKSA9PiBmbihjb2RlKSlcbiAgICAubWFwKChba2V5XSkgPT4ga2V5KVxuICAgIC5yZWR1Y2UoKHMsIHApID0+IHMuYWRkKHApLCBzZXQpXG5cbi8vIC8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4vLyAvKiAgICAgICAgICAgICAgICBERVJJVkUgTUFOSUZFU1QgICAgICAgICAgICAgICAqL1xuLy8gLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuLy8gZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZU1hbmlmZXN0KFxuLy8gICBtYW5pZmVzdDogQ2hyb21lRXh0ZW5zaW9uTWFuaWZlc3QsIC8vIG1hbmlmZXN0Lmpzb25cbi8vICAgLi4ucGVybWlzc2lvbnM6IHN0cmluZ1tdIHwgc3RyaW5nW11bXSAvLyB3aWxsIGJlIGNvbWJpbmVkIHdpdGggbWFuaWZlc3QucGVybWlzc2lvbnNcbi8vICk6IENocm9tZUV4dGVuc2lvbk1hbmlmZXN0IHtcbi8vICAgcmV0dXJuIHZhbGlkYXRlTWFuaWZlc3Qoe1xuLy8gICAgIC8vIFNNRUxMOiBJcyB0aGlzIG5lY2Vzc2FyeT9cbi8vICAgICBtYW5pZmVzdF92ZXJzaW9uOiAyLFxuLy8gICAgIC4uLm1hbmlmZXN0LFxuLy8gICAgIHBlcm1pc3Npb25zOiBjb21iaW5lUGVybXMocGVybWlzc2lvbnMsIG1hbmlmZXN0LnBlcm1pc3Npb25zKSxcbi8vICAgfSlcbi8vIH1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cbi8qICAgICAgICAgICAgICAgICBERVJJVkUgRklMRVMgICAgICAgICAgICAgICAgICovXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlRmlsZXMoXG4gIG1hbmlmZXN0OiBDaHJvbWVFeHRlbnNpb25NYW5pZmVzdCxcbiAgc3JjRGlyOiBzdHJpbmcsXG4pIHtcbiAgY29uc3QgZmlsZXMgPSBnZXQoXG4gICAgbWFuaWZlc3QsXG4gICAgJ3dlYl9hY2Nlc3NpYmxlX3Jlc291cmNlcycsXG4gICAgW10gYXMgc3RyaW5nW10sXG4gICkucmVkdWNlKChyLCB4KSA9PiB7XG4gICAgaWYgKGdsb2IuaGFzTWFnaWMoeCkpIHtcbiAgICAgIGNvbnN0IGZpbGVzID0gZ2xvYi5zeW5jKHgsIHsgY3dkOiBzcmNEaXIgfSlcbiAgICAgIHJldHVybiBbLi4uciwgLi4uZmlsZXMubWFwKChmKSA9PiBmLnJlcGxhY2Uoc3JjRGlyLCAnJykpXVxuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gWy4uLnIsIHhdXG4gICAgfVxuICB9LCBbXSBhcyBzdHJpbmdbXSlcblxuICBjb25zdCBqcyA9IFtcbiAgICAuLi5maWxlcy5maWx0ZXIoKGYpID0+IC9cXC5banRdc3g/JC8udGVzdChmKSksXG4gICAgLi4uZ2V0KG1hbmlmZXN0LCAnYmFja2dyb3VuZC5zY3JpcHRzJywgW10gYXMgc3RyaW5nW10pLFxuICAgIC4uLmdldChcbiAgICAgIG1hbmlmZXN0LFxuICAgICAgJ2NvbnRlbnRfc2NyaXB0cycsXG4gICAgICBbXSBhcyBDb250ZW50U2NyaXB0W10sXG4gICAgKS5yZWR1Y2UoKHIsIHsganMgPSBbXSB9KSA9PiBbLi4uciwgLi4uanNdLCBbXSBhcyBzdHJpbmdbXSksXG4gIF1cblxuICBjb25zdCBodG1sID0gW1xuICAgIC4uLmZpbGVzLmZpbHRlcigoZikgPT4gL1xcLmh0bWw/JC8udGVzdChmKSksXG4gICAgZ2V0KG1hbmlmZXN0LCAnYmFja2dyb3VuZC5wYWdlJyksXG4gICAgZ2V0KG1hbmlmZXN0LCAnb3B0aW9uc19wYWdlJyksXG4gICAgZ2V0KG1hbmlmZXN0LCAnb3B0aW9uc191aS5wYWdlJyksXG4gICAgZ2V0KG1hbmlmZXN0LCAnZGV2dG9vbHNfcGFnZScpLFxuICAgIGdldChtYW5pZmVzdCwgJ2Jyb3dzZXJfYWN0aW9uLmRlZmF1bHRfcG9wdXAnKSxcbiAgICBnZXQobWFuaWZlc3QsICdwYWdlX2FjdGlvbi5kZWZhdWx0X3BvcHVwJyksXG4gICAgLi4uT2JqZWN0LnZhbHVlcyhnZXQobWFuaWZlc3QsICdjaHJvbWVfdXJsX292ZXJyaWRlcycsIHt9KSksXG4gIF1cblxuICBjb25zdCBjc3MgPSBbXG4gICAgLi4uZmlsZXMuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKCcuY3NzJykpLFxuICAgIC4uLmdldChcbiAgICAgIG1hbmlmZXN0LFxuICAgICAgJ2NvbnRlbnRfc2NyaXB0cycsXG4gICAgICBbXSBhcyBDb250ZW50U2NyaXB0W10sXG4gICAgKS5yZWR1Y2UoXG4gICAgICAociwgeyBjc3MgPSBbXSB9KSA9PiBbLi4uciwgLi4uY3NzXSxcbiAgICAgIFtdIGFzIHN0cmluZ1tdLFxuICAgICksXG4gIF1cblxuICAvLyBUT0RPOiB0aGlzIGNhbiBiZSBhIHN0cmluZyBvciBvYmplY3RcbiAgY29uc3QgYWN0aW9uSWNvblNldCA9IFtcbiAgICAnYnJvd3Nlcl9hY3Rpb24uZGVmYXVsdF9pY29uJyxcbiAgICAncGFnZV9hY3Rpb24uZGVmYXVsdF9pY29uJyxcbiAgXS5yZWR1Y2UoKHNldCwgcXVlcnkpID0+IHtcbiAgICBjb25zdCByZXN1bHQ6IHN0cmluZyB8IHsgW3NpemU6IHN0cmluZ106IHN0cmluZyB9ID0gZ2V0KFxuICAgICAgbWFuaWZlc3QsXG4gICAgICBxdWVyeSxcbiAgICAgIHt9LFxuICAgIClcblxuICAgIGlmICh0eXBlb2YgcmVzdWx0ID09PSAnc3RyaW5nJykge1xuICAgICAgc2V0LmFkZChyZXN1bHQpXG4gICAgfSBlbHNlIHtcbiAgICAgIE9iamVjdC52YWx1ZXMocmVzdWx0KS5mb3JFYWNoKCh4KSA9PiBzZXQuYWRkKHgpKVxuICAgIH1cblxuICAgIHJldHVybiBzZXRcbiAgfSwgbmV3IFNldDxzdHJpbmc+KCkpXG5cbiAgY29uc3QgaW1nID0gW1xuICAgIC4uLmFjdGlvbkljb25TZXQsXG4gICAgLi4uZmlsZXMuZmlsdGVyKChmKSA9PlxuICAgICAgL1xcLihqcGU/Z3xwbmd8c3ZnfHRpZmY/fGdpZnx3ZWJwfGJtcHxpY28pJC9pLnRlc3QoZiksXG4gICAgKSxcbiAgICAuLi5PYmplY3QudmFsdWVzKGdldChtYW5pZmVzdCwgJ2ljb25zJywge30pKSxcbiAgXVxuXG4gIC8vIEZpbGVzIGxpa2UgZm9udHMsIHRoaW5ncyB0aGF0IGFyZSBub3QgZXhwZWN0ZWRcbiAgY29uc3Qgb3RoZXJzID0gZGlmZihmaWxlcywgY3NzLCBqcywgaHRtbCwgaW1nKVxuXG4gIHJldHVybiB7XG4gICAgY3NzOiB2YWxpZGF0ZShjc3MpLFxuICAgIGpzOiB2YWxpZGF0ZShqcyksXG4gICAgaHRtbDogdmFsaWRhdGUoaHRtbCksXG4gICAgaW1nOiB2YWxpZGF0ZShpbWcpLFxuICAgIG90aGVyczogdmFsaWRhdGUob3RoZXJzKSxcbiAgfVxuXG4gIGZ1bmN0aW9uIHZhbGlkYXRlKGFyeTogYW55W10pIHtcbiAgICByZXR1cm4gWy4uLm5ldyBTZXQoYXJ5LmZpbHRlcihpc1N0cmluZykpXS5tYXAoKHgpID0+XG4gICAgICBqb2luKHNyY0RpciwgeCksXG4gICAgKVxuICB9XG5cbiAgZnVuY3Rpb24gaXNTdHJpbmcoeDogYW55KTogeCBpcyBzdHJpbmcge1xuICAgIHJldHVybiB0eXBlb2YgeCA9PT0gJ3N0cmluZydcbiAgfVxufVxuIiwiaW1wb3J0IEFqdiBmcm9tICdhanYnXG5pbXBvcnQgeyBDaHJvbWVFeHRlbnNpb25NYW5pZmVzdCB9IGZyb20gJy4uLy4uL21hbmlmZXN0J1xuaW1wb3J0IGpzb25TY2hlbWEgZnJvbSAnLi9qc29uLXNjaGVtYS1kcmFmdC0wNC5qc29uJ1xuaW1wb3J0IG1hbmlmZXN0U2NoZW1hIGZyb20gJy4vc2NoZW1hLXdlYi1leHQtbWFuaWZlc3QtdjIuanNvbidcblxuZXhwb3J0IHR5cGUgVmFsaWRhdGlvbkVycm9yc0FycmF5ID1cbiAgfCBBanYuRXJyb3JPYmplY3RbXVxuICB8IG51bGxcbiAgfCB1bmRlZmluZWRcbmV4cG9ydCBjbGFzcyBWYWxpZGF0aW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1zZzogc3RyaW5nLCBlcnJvcnM6IFZhbGlkYXRpb25FcnJvcnNBcnJheSkge1xuICAgIHN1cGVyKG1zZylcbiAgICB0aGlzLm5hbWUgPSAnVmFsaWRhdGlvbkVycm9yJ1xuICAgIHRoaXMuZXJyb3JzID0gZXJyb3JzXG4gIH1cbiAgZXJyb3JzOiBWYWxpZGF0aW9uRXJyb3JzQXJyYXlcbn1cblxuLy8gY29uc3QganNvblNjaGVtYSA9IHJlYWRKU09OU3luYyhcbi8vICAgcmVzb2x2ZShfX2Rpcm5hbWUsICdqc29uLXNjaGVtYS1kcmFmdC0wNC5qc29uJyksXG4vLyApXG5cbi8vIGNvbnN0IG1hbmlmZXN0U2NoZW1hID0gcmVhZEpTT05TeW5jKFxuLy8gICByZXNvbHZlKF9fZGlybmFtZSwgJ3NjaGVtYS13ZWItZXh0LW1hbmlmZXN0LXYyLmpzb24nKSxcbi8vIClcblxuZXhwb3J0IGNvbnN0IGFqdiA9IG5ldyBBanYoe1xuICB2ZXJib3NlOiB0cnVlLFxuICBzY2hlbWFJZDogJ2F1dG8nLFxuICBzY2hlbWFzOiB7XG4gICAgJ2h0dHA6Ly9qc29uLXNjaGVtYS5vcmcvZHJhZnQtMDQvc2NoZW1hIyc6IGpzb25TY2hlbWEsXG4gIH0sXG4gIHN0cmljdERlZmF1bHRzOiB0cnVlLFxufSlcblxuLy8gYWp2LmFkZE1ldGFTY2hlbWEoanNvblNjaGVtYSlcblxuY29uc3QgdmFsaWRhdG9yID0gYWp2LmNvbXBpbGUobWFuaWZlc3RTY2hlbWEpXG5cbmV4cG9ydCBjb25zdCB2YWxpZGF0ZU1hbmlmZXN0ID0gKFxuICBtYW5pZmVzdDogQ2hyb21lRXh0ZW5zaW9uTWFuaWZlc3QsXG4pID0+IHtcbiAgaWYgKHZhbGlkYXRvcihtYW5pZmVzdCkpIHtcbiAgICByZXR1cm4gbWFuaWZlc3RcbiAgfVxuXG4gIGNvbnN0IHsgZXJyb3JzIH0gPSB2YWxpZGF0b3JcbiAgY29uc3QgbXNnID0gJ1RoZXJlIHdlcmUgcHJvYmxlbXMgd2l0aCB0aGUgZXh0ZW5zaW9uIG1hbmlmZXN0LidcblxuICB0aHJvdyBuZXcgVmFsaWRhdGlvbkVycm9yKG1zZywgZXJyb3JzKVxufVxuIiwiaW1wb3J0IHsgY29kZSBhcyBjdFdyYXBwZXJTY3JpcHQgfSBmcm9tICdjb2RlIC4vYnJvd3Nlci9jb250ZW50U2NyaXB0V3JhcHBlci50cydcbmltcG9ydCB7IGNvc21pY29uZmlnU3luYyB9IGZyb20gJ2Nvc21pY29uZmlnJ1xuaW1wb3J0IGZzIGZyb20gJ2ZzLWV4dHJhJ1xuaW1wb3J0IHsgSlNPTlBhdGggfSBmcm9tICdqc29ucGF0aC1wbHVzJ1xuaW1wb3J0IG1lbW9pemUgZnJvbSAnbWVtJ1xuaW1wb3J0IHBhdGgsIHsgYmFzZW5hbWUsIHJlbGF0aXZlIH0gZnJvbSAncGF0aCdcbmltcG9ydCB7IEVtaXR0ZWRBc3NldCwgT3V0cHV0Q2h1bmsgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgc2xhc2ggZnJvbSAnc2xhc2gnXG5pbXBvcnQge1xuICBpc0NodW5rLFxuICBpc0pzb25GaWxlUGF0aCxcbiAgbm9ybWFsaXplRmlsZW5hbWUsXG59IGZyb20gJy4uL2hlbHBlcnMnXG5pbXBvcnQgeyBDaHJvbWVFeHRlbnNpb25NYW5pZmVzdCB9IGZyb20gJy4uL21hbmlmZXN0J1xuaW1wb3J0IHtcbiAgTWFuaWZlc3RJbnB1dFBsdWdpbixcbiAgTWFuaWZlc3RJbnB1dFBsdWdpbkNhY2hlLFxuICBNYW5pZmVzdElucHV0UGx1Z2luT3B0aW9ucyxcbn0gZnJvbSAnLi4vcGx1Z2luLW9wdGlvbnMnXG5pbXBvcnQgeyBjbG9uZU9iamVjdCB9IGZyb20gJy4vY2xvbmVPYmplY3QnXG5pbXBvcnQgeyBwcmVwSW1wb3J0V3JhcHBlclNjcmlwdCB9IGZyb20gJy4vZHluYW1pY0ltcG9ydFdyYXBwZXInXG5pbXBvcnQgeyBjb21iaW5lUGVybXMgfSBmcm9tICcuL21hbmlmZXN0LXBhcnNlci9jb21iaW5lJ1xuaW1wb3J0IHtcbiAgZGVyaXZlRmlsZXMsXG4gIGRlcml2ZVBlcm1pc3Npb25zLFxufSBmcm9tICcuL21hbmlmZXN0LXBhcnNlci9pbmRleCdcbmltcG9ydCB7XG4gIHZhbGlkYXRlTWFuaWZlc3QsXG4gIFZhbGlkYXRpb25FcnJvcnNBcnJheSxcbn0gZnJvbSAnLi9tYW5pZmVzdC1wYXJzZXIvdmFsaWRhdGUnXG5pbXBvcnQgeyByZWR1Y2VUb1JlY29yZCB9IGZyb20gJy4vcmVkdWNlVG9SZWNvcmQnXG5cbmV4cG9ydCBmdW5jdGlvbiBkZWR1cGU8VD4oeDogVFtdKTogVFtdIHtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KHgpXVxufVxuXG5leHBvcnQgY29uc3QgZXhwbG9yZXIgPSBjb3NtaWNvbmZpZ1N5bmMoJ21hbmlmZXN0Jywge1xuICBjYWNoZTogZmFsc2UsXG59KVxuXG5jb25zdCBuYW1lID0gJ21hbmlmZXN0LWlucHV0J1xuXG5leHBvcnQgY29uc3Qgc3R1YkNodW5rTmFtZSA9XG4gICdzdHViX19lbXB0eS1jaHJvbWUtZXh0ZW5zaW9uLW1hbmlmZXN0J1xuXG5jb25zdCBucG1Qa2dEZXRhaWxzID1cbiAgcHJvY2Vzcy5lbnYubnBtX3BhY2thZ2VfbmFtZSAmJlxuICBwcm9jZXNzLmVudi5ucG1fcGFja2FnZV92ZXJzaW9uICYmXG4gIHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX2Rlc2NyaXB0aW9uXG4gICAgPyB7XG4gICAgICAgIG5hbWU6IHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX25hbWUsXG4gICAgICAgIHZlcnNpb246IHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX3ZlcnNpb24sXG4gICAgICAgIGRlc2NyaXB0aW9uOiBwcm9jZXNzLmVudi5ucG1fcGFja2FnZV9kZXNjcmlwdGlvbixcbiAgICAgIH1cbiAgICA6IHtcbiAgICAgICAgbmFtZTogJycsXG4gICAgICAgIHZlcnNpb246ICcnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJycsXG4gICAgICB9XG5cbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4vKiAgICAgICAgICAgICAgICBNQU5JRkVTVC1JTlBVVCAgICAgICAgICAgICAgICAqL1xuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuZXhwb3J0IGZ1bmN0aW9uIG1hbmlmZXN0SW5wdXQoXG4gIHtcbiAgICBicm93c2VyUG9seWZpbGwgPSBmYWxzZSxcbiAgICBjb250ZW50U2NyaXB0V3JhcHBlciA9IHRydWUsXG4gICAgY3Jvc3NCcm93c2VyID0gZmFsc2UsXG4gICAgZHluYW1pY0ltcG9ydFdyYXBwZXIgPSB7fSxcbiAgICBleHRlbmRNYW5pZmVzdCA9IHt9LFxuICAgIGZpcnN0Q2xhc3NNYW5pZmVzdCA9IHRydWUsXG4gICAgaWlmZUpzb25QYXRocyA9IFtdLFxuICAgIHBrZyA9IG5wbVBrZ0RldGFpbHMsXG4gICAgcHVibGljS2V5LFxuICAgIHZlcmJvc2UgPSB0cnVlLFxuICAgIGNhY2hlID0ge1xuICAgICAgYXNzZXRDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFzc2V0czogW10sXG4gICAgICBpaWZlOiBbXSxcbiAgICAgIGlucHV0OiBbXSxcbiAgICAgIGlucHV0QXJ5OiBbXSxcbiAgICAgIGlucHV0T2JqOiB7fSxcbiAgICAgIHBlcm1zSGFzaDogJycsXG4gICAgICByZWFkRmlsZTogbmV3IE1hcDxzdHJpbmcsIGFueT4oKSxcbiAgICAgIHNyY0RpcjogbnVsbCxcbiAgICB9IGFzIE1hbmlmZXN0SW5wdXRQbHVnaW5DYWNoZSxcbiAgfSA9IHt9IGFzIE1hbmlmZXN0SW5wdXRQbHVnaW5PcHRpb25zLFxuKTogTWFuaWZlc3RJbnB1dFBsdWdpbiB7XG4gIGNvbnN0IHJlYWRBc3NldEFzQnVmZmVyID0gbWVtb2l6ZShcbiAgICAoZmlsZXBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgcmV0dXJuIGZzLnJlYWRGaWxlKGZpbGVwYXRoKVxuICAgIH0sXG4gICAge1xuICAgICAgY2FjaGU6IGNhY2hlLnJlYWRGaWxlLFxuICAgIH0sXG4gIClcblxuICAvKiAtLS0tLS0tLS0tLSBIT09LUyBDTE9TVVJFUyBTVEFSVCAtLS0tLS0tLS0tLSAqL1xuXG4gIGxldCBtYW5pZmVzdFBhdGg6IHN0cmluZ1xuXG4gIGNvbnN0IG1hbmlmZXN0TmFtZSA9ICdtYW5pZmVzdC5qc29uJ1xuXG4gIC8qIC0tLS0tLS0tLS0tLSBIT09LUyBDTE9TVVJFUyBFTkQgLS0tLS0tLS0tLS0tICovXG5cbiAgLyogLSBTRVRVUCBEWU5BTUlDIElNUE9SVCBMT0FERVIgU0NSSVBUIFNUQVJUIC0gKi9cblxuICBsZXQgd3JhcHBlclNjcmlwdCA9ICcnXG4gIGlmIChkeW5hbWljSW1wb3J0V3JhcHBlciAhPT0gZmFsc2UpIHtcbiAgICB3cmFwcGVyU2NyaXB0ID0gcHJlcEltcG9ydFdyYXBwZXJTY3JpcHQoZHluYW1pY0ltcG9ydFdyYXBwZXIpXG4gIH1cblxuICAvKiAtLSBTRVRVUCBEWU5BTUlDIElNUE9SVCBMT0FERVIgU0NSSVBUIEVORCAtLSAqL1xuXG4gIC8qIC0tLS0tLS0tLS0tLS0tLSBwbHVnaW4gb2JqZWN0IC0tLS0tLS0tLS0tLS0tICovXG4gIHJldHVybiB7XG4gICAgbmFtZSxcblxuICAgIGJyb3dzZXJQb2x5ZmlsbCxcbiAgICBjcm9zc0Jyb3dzZXIsXG5cbiAgICBnZXQgc3JjRGlyKCkge1xuICAgICAgcmV0dXJuIGNhY2hlLnNyY0RpclxuICAgIH0sXG5cbiAgICBnZXQgZm9ybWF0TWFwKCkge1xuICAgICAgcmV0dXJuIHsgaWlmZTogY2FjaGUuaWlmZSB9XG4gICAgfSxcblxuICAgIC8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4gICAgLyogICAgICAgICAgICAgICAgIE9QVElPTlMgSE9PSyAgICAgICAgICAgICAgICAgKi9cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuXG4gICAgb3B0aW9ucyhvcHRpb25zKSB7XG4gICAgICAvLyBEbyBub3QgcmVsb2FkIG1hbmlmZXN0IHdpdGhvdXQgY2hhbmdlc1xuICAgICAgaWYgKCFjYWNoZS5tYW5pZmVzdCkge1xuICAgICAgICAvKiAtLS0tLS0tLS0tLSBMT0FEIEFORCBQUk9DRVNTIE1BTklGRVNUIC0tLS0tLS0tLS0tICovXG5cbiAgICAgICAgbGV0IGlucHV0TWFuaWZlc3RQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3B0aW9ucy5pbnB1dCkpIHtcbiAgICAgICAgICBjb25zdCBtYW5pZmVzdEluZGV4ID0gb3B0aW9ucy5pbnB1dC5maW5kSW5kZXgoXG4gICAgICAgICAgICBpc0pzb25GaWxlUGF0aCxcbiAgICAgICAgICApXG4gICAgICAgICAgaW5wdXRNYW5pZmVzdFBhdGggPSBvcHRpb25zLmlucHV0W21hbmlmZXN0SW5kZXhdXG4gICAgICAgICAgY2FjaGUuaW5wdXRBcnkgPSBbXG4gICAgICAgICAgICAuLi5vcHRpb25zLmlucHV0LnNsaWNlKDAsIG1hbmlmZXN0SW5kZXgpLFxuICAgICAgICAgICAgLi4ub3B0aW9ucy5pbnB1dC5zbGljZShtYW5pZmVzdEluZGV4ICsgMSksXG4gICAgICAgICAgXVxuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zLmlucHV0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgIGlucHV0TWFuaWZlc3RQYXRoID0gb3B0aW9ucy5pbnB1dC5tYW5pZmVzdFxuICAgICAgICAgIGNhY2hlLmlucHV0T2JqID0gY2xvbmVPYmplY3Qob3B0aW9ucy5pbnB1dClcbiAgICAgICAgICBkZWxldGUgY2FjaGUuaW5wdXRPYmpbJ21hbmlmZXN0J11cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpbnB1dE1hbmlmZXN0UGF0aCA9IG9wdGlvbnMuaW5wdXRcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghaXNKc29uRmlsZVBhdGgoaW5wdXRNYW5pZmVzdFBhdGgpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcbiAgICAgICAgICAgICdSb2xsdXBPcHRpb25zLmlucHV0IG11c3QgYmUgYSBzaW5nbGUgQ2hyb21lIGV4dGVuc2lvbiBtYW5pZmVzdC4nLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNvbmZpZ1Jlc3VsdCA9IGV4cGxvcmVyLmxvYWQoXG4gICAgICAgICAgaW5wdXRNYW5pZmVzdFBhdGgsXG4gICAgICAgICkgYXMge1xuICAgICAgICAgIGZpbGVwYXRoOiBzdHJpbmdcbiAgICAgICAgICBjb25maWc6IENocm9tZUV4dGVuc2lvbk1hbmlmZXN0XG4gICAgICAgICAgaXNFbXB0eT86IHRydWVcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb25maWdSZXN1bHQuaXNFbXB0eSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtvcHRpb25zLmlucHV0fSBpcyBhbiBlbXB0eSBmaWxlLmApXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IG9wdGlvbnNfcGFnZSwgb3B0aW9uc191aSB9ID0gY29uZmlnUmVzdWx0LmNvbmZpZ1xuICAgICAgICBpZiAoXG4gICAgICAgICAgb3B0aW9uc19wYWdlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICBvcHRpb25zX3VpICE9PSB1bmRlZmluZWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJ29wdGlvbnNfdWkgYW5kIG9wdGlvbnNfcGFnZSBjYW5ub3QgYm90aCBiZSBkZWZpbmVkIGluIG1hbmlmZXN0Lmpzb24uJyxcbiAgICAgICAgICApXG4gICAgICAgIH1cblxuICAgICAgICBtYW5pZmVzdFBhdGggPSBjb25maWdSZXN1bHQuZmlsZXBhdGhcblxuICAgICAgICBpZiAodHlwZW9mIGV4dGVuZE1hbmlmZXN0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgY2FjaGUubWFuaWZlc3QgPSBleHRlbmRNYW5pZmVzdChjb25maWdSZXN1bHQuY29uZmlnKVxuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBleHRlbmRNYW5pZmVzdCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICBjYWNoZS5tYW5pZmVzdCA9IHtcbiAgICAgICAgICAgIC4uLmNvbmZpZ1Jlc3VsdC5jb25maWcsXG4gICAgICAgICAgICAuLi5leHRlbmRNYW5pZmVzdCxcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY2FjaGUubWFuaWZlc3QgPSBjb25maWdSZXN1bHQuY29uZmlnXG4gICAgICAgIH1cblxuICAgICAgICBjYWNoZS5zcmNEaXIgPSBwYXRoLmRpcm5hbWUobWFuaWZlc3RQYXRoKVxuXG4gICAgICAgIGlmIChmaXJzdENsYXNzTWFuaWZlc3QpIHtcbiAgICAgICAgICBjYWNoZS5paWZlID0gaWlmZUpzb25QYXRoc1xuICAgICAgICAgICAgLm1hcCgoanNvblBhdGgpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gSlNPTlBhdGgoe1xuICAgICAgICAgICAgICAgIHBhdGg6IGpzb25QYXRoLFxuICAgICAgICAgICAgICAgIGpzb246IGNhY2hlLm1hbmlmZXN0ISxcbiAgICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmZsYXQoSW5maW5pdHkpXG5cbiAgICAgICAgICAvLyBEZXJpdmUgZW50cnkgcGF0aHMgZnJvbSBtYW5pZmVzdFxuICAgICAgICAgIGNvbnN0IHsganMsIGh0bWwsIGNzcywgaW1nLCBvdGhlcnMgfSA9IGRlcml2ZUZpbGVzKFxuICAgICAgICAgICAgY2FjaGUubWFuaWZlc3QsXG4gICAgICAgICAgICBjYWNoZS5zcmNEaXIsXG4gICAgICAgICAgKVxuXG4gICAgICAgICAgLy8gQ2FjaGUgZGVyaXZlZCBpbnB1dHNcbiAgICAgICAgICBjYWNoZS5pbnB1dCA9IFsuLi5jYWNoZS5pbnB1dEFyeSwgLi4uanMsIC4uLmh0bWxdXG5cbiAgICAgICAgICBjYWNoZS5hc3NldHMgPSBbXG4gICAgICAgICAgICAvLyBEZWR1cGUgYXNzZXRzXG4gICAgICAgICAgICAuLi5uZXcgU2V0KFsuLi5jc3MsIC4uLmltZywgLi4ub3RoZXJzXSksXG4gICAgICAgICAgXVxuICAgICAgICB9XG5cbiAgICAgICAgLyogLS0tLS0tLS0tLS0tLS0tIEVORCBMT0FEIE1BTklGRVNUIC0tLS0tLS0tLS0tLS0tLSAqL1xuICAgICAgfVxuXG4gICAgICBjb25zdCBmaW5hbElucHV0ID0gY2FjaGUuaW5wdXQucmVkdWNlKFxuICAgICAgICByZWR1Y2VUb1JlY29yZChjYWNoZS5zcmNEaXIpLFxuICAgICAgICBjYWNoZS5pbnB1dE9iaixcbiAgICAgIClcblxuICAgICAgaWYgKE9iamVjdC5rZXlzKGZpbmFsSW5wdXQpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBmaW5hbElucHV0W3N0dWJDaHVua05hbWVdID0gc3R1YkNodW5rTmFtZVxuICAgICAgfVxuXG4gICAgICByZXR1cm4geyAuLi5vcHRpb25zLCBpbnB1dDogZmluYWxJbnB1dCB9XG4gICAgfSxcblxuICAgIC8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4gICAgLyogICAgICAgICAgICAgIEhBTkRMRSBXQVRDSCBGSUxFUyAgICAgICAgICAgICAgKi9cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuXG4gICAgYXN5bmMgYnVpbGRTdGFydCgpIHtcbiAgICAgIHRoaXMuYWRkV2F0Y2hGaWxlKG1hbmlmZXN0UGF0aClcblxuICAgICAgY2FjaGUuYXNzZXRzLmZvckVhY2goKHNyY1BhdGgpID0+IHtcbiAgICAgICAgdGhpcy5hZGRXYXRjaEZpbGUoc3JjUGF0aClcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IGFzc2V0czogRW1pdHRlZEFzc2V0W10gPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgY2FjaGUuYXNzZXRzLm1hcChhc3luYyAoc3JjUGF0aCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IGF3YWl0IHJlYWRBc3NldEFzQnVmZmVyKHNyY1BhdGgpXG5cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdHlwZTogJ2Fzc2V0JyBhcyBjb25zdCxcbiAgICAgICAgICAgIHNvdXJjZSxcbiAgICAgICAgICAgIGZpbGVOYW1lOiBwYXRoLnJlbGF0aXZlKGNhY2hlLnNyY0RpciEsIHNyY1BhdGgpLFxuICAgICAgICAgIH1cbiAgICAgICAgfSksXG4gICAgICApXG5cbiAgICAgIGFzc2V0cy5mb3JFYWNoKChhc3NldCkgPT4ge1xuICAgICAgICB0aGlzLmVtaXRGaWxlKGFzc2V0KVxuICAgICAgfSlcbiAgICB9LFxuXG4gICAgcmVzb2x2ZUlkKHNvdXJjZSkge1xuICAgICAgaWYgKHNvdXJjZSA9PT0gc3R1YkNodW5rTmFtZSkge1xuICAgICAgICByZXR1cm4gc291cmNlXG4gICAgICB9XG5cbiAgICAgIHJldHVybiBudWxsXG4gICAgfSxcblxuICAgIGxvYWQoaWQpIHtcbiAgICAgIGlmIChpZCA9PT0gc3R1YkNodW5rTmFtZSkge1xuICAgICAgICByZXR1cm4geyBjb2RlOiBgY29uc29sZS5sb2coJHtzdHViQ2h1bmtOYW1lfSlgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIG51bGxcbiAgICB9LFxuXG4gICAgd2F0Y2hDaGFuZ2UoaWQpIHtcbiAgICAgIGlmIChpZC5lbmRzV2l0aChtYW5pZmVzdE5hbWUpKSB7XG4gICAgICAgIC8vIER1bXAgY2FjaGUubWFuaWZlc3QgaWYgbWFuaWZlc3QgY2hhbmdlc1xuICAgICAgICBkZWxldGUgY2FjaGUubWFuaWZlc3RcbiAgICAgICAgY2FjaGUuYXNzZXRDaGFuZ2VkID0gZmFsc2VcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEZvcmNlIG5ldyByZWFkIG9mIGNoYW5nZWQgYXNzZXRcbiAgICAgICAgY2FjaGUuYXNzZXRDaGFuZ2VkID0gY2FjaGUucmVhZEZpbGUuZGVsZXRlKGlkKVxuICAgICAgfVxuICAgIH0sXG5cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuICAgIC8qICAgICAgICAgICAgICAgIEdFTkVSQVRFQlVORExFICAgICAgICAgICAgICAgICovXG4gICAgLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuICAgIGdlbmVyYXRlQnVuZGxlKG9wdGlvbnMsIGJ1bmRsZSkge1xuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0gQ0xFQU4gVVAgU1RVQiAtLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICBkZWxldGUgYnVuZGxlW3N0dWJDaHVua05hbWUgKyAnLmpzJ11cblxuICAgICAgLyogLS0tLS0tLS0tLSBERVJJVkUgUEVSTUlTU0lPTlMgU1RBUlQgLS0tLS0tLS0tICovXG5cbiAgICAgIC8vIEdldCBtb2R1bGUgaWRzIGZvciBhbGwgY2h1bmtzXG4gICAgICBsZXQgcGVybWlzc2lvbnM6IHN0cmluZ1tdXG4gICAgICBpZiAoY2FjaGUuYXNzZXRDaGFuZ2VkICYmIGNhY2hlLnBlcm1zSGFzaCkge1xuICAgICAgICAvLyBQZXJtaXNzaW9ucyBkaWQgbm90IGNoYW5nZVxuICAgICAgICBwZXJtaXNzaW9ucyA9IEpTT04ucGFyc2UoY2FjaGUucGVybXNIYXNoKSBhcyBzdHJpbmdbXVxuXG4gICAgICAgIGNhY2hlLmFzc2V0Q2hhbmdlZCA9IGZhbHNlXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBjaHVua3MgPSBPYmplY3QudmFsdWVzKGJ1bmRsZSkuZmlsdGVyKGlzQ2h1bmspXG5cbiAgICAgICAgLy8gUGVybWlzc2lvbnMgbWF5IGhhdmUgY2hhbmdlZFxuICAgICAgICBwZXJtaXNzaW9ucyA9IEFycmF5LmZyb20oXG4gICAgICAgICAgY2h1bmtzLnJlZHVjZShkZXJpdmVQZXJtaXNzaW9ucywgbmV3IFNldDxzdHJpbmc+KCkpLFxuICAgICAgICApXG5cbiAgICAgICAgY29uc3QgcGVybXNIYXNoID0gSlNPTi5zdHJpbmdpZnkocGVybWlzc2lvbnMpXG5cbiAgICAgICAgaWYgKHZlcmJvc2UgJiYgcGVybWlzc2lvbnMubGVuZ3RoKSB7XG4gICAgICAgICAgaWYgKCFjYWNoZS5wZXJtc0hhc2gpIHtcbiAgICAgICAgICAgIHRoaXMud2FybihcbiAgICAgICAgICAgICAgYERldGVjdGVkIHBlcm1pc3Npb25zOiAke3Blcm1pc3Npb25zLnRvU3RyaW5nKCl9YCxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9IGVsc2UgaWYgKHBlcm1zSGFzaCAhPT0gY2FjaGUucGVybXNIYXNoKSB7XG4gICAgICAgICAgICB0aGlzLndhcm4oXG4gICAgICAgICAgICAgIGBEZXRlY3RlZCBuZXcgcGVybWlzc2lvbnM6ICR7cGVybWlzc2lvbnMudG9TdHJpbmcoKX1gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNhY2hlLnBlcm1zSGFzaCA9IHBlcm1zSGFzaFxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXMoYnVuZGxlKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICdUaGUgbWFuaWZlc3QgbXVzdCBoYXZlIGF0IGxlYXN0IG9uZSBhc3NldCAoaHRtbCBvciBjc3MpIG9yIHNjcmlwdCBmaWxlLicsXG4gICAgICAgIClcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gQ2xvbmUgY2FjaGUubWFuaWZlc3RcbiAgICAgICAgaWYgKCFjYWNoZS5tYW5pZmVzdClcbiAgICAgICAgICAvLyBUaGlzIGlzIGEgcHJvZ3JhbW1pbmcgZXJyb3IsIHNvIGl0IHNob3VsZCB0aHJvd1xuICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgICBgY2FjaGUubWFuaWZlc3QgaXMgJHt0eXBlb2YgY2FjaGUubWFuaWZlc3R9YCxcbiAgICAgICAgICApXG5cbiAgICAgICAgY29uc3QgY2xvbmVkTWFuaWZlc3QgPSBjbG9uZU9iamVjdChjYWNoZS5tYW5pZmVzdClcblxuICAgICAgICBjb25zdCBtYW5pZmVzdEJvZHkgPSB2YWxpZGF0ZU1hbmlmZXN0KHtcbiAgICAgICAgICBtYW5pZmVzdF92ZXJzaW9uOiAyLFxuICAgICAgICAgIG5hbWU6IHBrZy5uYW1lLFxuICAgICAgICAgIHZlcnNpb246IHBrZy52ZXJzaW9uLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBwa2cuZGVzY3JpcHRpb24sXG4gICAgICAgICAgLi4uY2xvbmVkTWFuaWZlc3QsXG4gICAgICAgICAgcGVybWlzc2lvbnM6IGNvbWJpbmVQZXJtcyhcbiAgICAgICAgICAgIHBlcm1pc3Npb25zLFxuICAgICAgICAgICAgY2xvbmVkTWFuaWZlc3QucGVybWlzc2lvbnMgfHwgW10sXG4gICAgICAgICAgKSxcbiAgICAgICAgfSlcblxuICAgICAgICBjb25zdCB7XG4gICAgICAgICAgY29udGVudF9zY3JpcHRzOiBjdHMgPSBbXSxcbiAgICAgICAgICB3ZWJfYWNjZXNzaWJsZV9yZXNvdXJjZXM6IHdhciA9IFtdLFxuICAgICAgICAgIGJhY2tncm91bmQ6IHsgc2NyaXB0czogYmdzID0gW10gfSA9IHt9LFxuICAgICAgICB9ID0gbWFuaWZlc3RCb2R5XG5cbiAgICAgICAgLyogLS0tLS0tLS0tLS0tLSBTRVRVUCBDT05URU5UIFNDUklQVFMgLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICAgIGNvbnN0IGNvbnRlbnRTY3JpcHRzID0gY3RzLnJlZHVjZShcbiAgICAgICAgICAociwgeyBqcyA9IFtdIH0pID0+IFsuLi5yLCAuLi5qc10sXG4gICAgICAgICAgW10gYXMgc3RyaW5nW10sXG4gICAgICAgIClcblxuICAgICAgICBpZiAoY29udGVudFNjcmlwdFdyYXBwZXIgJiYgY29udGVudFNjcmlwdHMubGVuZ3RoKSB7XG4gICAgICAgICAgY29uc3QgbWVtb2l6ZWRFbWl0dGVyID0gbWVtb2l6ZShcbiAgICAgICAgICAgIChzY3JpcHRQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgICAgY29uc3Qgc291cmNlID0gY3RXcmFwcGVyU2NyaXB0LnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgJyVQQVRIJScsXG4gICAgICAgICAgICAgICAgLy8gRml4IHBhdGggc2xhc2hlcyB0byBzdXBwb3J0IFdpbmRvd3NcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgICAgICAgICAgIHNsYXNoKHJlbGF0aXZlKCdhc3NldHMnLCBzY3JpcHRQYXRoKSksXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgIGNvbnN0IGFzc2V0SWQgPSB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnYXNzZXQnLFxuICAgICAgICAgICAgICAgIHNvdXJjZSxcbiAgICAgICAgICAgICAgICBuYW1lOiBiYXNlbmFtZShzY3JpcHRQYXRoKSxcbiAgICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgICByZXR1cm4gdGhpcy5nZXRGaWxlTmFtZShhc3NldElkKVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApXG5cbiAgICAgICAgICAvLyBTZXR1cCBjb250ZW50IHNjcmlwdCBpbXBvcnQgd3JhcHBlclxuICAgICAgICAgIG1hbmlmZXN0Qm9keS5jb250ZW50X3NjcmlwdHMgPSBjdHMubWFwKFxuICAgICAgICAgICAgKHsganMsIC4uLnJlc3QgfSkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gdHlwZW9mIGpzID09PSAndW5kZWZpbmVkJ1xuICAgICAgICAgICAgICAgID8gcmVzdFxuICAgICAgICAgICAgICAgIDoge1xuICAgICAgICAgICAgICAgICAgICBqczoganNcbiAgICAgICAgICAgICAgICAgICAgICAubWFwKG5vcm1hbGl6ZUZpbGVuYW1lKVxuICAgICAgICAgICAgICAgICAgICAgIC5tYXAobWVtb2l6ZWRFbWl0dGVyKSxcbiAgICAgICAgICAgICAgICAgICAgLi4ucmVzdCxcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgKVxuXG4gICAgICAgICAgLy8gbWFrZSBhbGwgaW1wb3J0cyAmIGR5bmFtaWMgaW1wb3J0cyB3ZWJfYWNjX3Jlc1xuICAgICAgICAgIGNvbnN0IGltcG9ydHMgPSBPYmplY3QudmFsdWVzKGJ1bmRsZSlcbiAgICAgICAgICAgIC5maWx0ZXIoKHgpOiB4IGlzIE91dHB1dENodW5rID0+IHgudHlwZSA9PT0gJ2NodW5rJylcbiAgICAgICAgICAgIC5yZWR1Y2UoXG4gICAgICAgICAgICAgIChyLCB7IGlzRW50cnksIGZpbGVOYW1lIH0pID0+XG4gICAgICAgICAgICAgICAgLy8gR2V0IGltcG9ydGVkIGZpbGVuYW1lc1xuICAgICAgICAgICAgICAgICFpc0VudHJ5ID8gWy4uLnIsIGZpbGVOYW1lXSA6IHIsXG4gICAgICAgICAgICAgIFtdIGFzIHN0cmluZ1tdLFxuICAgICAgICAgICAgKVxuXG4gICAgICAgICAgLy8gU01FTEw6IHdlYiBhY2Nlc3NpYmxlIHJlc291cmNlcyBjYW4gYmUgdXNlZCBmb3IgZmluZ2VycHJpbnRpbmcgZXh0ZW5zaW9uc1xuICAgICAgICAgIG1hbmlmZXN0Qm9keS53ZWJfYWNjZXNzaWJsZV9yZXNvdXJjZXMgPSBkZWR1cGUoW1xuICAgICAgICAgICAgLi4ud2FyLFxuICAgICAgICAgICAgLy8gRkVBVFVSRTogZmlsdGVyIG91dCBpbXBvcnRzIGZvciBiYWNrZ3JvdW5kP1xuICAgICAgICAgICAgLi4uaW1wb3J0cyxcbiAgICAgICAgICAgIC8vIE5lZWQgdG8gYmUgd2ViIGFjY2Vzc2libGUgYi9jIG9mIGltcG9ydFxuICAgICAgICAgICAgLi4uY29udGVudFNjcmlwdHMsXG4gICAgICAgICAgXSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8qIC0tLS0tLS0tLS0tIEVORCBTRVRVUCBDT05URU5UIFNDUklQVFMgLS0tLS0tLS0tLS0gKi9cblxuICAgICAgICAvKiAtLS0tLS0tLS0tLS0gU0VUVVAgQkFDS0dST1VORCBTQ1JJUFRTIC0tLS0tLS0tLS0tICovXG5cbiAgICAgICAgLy8gRW1pdCBiYWNrZ3JvdW5kIHNjcmlwdCB3cmFwcGVyc1xuICAgICAgICBpZiAoYmdzLmxlbmd0aCAmJiB3cmFwcGVyU2NyaXB0Lmxlbmd0aCkge1xuICAgICAgICAgIC8vIGJhY2tncm91bmQgZXhpc3RzIGJlY2F1c2UgYmdzIGhhcyBzY3JpcHRzXG4gICAgICAgICAgbWFuaWZlc3RCb2R5LmJhY2tncm91bmQhLnNjcmlwdHMgPSBiZ3NcbiAgICAgICAgICAgIC5tYXAobm9ybWFsaXplRmlsZW5hbWUpXG4gICAgICAgICAgICAubWFwKChzY3JpcHRQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgICAgLy8gTG9hZGVyIHNjcmlwdCBleGlzdHMgYmVjYXVzZSBvZiB0eXBlIGd1YXJkIGFib3ZlXG4gICAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9XG4gICAgICAgICAgICAgICAgLy8gUGF0aCB0byBtb2R1bGUgYmVpbmcgbG9hZGVkXG4gICAgICAgICAgICAgICAgd3JhcHBlclNjcmlwdC5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgJyVQQVRIJScsXG4gICAgICAgICAgICAgICAgICAvLyBGaXggcGF0aCBzbGFzaGVzIHRvIHN1cHBvcnQgV2luZG93c1xuICAgICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgICAgICAgICAgICAgIHNsYXNoKHJlbGF0aXZlKCdhc3NldHMnLCBzY3JpcHRQYXRoKSksXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIClcblxuICAgICAgICAgICAgICBjb25zdCBhc3NldElkID0gdGhpcy5lbWl0RmlsZSh7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2Fzc2V0JyxcbiAgICAgICAgICAgICAgICBzb3VyY2UsXG4gICAgICAgICAgICAgICAgbmFtZTogYmFzZW5hbWUoc2NyaXB0UGF0aCksXG4gICAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuZ2V0RmlsZU5hbWUoYXNzZXRJZClcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH1cblxuICAgICAgICAvKiAtLS0tLS0tLS0tIEVORCBTRVRVUCBCQUNLR1JPVU5EIFNDUklQVFMgLS0tLS0tLS0tICovXG5cbiAgICAgICAgLyogLS0tLS0tLS0tIFNUQUJMRSBFWFRFTlNJT04gSUQgQkVHSU4gLS0tLS0tLS0gKi9cblxuICAgICAgICBpZiAocHVibGljS2V5KSB7XG4gICAgICAgICAgbWFuaWZlc3RCb2R5LmtleSA9IHB1YmxpY0tleVxuICAgICAgICB9XG5cbiAgICAgICAgLyogLS0tLS0tLS0tLSBTVEFCTEUgRVhURU5TSU9OIElEIEVORCAtLS0tLS0tLS0gKi9cblxuICAgICAgICAvKiAtLS0tLS0tLS0tLSBPVVRQVVQgTUFOSUZFU1QuSlNPTiBCRUdJTiAtLS0tLS0tLS0tICovXG5cbiAgICAgICAgY29uc3QgbWFuaWZlc3RKc29uID0gSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgICAgbWFuaWZlc3RCb2R5LFxuICAgICAgICAgIG51bGwsXG4gICAgICAgICAgMixcbiAgICAgICAgKVxuICAgICAgICAgIC8vIFNNRUxMOiBpcyB0aGlzIG5lY2Vzc2FyeT9cbiAgICAgICAgICAucmVwbGFjZSgvXFwuW2p0XXN4P1wiL2csICcuanNcIicpXG5cbiAgICAgICAgLy8gRW1pdCBtYW5pZmVzdC5qc29uXG4gICAgICAgIHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgICAgZmlsZU5hbWU6IG1hbmlmZXN0TmFtZSxcbiAgICAgICAgICBzb3VyY2U6IG1hbmlmZXN0SnNvbixcbiAgICAgICAgfSlcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIC8vIENhdGNoIGhlcmUgYmVjYXVzZSB3ZSBuZWVkIHRoZSB2YWxpZGF0ZWQgcmVzdWx0IGluIHNjb3BlXG5cbiAgICAgICAgaWYgKGVycm9yLm5hbWUgIT09ICdWYWxpZGF0aW9uRXJyb3InKSB0aHJvdyBlcnJvclxuICAgICAgICBjb25zdCBlcnJvcnMgPSBlcnJvci5lcnJvcnMgYXMgVmFsaWRhdGlvbkVycm9yc0FycmF5XG4gICAgICAgIGlmIChlcnJvcnMpIHtcbiAgICAgICAgICBlcnJvcnMuZm9yRWFjaCgoZXJyKSA9PiB7XG4gICAgICAgICAgICAvLyBGSVhNRTogbWFrZSBhIGJldHRlciB2YWxpZGF0aW9uIGVycm9yIG1lc3NhZ2VcbiAgICAgICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9hdGxhc3NpYW4vYmV0dGVyLWFqdi1lcnJvcnNcbiAgICAgICAgICAgIHRoaXMud2FybihKU09OLnN0cmluZ2lmeShlcnIsIHVuZGVmaW5lZCwgMikpXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmVycm9yKGVycm9yLm1lc3NhZ2UpXG4gICAgICB9XG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLSBPVVRQVVQgTUFOSUZFU1QuSlNPTiBFTkQgLS0tLS0tLS0tLS0gKi9cbiAgICB9LFxuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IG1hbmlmZXN0SW5wdXRcbiIsImltcG9ydCBmcyBmcm9tICdmcy1leHRyYSdcbmltcG9ydCB7IFBsdWdpbiB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IGlzQXNzZXQgfSBmcm9tICcuLi9oZWxwZXJzJ1xuaW1wb3J0IHsgY29kZSBhcyBleGVjdXRlU2NyaXB0UG9seWZpbGwgfSBmcm9tICdjb2RlIC4vYnJvd3Nlci9leGVjdXRlU2NyaXB0UG9seWZpbGwudHMnXG5pbXBvcnQgeyBDaHJvbWVFeHRlbnNpb25NYW5pZmVzdCB9IGZyb20gJy4uL21hbmlmZXN0J1xuaW1wb3J0IHtcbiAgQ2hyb21lRXh0ZW5zaW9uUGx1Z2luLFxuICBNYW5pZmVzdElucHV0UGx1Z2luLFxufSBmcm9tICcuLi9wbHVnaW4tb3B0aW9ucydcblxuY29uc3QgZGVmYXVsdE9wdGlvbnMgPSB7IGV4ZWN1dGVTY3JpcHQ6IHRydWUgfVxuZXhwb3J0IGZ1bmN0aW9uIGJyb3dzZXJQb2x5ZmlsbCh7XG4gIGJyb3dzZXJQb2x5ZmlsbDogb3B0aW9ucyA9IGRlZmF1bHRPcHRpb25zLFxufTogUGljazxNYW5pZmVzdElucHV0UGx1Z2luLCAnYnJvd3NlclBvbHlmaWxsJz4pOiBQaWNrPFxuICBSZXF1aXJlZDxQbHVnaW4+LFxuICAnbmFtZScgfCAnZ2VuZXJhdGVCdW5kbGUnXG4+IHtcbiAgaWYgKG9wdGlvbnMgPT09IGZhbHNlKVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnbm8tb3AnLFxuICAgICAgZ2VuZXJhdGVCdW5kbGUoKSB7fSxcbiAgICB9XG4gIGVsc2UgaWYgKG9wdGlvbnMgPT09IHRydWUpIG9wdGlvbnMgPSBkZWZhdWx0T3B0aW9uc1xuICBjb25zdCB7IGV4ZWN1dGVTY3JpcHQgPSB0cnVlIH0gPSBvcHRpb25zXG5cbiAgY29uc3QgY29udmVydCA9IHJlcXVpcmUoJ2NvbnZlcnQtc291cmNlLW1hcCcpXG4gIGNvbnN0IHBvbHlmaWxsUGF0aCA9IHJlcXVpcmUucmVzb2x2ZSgnd2ViZXh0ZW5zaW9uLXBvbHlmaWxsJylcbiAgY29uc3Qgc3JjID0gZnMucmVhZEZpbGVTeW5jKHBvbHlmaWxsUGF0aCwgJ3V0Zi04JylcbiAgY29uc3QgbWFwID0gZnMucmVhZEpzb25TeW5jKHBvbHlmaWxsUGF0aCArICcubWFwJylcblxuICBjb25zdCBicm93c2VyUG9seWZpbGxTcmMgPSBbXG4gICAgY29udmVydC5yZW1vdmVNYXBGaWxlQ29tbWVudHMoc3JjKSxcbiAgICBjb252ZXJ0LmZyb21PYmplY3QobWFwKS50b0NvbW1lbnQoKSxcbiAgXS5qb2luKCdcXG4nKVxuXG4gIHJldHVybiB7XG4gICAgbmFtZTogJ2Jyb3dzZXItcG9seWZpbGwnLFxuICAgIGdlbmVyYXRlQnVuZGxlKHsgcGx1Z2lucyA9IFtdIH0sIGJ1bmRsZSkge1xuICAgICAgY29uc3QgZmlyZWZveFBsdWdpbiA9IHBsdWdpbnMuZmluZChcbiAgICAgICAgKHsgbmFtZSB9KSA9PiBuYW1lID09PSAnZmlyZWZveC1hZGRvbicsXG4gICAgICApXG4gICAgICBjb25zdCBjaHJvbWVFeHRlbnNpb25QbHVnaW4gPSBwbHVnaW5zLmZpbmQoXG4gICAgICAgICh7IG5hbWUgfSkgPT4gbmFtZSA9PT0gJ2Nocm9tZS1leHRlbnNpb24nLFxuICAgICAgKSBhcyBDaHJvbWVFeHRlbnNpb25QbHVnaW5cblxuICAgICAgaWYgKFxuICAgICAgICBmaXJlZm94UGx1Z2luICYmXG4gICAgICAgICFjaHJvbWVFeHRlbnNpb25QbHVnaW4uX3BsdWdpbnMubWFuaWZlc3QuY3Jvc3NCcm93c2VyXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIC8vIERvbid0IG5lZWQgdG8gYWRkIGl0XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1hbmlmZXN0QXNzZXQgPSBidW5kbGVbJ21hbmlmZXN0Lmpzb24nXVxuICAgICAgaWYgKCFpc0Fzc2V0KG1hbmlmZXN0QXNzZXQpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgYG1hbmlmZXN0Lmpzb24gbXVzdCBiZSBhbiBPdXRwdXRBc3NldCwgcmVjZWl2ZWQgXCIke3R5cGVvZiBtYW5pZmVzdEFzc2V0fVwiYCxcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgY29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKFxuICAgICAgICBtYW5pZmVzdEFzc2V0LnNvdXJjZSBhcyBzdHJpbmcsXG4gICAgICApIGFzIENocm9tZUV4dGVuc2lvbk1hbmlmZXN0XG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLS0gRU1JVCBCUk9XU0VSIFBPTFlGSUxMIC0tLS0tLS0tLS0tLS0gKi9cblxuICAgICAgY29uc3QgYnBJZCA9IHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICB0eXBlOiAnYXNzZXQnLFxuICAgICAgICBzb3VyY2U6IGJyb3dzZXJQb2x5ZmlsbFNyYyxcbiAgICAgICAgZmlsZU5hbWU6ICdhc3NldHMvYnJvd3Nlci1wb2x5ZmlsbC5qcycsXG4gICAgICB9KVxuXG4gICAgICBjb25zdCBicm93c2VyUG9seWZpbGxQYXRoID0gdGhpcy5nZXRGaWxlTmFtZShicElkKVxuXG4gICAgICBpZiAoZXhlY3V0ZVNjcmlwdCkge1xuICAgICAgICBjb25zdCBleElkID0gdGhpcy5lbWl0RmlsZSh7XG4gICAgICAgICAgdHlwZTogJ2Fzc2V0JyxcbiAgICAgICAgICBzb3VyY2U6IGV4ZWN1dGVTY3JpcHRQb2x5ZmlsbC5yZXBsYWNlKFxuICAgICAgICAgICAgJyVCUk9XU0VSX1BPTFlGSUxMX1BBVEglJyxcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGJyb3dzZXJQb2x5ZmlsbFBhdGgpLFxuICAgICAgICAgICksXG4gICAgICAgICAgZmlsZU5hbWU6ICdhc3NldHMvYnJvd3Nlci1wb2x5ZmlsbC1leGVjdXRlU2NyaXB0LmpzJyxcbiAgICAgICAgfSlcblxuICAgICAgICBjb25zdCBleGVjdXRlU2NyaXB0UG9seWZpbGxQYXRoID0gdGhpcy5nZXRGaWxlTmFtZShleElkKVxuXG4gICAgICAgIG1hbmlmZXN0LmJhY2tncm91bmQ/LnNjcmlwdHM/LnVuc2hpZnQoXG4gICAgICAgICAgZXhlY3V0ZVNjcmlwdFBvbHlmaWxsUGF0aCxcbiAgICAgICAgKVxuICAgICAgfVxuXG4gICAgICBtYW5pZmVzdC5iYWNrZ3JvdW5kPy5zY3JpcHRzPy51bnNoaWZ0KGJyb3dzZXJQb2x5ZmlsbFBhdGgpXG4gICAgICBtYW5pZmVzdC5jb250ZW50X3NjcmlwdHM/LmZvckVhY2goKHNjcmlwdCkgPT4ge1xuICAgICAgICBzY3JpcHQuanM/LnVuc2hpZnQoYnJvd3NlclBvbHlmaWxsUGF0aClcbiAgICAgIH0pXG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLS0tLS0gVVBEQVRFIE1BTklGRVNUIC0tLS0tLS0tLS0tLS0tLS0gKi9cbiAgICAgIG1hbmlmZXN0QXNzZXQuc291cmNlID0gSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QpXG4gICAgfSxcbiAgfVxufVxuIiwiaW1wb3J0IHsgT3V0cHV0QXNzZXQsIE91dHB1dENodW5rLCBQbHVnaW4gfSBmcm9tICdyb2xsdXAnXG5cbmludGVyZmFjZSBNYW5pZmVzdEFzc2V0IGV4dGVuZHMgT3V0cHV0QXNzZXQge1xuICBzb3VyY2U6IHN0cmluZ1xufVxuXG5leHBvcnQgdHlwZSBWYWxpZGF0ZU5hbWVzUGx1Z2luID0gUGljazxcbiAgUmVxdWlyZWQ8UGx1Z2luPixcbiAgJ25hbWUnIHwgJ2dlbmVyYXRlQnVuZGxlJ1xuPlxuXG5leHBvcnQgY29uc3QgdmFsaWRhdGVOYW1lcyA9ICgpOiBWYWxpZGF0ZU5hbWVzUGx1Z2luID0+ICh7XG4gIG5hbWU6ICd2YWxpZGF0ZS1uYW1lcycsXG5cbiAgZ2VuZXJhdGVCdW5kbGUob3B0aW9ucywgYnVuZGxlKSB7XG4gICAgY29uc3QgY2h1bmtzID0gT2JqZWN0LnZhbHVlcyhidW5kbGUpLmZpbHRlcihcbiAgICAgICh4KTogeCBpcyBPdXRwdXRDaHVuayA9PiB4LnR5cGUgPT09ICdjaHVuaycsXG4gICAgKVxuXG4gICAgLy8gRmlsZXMgY2Fubm90IHN0YXJ0IHdpdGggXCJfXCIgaW4gQ2hyb21lIEV4dGVuc2lvbnNcbiAgICAvLyBMb29wIHRocm91Z2ggZWFjaCBmaWxlIGFuZCBjaGVjayBmb3IgXCJfXCIgaW4gZmlsZW5hbWVcbiAgICBPYmplY3Qua2V5cyhidW5kbGUpXG4gICAgICAuZmlsdGVyKChmaWxlTmFtZSkgPT4gZmlsZU5hbWUuc3RhcnRzV2l0aCgnXycpKVxuICAgICAgLmZvckVhY2goKGZpbGVOYW1lKSA9PiB7XG4gICAgICAgIC8vIE9ubHkgcmVwbGFjZSBmaXJzdCBpbnN0YW5jZVxuICAgICAgICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAoZmlsZU5hbWUpXG4gICAgICAgIGNvbnN0IGZpeGVkID0gZmlsZU5hbWUuc2xpY2UoMSlcblxuICAgICAgICAvLyBGaXggbWFuaWZlc3RcbiAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBidW5kbGVbJ21hbmlmZXN0Lmpzb24nXSBhcyBNYW5pZmVzdEFzc2V0XG4gICAgICAgIG1hbmlmZXN0LnNvdXJjZSA9IG1hbmlmZXN0LnNvdXJjZS5yZXBsYWNlKHJlZ2V4LCBmaXhlZClcblxuICAgICAgICAvLyBDaGFuZ2UgYnVuZGxlIGtleVxuICAgICAgICBjb25zdCBjaHVuayA9IGJ1bmRsZVtmaWxlTmFtZV1cbiAgICAgICAgZGVsZXRlIGJ1bmRsZVtmaWxlTmFtZV1cbiAgICAgICAgYnVuZGxlW2ZpeGVkXSA9IGNodW5rXG5cbiAgICAgICAgLy8gRml4IGNodW5rXG4gICAgICAgIGNodW5rLmZpbGVOYW1lID0gZml4ZWRcblxuICAgICAgICAvLyBGaW5kIGltcG9ydHMgYW5kIGZpeFxuICAgICAgICBjaHVua3NcbiAgICAgICAgICAuZmlsdGVyKCh7IGltcG9ydHMgfSkgPT4gaW1wb3J0cy5pbmNsdWRlcyhmaWxlTmFtZSkpXG4gICAgICAgICAgLmZvckVhY2goKGNodW5rKSA9PiB7XG4gICAgICAgICAgICAvLyBGaXggaW1wb3J0cyBsaXN0XG4gICAgICAgICAgICBjaHVuay5pbXBvcnRzID0gY2h1bmsuaW1wb3J0cy5tYXAoKGkpID0+XG4gICAgICAgICAgICAgIGkgPT09IGZpbGVOYW1lID8gZml4ZWQgOiBpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLy8gRml4IGltcG9ydHMgaW4gY29kZVxuICAgICAgICAgICAgY2h1bmsuY29kZSA9IGNodW5rLmNvZGUucmVwbGFjZShyZWdleCwgZml4ZWQpXG4gICAgICAgICAgfSlcbiAgICAgIH0pXG4gIH0sXG59KVxuIiwiaW1wb3J0IHBhdGggZnJvbSAncGF0aCdcbmltcG9ydCB7IE91dHB1dEJ1bmRsZSB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IFBsdWdpbiB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IGlzQ2h1bmsgfSBmcm9tICcuLi9oZWxwZXJzJ1xuXG5leHBvcnQgY29uc3QgcmVzb2x2ZUZyb21CdW5kbGUgPSAoXG4gIGJ1bmRsZTogT3V0cHV0QnVuZGxlLFxuKTogUGx1Z2luID0+ICh7XG4gIG5hbWU6ICdyZXNvbHZlLWZyb20tYnVuZGxlJyxcbiAgcmVzb2x2ZUlkKHNvdXJjZSwgaW1wb3J0ZXIpIHtcbiAgICBpZiAodHlwZW9mIGltcG9ydGVyID09PSAndW5kZWZpbmVkJykge1xuICAgICAgcmV0dXJuIHNvdXJjZVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBkaXJuYW1lID0gcGF0aC5kaXJuYW1lKGltcG9ydGVyKVxuICAgICAgY29uc3QgcmVzb2x2ZWQgPSBwYXRoLmpvaW4oZGlybmFtZSwgc291cmNlKVxuXG4gICAgICAvLyBpZiBpdCdzIG5vdCBpbiB0aGUgYnVuZGxlLFxuICAgICAgLy8gICB0ZWxsIFJvbGx1cCBub3QgdG8gdHJ5IHRvIHJlc29sdmUgaXRcbiAgICAgIHJldHVybiByZXNvbHZlZCBpbiBidW5kbGUgPyByZXNvbHZlZCA6IGZhbHNlXG4gICAgfVxuICB9LFxuICBsb2FkKGlkKSB7XG4gICAgY29uc3QgY2h1bmsgPSBidW5kbGVbaWRdXG5cbiAgICBpZiAoaXNDaHVuayhjaHVuaykpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvZGU6IGNodW5rLmNvZGUsXG4gICAgICAgIG1hcDogY2h1bmsubWFwLFxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBhbnl0aGluZyBub3QgaW4gdGhlIGJ1bmRsZSBpcyBleHRlcm5hbFxuICAgICAgLy8gIHRoaXMgZG9lc24ndCBtYWtlIHNlbnNlIGZvciBhIGNocm9tZSBleHRlbnNpb24sXG4gICAgICAvLyAgICBidXQgd2Ugc2hvdWxkIGxldCBSb2xsdXAgaGFuZGxlIGl0XG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cbiAgfSxcbn0pXG4iLCJpbXBvcnQgcGF0aCBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgT3V0cHV0Q2h1bmsgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyBSb2xsdXBPcHRpb25zIH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHtcbiAgUGx1Z2luLFxuICBPdXRwdXRCdW5kbGUsXG4gIFBsdWdpbkNvbnRleHQsXG4gIHJvbGx1cCxcbn0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHsgcmVzb2x2ZUZyb21CdW5kbGUgfSBmcm9tICcuL3Jlc29sdmVGcm9tQnVuZGxlJ1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVnZW5lcmF0ZUJ1bmRsZShcbiAgdGhpczogUGx1Z2luQ29udGV4dCxcbiAgeyBpbnB1dCwgb3V0cHV0IH06IFJvbGx1cE9wdGlvbnMsXG4gIGJ1bmRsZTogT3V0cHV0QnVuZGxlLFxuKTogUHJvbWlzZTxPdXRwdXRCdW5kbGU+IHtcbiAgaWYgKCFvdXRwdXQgfHwgQXJyYXkuaXNBcnJheShvdXRwdXQpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcbiAgICAgICdvcHRpb25zLm91dHB1dCBtdXN0IGJlIGFuIE91dHB1dE9wdGlvbnMgb2JqZWN0JyxcbiAgICApXG4gIH1cblxuICBpZiAodHlwZW9mIGlucHV0ID09PSAndW5kZWZpbmVkJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAnb3B0aW9ucy5pbnB1dCBzaG91bGQgYmUgYW4gb2JqZWN0LCBzdHJpbmcgYXJyYXkgb3Igc3RyaW5nJyxcbiAgICApXG4gIH1cblxuICAvLyBEb24ndCBkbyBhbnl0aGluZyBpZiBpbnB1dCBpcyBhbiBlbXB0eSBhcnJheVxuICBpZiAoQXJyYXkuaXNBcnJheShpbnB1dCkgJiYgaW5wdXQubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHt9XG4gIH1cblxuICBjb25zdCB7IGZvcm1hdCwgY2h1bmtGaWxlTmFtZXM6IGNmbiA9ICcnIH0gPSBvdXRwdXRcbiAgXG4gIGNvbnN0IGNodW5rRmlsZU5hbWVzID0gcGF0aC5qb2luKHBhdGguZGlybmFtZShjZm4pLCAnW25hbWVdLmpzJylcblxuICAvLyBUcmFuc2Zvcm0gaW5wdXQgYXJyYXkgdG8gaW5wdXQgb2JqZWN0XG4gIGNvbnN0IGlucHV0VmFsdWUgPSBBcnJheS5pc0FycmF5KGlucHV0KVxuICAgID8gaW5wdXQucmVkdWNlKChyLCB4KSA9PiB7XG4gICAgICAgIGNvbnN0IHsgZGlyLCBuYW1lIH0gPSBwYXRoLnBhcnNlKHgpXG4gICAgICAgIHJldHVybiB7IC4uLnIsIFtwYXRoLmpvaW4oZGlyLCBuYW1lKV06IHggfVxuICAgICAgfSwge30gYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPilcbiAgICA6IGlucHV0XG5cbiAgY29uc3QgYnVpbGQgPSBhd2FpdCByb2xsdXAoe1xuICAgIGlucHV0OiBpbnB1dFZhbHVlLFxuICAgIHBsdWdpbnM6IFtyZXNvbHZlRnJvbUJ1bmRsZShidW5kbGUpXSxcbiAgfSlcblxuICBsZXQgX2I6IE91dHB1dEJ1bmRsZVxuICBhd2FpdCBidWlsZC5nZW5lcmF0ZSh7XG4gICAgZm9ybWF0LFxuICAgIGNodW5rRmlsZU5hbWVzLFxuICAgIHBsdWdpbnM6IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ2dldC1idW5kbGUnLFxuICAgICAgICBnZW5lcmF0ZUJ1bmRsZShvLCBiKSB7XG4gICAgICAgICAgX2IgPSBiXG4gICAgICAgIH0sXG4gICAgICB9IGFzIFBsdWdpbixcbiAgICBdLFxuICB9KVxuICBjb25zdCBuZXdCdW5kbGUgPSBfYiFcblxuICBpZiAodHlwZW9mIGlucHV0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgZGVsZXRlIGJ1bmRsZVtpbnB1dFZhbHVlXVxuXG4gICAgY29uc3QgYnVuZGxlS2V5ID0gcGF0aC5iYXNlbmFtZShpbnB1dFZhbHVlKVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIFtpbnB1dFZhbHVlXToge1xuICAgICAgICAuLi4obmV3QnVuZGxlW2J1bmRsZUtleV0gYXMgT3V0cHV0Q2h1bmspLFxuICAgICAgICBmaWxlTmFtZTogaW5wdXRWYWx1ZSxcbiAgICAgIH0sXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFJlbW92ZSByZWdlbmVyYXRlZCBlbnRyaWVzIGZyb20gYnVuZGxlXG4gICAgT2JqZWN0LnZhbHVlcyhpbnB1dFZhbHVlKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIGRlbGV0ZSBidW5kbGVba2V5XVxuICAgIH0pXG5cbiAgICByZXR1cm4gbmV3QnVuZGxlXG4gIH1cbn1cbiIsImltcG9ydCB7XG4gIFBsdWdpbixcbiAgT3V0cHV0QnVuZGxlLFxuICBPdXRwdXRPcHRpb25zLFxuICBQbHVnaW5Db250ZXh0LFxuICBNb2R1bGVGb3JtYXQsXG59IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IGlzQ2h1bmsgfSBmcm9tICcuLi9oZWxwZXJzJ1xuaW1wb3J0IHsgTWFuaWZlc3RJbnB1dFBsdWdpbiB9IGZyb20gJy4uL3BsdWdpbi1vcHRpb25zJ1xuaW1wb3J0IHsgcmVnZW5lcmF0ZUJ1bmRsZSB9IGZyb20gJy4vcmVnZW5lcmF0ZUJ1bmRsZSdcblxuZXhwb3J0IGZ1bmN0aW9uIG1peGVkRm9ybWF0KFxuICBvcHRpb25zOiBQaWNrPE1hbmlmZXN0SW5wdXRQbHVnaW4sICdmb3JtYXRNYXAnPixcbik6IFBpY2s8UmVxdWlyZWQ8UGx1Z2luPiwgJ25hbWUnIHwgJ2dlbmVyYXRlQnVuZGxlJz4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICdtaXhlZC1mb3JtYXQnLFxuICAgIGFzeW5jIGdlbmVyYXRlQnVuZGxlKFxuICAgICAgdGhpczogUGx1Z2luQ29udGV4dCxcbiAgICAgIHsgZm9ybWF0LCBjaHVua0ZpbGVOYW1lcyB9OiBPdXRwdXRPcHRpb25zLFxuICAgICAgYnVuZGxlOiBPdXRwdXRCdW5kbGUsXG4gICAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICBjb25zdCB7IGZvcm1hdE1hcCB9ID0gb3B0aW9ucyAvLyB0aGlzIG1pZ2h0IG5vdCBiZSBkZWZpbmVkIHVwb24gaW5pdFxuXG4gICAgICBpZiAodHlwZW9mIGZvcm1hdE1hcCA9PT0gJ3VuZGVmaW5lZCcpIHJldHVyblxuXG4gICAgICBjb25zdCBmb3JtYXRzID0gT2JqZWN0LmVudHJpZXMoZm9ybWF0TWFwKS5maWx0ZXIoXG4gICAgICAgIChcbiAgICAgICAgICB4LFxuICAgICAgICApOiB4IGlzIFtcbiAgICAgICAgICBNb2R1bGVGb3JtYXQsXG4gICAgICAgICAgc3RyaW5nW10gfCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuICAgICAgICBdID0+IHR5cGVvZiB4WzFdICE9PSAndW5kZWZpbmVkJyxcbiAgICAgIClcblxuICAgICAge1xuICAgICAgICBjb25zdCBhbGxJbnB1dCA9IGZvcm1hdHMuZmxhdE1hcCgoWywgaW5wdXRzXSkgPT5cbiAgICAgICAgICBBcnJheS5pc0FycmF5KGlucHV0cylcbiAgICAgICAgICAgID8gaW5wdXRzXG4gICAgICAgICAgICA6IE9iamVjdC52YWx1ZXMoaW5wdXRzIHx8IHt9KSxcbiAgICAgICAgKVxuICAgICAgICBjb25zdCBhbGxJbnB1dFNldCA9IG5ldyBTZXQoYWxsSW5wdXQpXG4gICAgICAgIGlmIChhbGxJbnB1dC5sZW5ndGggIT09IGFsbElucHV0U2V0LnNpemUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnZm9ybWF0cyBzaG91bGQgbm90IGhhdmUgZHVwbGljYXRlIGlucHV0cycsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRPRE86IGhhbmRsZSBkaWZmZXJlbnQga2luZHMgb2YgZm9ybWF0cyBkaWZmZXJlbnRseT9cbiAgICAgIGNvbnN0IGJ1bmRsZXMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgLy8gQ29uZmlndXJlZCBmb3JtYXRzXG4gICAgICAgIGZvcm1hdHMuZmxhdE1hcCgoW2YsIGlucHV0c10pID0+XG4gICAgICAgICAgKEFycmF5LmlzQXJyYXkoaW5wdXRzKVxuICAgICAgICAgICAgPyBpbnB1dHNcbiAgICAgICAgICAgIDogT2JqZWN0LnZhbHVlcyhpbnB1dHMpXG4gICAgICAgICAgKS5tYXAoKGlucHV0KSA9PlxuICAgICAgICAgICAgcmVnZW5lcmF0ZUJ1bmRsZS5jYWxsKFxuICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgaW5wdXQsXG4gICAgICAgICAgICAgICAgb3V0cHV0OiB7XG4gICAgICAgICAgICAgICAgICBmb3JtYXQ6IGYsXG4gICAgICAgICAgICAgICAgICBjaHVua0ZpbGVOYW1lcyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBidW5kbGUsXG4gICAgICAgICAgICApLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICApXG5cbiAgICAgIC8vIEJhc2UgZm9ybWF0IChFU00pXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgcmVnZW5lcmF0ZUJ1bmRsZS5jYWxsKFxuICAgICAgICB0aGlzLFxuICAgICAgICB7XG4gICAgICAgICAgaW5wdXQ6IE9iamVjdC5lbnRyaWVzKGJ1bmRsZSlcbiAgICAgICAgICAgIC5maWx0ZXIoKFssIGZpbGVdKSA9PiBpc0NodW5rKGZpbGUpICYmIGZpbGUuaXNFbnRyeSlcbiAgICAgICAgICAgIC5tYXAoKFtrZXldKSA9PiBrZXkpLFxuICAgICAgICAgIG91dHB1dDogeyBmb3JtYXQsIGNodW5rRmlsZU5hbWVzIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGJ1bmRsZSxcbiAgICAgIClcblxuICAgICAgLy8gRW1wdHkgYnVuZGxlXG4gICAgICBPYmplY3QuZW50cmllcyhidW5kbGUpXG4gICAgICAgIC5maWx0ZXIoKFssIHZdKSA9PiBpc0NodW5rKHYpKVxuICAgICAgICAuZm9yRWFjaCgoW2tleV0pID0+IHtcbiAgICAgICAgICBkZWxldGUgYnVuZGxlW2tleV1cbiAgICAgICAgfSlcblxuICAgICAgLy8gUmVmaWxsIGJ1bmRsZVxuICAgICAgT2JqZWN0LmFzc2lnbihidW5kbGUsIGJhc2UsIC4uLmJ1bmRsZXMpXG4gICAgfSxcbiAgfVxufVxuIiwiLyogLS0tLS0tLS0tLS0tLS0tLS0tLSBGSUxFTkFNRVMgLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5leHBvcnQgY29uc3QgYmFja2dyb3VuZFBhZ2VSZWxvYWRlciA9XG4gICdiYWNrZ3JvdW5kLXBhZ2UtcmVsb2FkZXIuanMnXG5leHBvcnQgY29uc3QgY29udGVudFNjcmlwdFJlbG9hZGVyID0gJ2NvbnRlbnQtc2NyaXB0LXJlbG9hZGVyLmpzJ1xuZXhwb3J0IGNvbnN0IHRpbWVzdGFtcEZpbGVuYW1lID0gJ3RpbWVzdGFtcC5qc29uJ1xuXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0gUExBQ0VIT0xERVJTIC0tLS0tLS0tLS0tLS0tLS0tICovXG5cbmV4cG9ydCBjb25zdCB0aW1lc3RhbXBQYXRoUGxhY2Vob2xkZXIgPSAnJVRJTUVTVEFNUF9QQVRIJSdcbmV4cG9ydCBjb25zdCBsb2FkTWVzc2FnZVBsYWNlaG9sZGVyID0gJyVMT0FEX01FU1NBR0UlJ1xuZXhwb3J0IGNvbnN0IGN0U2NyaXB0UGF0aFBsYWNlaG9sZGVyID0gJyVDT05URU5UX1NDUklQVF9QQVRIJSdcbmV4cG9ydCBjb25zdCB1bnJlZ2lzdGVyU2VydmljZVdvcmtlcnNQbGFjZWhvbGRlciA9ICclVU5SRUdJU1RFUl9TRVJWSUNFX1dPUktFUlMlJ1xuZXhwb3J0IGNvbnN0IGV4ZWN1dGVTY3JpcHRQbGFjZWhvbGRlciA9ICclRVhFQ1VURV9TQ1JJUFQlJyIsImltcG9ydCB7IGNvZGUgYXMgYmdDbGllbnRDb2RlIH0gZnJvbSAnY29kZSAuL2NsaWVudC9iYWNrZ3JvdW5kLnRzJ1xuaW1wb3J0IHsgY29kZSBhcyBjdENsaWVudENvZGUgfSBmcm9tICdjb2RlIC4vY2xpZW50L2NvbnRlbnQudHMnXG5pbXBvcnQgeyBvdXRwdXRKc29uIH0gZnJvbSAnZnMtZXh0cmEnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCdcbmltcG9ydCB7IFBsdWdpbiB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IHVwZGF0ZU1hbmlmZXN0IH0gZnJvbSAnLi4vaGVscGVycydcbmltcG9ydCB7XG4gIGJhY2tncm91bmRQYWdlUmVsb2FkZXIsXG4gIGNvbnRlbnRTY3JpcHRSZWxvYWRlcixcbiAgdGltZXN0YW1wUGF0aFBsYWNlaG9sZGVyLFxuICBsb2FkTWVzc2FnZVBsYWNlaG9sZGVyLFxuICB0aW1lc3RhbXBGaWxlbmFtZSxcbiAgY3RTY3JpcHRQYXRoUGxhY2Vob2xkZXIsXG4gIGV4ZWN1dGVTY3JpcHRQbGFjZWhvbGRlcixcbiAgdW5yZWdpc3RlclNlcnZpY2VXb3JrZXJzUGxhY2Vob2xkZXIsXG59IGZyb20gJy4vQ09OU1RBTlRTJ1xuXG5leHBvcnQgdHlwZSBTaW1wbGVSZWxvYWRlclBsdWdpbiA9IFBpY2s8XG4gIFJlcXVpcmVkPFBsdWdpbj4sXG4gICduYW1lJyB8ICdnZW5lcmF0ZUJ1bmRsZScgfCAnd3JpdGVCdW5kbGUnXG4+XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2ltcGxlUmVsb2FkZXJPcHRpb25zIHtcbiAgZXhlY3V0ZVNjcmlwdD86IGJvb2xlYW5cbiAgdW5yZWdpc3RlclNlcnZpY2VXb3JrZXJzPzogYm9vbGVhblxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNpbXBsZVJlbG9hZGVyQ2FjaGUge1xuICBiZ1NjcmlwdFBhdGg/OiBzdHJpbmdcbiAgY3RTY3JpcHRQYXRoPzogc3RyaW5nXG4gIHRpbWVzdGFtcFBhdGg/OiBzdHJpbmdcbiAgb3V0cHV0RGlyPzogc3RyaW5nXG4gIGxvYWRNZXNzYWdlPzogc3RyaW5nXG59XG5cbi8vIFVzZWQgZm9yIHRlc3RpbmdcbmV4cG9ydCBjb25zdCBfaW50ZXJuYWxDYWNoZTogU2ltcGxlUmVsb2FkZXJDYWNoZSA9IHt9XG5cbmV4cG9ydCBjb25zdCBzaW1wbGVSZWxvYWRlciA9IChcbiAge1xuICAgIGV4ZWN1dGVTY3JpcHQgPSB0cnVlLFxuICAgIHVucmVnaXN0ZXJTZXJ2aWNlV29ya2VycyA9IHRydWUsXG4gIH0gPSB7fSBhcyBTaW1wbGVSZWxvYWRlck9wdGlvbnMsXG4gIGNhY2hlID0ge30gYXMgU2ltcGxlUmVsb2FkZXJDYWNoZSxcbik6IFNpbXBsZVJlbG9hZGVyUGx1Z2luIHwgdW5kZWZpbmVkID0+IHtcbiAgaWYgKCFwcm9jZXNzLmVudi5ST0xMVVBfV0FUQ0gpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkXG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdjaHJvbWUtZXh0ZW5zaW9uLXNpbXBsZS1yZWxvYWRlcicsXG5cbiAgICBnZW5lcmF0ZUJ1bmRsZSh7IGRpciB9LCBidW5kbGUpIHtcbiAgICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZSgpXG4gICAgICBjb25zdCB0aW1lID0gYCR7ZGF0ZVxuICAgICAgICAuZ2V0RnVsbFllYXIoKVxuICAgICAgICAudG9TdHJpbmcoKVxuICAgICAgICAucGFkU3RhcnQoMiwgJzAnKX0tJHsoZGF0ZS5nZXRNb250aCgpICsgMSlcbiAgICAgICAgLnRvU3RyaW5nKClcbiAgICAgICAgLnBhZFN0YXJ0KDIsICcwJyl9LSR7ZGF0ZVxuICAgICAgICAuZ2V0RGF0ZSgpXG4gICAgICAgIC50b1N0cmluZygpXG4gICAgICAgIC5wYWRTdGFydCgyLCAnMCcpfSAke2RhdGVcbiAgICAgICAgLmdldEhvdXJzKClcbiAgICAgICAgLnRvU3RyaW5nKClcbiAgICAgICAgLnBhZFN0YXJ0KDIsICcwJyl9OiR7ZGF0ZVxuICAgICAgICAuZ2V0TWludXRlcygpXG4gICAgICAgIC50b1N0cmluZygpXG4gICAgICAgIC5wYWRTdGFydCgyLCAnMCcpfToke2RhdGVcbiAgICAgICAgLmdldFNlY29uZHMoKVxuICAgICAgICAudG9TdHJpbmcoKVxuICAgICAgICAucGFkU3RhcnQoMiwgJzAnKX1gXG5cbiAgICAgIGNhY2hlLm91dHB1dERpciA9IGRpclxuICAgICAgY2FjaGUubG9hZE1lc3NhZ2UgPSBbXG4gICAgICAgICdERVZFTE9QTUVOVCBidWlsZCB3aXRoIHNpbXBsZSBhdXRvLXJlbG9hZGVyJyxcbiAgICAgICAgYFske3RpbWV9XSB3YWl0aW5nIGZvciBjaGFuZ2VzLi4uYCxcbiAgICAgIF0uam9pbignXFxuJylcblxuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tIEVNSVQgQ0xJRU5UIEZJTEVTIC0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICBjb25zdCBlbWl0ID0gKFxuICAgICAgICBuYW1lOiBzdHJpbmcsXG4gICAgICAgIHNvdXJjZTogc3RyaW5nLFxuICAgICAgICBpc0ZpbGVOYW1lPzogYm9vbGVhbixcbiAgICAgICkgPT4ge1xuICAgICAgICBjb25zdCBpZCA9IHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgICAgW2lzRmlsZU5hbWUgPyAnZmlsZU5hbWUnIDogJ25hbWUnXTogbmFtZSxcbiAgICAgICAgICBzb3VyY2UsXG4gICAgICAgIH0pXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZ2V0RmlsZU5hbWUoaWQpXG4gICAgICB9XG5cbiAgICAgIGNhY2hlLnRpbWVzdGFtcFBhdGggPSBlbWl0KFxuICAgICAgICB0aW1lc3RhbXBGaWxlbmFtZSxcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoRGF0ZS5ub3coKSksXG4gICAgICAgIHRydWUsXG4gICAgICApXG5cbiAgICAgIGNhY2hlLmN0U2NyaXB0UGF0aCA9IGVtaXQoXG4gICAgICAgIGNvbnRlbnRTY3JpcHRSZWxvYWRlcixcbiAgICAgICAgY3RDbGllbnRDb2RlLnJlcGxhY2UoXG4gICAgICAgICAgbG9hZE1lc3NhZ2VQbGFjZWhvbGRlcixcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShjYWNoZS5sb2FkTWVzc2FnZSksXG4gICAgICAgICksXG4gICAgICApXG5cbiAgICAgIGNhY2hlLmJnU2NyaXB0UGF0aCA9IGVtaXQoXG4gICAgICAgIGJhY2tncm91bmRQYWdlUmVsb2FkZXIsXG4gICAgICAgIGJnQ2xpZW50Q29kZVxuICAgICAgICAgIC5yZXBsYWNlKHRpbWVzdGFtcFBhdGhQbGFjZWhvbGRlciwgY2FjaGUudGltZXN0YW1wUGF0aClcbiAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgIGxvYWRNZXNzYWdlUGxhY2Vob2xkZXIsXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShjYWNoZS5sb2FkTWVzc2FnZSksXG4gICAgICAgICAgKVxuICAgICAgICAgIC5yZXBsYWNlKFxuICAgICAgICAgICAgY3RTY3JpcHRQYXRoUGxhY2Vob2xkZXIsXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShjYWNoZS5jdFNjcmlwdFBhdGgpLFxuICAgICAgICAgIClcbiAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgIGV4ZWN1dGVTY3JpcHRQbGFjZWhvbGRlcixcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGV4ZWN1dGVTY3JpcHQpLFxuICAgICAgICAgIClcbiAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgIHVucmVnaXN0ZXJTZXJ2aWNlV29ya2Vyc1BsYWNlaG9sZGVyLFxuICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkodW5yZWdpc3RlclNlcnZpY2VXb3JrZXJzKSxcbiAgICAgICAgICApLFxuICAgICAgKVxuXG4gICAgICAvLyBVcGRhdGUgdGhlIGV4cG9ydGVkIGNhY2hlXG4gICAgICBPYmplY3QuYXNzaWduKF9pbnRlcm5hbENhY2hlLCBjYWNoZSlcblxuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLSBVUERBVEUgTUFOSUZFU1QgLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICB1cGRhdGVNYW5pZmVzdChcbiAgICAgICAgKG1hbmlmZXN0KSA9PiB7XG4gICAgICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0tIERFU0NSSVBUSU9OIC0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICAgICAgbWFuaWZlc3QuZGVzY3JpcHRpb24gPSBjYWNoZS5sb2FkTWVzc2FnZVxuXG4gICAgICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLSBCQUNLR1JPVU5EIFBBR0UgLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICAgICAgaWYgKCFtYW5pZmVzdC5iYWNrZ3JvdW5kKSB7XG4gICAgICAgICAgICBtYW5pZmVzdC5iYWNrZ3JvdW5kID0ge31cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBtYW5pZmVzdC5iYWNrZ3JvdW5kLnBlcnNpc3RlbnQgPSB0cnVlXG5cbiAgICAgICAgICBjb25zdCB7IHNjcmlwdHM6IGJnU2NyaXB0cyA9IFtdIH0gPSBtYW5pZmVzdC5iYWNrZ3JvdW5kXG5cbiAgICAgICAgICBpZiAoY2FjaGUuYmdTY3JpcHRQYXRoKSB7XG4gICAgICAgICAgICBtYW5pZmVzdC5iYWNrZ3JvdW5kLnNjcmlwdHMgPSBbXG4gICAgICAgICAgICAgIGNhY2hlLmJnU2NyaXB0UGF0aCxcbiAgICAgICAgICAgICAgLi4uYmdTY3JpcHRzLFxuICAgICAgICAgICAgXVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVycm9yKFxuICAgICAgICAgICAgICBgY2FjaGUuYmdTY3JpcHRQYXRoIGlzICR7dHlwZW9mIGNhY2hlLmJnU2NyaXB0UGF0aH1gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8qIC0tLS0tLS0tLS0tLS0tLS0gQ09OVEVOVCBTQ1JJUFRTIC0tLS0tLS0tLS0tLS0tLS0gKi9cblxuICAgICAgICAgIGNvbnN0IHsgY29udGVudF9zY3JpcHRzOiBjdFNjcmlwdHMgfSA9IG1hbmlmZXN0XG5cbiAgICAgICAgICBpZiAoY2FjaGUuY3RTY3JpcHRQYXRoKSB7XG4gICAgICAgICAgICBtYW5pZmVzdC5jb250ZW50X3NjcmlwdHMgPSBjdFNjcmlwdHM/Lm1hcChcbiAgICAgICAgICAgICAgKHsganMgPSBbXSwgLi4ucmVzdCB9KSA9PiAoe1xuICAgICAgICAgICAgICAgIGpzOiBbY2FjaGUuY3RTY3JpcHRQYXRoISwgLi4uanNdLFxuICAgICAgICAgICAgICAgIC4uLnJlc3QsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVycm9yKFxuICAgICAgICAgICAgICBgY2FjaGUuY3RTY3JpcHRQYXRoIGlzICR7dHlwZW9mIGNhY2hlLmN0U2NyaXB0UGF0aH1gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBtYW5pZmVzdFxuICAgICAgICB9LFxuICAgICAgICBidW5kbGUsXG4gICAgICAgIHRoaXMuZXJyb3IsXG4gICAgICApXG5cbiAgICAgIC8vIFdlJ2xsIHdyaXRlIHRoaXMgZmlsZSBvdXJzZWx2ZXMsIHdlIGp1c3QgbmVlZCBhIHNhZmUgcGF0aCB0byB3cml0ZSB0aGUgdGltZXN0YW1wXG4gICAgICBkZWxldGUgYnVuZGxlW2NhY2hlLnRpbWVzdGFtcFBhdGhdXG4gICAgfSxcblxuICAgIC8qIC0tLS0tLS0tLS0tLS0tIFdSSVRFIFRJTUVTVEFNUCBGSUxFIC0tLS0tLS0tLS0tLS0gKi9cbiAgICBhc3luYyB3cml0ZUJ1bmRsZSgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IG91dHB1dEpzb24oXG4gICAgICAgICAgam9pbihjYWNoZS5vdXRwdXREaXIhLCBjYWNoZS50aW1lc3RhbXBQYXRoISksXG4gICAgICAgICAgRGF0ZS5ub3coKSxcbiAgICAgICAgKVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZXJyLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgdGhpcy5lcnJvcihcbiAgICAgICAgICAgIGBVbmFibGUgdG8gdXBkYXRlIHRpbWVzdGFtcCBmaWxlOlxcblxcdCR7ZXJyLm1lc3NhZ2V9YCxcbiAgICAgICAgICApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5lcnJvcignVW5hYmxlIHRvIHVwZGF0ZSB0aW1lc3RhbXAgZmlsZScpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuICB9XG59XG4iLCJpbXBvcnQgaHRtbElucHV0cyBmcm9tICcuL2h0bWwtaW5wdXRzJ1xuaW1wb3J0IG1hbmlmZXN0SW5wdXQgZnJvbSAnLi9tYW5pZmVzdC1pbnB1dCdcbmltcG9ydCB7IGJyb3dzZXJQb2x5ZmlsbCBhcyBiIH0gZnJvbSAnLi9icm93c2VyLXBvbHlmaWxsJ1xuaW1wb3J0IHsgdmFsaWRhdGVOYW1lcyBhcyB2IH0gZnJvbSAnLi92YWxpZGF0ZS1uYW1lcydcbmltcG9ydCB7IHJlYWRKU09OU3luYyB9IGZyb20gJ2ZzLWV4dHJhJ1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnXG5cbmltcG9ydCB7XG4gIENocm9tZUV4dGVuc2lvbk9wdGlvbnMsXG4gIENocm9tZUV4dGVuc2lvblBsdWdpbixcbn0gZnJvbSAnLi9wbHVnaW4tb3B0aW9ucydcbmltcG9ydCB7IG1peGVkRm9ybWF0IGFzIG0gfSBmcm9tICcuL21peGVkLWZvcm1hdCdcblxuZXhwb3J0IHsgc2ltcGxlUmVsb2FkZXIgfSBmcm9tICcuL3BsdWdpbi1yZWxvYWRlci1zaW1wbGUnXG5cbmV4cG9ydCBjb25zdCBjaHJvbWVFeHRlbnNpb24gPSAoXG4gIG9wdGlvbnMgPSB7fSBhcyBDaHJvbWVFeHRlbnNpb25PcHRpb25zLFxuKTogQ2hyb21lRXh0ZW5zaW9uUGx1Z2luID0+IHtcbiAgLyogLS0tLS0tLS0tLS0tLS0tIExPQUQgUEFDS0FHRS5KU09OIC0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcGFja2FnZUpzb25QYXRoID0gam9pbihwcm9jZXNzLmN3ZCgpLCAncGFja2FnZS5qc29uJylcbiAgICBvcHRpb25zLnBrZyA9IG9wdGlvbnMucGtnIHx8IHJlYWRKU09OU3luYyhwYWNrYWdlSnNvblBhdGgpXG4gIH0gY2F0Y2ggKGVycm9yKSB7fVxuXG4gIC8qIC0tLS0tLS0tLS0tLS0tLS0tIFNFVFVQIFBMVUdJTlMgLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuICBjb25zdCBtYW5pZmVzdCA9IG1hbmlmZXN0SW5wdXQob3B0aW9ucylcbiAgY29uc3QgaHRtbCA9IGh0bWxJbnB1dHMobWFuaWZlc3QpXG4gIGNvbnN0IHZhbGlkYXRlID0gdigpXG4gIGNvbnN0IGJyb3dzZXIgPSBiKG1hbmlmZXN0KVxuICBjb25zdCBtaXhlZEZvcm1hdCA9IG0obWFuaWZlc3QpXG5cbiAgLyogLS0tLS0tLS0tLS0tLS0tLS0gUkVUVVJOIFBMVUdJTiAtLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gIHJldHVybiB7XG4gICAgbmFtZTogJ2Nocm9tZS1leHRlbnNpb24nLFxuXG4gICAgLy8gRm9yIHRlc3RpbmdcbiAgICBfcGx1Z2luczogeyBtYW5pZmVzdCwgaHRtbCwgdmFsaWRhdGUgfSxcblxuICAgIG9wdGlvbnMob3B0aW9ucykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIFttYW5pZmVzdCwgaHRtbF0ucmVkdWNlKChvcHRzLCBwbHVnaW4pID0+IHtcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBwbHVnaW4ub3B0aW9ucy5jYWxsKHRoaXMsIG9wdHMpXG5cbiAgICAgICAgICByZXR1cm4gcmVzdWx0IHx8IG9wdGlvbnNcbiAgICAgICAgfSwgb3B0aW9ucylcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IG1hbmlmZXN0RXJyb3IgPVxuICAgICAgICAgICdUaGUgbWFuaWZlc3QgbXVzdCBoYXZlIGF0IGxlYXN0IG9uZSBzY3JpcHQgb3IgSFRNTCBmaWxlLidcbiAgICAgICAgY29uc3QgaHRtbEVycm9yID1cbiAgICAgICAgICAnQXQgbGVhc3Qgb25lIEhUTUwgZmlsZSBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIHNjcmlwdC4nXG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVycm9yLm1lc3NhZ2UgPT09IG1hbmlmZXN0RXJyb3IgfHxcbiAgICAgICAgICBlcnJvci5tZXNzYWdlID09PSBodG1sRXJyb3JcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJ0EgQ2hyb21lIGV4dGVuc2lvbiBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIHNjcmlwdCBvciBIVE1MIGZpbGUuJyxcbiAgICAgICAgICApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3JcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0sXG5cbiAgICBhc3luYyBidWlsZFN0YXJ0KG9wdGlvbnMpIHtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgbWFuaWZlc3QuYnVpbGRTdGFydC5jYWxsKHRoaXMsIG9wdGlvbnMpLFxuICAgICAgICBodG1sLmJ1aWxkU3RhcnQuY2FsbCh0aGlzLCBvcHRpb25zKSxcbiAgICAgIF0pXG4gICAgfSxcblxuICAgIGFzeW5jIHJlc29sdmVJZChzb3VyY2UsIGltcG9ydGVyKSB7XG4gICAgICByZXR1cm4gbWFuaWZlc3QucmVzb2x2ZUlkLmNhbGwodGhpcywgc291cmNlLCBpbXBvcnRlcilcbiAgICB9LFxuXG4gICAgYXN5bmMgbG9hZChpZCkge1xuICAgICAgcmV0dXJuIG1hbmlmZXN0LmxvYWQuY2FsbCh0aGlzLCBpZClcbiAgICB9LFxuXG4gICAgd2F0Y2hDaGFuZ2UoaWQpIHtcbiAgICAgIG1hbmlmZXN0LndhdGNoQ2hhbmdlLmNhbGwodGhpcywgaWQpXG4gICAgICBodG1sLndhdGNoQ2hhbmdlLmNhbGwodGhpcywgaWQpXG4gICAgfSxcblxuICAgIGFzeW5jIGdlbmVyYXRlQnVuZGxlKC4uLmFyZ3MpIHtcbiAgICAgIGF3YWl0IG1hbmlmZXN0LmdlbmVyYXRlQnVuZGxlLmNhbGwodGhpcywgLi4uYXJncylcbiAgICAgIGF3YWl0IHZhbGlkYXRlLmdlbmVyYXRlQnVuZGxlLmNhbGwodGhpcywgLi4uYXJncylcbiAgICAgIGF3YWl0IGJyb3dzZXIuZ2VuZXJhdGVCdW5kbGUuY2FsbCh0aGlzLCAuLi5hcmdzKVxuICAgICAgLy8gVE9ETzogc2hvdWxkIHNraXAgdGhpcyBpZiBub3QgbmVlZGVkXG4gICAgICBhd2FpdCBtaXhlZEZvcm1hdC5nZW5lcmF0ZUJ1bmRsZS5jYWxsKHRoaXMsIC4uLmFyZ3MpXG4gICAgfSxcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBS0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFVQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3JFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNWQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7Ozs7Ozs7QUNoTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3BDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FDdkdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQ3BJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNqQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OzttZ0JDM2ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3RGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQy9DQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDeEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUN4RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7O0FDOUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O3FnQkNHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDaE1BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7In0=
