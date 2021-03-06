"use strict";

var logger = require('../../server/logger.js').get('appium')
  , _ = require('underscore')
  , errors = require('../../server/errors.js')
  , UnknownError = errors.UnknownError
  , async = require('async')
  , Chromedriver = require('./chromedriver.js')
  , status = require("../../server/status.js");

var androidHybrid = {};

androidHybrid.chromedriver = null;
androidHybrid.sessionChromedrivers = {};

androidHybrid.listWebviews = function (cb) {
  logger.debug("Getting a list of available webviews");
  var webviews = [];
  var definedDeviceSocket = this.args.androidDeviceSocket;
  this.adb.shell("cat /proc/net/unix", function (err, out) {
    if (err) return cb(err);
    _.each(out.split("\n"), function (line) {
      line = line.trim();
      var webviewPid = line.match(/@?webview_devtools_remote_(\d+)/);
      if (definedDeviceSocket) {
        if (line.indexOf("@" + definedDeviceSocket) ===
          line.length - definedDeviceSocket.length - 1) {
          if (webviewPid) {
            webviews.push(this.WEBVIEW_BASE + webviewPid[1]);
          } else {
            webviews.push(this.CHROMIUM_WIN);
          }
        }
      } else if (webviewPid) {
        // for multiple webviews a list of 'WEBVIEW_<index>' will be returned
        // where <index> is zero based (same is in selendroid)
        webviews.push(this.WEBVIEW_BASE + webviewPid[1]);
      }
    }.bind(this));
    webviews = _.uniq(webviews);

    if (definedDeviceSocket) {
      return cb(null, webviews);
    }

    var webviewsTmp = webviews;
    webviews = [];

    var getProcessNameFromWebview = function (view, cb) {
      this.getProcessNameFromWebview(view, function (err, pkg) {
        if (err) return cb(err);
        webviews.push(this.WEBVIEW_BASE + pkg);
        cb();
      }.bind(this));
    }.bind(this);

    async.each(webviewsTmp, getProcessNameFromWebview, function (err) {
      if (err) return cb(err);
      logger.debug("Available contexts: " + this.contexts);
      logger.debug(JSON.stringify(webviews));
      cb(null, webviews);
    }.bind(this));
  }.bind(this));
};

var previousState = {};

androidHybrid.rememberProxyState = function () {
  previousState.proxyHost = this.proxyHost;
  previousState.proxyPort = this.proxyPort;
  previousState.proxySessionId = this.proxySessionId;
  previousState.isProxy = this.isProxy;
};

androidHybrid.restoreProxyState = function () {
  this.proxyHost = previousState.proxyHost;
  this.proxyPort = previousState.proxyPort;
  this.proxySessionId = previousState.proxySessionId;
  this.isProxy = previousState.isProxy;
};

androidHybrid.getProcessNameFromWebview = function (webview, cb) {
  // webview_devtools_remote_4296 => 4296
  var pid = webview.match(/\d+$/);
  if (!pid) return cb("No pid for webview " + webview);
  pid = pid[0];
  logger.debug(webview + " mapped to pid " + pid);

  logger.debug("Getting process name for webview");
  this.adb.shell("ps", function (err, out) {
    if (err) return cb(err);
    var pkg = "unknown";

    var lines = out.split(/\r?\n/);
    /*
     USER     PID   PPID  VSIZE  RSS     WCHAN    PC         NAME
     u0_a136   6248  179   946000 48144 ffffffff 4005903e R com.example.test
     */
    var header = lines[0].trim().split(/\s+/);
    // the column order may not be identical on all androids
    // dynamically locate the pid and name column.
    var pidColumn = header.indexOf("PID");
    var pkgColumn = header.indexOf("NAME") + 1;

    _.find(lines, function (line) {
      line = line.trim().split(/\s+/);
      if (line[pidColumn].indexOf(pid) !== -1) {
        logger.debug("Parsed pid: " + line[pidColumn] + " pkg: " + line[pkgColumn]);
        logger.debug("from: " + line);
        pkg = line[pkgColumn];
        return pkg; // exit from _.find
      }
    });

    logger.debug("returning process name: " + pkg);
    cb(null, pkg);
  });
};

