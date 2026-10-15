// aegis-web: browser shim for the Electron preload bridge.
// Defines window.electron / window.appConfig so the aegis Desktop renderer can
// run as a plain web app against a remote `aegis serve` ACP backend.
// Loaded as a classic script before the app module. No imports on purpose.
(function () {
  'use strict';

  var CFG = (window.__AEGIS_WEB__ = window.__AEGIS_WEB__ || {});
  var APP = CFG.appConfig || {};

  // --- client-side reporter: ship errors/console.error to the server ------
  var errCount = 0;
  function report(kind, msg) {
    try {
      navigator.sendBeacon(
        '/client-log',
        JSON.stringify({
          kind: kind,
          msg: String(msg).slice(0, 7000),
          url: location.href,
          ua: navigator.userAgent,
        })
      );
    } catch (e) {
      /* ignore */
    }
  }
  window.addEventListener('error', function (e) {
    errCount++;
    report(
      'error',
      (e.message || '') +
        ' @ ' +
        (e.filename || '') +
        ':' +
        (e.lineno || 0) +
        ':' +
        (e.colno || 0) +
        (e.error && e.error.stack ? '\n' + e.error.stack : '')
    );
  });
  window.addEventListener('unhandledrejection', function (e) {
    errCount++;
    var r = e.reason;
    report('rejection', (r && (r.stack || r.message)) || String(r));
  });
  var origConsoleError = console.error;
  console.error = function () {
    try {
      errCount++;
      report(
        'console.error',
        Array.prototype.map
          .call(arguments, function (a) {
            return a && a.stack ? a.stack : String(a);
          })
          .join(' ')
      );
    } catch (e) {
      /* ignore */
    }
    origConsoleError.apply(console, arguments);
  };
  report('boot', 'shim v3 loaded; acpUrl=' + (CFG.acpUrl ? 'set' : 'MISSING') + '; locale=' + (APP.AEGIS_LOCALE || 'auto'));

  // Compact DOM snapshot: enough to see what the main pane rendered on ANY
  // client without blowing up the report size (debug aid for aegis-web).
  function domSnap(tag) {
    try {
      var root = document.getElementById('root');
      var shell = root && root.lastElementChild;
      var main = null;
      try {
        var row = shell ? shell.querySelector('div.flex.flex-1.w-full.h-full') : null;
        // row -> inner flex-row (sidebar + main) -> main pane
        main = row ? (row.lastElementChild ? row.lastElementChild.lastElementChild : null) : null;
        if (!main && shell) main = shell.lastElementChild;
      } catch (e) {
        /* ignore */
      }
      report(
        'dom:' + tag,
        JSON.stringify({
          hash: location.hash,
          vp: window.innerWidth + 'x' + window.innerHeight + '@' + (window.devicePixelRatio || 1),
          errCount: errCount,
          rootChildren: root ? root.children.length : -1,
          mainTag: main ? main.tagName : null,
          mainClass: main ? String(main.className).slice(0, 160) : null,
          mainChildren: main ? main.children.length : -1,
          mainHtmlLen: main ? main.innerHTML.length : -1,
          mainText: main ? (main.innerText || '').slice(0, 500) : null,
          mainOuterTail: main ? main.outerHTML.slice(-1500) : null,
          bodyLen: (document.body.innerText || '').length,
          ls: Object.keys(localStorage).slice(0, 30),
        })
      );
    } catch (e) {
      report('dom-snap-error', String(e));
    }
  }
  setTimeout(function () {
    domSnap('t6');
  }, 6000);
  setTimeout(function () {
    domSnap('t14');
  }, 14000);

  var LS_PREFIX = 'aegis_web_setting_';
  function lsGet(key, dflt) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + key);
      return raw === null ? dflt : JSON.parse(raw);
    } catch (e) {
      return dflt;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      /* ignore */
    }
  }

  var DEFAULTS = {
    showMenuBarIcon: true,
    disableAutoDownload: true,
    showDockIcon: true,
    enableWakelock: false,
    enableNotifications: true,
    spellcheckEnabled: true,
    externalAegisd: { enabled: false, url: '', secret: '' },
    keyboardShortcuts: {
      focusWindow: null,
      quickLauncher: null,
      newChat: 'CommandOrControl+T',
      newChatWindow: null,
      openDirectory: 'CommandOrControl+O',
      settings: 'CommandOrControl+,',
      find: 'CommandOrControl+F',
      findNext: 'CommandOrControl+G',
      findPrevious: 'CommandOrControl+Shift+G',
      alwaysOnTop: null,
      toggleNavigation: 'CommandOrControl+/',
    },
    theme: 'light',
    useSystemTheme: true,
    language: 'system',
    responseStyle: 'concise',
    showPricing: true,
    seenAnnouncementIds: [],
    recentModels: [],
  };

  // --- tiny event bus for ipcRenderer-style channels -----------------------
  var listeners = new Map(); // channel -> Set<cb>
  function busOn(channel, cb) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
  }
  function busOff(channel, cb) {
    var set = listeners.get(channel);
    if (set) set.delete(cb);
  }
  function busEmit(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    var set = listeners.get(channel);
    if (!set) return;
    Array.from(set).forEach(function (cb) {
      try {
        cb({ channel: channel }, ...args);
      } catch (e) {
        console.error('[aegis-web shim] listener error on', channel, e);
      }
    });
  }

  // --- recent directories (localStorage backed) -----------------------------
  var RECENTS_KEY = 'aegis_web_recent_dirs';
  function readRecents() {
    try {
      return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function writeRecents(list) {
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (e) {
      /* ignore */
    }
  }

  var electronAPI = {
    platform: 'win32',
    arch: 'x64',

    reactReady: function () {},
    getConfig: function () {
      return APP;
    },
    hideWindow: function () {
      /* no-op */
    },
    directoryChooser: function () {
      return Promise.resolve({ canceled: true, filePaths: [] });
    },
    createChatWindow: function () {
      try {
        window.open(window.location.pathname, '_blank', 'noopener');
      } catch (e) {
        /* ignore */
      }
    },
    logInfo: function (txt) {
      console.log('[aegis]', txt);
    },
    showNotification: function (data) {
      try {
        if (window.Notification && Notification.permission === 'granted') {
          new Notification(data.title || 'Aegis', { body: data.body || '' });
        } else {
          console.log('[aegis notification]', data.title, data.body);
        }
      } catch (e) {
        /* ignore */
      }
    },
    showMessageBox: function (options) {
      var opts = options || {};
      var text = (opts.message || '') + (opts.detail ? '\n\n' + opts.detail : '');
      var ok = true;
      try {
        ok = window.confirm(text);
      } catch (e) {
        ok = true;
      }
      return Promise.resolve({ response: ok ? 0 : 1, checkboxChecked: false });
    },
    showSaveDialog: function () {
      return Promise.resolve({ canceled: true });
    },
    openInChrome: function (url) {
      try {
        window.open(url, '_blank', 'noopener');
      } catch (e) {
        /* ignore */
      }
    },
    reloadApp: function () {
      window.location.reload();
    },
    checkForOllama: function () {
      return Promise.resolve(false);
    },
    selectFileOrDirectory: function () {
      return Promise.resolve(null);
    },
    selectImportSessionFile: function () {
      return Promise.resolve(null);
    },
    getBinaryPath: function () {
      return Promise.resolve('');
    },
    selectRecipeFile: function () {
      return Promise.resolve(null);
    },
    readAegishints: function () {
      return Promise.resolve({ file: '', filePath: '', error: null, found: false });
    },
    writeAegishints: function () {
      return Promise.resolve(false);
    },
    writeFile: function () {
      return Promise.resolve(false);
    },
    ensureDirectory: function () {
      return Promise.resolve(false);
    },
    listFiles: function () {
      return Promise.resolve([]);
    },
    getAllowedExtensions: function () {
      return Promise.resolve([
        'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'svg',
      ]);
    },
    getPathForFile: function () {
      return '';
    },
    setMenuBarIcon: function () {
      return Promise.resolve(true);
    },
    getMenuBarIconState: function () {
      return Promise.resolve(true);
    },
    setDockIcon: function () {
      return Promise.resolve(true);
    },
    getDockIconState: function () {
      return Promise.resolve(true);
    },
    getSetting: function (key) {
      return Promise.resolve(lsGet(key, DEFAULTS[key]));
    },
    setSetting: function (key, value) {
      lsSet(key, value);
      return Promise.resolve();
    },
    getSecretKey: function () {
      return Promise.resolve(CFG.secretKey || null);
    },
    getAcpUrl: function () {
      return Promise.resolve(CFG.acpUrl || null);
    },
    setWakelock: function () {
      return Promise.resolve(false);
    },
    getWakelockState: function () {
      return Promise.resolve(false);
    },
    setSpellcheck: function (enable) {
      return Promise.resolve(!!enable);
    },
    getSpellcheckState: function () {
      return Promise.resolve(true);
    },
    openNotificationsSettings: function () {
      return Promise.resolve(true);
    },
    isAnyWindowFocused: function () {
      return Promise.resolve(document.hasFocus());
    },
    getIsFullScreen: function () {
      return Promise.resolve(!!document.fullscreenElement);
    },
    onMouseBackButtonClicked: function () {},
    offMouseBackButtonClicked: function () {},
    on: function (channel, callback) {
      busOn(channel, callback);
    },
    off: function (channel, callback) {
      busOff(channel, callback);
    },
    emit: function (channel) {
      busEmit.apply(null, arguments);
    },
    broadcastThemeChange: function (themeData) {
      busEmit('theme-broadcast', themeData);
    },
    openExternal: function (url) {
      try {
        var w = window.open(url, '_blank', 'noopener');
        return Promise.resolve(w ? 'opened' : 'blocked');
      } catch (e) {
        return Promise.resolve('blocked');
      }
    },
    getVersion: function () {
      return String(APP.AEGIS_VERSION || 'web');
    },
    checkForUpdates: function () {
      return Promise.resolve({ updateInfo: null, error: null });
    },
    downloadUpdate: function () {
      return Promise.resolve({ success: false, error: null });
    },
    installUpdate: function () {},
    restartApp: function () {
      window.location.reload();
    },
    onUpdaterEvent: function () {},
    getUpdateState: function () {
      return Promise.resolve(null);
    },
    isUsingGitHubFallback: function () {
      return Promise.resolve(false);
    },
    getAutoDownloadDisabled: function () {
      return Promise.resolve(true);
    },
    closeWindow: function () {
      try {
        window.close();
      } catch (e) {
        /* ignore */
      }
    },
    hasAcceptedRecipeBefore: function () {
      return Promise.resolve(lsGet('accepted_recipe', false) === true);
    },
    recordRecipeHash: function () {
      lsSet('accepted_recipe', true);
      return Promise.resolve(true);
    },
    openDirectoryInExplorer: function () {
      return Promise.resolve(false);
    },
    launchApp: function () {
      return Promise.resolve();
    },
    refreshApp: function () {
      return Promise.resolve();
    },
    closeApp: function () {
      return Promise.resolve();
    },
    addRecentDir: function (dir) {
      var list = readRecents().filter(function (d) {
        return d !== dir;
      });
      list.unshift(dir);
      writeRecents(list);
      return Promise.resolve(true);
    },
    listRecentDirs: function () {
      return Promise.resolve(readRecents());
    },
    listGitWorktreeDirs: function () {
      return Promise.resolve([]);
    },
    getGitBranchInfo: function () {
      return Promise.resolve(null);
    },
    listGitBranches: function () {
      return Promise.resolve([]);
    },
    switchGitBranch: function () {
      return Promise.resolve({ success: false, error: 'not available in web mode' });
    },
  };

  try {
    Object.defineProperty(window, 'electron', {
      value: electronAPI,
      writable: false,
      configurable: false,
    });
  } catch (e) {
    window.electron = electronAPI;
  }

  window.appConfig = {
    get: function (key) {
      if (key === 'AEGIS_LOCALE') {
        return APP.AEGIS_LOCALE || navigator.language || 'en';
      }
      return APP[key];
    },
    getAll: function () {
      var out = {};
      for (var k in APP) out[k] = APP[k];
      out.AEGIS_LOCALE = window.appConfig.get('AEGIS_LOCALE');
      return out;
    },
  };

  console.log('[aegis-web] shim installed. backend:', (CFG.acpUrl || '').replace(/token=.*/, 'token=***'));
})();
