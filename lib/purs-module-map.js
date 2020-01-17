'use strict';

var path = require('path');

var Promise = require('bluebird');

var fs = Promise.promisifyAll(require('fs'));

var globby = require('globby');

var debug = require('debug')('purs-loader');

var srcModuleRegex = /(?:^|\n)module\s+([\w\.]+)/i;

var importModuleRegex = /(?:^|\n)\s*import\s+([\w\.]+)/ig;

module.exports.matchModule = function matchModule(str) {
  var matches = str.match(srcModuleRegex);
  return matches && matches[1];
};

module.exports.matchImports = function matchImports(str) {
  var matches = str.match(importModuleRegex);
  return (matches || []).map(function (a) {
    return a.replace(/\n?\s*import\s+/i, '');
  });
};

module.exports.makeMapEntry = function makeMapEntry(filePurs) {
  var dirname = path.dirname(filePurs);

  var basename = path.basename(filePurs, '.purs');

  var fileJs = path.join(dirname, basename + '.js');

  var result = Promise.props({
    filePurs: fs.readFileAsync(filePurs, 'utf8'),
    fileJs: fs.readFileAsync(fileJs, 'utf8').catch(function () {
      return undefined;
    })
  }).then(function (fileMap) {
    var sourcePurs = fileMap.filePurs;

    var sourceJs = fileMap.fileJs;

    var moduleName = module.exports.matchModule(sourcePurs);

    var imports = module.exports.matchImports(sourcePurs);

    var map = {};

    map[moduleName] = map[moduleName] || {};

    map[moduleName].src = path.resolve(filePurs);

    map[moduleName].imports = imports;

    if (sourceJs) {
      map[moduleName].ffi = path.resolve(fileJs);
    }

    return map;
  });

  return result;
};

module.exports.makeMap = function makeMap(src) {
  debug('loading PureScript source and FFI files from %o', src);

  var globs = [].concat(src);

  return globby(globs).then(function (paths) {
    return Promise.all(paths.map(module.exports.makeMapEntry)).then(function (result) {
      return result.reduce(Object.assign, {});
    });
  });
};