androidHybrid.startChromedriverProxy = function (context, cb) {
  logger.debug("Connecting to chrome-backed webview");
  if (this.chromedriver !== null) {
    return cb(new Error("We already have a chromedriver instance running"));
  }

  var setupNewChromeDriver = function (ocb) {
    var chromeArgs = {
      port: this.args.chromeDriverPort
    , executable: this.args.chromedriverExecutable
    , deviceId: this.adb.curDeviceId
    , enablePerformanceLogging: this.args.enablePerformanceLogging
    };
    this.chromedriver = new Chromedriver(chromeArgs, this.onChromedriverExit.bind(this));
    this.rememberProxyState();
    this.proxyHost = this.chromedriver.proxyHost;
    this.proxyPort = this.chromedriver.proxyPort;
    this.isProxy = true;
    var caps = {
      chromeOptions: {
        androidPackage: this.args.appPackage,
        androidUseRunningApp: true
      }
    };
    // For now the only known arg passed this way is androidDeviceSocked used by Operadriver (deriving from Chromedriver)
    // We don't know how other Chromium embedders will call this argument so for now it's name needs to be configurable
    // When Google adds the androidDeviceSocket argument to the original Chromedriver then we will be sure about it's name
    // for all Chromium embedders (as their Webdrivers will derive from Chromedriver)
    if (this.args.specialChromedriverSessionArgs) {
      _.each(this.args.specialChromedriverSessionArgs, function (val, option) {
        logger.debug("This method is being deprecated. Apply chromeOptions normally to pass along options," +
                     "see sites.google.com/a/chromium.org/chromedriver/capabilities for more info");
        caps.chromeOptions[option] = val;
      });
    }
    caps = this.decorateChromeOptions(caps);
    this.chromedriver.createSession(caps, function (err, sessId) {
      if (err) return cb(err);
      logger.debug("Setting proxy session id to " + sessId);
      this.proxySessionId = sessId;
      this.sessionChromedrivers[context] = this.chromedriver;
      ocb();
    }.bind(this));
  }.bind(this);

  if (this.sessionChromedrivers[context]) {
    logger.debug("Found existing Chromedriver for context '" + context + "'." +
                 " Using it.");
    this.rememberProxyState();
    this.chromedriver = this.sessionChromedrivers[context];
    this.proxyHost = this.chromedriver.proxyHost;
    this.proxyPort = this.chromedriver.proxyPort;
    this.proxySessionId = this.chromedriver.chromeSessionId;
    this.isProxy = true;

    // check the status by sending a simple window-based command to ChromeDriver
    // if there is an error, we want to recreate the ChromeDriver session
    var url = '/wd/hub/session/' + this.proxySessionId + '/url';
    this.chromedriver.proxyTo(url, 'GET', {}, function (err, res, body) {
      body = JSON.parse(body);
      if ((body.status === status.codes.NoSuchWindow.code && body.value.message.indexOf('no such window: window was already closed') !== -1) ||
          (body.status === 100 && body.value.message.indexOf('chrome not reachable') !== -1)) {
        // the window is closed and we need to reinitialize
        logger.debug("ChromeDriver is not associated with a window. Re-initializing the session.");
        this.cleanupChromedriver(this.chromedriver, function () {
          setupNewChromeDriver(cb);
        });
      } else {
        cb();
      }
    }.bind(this));
  } else {
    setupNewChromeDriver(cb);
  }
};

androidHybrid.onChromedriverExit = function () {
  logger.debug("Chromedriver exited unexpectedly");
  if (typeof this.cbForCurrentCmd === "function") {
    var error = new UnknownError("Chromedriver quit unexpectedly during session");
    this.shutdown(function () {
      this.cbForCurrentCmd(error, null);
    }.bind(this));
  }
};

androidHybrid.cleanupChromedriver = function (chromedriver, cb) {
  if (chromedriver) {
    logger.debug("Cleaning up Chromedriver");
    chromedriver.stop(function (err) {
      if (err) logger.warn("Error stopping chromedriver: " + err.message);
      this.restoreProxyState();
      cb();
    }.bind(this));
  } else {
    cb();
  }
};

androidHybrid.suspendChromedriverProxy = function (cb) {
  this.chromedriver = null;
  this.restoreProxyState();
  cb();
};

androidHybrid.stopChromedriverProxies = function (ocb) {
  async.eachSeries(Object.keys(this.sessionChromedrivers), function (context, cb) {
    var chromedriver = this.sessionChromedrivers[context];
    chromedriver.deleteSession(function (err) {
      if (err) return cb(err);
      this.cleanupChromedriver(chromedriver, cb);
      delete this.sessionChromedrivers[context];
    }.bind(this));
  }.bind(this), ocb);
};

androidHybrid.defaultWebviewName = function () {
  return this.WEBVIEW_BASE + this.appProcess;
};

androidHybrid.initAutoWebview = function (cb) {
  if (this.args.autoWebview) {
    logger.debug('Setting auto webview');
    var viewName = this.defaultWebviewName();
    var timeout = (this.args.autoWebviewTimeout) || 2000;
    this.setContext(viewName, function (err, res) {
      if (err && res.status !== status.codes.NoSuchContext.code) return cb(err);
      if (res.status === status.codes.Success.code) return cb();
      setTimeout(function () {
        logger.debug("Retrying context switch with timeout '" + timeout + "'");
        this.setContext(viewName, cb);
      }.bind(this), timeout);
    }.bind(this));
  } else {
    cb();
  }
};

module.exports = androidHybrid;
