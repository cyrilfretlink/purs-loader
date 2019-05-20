'use strict';

var Promise = require('bluebird');

var fs = require('fs');

var path = require('path');

var debug_ = require('debug');

var debugVerbose = debug_('purs-loader:verbose');

module.exports = function sourceMap(psModule, js) {
  var options = psModule.options;

  var jsPath = psModule.jsPath;

  var srcPath = psModule.srcPath;

  var source = psModule.source;

  var remainingRequest = psModule.remainingRequest;

  var sourceMapPath = path.join(path.dirname(jsPath), 'index.js.map');

  var isSourceMapsEnabled = options.pscArgs && options.pscArgs.sourceMaps;

  return new Promise(function (resolve, reject) {
    if (!isSourceMapsEnabled) {
      resolve({
        js: js,
        map: undefined
      });
    } else {
      debugVerbose('loading source map %s', sourceMapPath);

      fs.readFile(sourceMapPath, 'utf-8', function (error, result) {
        if (error) {
          reject(error);
        } else {
          try {
            var map = Object.assign(JSON.parse(result), {
              sources: [remainingRequest],
              file: path.normalize(srcPath),
              sourcesContent: [source]
            });

            var jsRemovedMapUrl = js.replace(/^\/\/# sourceMappingURL=[^\r\n]*/gm, '');

            resolve({
              js: jsRemovedMapUrl,
              map: map
            });
          } catch (error) {
            reject(error);
          }
        }
      });
    }
  });
};