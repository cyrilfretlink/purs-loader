'use strict'

const debug_ = require('debug');

const debug = debug_('purs-loader');

const debugVerbose = debug_('purs-loader:verbose');

const loaderUtils = require('loader-utils')

const Promise = require('bluebird')

const path = require('path')

const PsModuleMap = require('./purs-module-map');

const compile = require('./compile');

const bundle = require('./bundle');

const ide = require('./ide');

const toJavaScript = require('./to-javascript');

const sourceMaps = require('./source-maps');

const dargs = require('./dargs');

const utils = require('./utils');

const spawn = require('cross-spawn').sync

const eol = require('os').EOL

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
  compilationFailed: false,
  installed: false,
  srcOption: []
};

module.exports = function purescriptLoader(source, map) {
  this.cacheable && this.cacheable();

  const webpackContext = (this.options && this.options.context) || this.rootContext;

  const callback = this.async();

  const loaderOptions = loaderUtils.getOptions(this) || {};

  const srcOption = (pscPackage => {
    const srcPath = path.join('src', '**', '*.purs');

    const bowerPath = path.join('bower_components', 'purescript-*', 'src', '**', '*.purs');

    if (CACHE_VAR.srcOption.length > 0) {
      return CACHE_VAR.srcOption;
    }
    else if (pscPackage) {
      const pscPackageCommand = 'psc-package';

      const pscPackageArgs = ['sources'];

      const loaderSrc = loaderOptions.src || [
        srcPath
      ];

      debug('psc-package %s %o', pscPackageCommand, pscPackageArgs);

      const cmd = spawn(pscPackageCommand, pscPackageArgs);

      if (cmd.error) {
        throw new Error(cmd.error);
      }
      else if (cmd.status !== 0) {
        const error = cmd.stdout.toString();

        throw new Error(error);
      }
      else {
        const result = cmd.stdout.toString().split(eol).filter(v => v != '').concat(loaderSrc);

        debug('psc-package result: %o', result);

        CACHE_VAR.srcOption = result;

        return result;
      }
    }
    else {
      const result = loaderOptions.src || [
        bowerPath,
        srcPath
      ];

      CACHE_VAR.srcOption = result;

      return result;
    }
  })(loaderOptions.pscPackage);

  const options = Object.assign({
    context: webpackContext,
    psc: null,
    pscArgs: {},
    pscBundle: null,
    pscBundleArgs: {},
    pscIdeClient: null,
    pscIdeClientArgs: {},
    pscIdeServer: null,
    pscIdeServerArgs: {},
    pscIde: false,
    pscIdeColors: loaderOptions.psc === 'psa',
    pscPackage: false,
    bundleOutput: 'output/bundle.js',
    bundleNamespace: 'PS',
    bundle: false,
    warnings: true,
    watch: false,
    output: 'output',
    src: []
  }, loaderOptions, {
    src: srcOption
  });

  if (!CACHE_VAR.installed) {
    debugVerbose('installing purs-loader with options: %O', options);

    CACHE_VAR.installed = true;

    // invalidate loader CACHE_VAR when bundle is marked as invalid (in watch mode)
    this._compiler.plugin('invalid', () => {
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
        compilationFailed: false,
        installed: CACHE_VAR.installed,
        srcOption: []
      };
    });

    // add psc warnings to webpack compilation warnings
    this._compiler.plugin('after-compile', (compilation, callback) => {
      CACHE_VAR.warnings.forEach(warning => {
        compilation.warnings.push(warning);
      });

      CACHE_VAR.errors.forEach(error => {
        compilation.errors.push(error);
      });

      callback()
    });
  }

  const psModuleName = PsModuleMap.matchModule(source);

  const psModule = {
    name: psModuleName,
    source: source,
    load: ({js, map}) => callback(null, js, map),
    reject: error => callback(error),
    srcPath: this.resourcePath,
    remainingRequest: loaderUtils.getRemainingRequest(this),
    srcDir: path.dirname(this.resourcePath),
    jsPath: path.resolve(path.join(options.output, psModuleName, 'index.js')),
    options: options,
    cache: CACHE_VAR,
    emitWarning: warning => {
      if (options.warnings && warning.length) {
        CACHE_VAR.warnings.push(warning);
      }
    },
    emitError: pscMessage => {
      if (pscMessage.length) {
        const modules = [];

        const matchErrorsSeparator = /\n(?=Error)/;
        const errors = pscMessage.split(matchErrorsSeparator);
        for (const error of errors) {
          const matchErrLocation = /at (.+\.purs) line (\d+), column (\d+) - line (\d+), column (\d+)/;
          const [, filename] = matchErrLocation.exec(error) || [];
          if (!filename) continue;

          const baseModulePath = path.join(this.rootContext, filename);
          this.addDependency(baseModulePath);

          const matchErrModuleName = /in module ((?:\w+\.)*\w+)/;
          const [, baseModuleName] = matchErrModuleName.exec(error) || [];
          if (!baseModuleName) continue;

          const matchMissingModuleName = /Module ((?:\w+\.)*\w+) was not found/;
          const matchMissingImportFromModuleName = /Cannot import value \w+ from module ((?:\w+\.)*\w+)/;
          for (const re of [matchMissingModuleName, matchMissingImportFromModuleName]) {
            const [, targetModuleName] = re.exec(error) || [];
            if (targetModuleName) {
              const resolved = utils.resolvePursModule({
                baseModulePath,
                baseModuleName,
                targetModuleName
              });
              this.addDependency(resolved);
            }
          }

          const desc = {
            name: baseModuleName,
            filename: baseModulePath
          };

          if (typeof this.describePscError === 'function') {
            const { dependencies = [], details } = this.describePscError(error, desc);

            for (const dep of dependencies) {
              this.addDependency(dep);
            }

            Object.assign(desc, details);
          }

          modules.push(desc);
        }

        CACHE_VAR.errors.push(Object.assign(new Error(pscMessage), { modules }));
      }
    }
  }

  debug('loading %s', psModule.name);

  if (options.bundle) {
    CACHE_VAR.bundleModules.push(psModule.name);
  }

  if (CACHE_VAR.rebuild) {
    const connect = () => {
      if (!CACHE_VAR.ideServer) {
        CACHE_VAR.ideServer = true;

        return ide.connect(psModule)
          .then(ideServer => {
            CACHE_VAR.ideServer = ideServer;
            return psModule;
          })
          .then(ide.loadWithRetry)
          .catch(error => {
            if (CACHE_VAR.ideServer.kill) {
              debug('ide failed to initially load modules, stopping the ide server process');

              CACHE_VAR.ideServer.kill();
            }

            CACHE_VAR.ideServer = null;

            return Promise.reject(error);
          })
        ;
      }
      else {
        return Promise.resolve(psModule);
      }
    };

    const rebuild = () =>
      ide.rebuild(psModule)
      .then(() =>
        toJavaScript(psModule)
          .then(js => sourceMaps(psModule, js))
          .then(psModule.load)
          .catch(psModule.reject)
      )
      .catch(error => {
        if (error instanceof ide.UnknownModuleError) {
          // Store the modules that trigger a recompile due to an
          // unknown module error. We need to wait until compilation is
          // done before loading these files.

          CACHE_VAR.deferred.push(psModule);

          if (!CACHE_VAR.compilationStarted) {
            CACHE_VAR.compilationStarted = true;

            return compile(psModule)
              .then(() => {
                CACHE_VAR.compilationFinished = true;
              })
              .then(() =>
                Promise.map(CACHE_VAR.deferred, psModule =>
                  ide.load(psModule)
                    .then(() => toJavaScript(psModule))
                    .then(js => sourceMaps(psModule, js))
                    .then(psModule.load)
                )
              )
              .catch(error => {
                CACHE_VAR.compilationFailed = true;

                CACHE_VAR.deferred[0].reject(error);

                CACHE_VAR.deferred.slice(1).forEach(psModule => {
                  psModule.reject(new Error('purs-loader failed'));
                })
              })
            ;
          } else if (CACHE_VAR.compilationFailed) {
            CACHE_VAR.deferred.pop().reject(new Error('purs-loader failed'));
          } else {
            // The compilation has started. We must wait until it is
            // done in order to ensure the module map contains all of
            // the unknown modules.
          }
        }
        else {
          debug('ide rebuild failed due to an unhandled error: %o', error);

          psModule.reject(error);
        }
      })
    ;

    connect().then(rebuild);
  }
  else if (CACHE_VAR.compilationFinished) {
    debugVerbose('compilation is already finished, loading module %s', psModule.name);

    toJavaScript(psModule)
      .then(js => sourceMaps(psModule, js))
      .then(psModule.load)
      .catch(psModule.reject);
  }
  else {
    // The compilation has not finished yet. We need to wait for
    // compilation to finish before the loaders run so that references
    // to compiled output are valid. Push the modules into the CACHE_VAR to
    // be loaded once the complation is complete.

    CACHE_VAR.deferred.push(psModule);

    if (!CACHE_VAR.compilationStarted) {
      CACHE_VAR.compilationStarted = true;

      compile(psModule)
        .then(() => {
          CACHE_VAR.compilationFinished = true;
        })
        .then(() => {
          if (options.bundle) {
            return bundle(options, CACHE_VAR.bundleModules);
          }
        })
        .then(() =>
          Promise.map(CACHE_VAR.deferred, psModule =>
            toJavaScript(psModule)
              .then(js => sourceMaps(psModule, js))
              .then(psModule.load)
          )
        )
        .catch(error => {
          CACHE_VAR.compilationFailed = true;

          CACHE_VAR.deferred[0].reject(error);

          CACHE_VAR.deferred.slice(1).forEach(psModule => {
            psModule.reject(new Error('purs-loader failed'));
          })
        })
      ;
    } else if (CACHE_VAR.compilationFailed) {
      CACHE_VAR.deferred.pop().reject(new Error('purs-loader failed'));
    } else {
      // The complation has started. Nothing to do but wait until it is
      // done before loading all of the modules.
    }
  }
}
