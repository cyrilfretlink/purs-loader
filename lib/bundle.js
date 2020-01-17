'use strict';

var path = require('path');

var Promise = require('bluebird');

var fs = Promise.promisifyAll(require('fs'));

var spawn = require('cross-spawn');

var debug = require('debug')('purs-loader');

var dargs = require('./dargs');

module.exports = function bundle(options, bundleModules) {
  var stdout = [];

  var stderr = [];

  var bundleCommand = options.pscBundle || 'purs';

  var bundleArgs = (options.pscBundle ? [] : ['bundle']).concat(dargs(Object.assign({
    _: [path.join(options.output, '*', '*.js')],
    output: options.bundleOutput,
    namespace: options.bundleNamespace
  }, options.pscBundleArgs)));

  bundleModules.forEach(function (name) {
    return bundleArgs.push('--module', name);
  });

  debug('bundle: %s %O', bundleCommand, bundleArgs);

  return new Promise(function (resolve, reject) {
    debug('bundling PureScript...');

    var compilation = spawn(bundleCommand, bundleArgs);

    compilation.stdout.on('data', function (data) {
      return stdout.push(data.toString());
    });

    compilation.stderr.on('data', function (data) {
      return stderr.push(data.toString());
    });

    compilation.on('close', function (code) {
      debug('finished bundling PureScript.');

      if (code !== 0) {
        var errorMessage = stderr.join('');

        if (errorMessage.length) {
          reject(new Error('bundling failed: ' + errorMessage));
        } else {
          reject(new Error('bundling failed'));
        }
      } else {
        resolve(fs.appendFileAsync(options.bundleOutput, 'module.exports = ' + options.bundleNamespace));
      }
    });
  });
};