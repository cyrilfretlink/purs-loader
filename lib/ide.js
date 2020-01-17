'use strict';

var path = require('path');

var Promise = require('bluebird');

var fs = Promise.promisifyAll(require('fs'));

var retryPromise = require('promise-retry');

var spawn = require('cross-spawn');

var colors = require('chalk');

var debug_ = require('debug');

var debug = debug_('purs-loader');

var debugVerbose = debug_('purs-loader:verbose');

var dargs = require('./dargs');

var compile = require('./compile');

var PsModuleMap = require('./purs-module-map');

function UnknownModuleError() {
  this.name = 'UnknownModuleError';
  this.stack = new Error().stack;
}

UnknownModuleError.prototype = Object.create(Error.prototype);

UnknownModuleError.prototype.constructor = UnknownModuleError;

module.exports.UnknownModuleError = UnknownModuleError;

function spawnIdeClient(body, options) {
  var ideClientCommand = options.pscIdeClient || 'purs';

  var ideClientArgs = (options.pscIdeClient ? [] : ['ide', 'client']).concat(dargs(options.pscIdeClientArgs));

  var stderr = [];

  var stdout = [];

  debug('ide client %s %o %O', ideClientCommand, ideClientArgs, body);

  return new Promise(function (resolve, reject) {
    var ideClient = spawn(ideClientCommand, ideClientArgs);

    ideClient.stderr.on('data', function (data) {
      stderr.push(data.toString());
    });

    ideClient.stdout.on('data', function (data) {
      stdout.push(data.toString());
    });

    ideClient.on('close', function (code) {
      if (code !== 0) {
        var errorMessage = stderr.join('');

        reject(new Error('ide client failed: ' + errorMessage));
      } else {
        var result = stdout.join('');

        resolve(result);
      }
    });

    ideClient.stdin.resume();

    ideClient.stdin.write(JSON.stringify(body));

    ideClient.stdin.write('\n');
  });
}

function formatIdeResult(result, options, index, length) {
  var numAndErr = '[' + (index + 1) + '/' + length + ' ' + result.errorCode + ']';
  numAndErr = options.pscIdeColors ? colors.yellow(numAndErr) : numAndErr;

  function makeResult() {
    return Promise.resolve('\n' + numAndErr + ' ' + result.message);
  }

  function makeResultSnippet(filename, pos) {
    var srcPath = path.relative(options.context, filename);
    var fileAndPos = srcPath + ':' + pos.startLine + ':' + pos.startColumn;

    return fs.readFileAsync(filename, 'utf8').then(function (source) {
      var lines = source.split('\n').slice(pos.startLine - 1, pos.endLine);
      var endsOnNewline = pos.endColumn === 1 && pos.startLine !== pos.endLine;
      var up = options.pscIdeColors ? colors.red('^') : '^';
      var down = options.pscIdeColors ? colors.red('v') : 'v';
      var trimmed = lines.slice(0);

      if (endsOnNewline) {
        lines.splice(lines.length - 1, 1);
        pos.endLine = pos.endLine - 1;
        pos.endColumn = lines[lines.length - 1].length || 1;
      }

      // strip newlines at the end
      if (endsOnNewline) {
        trimmed = lines.reverse().reduce(function (trimmed, line, i) {
          if (i === 0 && line === '') trimmed.trimming = true;
          if (!trimmed.trimming) trimmed.push(line);
          if (trimmed.trimming && line !== '') {
            trimmed.trimming = false;
            trimmed.push(line);
          }
          return trimmed;
        }, []).reverse();
        pos.endLine = pos.endLine - (lines.length - trimmed.length);
        pos.endColumn = trimmed[trimmed.length - 1].length || 1;
      }

      var spaces = ' '.repeat(String(pos.endLine).length);
      var snippet = trimmed.map(function (line, i) {
        return '  ' + (pos.startLine + i) + '  ' + line;
      }).join('\n');

      if (trimmed.length === 1) {
        snippet += '\n  ' + spaces + '  ' + ' '.repeat(pos.startColumn - 1) + up.repeat(pos.endColumn - pos.startColumn + 1);
      } else {
        snippet = '  ' + spaces + '  ' + ' '.repeat(pos.startColumn - 1) + down + '\n' + snippet;
        snippet += '\n  ' + spaces + '  ' + ' '.repeat(pos.endColumn - 1) + up;
      }

      return Promise.resolve('\n' + numAndErr + ' ' + fileAndPos + '\n\n' + snippet + '\n\n' + result.message);
    }).catch(function (error) {
      debug('failed to format ide result: %o', error);

      return Promise.resolve('');
    });
  }

  return result.filename && result.position ? makeResultSnippet(result.filename, result.position) : makeResult();
}

