'use strict';

var Promise = require('bluebird');

var spawn = require('cross-spawn');

var debug_ = require('debug');

var debug = debug_('purs-loader');

var debugVerbose = debug_('purs-loader:verbose');

var dargs = require('./dargs');

module.exports = function compile(psModule) {
  var options = psModule.options;

  var compileCommand = options.psc || 'purs';

  var compileArgs = (options.psc ? [] : ['compile']).concat(dargs(Object.assign({
    _: options.src,
    output: options.output
  }, options.pscArgs)));

  var stderr = [];

  debug('compile %s %O', compileCommand, compileArgs);

  return new Promise(function (resolve, reject) {
    debug('compiling PureScript...');

    var compilation = spawn(compileCommand, compileArgs);

    compilation.stderr.on('data', function (data) {
      stderr.push(data.toString());
    });

    compilation.stdout.on('data', function (data) {
      debugVerbose(data.toString());
    });

    compilation.on('close', function (code) {
      debug('finished compiling PureScript.');

      if (code !== 0) {
        var errorMessage = stderr.join('');
        if (errorMessage.length) {
          psModule.emitError(errorMessage);
        }
        if (options.watch) {
          resolve(psModule);
        } else {
          reject(new Error('compilation failed'));
        }
      } else {
        var warningMessage = stderr.join('');
        if (options.warnings && warningMessage.length) {
          psModule.emitWarning(warningMessage);
        }
        resolve(psModule);
      }
    });
  });
};