'use strict';

var debug_ = require('debug');

var debug = debug_('purs-loader');

var debugVerbose = debug_('purs-loader:verbose');

var loaderUtils = require('loader-utils');

var Promise = require('bluebird');

var path = require('path');

var PsModuleMap = require('./purs-module-map');

var compile = require('./compile');

var bundle = require('./bundle');

var ide = require('./ide');

var toJavaScript = require('./to-javascript');

var sourceMaps = require('./source-maps');

var spawn = require('cross-spawn').sync;

var eol = require('os').EOL;

var CACHE_VAR = {
  rebuild: false,
  deferred: [],
  bundleModules: [],
  ideServer: null,
  psModuleMap: null,
  warnings: [],
  errors: [],
  compilationStarted: false,
  compilationFinished: false,
  installed: false,
  srcOption: [],
  spagoOutputPath: null
};

// include src files provided by psc-package or Spago
function requestDependencySources(packagerCommand, srcPath, loaderOptions) {
  var packagerArgs = ['sources'];

  var loaderSrc = loaderOptions.src || [srcPath];

  debug('%s %o', packagerCommand, packagerArgs);

  var cmd = spawn(packagerCommand, packagerArgs);

  if (cmd.error) {
    throw new Error(cmd.error);
  } else if (cmd.status !== 0) {
    var error = cmd.stdout.toString();

    throw new Error(error);
  } else {
    var result = cmd.stdout.toString().split(eol).filter(function (v) {
      return v != '';
    }).concat(loaderSrc);

    debug('%s result: %o', packagerCommand, result);

    CACHE_VAR.srcOption = result;

    return result;
  }
}

// 'spago output path' will return the output folder in a monorepo
function getSpagoSources() {
  var cachedVal = CACHE_VAR.spagoOutputPath;
  if (cachedVal) {
    return cachedVal;
  }
  var command = "spago";
  var args = ["path", "output"];

  var cmd = spawn(command, args);

  if (cmd.error) {
    throw new Error(cmd.error);
  } else if (cmd.status !== 0) {
    var error = cmd.stdout.toString();

    throw new Error(error);
  } else {
    var result = cmd.stdout.toString().split(eol)[0];

    debug('"spago path output" result: %o', result);

    CACHE_VAR.spagoOutputPath = result;

    return result;
  }
}