module.exports.connect = function connect(psModule) {
  var options = psModule.options;

  var serverCommand = options.pscIdeServer || 'purs';

  var serverArgs = (options.pscIdeServer ? [] : ['ide', 'server']).concat(dargs(Object.assign({
    outputDirectory: options.output,
    '_': options.src
  }, options.pscIdeServerArgs)));

  debug('ide server: %s %o', serverCommand, serverArgs);

  var ideServer = spawn(serverCommand, serverArgs);

  ideServer.stdout.on('data', function (data) {
    debugVerbose('ide server stdout: %s', data.toString());
  });

  ideServer.stderr.on('data', function (data) {
    debugVerbose('ide server stderr: %s', data.toString());
  });

  ideServer.on('error', function (error) {
    debugVerbose('ide server error: %o', error);
  });

  ideServer.on('close', function (code, signal) {
    debugVerbose('ide server close: %s %s', code, signal);
  });

  return Promise.resolve(ideServer);
};

module.exports.load = function load(psModule) {
  var options = psModule.options;

  var body = { command: 'load' };

  return spawnIdeClient(body, options);
};

module.exports.loadWithRetry = function loadWithRetry(psModule) {
  var retries = 9;

  return retryPromise(function (retry, number) {
    debugVerbose('attempting to load modules (%d out of %d attempts)', number, retries);

    return module.exports.load(psModule).catch(retry);
  }, {
    retries: retries,
    factor: 1,
    minTimeout: 333,
    maxTimeout: 333
  }).then(function () {
    return psModule;
  });
};

module.exports.rebuild = function rebuild(psModule) {
  var options = psModule.options;

  var body = {
    command: 'rebuild',
    params: Object.assign({
      file: psModule.srcPath
    }, options.pscIdeRebuildArgs)
  };

  var parseResponse = function parseResponse(response) {
    try {
      var parsed = JSON.parse(response);

      debugVerbose('parsed JSON response: %O', parsed);

      return Promise.resolve(parsed);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  var formatResponse = function formatResponse(parsed) {
    var result = Array.isArray(parsed.result) ? parsed.result : [];

    return Promise.map(result, function (item, i) {
      debugVerbose('formatting result %O', item);

      return formatIdeResult(item, options, i, result.length);
    }).then(function (formatted) {
      return {
        parsed: parsed,
        formatted: formatted,
        formattedMessage: formatted.join('\n')
      };
    });
  };

  return spawnIdeClient(body, options).then(parseResponse).then(formatResponse).then(function (_ref) {
    var parsed = _ref.parsed,
        formatted = _ref.formatted,
        formattedMessage = _ref.formattedMessage;

    if (parsed.resultType === 'success') {
      if (options.warnings && formattedMessage.length) {
        psModule.emitWarning(formattedMessage);
      }

      return psModule;
    } else if ((parsed.result || []).some(function (item) {
      var isModuleNotFound = item.errorCode === 'ModuleNotFound';

      var isUnknownModule = item.errorCode === 'UnknownModule';

      var isUnknownModuleImport = item.errorCode === 'UnknownName' && /Unknown module/.test(item.message);

      return isModuleNotFound || isUnknownModule || isUnknownModuleImport;
    })) {
      debug('module %s was not rebuilt because the module is unknown', psModule.name);

      return Promise.reject(new UnknownModuleError());
    } else {
      if (formattedMessage.length) {
        psModule.emitError(formattedMessage);
      }

      return psModule;
    }
  });
};