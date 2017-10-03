#!/usr/bin/env node
'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var fs = require('fs');
var path = require('path');
var defaultsDeep = require('lodash.defaultsdeep');
var entries = require('lodash.topairs');
var yargs = require('yargs');
var AWS = require('aws-sdk');
var ini = require('ini');

var args = yargs.usage('Usage: $0 <command> [options]').alias('c', 'config').nargs('c', 1).describe('c', 'Apex project JSON file location').command('create <name> [description] [cloneFrom]', 'Create a new REST API on AWS API Gateway', {
  region: { alias: 'r', describe: 'configure which aws region to use' },
  profile: { alias: 'p', describe: 'configure which aws profile to use' },
  force: { alias: 'f', describe: 'Force creating REST API overriding existing configuration' }
}, create).command('update', 'Update the REST API with the new Swagger definitions', {
  region: { alias: 'r', describe: 'configure which aws region to use' },
  profile: { alias: 'p', describe: 'configure which aws profile to use' },
  stdout: { describe: 'Output swagger to console without deploying' }
}, update).help().argv;

function create(_ref) {
  var name = _ref.name,
      _ref$description = _ref.description,
      description = _ref$description === undefined ? null : _ref$description,
      _ref$cloneFrom = _ref.cloneFrom,
      cloneFrom = _ref$cloneFrom === undefined ? '' : _ref$cloneFrom,
      _ref$config = _ref.config,
      config = _ref$config === undefined ? './project.json' : _ref$config,
      force = _ref.force,
      region = _ref.region,
      profile = _ref.profile;

  loadAwsConfig(profile, region);
  var apigateway = new AWS.APIGateway();
  var projectConfig = loadConfig(config);

  if (!force && projectConfig && projectConfig['x-api-gateway'] && projectConfig['x-api-gateway']['rest-api-id']) {
    console.error('A REST API id is already defined the project.json, if you really want to override this use -f parameter');
    return;
  }

  var params = {
    name: name,
    cloneFrom: cloneFrom,
    description: description
  };
  apigateway.createRestApi(params, function (err, data) {
    if (err) {
      console.log(err, err.stack);
      return;
    }

    var updatedConfig = JSON.stringify(Object.assign({}, projectConfig, _defineProperty({}, 'x-api-gateway', Object.assign({}, projectConfig['x-api-gateway'], { 'rest-api-id': data.id }))), null, 2);

    fs.writeFile(config, updatedConfig, function (err) {
      if (err) throw err;

      console.log('Success! Now you can push your REST API using update command.');
    });
  });
}

function update(_ref2) {
  var config = _ref2.config,
      stdout = _ref2.stdout,
      profile = _ref2.profile,
      region = _ref2.region;

  loadAwsConfig(profile, region);
  var apigateway = new AWS.APIGateway();
  var projectConfig = loadConfig(config);

  if (!projectConfig['x-api-gateway'] || !projectConfig['x-api-gateway']['rest-api-id']) {
    throw new Error('Missing REST API id, you might want to use create command first.');
  }

  var restApiId = projectConfig['x-api-gateway']['rest-api-id'];

  var renderMethod = function renderMethod(name, _ref3) {
    var _defaultsDeep;

    var description = _ref3.description,
        parameters = _ref3['x-api-gateway'].parameters;

    var template = projectConfig['x-api-gateway']['swagger-func-template'];
    return defaultsDeep((_defaultsDeep = {
      description: description
    }, _defineProperty(_defaultsDeep, 'x-amazon-apigateway-integration', {
      httpMethod: 'post',
      uri: template['x-amazon-apigateway-integration'].uri.replace('{{functionName}}', projectConfig.name + '_' + name)
    }), _defineProperty(_defaultsDeep, 'parameters', parameters), _defaultsDeep), template);
  };

  var renderPaths = function renderPaths(functions) {
    var paths = {};

    functions.map(function (_ref4) {
      var name = _ref4.name,
          definition = _ref4.definition;
      var _definition$xApiGat = definition['x-api-gateway'],
          path = _definition$xApiGat.path,
          method = _definition$xApiGat.method;

      if (!path || !method) {
        return;
      }

      paths[path] = paths[path] || {};
      paths[path][method] = renderMethod(name, definition);
    });

    entries(projectConfig['x-api-gateway']['paths']).forEach(function (_ref5) {
      var _ref6 = _slicedToArray(_ref5, 2),
          key = _ref6[0],
          value = _ref6[1];

      var keyPattern = new RegExp('^' + key + '$');
      var matchedPaths = entries(paths).filter(function (_ref7) {
        var _ref8 = _slicedToArray(_ref7, 1),
            path = _ref8[0];

        return keyPattern.test(path);
      });

      matchedPaths.forEach(function (_ref9) {
        var _ref10 = _slicedToArray(_ref9, 2),
            path = _ref10[0],
            pathValue = _ref10[1];

        defaultsDeep(pathValue, value); // paths local mutation seems to be the best
      });
    });

    return paths;
  };

  var functionsDefs = fs.readdirSync(path.join(process.cwd(), './functions')).map(function (folder) {
    try {
      var functionDef = require(path.join(process.cwd(), './functions/' + folder + '/function.json'));

      return {
        name: folder,
        definition: functionDef
      };
    } catch (e) {
      return;
    }
  }).filter(function (i) {
    return i;
  });

  var swagger = {
    "swagger": "2.0",
    "info": {
      "version": new Date().toISOString(),
      "title": projectConfig.name
    },
    "basePath": projectConfig['x-api-gateway'].base_path,
    "schemes": ["https"],
    "paths": renderPaths(functionsDefs),
    "securityDefinitions": {
      "api_key": {
        "type": "apiKey",
        "name": "x-api-key",
        "in": "header"
      }
    },
    "definitions": {
      "Empty": {
        "type": "object"
      }
    }
  };

  if (stdout) {
    process.stdout.write(JSON.stringify(swagger, null, 2));
    return;
  }

  console.log('Pushing REST API...');

  var params = {
    body: JSON.stringify(swagger),
    restApiId: restApiId,
    mode: 'overwrite'
  };
  apigateway.putRestApi(params, function (err, data) {
    if (err) {
      console.log(err, err.stack);
      return;
    }

    console.log('Updated API with success!');
    console.log('Deploying REST API...');

    var params = {
      restApiId: restApiId,
      stageName: projectConfig['x-api-gateway']['stage_name']
    };
    apigateway.createDeployment(params, function (err, data) {
      if (err) {
        console.log(err, err.stack);
        return;
      }

      console.log('API deployed successfully!');
    });
  });
}

function loadConfig() {
  var projectFile = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : './project.json';

  return require(path.join(process.cwd(), projectFile));
}

function loadAwsConfig(profile, region) {
  if (profile && profile !== 'default') {
    console.log('setting up api-gateway using profile ' + profile);
    AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: profile });

    // in order to load the profile's config we need to require the ini file
    var profiles = ini.parse(fs.readFileSync(AWS.config.credentials.filename.replace('credentials', 'config'), 'utf-8'));
    var profileConfig = profiles['profile ' + profile];
    AWS.config.update(profileConfig);
  }
  if (region) {
    console.log('setting up api-gateway using region ' + region);
    AWS.config.update({ region: region });
  }
}