module.exports = function purescriptLoader(source, map) {
  this.cacheable && this.cacheable();

  var webpackContext = this.options && this.options.context || this.rootContext;

  var callback = this.async();

  var loaderOptions = loaderUtils.getOptions(this) || {};

  var srcOption = function (pscPackage, spago) {
    var srcPath = path.join('src', '**', '*.purs');

    var bowerPath = path.join('bower_components', 'purescript-*', 'src', '**', '*.purs');

    if (CACHE_VAR.srcOption.length > 0) {
      return CACHE_VAR.srcOption;
    } else if (pscPackage) {
      return requestDependencySources('psc-package', srcPath, loaderOptions);
    } else if (spago) {
      return requestDependencySources('spago', srcPath, loaderOptions);
    } else {
      var result = loaderOptions.src || [bowerPath, srcPath];

      CACHE_VAR.srcOption = result;

      return result;
    }
  }(loaderOptions.pscPackage, loaderOptions.spago);

  var outputPath = loaderOptions.spago ? getSpagoSources() : 'output';

  var options = Object.assign({
    context: webpackContext,
    psc: null,
    pscArgs: {},
    pscBundle: null,
    pscBundleArgs: {},
    pscIdeClient: null,
    pscIdeClientArgs: {},
    pscIdeServer: null,
    pscIdeServerArgs: {},
    pscIdeRebuildArgs: {},
    pscIde: false,
    pscIdeColors: loaderOptions.psc === 'psa',
    pscPackage: false,
    spago: false,
    bundleOutput: 'output/bundle.js',
    bundleNamespace: 'PS',
    bundle: false,
    warnings: true,
    watch: false,
    output: outputPath,
    src: []
  }, loaderOptions, {
    src: srcOption
  });

  if (!CACHE_VAR.installed) {
    debugVerbose('installing purs-loader with options: %O', options);

    CACHE_VAR.installed = true;

    var invalidCb = function invalidCb() {
      debugVerbose('invalidating loader CACHE_VAR');

      CACHE_VAR = {
        rebuild: options.pscIde,
        deferred: [],
        bundleModules: [],
        ideServer: CACHE_VAR.ideServer,
        psModuleMap: CACHE_VAR.psModuleMap,
        warnings: [],
        errors: [],
        compilationStarted: false,
        compilationFinished: false,
        installed: CACHE_VAR.installed,
        srcOption: []
      };
    };

    // invalidate loader CACHE_VAR when bundle is marked as invalid (in watch mode)
    if (this._compiler.hooks) {
      this._compiler.hooks.invalid.tap('purs-loader', invalidCb);
    } else {
      this._compiler.plugin('invalid', invalidCb);
    }

    var afterCompileCb = function afterCompileCb(compilation, callback) {
      CACHE_VAR.warnings.forEach(function (warning) {
        compilation.warnings.push(warning);
      });

      CACHE_VAR.errors.forEach(function (error) {
        compilation.errors.push(error);
      });

      callback();
    };

    // add psc warnings to webpack compilation warnings
    if (this._compiler.hooks) {
      this._compiler.hooks.afterCompile.tapAsync('purs-loader', afterCompileCb);
    } else {
      this._compiler.plugin('after-compile', afterCompileCb);
    }
  }

  var psModuleName = PsModuleMap.matchModule(source);

  var psModule = {
    name: psModuleName,
    source: source,
    load: function load(_ref) {
      var js = _ref.js,
          map = _ref.map;

      CACHE_VAR.psModuleMap.then(function (modulesMap) {
        return callback(null, js, map, {
          options: { src: options.src, output: options.output },
          module: { name: psModuleName, map: modulesMap }
        });
      }, callback);
    },
    reject: function reject(error) {
      return callback(error);
    },
    srcPath: this.resourcePath,
    remainingRequest: loaderUtils.getRemainingRequest(this),
    srcDir: path.dirname(this.resourcePath),
    jsPath: path.resolve(path.join(options.output, psModuleName, 'index.js')),
    options: options,
    cache: CACHE_VAR,
    emitWarning: function emitWarning(warning) {
      if (options.warnings && warning.length) {
        CACHE_VAR.warnings.push(warning);
      }
    },
    emitError: function emitError(error) {
      if (error.length) {
        CACHE_VAR.errors.push(error);
      }
    }
  };

  debug('loading %s', psModule.name);

  if (options.bundle) {
    CACHE_VAR.bundleModules.push(psModule.name);
  }

  if (CACHE_VAR.rebuild) {
    var connect = function connect() {
      if (!CACHE_VAR.ideServer) {
        CACHE_VAR.ideServer = true;

        return ide.connect(psModule).then(function (ideServer) {
          CACHE_VAR.ideServer = ideServer;
          return psModule;
        }).then(ide.loadWithRetry).catch(function (error) {
          if (CACHE_VAR.ideServer.kill) {
            debug('ide failed to initially load modules, stopping the ide server process');

            CACHE_VAR.ideServer.kill();
          }

          CACHE_VAR.ideServer = null;

          return Promise.reject(error);
        });
      } else {
        return Promise.resolve(psModule);
      }
    };

    var rebuild = function rebuild() {
      return ide.rebuild(psModule).then(function () {
        return toJavaScript(psModule).then(function (js) {
          return sourceMaps(psModule, js);
        }).then(psModule.load).catch(psModule.reject);
      }).catch(function (error) {
        if (error instanceof ide.UnknownModuleError) {
          // Store the modules that trigger a recompile due to an
          // unknown module error. We need to wait until compilation is
          // done before loading these files.

          CACHE_VAR.deferred.push(psModule);

          if (!CACHE_VAR.compilationStarted) {
            CACHE_VAR.compilationStarted = true;

            return compile(psModule).then(function () {
              CACHE_VAR.compilationFinished = true;
            }).then(function () {
              return Promise.map(CACHE_VAR.deferred, function (psModule) {
                return ide.load(psModule).then(function () {
                  return toJavaScript(psModule);
                }).then(function (js) {
                  return sourceMaps(psModule, js);
                }).then(psModule.load);
              });
            }).catch(function (error) {
              CACHE_VAR.deferred[0].reject(error);

              CACHE_VAR.deferred.slice(1).forEach(function (psModule) {
                psModule.reject(new Error('purs-loader failed'));
              });
            });
          } else {
            // The compilation has started. We must wait until it is
            // done in order to ensure the module map contains all of
            // the unknown modules.
          }
        } else {
          debug('ide rebuild failed due to an unhandled error: %o', error);

          psModule.reject(error);
        }
      });
    };

    connect().then(rebuild);
  } else if (CACHE_VAR.compilationFinished) {
    debugVerbose('compilation is already finished, loading module %s', psModule.name);

    toJavaScript(psModule).then(function (js) {
      return sourceMaps(psModule, js);
    }).then(psModule.load).catch(psModule.reject);
  } else {
    // The compilation has not finished yet. We need to wait for
    // compilation to finish before the loaders run so that references
    // to compiled output are valid. Push the modules into the CACHE_VAR to
    // be loaded once the complation is complete.

    CACHE_VAR.deferred.push(psModule);

    if (!CACHE_VAR.compilationStarted) {
      CACHE_VAR.compilationStarted = true;

      compile(psModule).then(function () {
        CACHE_VAR.compilationFinished = true;
      }).then(function () {
        if (options.bundle) {
          return bundle(options, CACHE_VAR.bundleModules);
        }
      }).then(function () {
        return Promise.map(CACHE_VAR.deferred, function (psModule) {
          return toJavaScript(psModule).then(function (js) {
            return sourceMaps(psModule, js);
          }).then(psModule.load);
        });
      }).catch(function (error) {
        CACHE_VAR.deferred[0].reject(error);

        CACHE_VAR.deferred.slice(1).forEach(function (psModule) {
          psModule.reject(new Error('purs-loader failed'));
        });
      });
    } else {
      // The complation has started. Nothing to do but wait until it is
      // done before loading all of the modules.
    }
  }
};